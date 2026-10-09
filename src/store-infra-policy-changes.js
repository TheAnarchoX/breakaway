/**
 * TaskStore's policy changes from the board (WEB-123, docs/specs/WEB-123-policy-manager.md). The owner edits a
 * repository's policy on its Policy view; POST /api/infra/policy/changes with `{ repo, policy }` answers what the edit
 * loosens and tightens, in words, writing nothing, and with `propose: true` the board commits `policy.json` on a branch
 * of its own and opens the pull request, the way an environment's change does (store-infra-changes.js's
 * writeChangeBranch, changePullFate, and the approval's merge settings and refusals, called, not copied). The plan check
 * on that pull request shows the same lines (store-infra-pulls.js).
 *
 * Approve merges it, as the owner's action, at the head they saw. A change that loosens the policy is never one press:
 * Approve answers 409 with `confirm` and the exact lines that will no longer wait for the owner, and only a second
 * press that sends those lines back merges it. Either way it refuses while a plan waits that the new policy would let
 * through: the owner answers that plan on its own first. Merging applies nothing and approves no plan: a plan made
 * before keeps the result it was made with, and the next sync reads the merged file for the plans after it. Every
 * write is the owner's press, cookie-only in worker.js with the `by` check second, and appends a `policy` entry to the
 * audit trail of every environment the policy decides for.
 */
import { AgentError } from './store-agents.js';
import { personWords } from './store-permissions.js';
import { GitHubError, fromBase64 } from './github.js';
import { checkPolicyFile, DEFAULT_POLICY, evaluatePolicy, POLICY_MAX_BYTES, POLICY_PATH } from './infra-policy.js';
import { changePullFate, LIVE_STATES } from './infra-changes.js';
import { approvalWords, mergeRoute } from './infra-change-approval.js';
import { planId } from './infra-plans.js';
import { envelopeWords } from './infra-envelopes.js';
import { redact } from './redact.js';
import {
  checkPolicyEdit,
  comparePolicies,
  environmentRules,
  policyBranch,
  policyChangeBody,
  policyChangeTitle,
  policyCommitMessage,
} from './infra-policy-changes.js';

/** The policy changes a repository's list shows. */
const LIST_LIMIT = 10;
/** The plans the Policy view shows the rules of. */
const RECENT_PLANS = 10;

const refPath = (b) => b.split('/').map(encodeURIComponent).join('/');
const refuse = (status, error, extra = {}) => ({ status, body: { error, ...extra } });

/** A read GitHub answers 404 (not there) to is nothing found. */
async function orNull(promise) {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return null;
    throw error;
  }
}

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraPolicyChangesMethods = {
  initInfraPolicyChanges() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS infra_policy_changes (
        n INTEGER PRIMARY KEY, repo TEXT NOT NULL, policy TEXT NOT NULL, lines TEXT NOT NULL,
        base_sha TEXT, commit_sha TEXT, branch TEXT NOT NULL, pull INTEGER, pull_url TEXT,
        state TEXT NOT NULL, why TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS infra_policy_changes_repo ON infra_policy_changes (repo, state);
    `);
  },

  /** The repository's slug, from the request or the board's default. */
  policyRepo(repo) {
    const slug = String(repo || this.defaultRepoSlug())
      .trim()
      .toLowerCase();
    if (!this.repos().some((r) => r.slug === slug)) throw new AgentError(`no repository ${slug.slice(0, 40)}`, 404);
    return slug;
  },

  /** The environments a repository's policy decides for, with what the words need: kind, gates, freeze. */
  policyEnvironments(slug) {
    return this.plannableEnvironments(slug).map((env) => {
      const view = this.environmentOut(env);
      return { id: Number(env.id), name: env.name, kind: env.kind ?? null, gates: view.gates, frozen: view.frozen };
    });
  },

  /** An environment's envelope in words, or null: shown read only, since it's set in the repository's settings. */
  policyEnvelopeWords(envId) {
    const row = this.sql.exec('SELECT envelope FROM infra_envelopes WHERE environment = ?', envId).toArray()[0];
    return row ? envelopeWords(JSON.parse(row.envelope)) : null;
  },

  /** One `policy` audit entry for each environment the policy decides for: it changes what waits in each. */
  auditPolicyChange(slug, { by, person = null, outcome, summary }) {
    for (const env of this.plannableEnvironments(slug))
      this.appendInfraAudit({
        kind: 'policy',
        repo: slug,
        environment: env.name,
        environmentId: Number(env.id),
        by,
        person,
        outcome,
        summary,
      });
  },

  /** The repository's open policy change, or null. */
  livePolicyChangeRow(slug) {
    return (
      this.sql
        .exec(
          `SELECT * FROM infra_policy_changes WHERE repo = ? AND state IN (SELECT value FROM json_each(?)) ORDER BY n DESC LIMIT 1`,
          slug,
          JSON.stringify(LIVE_STATES),
        )
        .toArray()[0] ?? null
    );
  },

  /** A policy change by its number, or a 404. */
  policyChangeRow(ref) {
    const n = Number(ref);
    const row = Number.isSafeInteger(n)
      ? this.sql.exec('SELECT * FROM infra_policy_changes WHERE n = ?', n).toArray()[0]
      : null;
    if (!row) throw new AgentError(`no policy change ${String(ref).slice(0, 20)}`, 404);
    return row;
  },

  /** A policy change as the API shows it. */
  policyChangeOut(row) {
    const lines = JSON.parse(row.lines);
    return {
      n: Number(row.n),
      repo: row.repo,
      policy: JSON.parse(row.policy),
      lines,
      loosens: lines.filter((l) => l.effect === 'loosens').map((l) => l.line),
      head: row.base_sha ?? null,
      commit: row.commit_sha ?? null,
      branch: row.branch,
      pull: row.pull ? { number: Number(row.pull), url: row.pull_url ?? null } : null,
      state: row.state,
      why: row.why ?? null,
      created: new Date(row.created).toISOString(),
      updated: new Date(row.updated).toISOString(),
    };
  },

  /** Moves a policy change to `state`, with why, and its audit entries. */
  movePolicyChange(row, state, { by, person = null, outcome, why = null, summary }) {
    this.sql.exec(
      'UPDATE infra_policy_changes SET state = ?, why = ?, updated = ? WHERE n = ?',
      state,
      why,
      Date.now(),
      row.n,
    );
    this.auditPolicyChange(row.repo, { by, person, outcome, summary });
  },

  /** Follows a policy change's pull request as GitHub reads it; true when it stopped being the board's open one. */
  followPolicyChange(row, pull) {
    const fate = changePullFate(row.commit_sha, pull);
    const ref = `#${row.pull}`;
    if (fate === 'merged')
      this.movePolicyChange(row, 'merged', {
        by: 'board',
        outcome: 'merged',
        summary: `${ref} merged on GitHub; plans made from now on are checked against it`,
      });
    else if (fate === 'closed')
      this.movePolicyChange(row, 'closed', {
        by: 'board',
        outcome: 'closed',
        why: 'closed on GitHub',
        summary: `${ref} was closed on GitHub; the policy stays as it was`,
      });
    else if (fate === 'taken over')
      this.movePolicyChange(row, 'taken over', {
        by: 'board',
        outcome: 'taken over',
        why: 'someone else pushed to its branch',
        summary: `${ref} has a commit the board didn’t write, so it’s an ordinary pull request now`,
      });
    return fate !== null;
  },

  /** During a sync: follow the repository's open policy change in GitHub's list of pull requests (no extra call). */
  followPolicyChanges(slug, pulls) {
    const row = this.livePolicyChangeRow(slug);
    if (!row?.pull) return;
    const pull = (pulls ?? []).find((p) => Number(p.number) === Number(row.pull));
    if (pull) this.followPolicyChange(row, pull);
  },

  /**
   * The policy at a commit, as the board decides with it: the file when it checks, else the default. `created` is
   * true when there's no file, so the change adds it.
   */
  async policyAt(client, sha) {
    const got = await orNull(client.get(`/contents/${refPath(POLICY_PATH)}?ref=${encodeURIComponent(sha)}`));
    if (!got || Array.isArray(got) || got.type !== 'file') return { policy: DEFAULT_POLICY, created: true, text: null };
    if (Number(got.size ?? 0) > POLICY_MAX_BYTES) return { policy: DEFAULT_POLICY, created: false, text: null };
    const text = fromBase64(got.content);
    const checked = checkPolicyFile(text);
    return { policy: checked.ok ? checked.policy : DEFAULT_POLICY, created: false, text };
  },

  /**
   * The plans waiting for the owner in a repository that `policy` would let through without them: a loosening change
   * isn't approved while one does (the owner answers it on its own first).
   * @param {string} slug
   * @param {import('./infra-policy.js').Policy} policy
   * @returns {Array<{ id: string, environment: string, environmentId: number }>}
   */
  plansPolicyLetsThrough(slug, policy) {
    const rows = this.sql
      .exec(
        `SELECT p.n, p.diff, p.cost, e.* FROM infra_plans p JOIN infra_environments e ON e.id = p.environment
         WHERE p.repo = ? AND p.state = 'waiting' ORDER BY p.n`,
        slug,
      )
      .toArray();
    const out = [];
    for (const row of rows) {
      const view = this.environmentOut(row);
      const result = evaluatePolicy(policy, {
        environment: { name: row.name, kind: row.kind, frozen: view.frozen, gates: view.gates },
        diff: JSON.parse(row.diff),
        cost: JSON.parse(row.cost),
        provider: row.provider ? this.infraProviderFor(row.provider) : null,
        currency: this.infraCurrency().currency,
      });
      if (result.outcome === 'allowed')
        out.push({ id: planId(Number(row.n)), environment: row.name, environmentId: Number(row.id) });
    }
    return out;
  },

  /**
   * POST /api/infra/policy/changes: the owner's, from the signed-in board. `{ repo, policy }` answers `{ text, lines,
   * loosens, tightens, passes }` against the policy in force and writes nothing; with `propose: true` the board opens
   * (or replaces) the change's pull request and answers `{ change }`.
   */
  infraPolicyChangesApi(body = {}) {
    return this.run(async () => {
      this.allowOn(
        body,
        'policy.propose',
        () => this.policyRepo(body.repo),
        'only the owner changes the policy, from the board',
      );
      const slug = this.policyRepo(body.repo);
      const checked = checkPolicyEdit(body.policy);
      if ('error' in checked)
        return refuse(422, `The policy doesn’t check: ${checked.error.message}`, { field: checked.error.field });
      if (body.propose === true) return this.proposePolicyChange(slug, checked, this.pressedBy(body));
      const { policy: before } = this.infraPolicyFor(slug);
      const environments = this.policyEnvironments(slug);
      const diff = comparePolicies(before, checked.policy, {
        environments,
        currency: this.infraCurrency().currency,
      });
      return {
        status: 200,
        body: {
          text: checked.text,
          ...diff,
          passes: diff.loosens.length ? this.plansPolicyLetsThrough(slug, checked.policy) : [],
        },
      };
    });
  },

  /** Propose the change: one at a time per repository. `pressed` is who pressed (BRK-303). */
  async proposePolicyChange(slug, checked, pressed = { by: 'owner', person: 'owner' }) {
    this.infraPolicyProposing ??= new Set();
    if (this.infraPolicyProposing.has(slug))
      throw new AgentError(`The board is already proposing ${slug}’s policy: wait a moment`, 409);
    if (!this.plannableEnvironments(slug).length)
      throw new AgentError(`${slug} has no environment the board plans for: add one first, then its policy`, 409);
    this.infraPolicyProposing.add(slug);
    try {
      const github = await this.changeGitHub({ repo: slug });
      if (!github)
        throw new AgentError(
          'Connect GitHub on Connections first: the board proposes the policy as a pull request',
          409,
        );
      return await this.openPolicyChange(slug, checked, github, pressed);
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      return refuse(
        502,
        `GitHub refused the policy change: ${redact(error.reason ?? error.message)}. Check the App can write to ${slug}’s repository (Connections), then propose again; your edits are kept.`,
        { github: error.status },
      );
    } finally {
      this.infraPolicyProposing.delete(slug);
    }
  },

  async openPolicyChange(slug, checked, { client, repo }, pressed = { by: 'owner', person: 'owner' }) {
    const branchOf = repo.defaultBranch || 'main';
    let live = this.livePolicyChangeRow(slug);
    if (live?.pull) {
      const pull = await orNull(client.get(`/pulls/${live.pull}`));
      if (!pull)
        this.movePolicyChange(live, 'closed', {
          by: 'board',
          outcome: 'closed',
          why: 'its pull request is gone from GitHub',
          summary: `#${live.pull} is gone from GitHub; the policy stays as it was`,
        });
      if (!pull || this.followPolicyChange(live, pull)) live = null;
    }
    const head = (await client.get(`/git/ref/heads/${refPath(branchOf)}`))?.object?.sha;
    if (!head) throw new AgentError(`${branchOf} has no commit yet: push one first`, 409);
    const before = await this.policyAt(client, head);
    if (before.text === checked.text)
      throw new AgentError(`Nothing to propose: the edits leave ${POLICY_PATH} as it is`, 409);
    const environments = this.policyEnvironments(slug);
    const diff = comparePolicies(before.policy, checked.policy, {
      environments,
      currency: this.infraCurrency().currency,
    });
    const reserve = () => {
      const kept = Number(this.meta('infra_policy_change_seq') ?? 0);
      const max = Number(this.sql.exec('SELECT COALESCE(MAX(n), 0) AS n FROM infra_policy_changes').toArray()[0].n);
      const n = Math.max(kept, max) + 1;
      this.setMeta('infra_policy_change_seq', n);
      return n;
    };
    const made = await this.writeChangeBranch(client, {
      head,
      files: [{ path: POLICY_PATH, text: checked.text }],
      message: policyCommitMessage(diff),
      live: live ? { n: Number(live.n), branch: live.branch } : null,
      branchFor: policyBranch,
      reserve,
      repo: slug,
    });
    const home = this.homeUrl();
    const page = home ? `${home}/#/infrastructure/policy?repo=${encodeURIComponent(slug)}` : null;
    const title = policyChangeTitle(diff);
    const description = policyChangeBody({ lines: diff.lines, created: before.created, page });
    const pull = live
      ? await client.send('PATCH', `/pulls/${live.pull}`, { title, body: description })
      : await client.send('POST', '/pulls', { title, head: made.branch, base: branchOf, body: description });

    const now = Date.now();
    if (live)
      this.sql.exec(
        `UPDATE infra_policy_changes SET policy = ?, lines = ?, base_sha = ?, commit_sha = ?, state = 'open', why = NULL,
           updated = ? WHERE n = ?`,
        JSON.stringify(checked.policy),
        JSON.stringify(diff.lines),
        head,
        made.sha,
        now,
        made.n,
      );
    else
      this.sql.exec(
        `INSERT INTO infra_policy_changes (n, repo, policy, lines, base_sha, commit_sha, branch, pull, pull_url, state,
           why, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?)`,
        made.n,
        slug,
        JSON.stringify(checked.policy),
        JSON.stringify(diff.lines),
        head,
        made.sha,
        made.branch,
        Number(pull.number),
        pull.html_url ?? null,
        now,
        now,
      );
    const mark = diff.loosens.length ? ' It loosens your policy.' : '';
    this.auditPolicyChange(slug, {
      ...pressed,
      outcome: live ? 'replaced' : 'proposed',
      summary: `${live ? 'replaced' : 'proposed'} by ${personWords(pressed.person)} as #${pull.number}: ${title}.${mark}`,
    });
    // The plan check (BRK-185) posts the lines on the pull request at the next sync: ask for it now.
    await this.githubWebhook('pull_request', live ? 'synchronize' : 'opened', { slug });
    return {
      status: live ? 200 : 201,
      body: { change: this.policyChangeOut(this.policyChangeRow(made.n)) },
    };
  },

  /**
   * POST /api/infra/policy/changes/<n>/approve: the owner's, from the signed-in board. `{ sha }` is the pull request's
   * head they saw; a change that loosens also sends `loosens`, the exact lines the board named, as the second press.
   * The board merges it at that head as the owner's action and answers `{ change }`.
   */
  infraPolicyChangeApproveApi(ref, body = {}) {
    return this.run(async () => {
      // One that loosens the policy is the owner's alone; one that only tightens it a maintainer's (BRK-301).
      this.allowOn(
        body,
        'policy.tighten',
        () => this.policyChangeRow(ref).repo,
        'only the owner approves a policy change, from the board',
      );
      const row = this.policyChangeRow(ref);
      if (JSON.parse(row.lines).some((l) => l.effect === 'loosens')) this.allow(body, 'policy.loosen', row.repo);
      if (!LIVE_STATES.includes(row.state))
        throw new AgentError(`policy change ${row.n} is ${row.state}, so there’s nothing to approve`, 409);
      if (!/^[0-9a-f]{7,64}$/iu.test(String(body.sha ?? '')))
        return refuse(400, 'send the head commit you saw as "sha"');
      this.infraPolicyApproving ??= new Set();
      if (this.infraPolicyApproving.has(Number(row.n)))
        throw new AgentError(`The board is already approving policy change ${row.n}: wait a moment`, 409);
      this.infraPolicyApproving.add(Number(row.n));
      try {
        const github = await this.changeGitHub({ repo: row.repo });
        if (!github)
          throw new AgentError('Connect GitHub on Connections first: approving merges its pull request', 409);
        return await this.approvePolicyChange(row, github, {
          sha: String(body.sha),
          loosens: body.loosens,
          pressed: this.pressedBy(body),
        });
      } catch (error) {
        if (!(error instanceof GitHubError)) throw error;
        return refuse(
          502,
          `GitHub didn’t answer for #${row.pull}: ${redact(error.reason ?? error.message)}. Nothing merged; approve again in a moment.`,
          { github: error.status },
        );
      } finally {
        this.infraPolicyApproving.delete(Number(row.n));
      }
    });
  },

  async approvePolicyChange(row, { client, repo }, { sha, loosens, pressed = { by: 'owner', person: 'owner' } }) {
    // 1. The pull request: still open, still the board's, at the head the owner saw.
    const pull = await orNull(client.get(`/pulls/${row.pull}`));
    if (!pull) {
      this.movePolicyChange(row, 'closed', {
        by: 'board',
        outcome: 'closed',
        why: 'its pull request is gone from GitHub',
        summary: `#${row.pull} is gone from GitHub; the policy stays as it was`,
      });
      return refuse(409, `#${row.pull} is gone from GitHub, so there’s nothing to approve`);
    }
    if (this.followPolicyChange(row, pull))
      return refuse(409, `#${row.pull} is ${this.policyChangeRow(row.n).state} now, so there’s nothing to approve`, {
        change: this.policyChangeOut(this.policyChangeRow(row.n)),
      });
    if (pull.head?.sha !== sha || sha !== row.commit_sha)
      return refuse(409, approvalWords.moved(row.pull), { headSha: pull.head?.sha ?? null });

    // 2. What it does now, against the default branch as it is: the lines the owner confirms are these, exactly.
    const branchOf = repo.defaultBranch || 'main';
    const base = (await client.get(`/git/ref/heads/${refPath(branchOf)}`))?.object?.sha;
    const before = base ? await this.policyAt(client, base) : { policy: DEFAULT_POLICY };
    const after = await this.policyAt(client, sha);
    if (after.text === null || !checkPolicyFile(after.text).ok)
      return refuse(409, `${POLICY_PATH} doesn’t check at #${row.pull}’s head: propose again`);
    const diff = comparePolicies(before.policy, after.policy, {
      environments: this.policyEnvironments(row.repo),
      currency: this.infraCurrency().currency,
    });
    if (JSON.stringify(diff.lines) !== row.lines)
      this.sql.exec(
        'UPDATE infra_policy_changes SET lines = ?, updated = ? WHERE n = ?',
        JSON.stringify(diff.lines),
        Date.now(),
        row.n,
      );
    const change = () => this.policyChangeOut(this.policyChangeRow(row.n));
    if (diff.loosens.length) {
      // 3. Never with a plan it would let through: the owner answers that plan on its own first.
      const passes = this.plansPolicyLetsThrough(row.repo, after.policy);
      if (passes.length)
        return refuse(
          409,
          `${passes.length === 1 ? `${passes[0].id} waits for you in ${passes[0].environment}` : `${passes.length} plans wait for you`}, and this change would let ${passes.length === 1 ? 'it' : 'them'} through without you. Approve or reject ${passes.length === 1 ? 'it' : 'them'} on ${passes.length === 1 ? 'its' : 'their'} own first, then approve the policy.`,
          { passes, change: change() },
        );
      // 4. Loosening is never one press: the second sends back exactly what will no longer wait.
      const confirmed =
        Array.isArray(loosens) && JSON.stringify(loosens.map((l) => String(l))) === JSON.stringify(diff.loosens);
      if (!confirmed)
        return refuse(409, 'This loosens your policy. Confirm what will no longer wait for you.', {
          confirm: true,
          loosens: diff.loosens,
          change: change(),
        });
    }

    // 5. Merge it as the owner's action, at that head.
    const known = this.sql
      .exec('SELECT data FROM gh_pulls WHERE repo = ? AND number = ?', row.repo, Number(row.pull))
      .toArray()[0];
    const data = known ? JSON.parse(known.data) : null;
    const route = mergeRoute({
      mergeable: pull.mergeable ?? null,
      mergeableState: pull.mergeable_state ?? null,
      checks: data?.headSha === pull.head.sha ? (data.checks?.state ?? null) : null,
    });
    if (route === 'conflicts') return refuse(409, approvalWords.conflicts(row.pull), { change: change() });
    if (route === 'failing') return refuse(409, approvalWords.failing(row.pull), { change: change() });
    if (route === 'behind')
      return refuse(409, `Can’t merge #${row.pull}: it’s behind ${branchOf}. Propose again.`, { change: change() });
    if (route === 'wait')
      return refuse(409, `Can’t merge #${row.pull} yet: its checks are still running. Approve again once they pass.`, {
        change: change(),
      });
    const { method } = await this.changeMergeSettings(client);
    try {
      await client.send('PUT', `/pulls/${row.pull}/merge`, { sha, merge_method: method });
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      return refuse(409, this.mergeRefusal(row, error), { change: change() });
    }
    this.movePolicyChange(this.policyChangeRow(row.n), 'merged', {
      ...pressed,
      outcome: 'merged',
      summary: `#${row.pull} merged on ${pressed.person === 'owner' ? 'the owner’s' : `${pressed.person}’s`} approval (${method})${diff.loosens.length ? `, confirming what no longer waits: ${diff.loosens.join(' ')}` : ''}. Plans already made keep their answer`,
    });
    // The sync reads the merged policy for the plans made after it.
    await this.githubWebhook('pull_request', null, { slug: row.repo });
    return { status: 200, body: { change: change() } };
  },

  /**
   * POST /api/infra/policy/changes/<n>/reject: the owner's, from the signed-in board. The board closes the change's
   * pull request and deletes its branch; the policy stays as it was.
   */
  infraPolicyChangeRejectApi(ref, body = {}) {
    return this.run(async () => {
      this.allowOn(
        body,
        'policy.tighten',
        () => this.policyChangeRow(ref).repo,
        'only the owner rejects a policy change, from the board',
      );
      const row = this.policyChangeRow(ref);
      if (!LIVE_STATES.includes(row.state))
        throw new AgentError(`policy change ${row.n} is ${row.state}, so there’s nothing to reject`, 409);
      const github = await this.changeGitHub({ repo: row.repo });
      if (!github) throw new AgentError('Connect GitHub on Connections first: rejecting closes its pull request', 409);
      try {
        if (row.pull) {
          const pull = await orNull(github.client.get(`/pulls/${row.pull}`));
          if (pull && this.followPolicyChange(row, pull))
            throw new AgentError(
              `#${row.pull} changed on GitHub: it’s ${this.policyChangeRow(row.n).state} now, so the board leaves it`,
              409,
            );
          if (pull) await github.client.send('PATCH', `/pulls/${row.pull}`, { state: 'closed' });
        }
        try {
          await github.client.send('DELETE', `/git/refs/heads/${refPath(row.branch)}`);
        } catch (error) {
          if (!(error instanceof GitHubError) || ![404, 422].includes(error.status)) throw error;
        }
      } catch (error) {
        if (!(error instanceof GitHubError)) throw error;
        return refuse(
          502,
          `GitHub refused to close #${row.pull}: ${redact(error.reason ?? error.message)}. Close it on GitHub, or check the App can write to ${row.repo}’s repository (Connections).`,
          { github: error.status },
        );
      }
      const pressed = this.pressedBy(body);
      this.movePolicyChange(row, 'rejected', {
        ...pressed,
        outcome: 'rejected',
        why: `rejected by ${personWords(pressed.person)}`,
        summary: `rejected by ${personWords(pressed.person)}; #${row.pull} is closed and the policy stays as it was`,
      });
      return { status: 200, body: { change: this.policyChangeOut(this.policyChangeRow(row.n)) } };
    });
  },

  /**
   * GET /api/infra/policy/view?repo=: what the Policy view shows. The policy in force (policyOut), each environment's
   * rules in words with the level each comes from, the recent plans with the rules that applied to them, the open
   * change and the last few, and each environment's envelope, read only (it's set in the repository's settings).
   */
  infraPolicyViewApi({ repo } = {}) {
    return this.run(async () => {
      const slug = this.policyRepo(repo);
      const out = this.policyOut(slug);
      const currency = this.infraCurrency().currency;
      const environments = this.policyEnvironments(slug).map((env) => ({
        ...env,
        own: Boolean(out.rules.environments?.[env.name]),
        rules: environmentRules(out.rules, env, { from: out.policy, currency }),
        envelope: this.policyEnvelopeWords(env.id),
      }));
      const plans = this.sql
        .exec(
          `SELECT p.n, p.state, p.policy, p.created, e.name AS env_name FROM infra_plans p
           LEFT JOIN infra_environments e ON e.id = p.environment WHERE p.repo = ? ORDER BY p.n DESC LIMIT ?`,
          slug,
          RECENT_PLANS,
        )
        .toArray()
        .map((p) => {
          const policy = p.policy ? JSON.parse(p.policy) : null;
          return {
            id: planId(Number(p.n)),
            environment: p.env_name ?? null,
            state: p.state,
            created: new Date(p.created).toISOString(),
            outcome: policy?.outcome ?? null,
            rule: policy?.rule ?? null,
            from: policy?.policy ?? null,
            applied: (policy?.rules ?? []).filter((r) => r.applies).map((r) => ({ rule: r.rule, reason: r.reason })),
          };
        });
      const live = this.livePolicyChangeRow(slug);
      const changes = this.sql
        .exec('SELECT * FROM infra_policy_changes WHERE repo = ? ORDER BY n DESC LIMIT ?', slug, LIST_LIMIT)
        .toArray()
        .map((r) => this.policyChangeOut(r));
      return {
        status: 200,
        body: {
          ...out,
          environments,
          plans,
          open: live ? this.policyChangeOut(live) : null,
          changes,
        },
      };
    });
  },
};
