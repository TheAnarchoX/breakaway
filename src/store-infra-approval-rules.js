/**
 * TaskStore's approval rules and approvals (BRK-303, docs/specs/BRK-299-people-and-roles.md, point 7): each
 * environment's rule for who must approve its plans and its console's changes, and the approvals each one has so far.
 * The pure part is src/infra-approval-rules.js.
 *
 * A rule lives on the board, never in the repository, so a pull request can't lower the bar for its own plans. An
 * environment without one has the default, one maintainer (the owner always counts), which is exactly what the board
 * did before. Tightening a rule is a maintainer's press; loosening it is the owner's, like a policy that loosens. Every
 * change and every approval is in the audit trail, with who pressed.
 */
import { AgentError } from './store-agents.js';
import { DEFAULT_RULE, approvalState, approveRefusal, checkRule, loosens, ruleWords } from './infra-approval-rules.js';
import { OWNER } from './permissions.js';
import { personWords } from './store-permissions.js';

/** What can be approved: a plan, or a change from the console. */
const KINDS = ['plan', 'change'];

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraApprovalRulesMethods = {
  initInfraApprovalRules() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS infra_approval_rules (
        environment INTEGER PRIMARY KEY, role TEXT NOT NULL, people INTEGER NOT NULL, edited INTEGER NOT NULL,
        person TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS infra_approvals (
        kind TEXT NOT NULL, n INTEGER NOT NULL, person TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (kind, n, person)
      );
    `);
  },

  /**
   * An environment's rule, by its ID: the one kept for it, or the default.
   * @param {number} environmentId
   * @returns {import('./infra-approval-rules.js').ApprovalRule}
   */
  approvalRuleOf(environmentId) {
    const row = this.sql
      .exec('SELECT role, people FROM infra_approval_rules WHERE environment = ?', Number(environmentId))
      .toArray()[0];
    return row ? checkRule(row) : { ...DEFAULT_RULE };
  },

  /**
   * Everyone who may approve under `rule` in `repo`: the owner, and, unless the rule is the owner's alone, every person
   * who maintains the repository (by its grant or the `*` grant) and hasn't been removed.
   * @param {string} repo
   * @param {import('./infra-approval-rules.js').ApprovalRule} rule
   */
  approversOf(repo, rule) {
    if (rule.role === 'owner' && rule.people === 1) return [OWNER];
    const maintainers = this.sql
      .exec(
        `SELECT DISTINCT g.handle FROM grants g JOIN people p ON p.handle = g.handle
         WHERE p.removed IS NULL AND g.role = 'maintainer' AND (g.repo = ? OR g.repo = '*') ORDER BY g.handle`,
        String(repo),
      )
      .toArray()
      .map((r) => String(r.handle));
    return [OWNER, ...maintainers];
  },

  /** The approvals a plan or a change has so far, oldest first. */
  approvalsOf(kind, n) {
    return this.sql
      .exec('SELECT person, at FROM infra_approvals WHERE kind = ? AND n = ? ORDER BY at, person', kind, Number(n))
      .toArray()
      .map((r) => ({ person: String(r.person), at: Number(r.at) }));
  },

  /**
   * The person who proposed a plan: whoever pressed for its draft (BRK-303), from its first audit entry. An agent's
   * or the board's draft has none: agents propose, and people approve.
   * @param {string} id the plan's ID
   */
  planProposer(id) {
    const row = this.sql
      .exec("SELECT by, person FROM infra_audit WHERE plan = ? AND kind = 'plan' ORDER BY id LIMIT 1", id)
      .toArray()[0];
    return row && (row.by === 'owner' || row.by === 'person') ? (row.person ?? OWNER) : null;
  },

  /**
   * Where approving a plan or a change stands, for its page: the rule, who has approved, how many more it needs, who
   * else may, and whether the owner may approve alone.
   * @param {'plan' | 'change'} kind
   * @param {number} n
   * @param {{ environment: number, repo: string, proposer?: string | null }} on
   */
  approvalView(kind, n, { environment, repo, proposer = null }) {
    const rule = this.approvalRuleOf(environment);
    return {
      ...approvalState(rule, {
        approvals: this.approvalsOf(kind, n),
        eligible: this.approversOf(repo, rule),
        proposer,
      }),
      proposer,
    };
  },

  /**
   * Counts one approval of a plan or a change by the person behind `input`, under its environment's rule. Refuses
   * someone the rule doesn't let approve, a second approval by the same person, and the proposer under the
   * two-person rule. Answers `done` once it has the approvals the rule needs, with the words for the audit trail;
   * until then the approval is kept and the plan or change still waits. `alone` is the owner's Approve alone: only
   * the owner, only under the two-person rule, and only when nobody else could approve.
   * @param {'plan' | 'change'} kind
   * @param {number} n
   * @param {{ environment: number, repo: string, proposer?: string | null, what: string }} on
   * @param {any} input what the call was given: `{ actor?, by?, alone? }`
   * @returns {{ done: boolean, person: string, alone: boolean, words: string, view: ReturnType<typeof approvalState> }}
   */
  countApproval(kind, n, { environment, repo, proposer = null, what }, input) {
    if (!KINDS.includes(kind)) throw new AgentError(`nothing called ${kind} is approved`, 400);
    const { person } = this.actorIn(input);
    const rule = this.approvalRuleOf(environment);
    const eligible = this.approversOf(repo, rule);
    const approvals = this.approvalsOf(kind, n);
    const state = approvalState(rule, { approvals, eligible, proposer });
    if (input?.alone === true) {
      if (person !== OWNER) throw new AgentError(`only the owner approves ${what} alone`, 403);
      if (!state.alone)
        throw new AgentError(
          state.needs === 0 || rule.people !== 2
            ? `${what} needs no second approval: approve it as usual`
            : `${state.mayApprove.filter((p) => p !== OWNER).join(', ')} can approve ${what} too: ask them, since its environment’s rule is ${ruleWords(rule)}`,
          409,
        );
      this.sql.exec(
        'INSERT OR IGNORE INTO infra_approvals (kind, n, person, at) VALUES (?, ?, ?, ?)',
        kind,
        Number(n),
        person,
        Date.now(),
      );
      return {
        done: true,
        person,
        alone: true,
        words: `approved alone by the owner, overriding its environment’s rule (${ruleWords(rule)}): nobody else could approve`,
        view: approvalState(rule, { approvals: this.approvalsOf(kind, n), eligible, proposer }),
      };
    }
    const no = approveRefusal(rule, person, { approvals, eligible, proposer, what });
    if (no) throw new AgentError(no, approvals.some((a) => a.person === person) ? 409 : 403);
    this.sql.exec(
      'INSERT INTO infra_approvals (kind, n, person, at) VALUES (?, ?, ?, ?)',
      kind,
      Number(n),
      person,
      Date.now(),
    );
    const now = this.approvalsOf(kind, n);
    const view = approvalState(rule, { approvals: now, eligible, proposer });
    const names = now.map((a) => personWords(a.person));
    return {
      done: view.needs === 0,
      person,
      alone: false,
      words:
        view.needs === 0
          ? `approved by ${names.join(' and ')}`
          : `approved by ${personWords(person)}; ${ruleWords(rule)} must approve, so it waits for ${view.needs} more`,
      view,
    };
  },

  /** GET /api/infra/environments/<name>/approval: the environment's rule, for anyone who reads the environment. */
  approvalRuleApi(ref, { repo = null } = {}) {
    return this.run(async () => {
      const env = this.environmentRow(ref, repo ? String(repo).trim().toLowerCase() : null);
      if (!env) throw new AgentError(`no environment ${String(ref).slice(0, 40)}`, 404);
      const rule = this.approvalRuleOf(env.id);
      return {
        status: 200,
        body: { rule, words: ruleWords(rule), approvers: this.approversOf(env.repo, rule) },
      };
    });
  },

  /**
   * PUT /api/infra/environments/<name>/approval: `{ role, people }`. Tightening is a maintainer's press; anything that
   * loosens is the owner's (BRK-299 point 7). Written to the audit trail with who pressed.
   */
  approvalRuleSetApi(ref, body = {}) {
    return this.run(async () => {
      const repo = body.repo ? String(body.repo).trim().toLowerCase() : null;
      this.allowOn(
        body,
        'policy.tighten',
        () => this.environmentRow(ref, repo)?.repo ?? null,
        'only the owner changes who approves a plan, from the board',
      );
      const env = this.environmentRow(ref, repo);
      if (!env) throw new AgentError(`no environment ${String(ref).slice(0, 40)}`, 404);
      const was = this.approvalRuleOf(env.id);
      const rule = checkRule(body);
      if (loosens(was, rule)) this.allow(body, 'policy.loosen', env.repo);
      if (was.role === rule.role && was.people === rule.people)
        return { status: 200, body: { rule, words: ruleWords(rule), approvers: this.approversOf(env.repo, rule) } };
      const pressed = this.pressedBy(body);
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          `INSERT INTO infra_approval_rules (environment, role, people, edited, person) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (environment) DO UPDATE SET role = excluded.role, people = excluded.people,
             edited = excluded.edited, person = excluded.person`,
          env.id,
          rule.role,
          rule.people,
          Date.now(),
          pressed.person,
        );
        this.appendInfraAudit({
          kind: 'policy',
          repo: env.repo,
          environment: env.name,
          environmentId: Number(env.id),
          ...pressed,
          outcome: loosens(was, rule) ? 'loosened' : 'tightened',
          summary: `who approves: ${ruleWords(rule)}, was ${ruleWords(was)}; by ${personWords(pressed.person)}`,
        });
      });
      return { status: 200, body: { rule, words: ruleWords(rule), approvers: this.approversOf(env.repo, rule) } };
    });
  },
};
