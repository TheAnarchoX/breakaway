/**
 * TaskStore's scaling rules (docs/specs/IDEA-19-architect.md, "Envelopes"; BRK-241). During a sync, when a repository's
 * default branch has a new commit, the desired-state read (store-infra-desired.js) hands over the folder's listing, and
 * the board reads `.github/breakaway-infra/scaling.json` from it when it's there, checked with infra-scaling.js, the way
 * the policy is read (store-infra-policy.js). A repository without one acts on nothing, and costs no extra call. An
 * invalid file fails closed: the repository acts on nothing until it's fixed, and the error, with its line, shows on
 * GET /api/infra/scaling. Read only: the rules change by pull request.
 *
 * The rules hear the signals stream (BRK-190) through `signalSubscribers`. A signal a rule matches, in one of the
 * repository's environments, becomes one act through actInEnvelope (store-infra-envelopes.js), by the board: the
 * envelope's bounds, its restart cap, a freeze, and observe-only decide, never the rule, so inside them the act applies
 * with no press and outside them it's a plan that waits for the owner. A duplicate (the same rule and signal key) within
 * RUNBOOK_DEDUPE_MS does nothing at all, so a storm of signals is one act. Only the signal's environment, resource,
 * kind, level, and value are read; its text never reaches the act. Each act or refusal is kept, newest first.
 */
import { AgentError } from './store-agents.js';
import { GitHubError } from './github.js';
import { DESIRED_DIR } from './infra-desired.js';
import { RUNBOOK_DEDUPE_MS, RUNBOOK_FRESH_MS, signalKey } from './infra-runbooks.js';
import {
  checkScalingFile,
  ruleAct,
  ruleMatches,
  ruleWords,
  SCALING_FILE,
  SCALING_MAX_BYTES,
  SCALING_PATH,
} from './infra-scaling.js';
import { signalSubscribers } from './store-infra-signals.js';

/** @typedef {import('./infra-scaling.js').ScalingRule} ScalingRule */

const DAY_MS = 86_400_000;
/** The most acts and refusals a repository keeps, and shows. */
const KEPT = 200;
const SHOWN = 20;

const decode = (b64) =>
  new TextDecoder().decode(Uint8Array.from(atob(String(b64 ?? '').replace(/\s+/gu, '')), (c) => c.charCodeAt(0)));

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraScalingMethods = {
  initInfraScaling() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS infra_scaling (
        repo TEXT PRIMARY KEY, sha TEXT, read_at INTEGER NOT NULL,
        rules TEXT, valid_sha TEXT, valid_at INTEGER,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS infra_scaling_seen (
        repo TEXT NOT NULL, rule TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (repo, rule, key)
      );
      CREATE TABLE IF NOT EXISTS infra_scaling_acts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, at INTEGER NOT NULL, rule TEXT NOT NULL,
        environment INTEGER NOT NULL, signal INTEGER NOT NULL, resource TEXT NOT NULL, outcome TEXT NOT NULL,
        plan TEXT, why TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS infra_scaling_acts_by_repo ON infra_scaling_acts (repo, id);
    `);
  },

  /**
   * During a sync, from the desired-state read: `listing` is the folder's entries on the default branch at `sha` (an
   * empty list when there's no folder). No scaling.json: the repository acts on nothing, and its row goes. A GitHub
   * failure other than 403 or 404 throws, and the next sync tries again.
   */
  async readInfraScaling(client, repo, sha, listing) {
    const entry = (Array.isArray(listing) ? listing : []).find((e) => e?.type === 'file' && e.name === SCALING_FILE);
    if (!entry) {
      this.sql.exec('DELETE FROM infra_scaling WHERE repo = ?', repo.slug);
      return;
    }
    let checked;
    if (entry.size > SCALING_MAX_BYTES)
      checked = {
        ok: false,
        error: { line: null, field: null, message: `the file is over ${SCALING_MAX_BYTES / 1024} KB: trim it` },
      };
    else {
      const branch = repo.defaultBranch || 'main';
      let got = null;
      try {
        got = await client.get(`/contents/${DESIRED_DIR}/${SCALING_FILE}?ref=${encodeURIComponent(branch)}`);
      } catch (error) {
        if (!(error instanceof GitHubError && [403, 404].includes(error.status))) throw error;
      }
      if (!got || Array.isArray(got) || got.type !== 'file') {
        this.sql.exec('DELETE FROM infra_scaling WHERE repo = ?', repo.slug);
        return;
      }
      checked = checkScalingFile(decode(got.content));
    }
    const now = Date.now();
    if (checked.ok)
      this.sql.exec(
        `INSERT INTO infra_scaling (repo, sha, read_at, rules, valid_sha, valid_at, error) VALUES (?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (repo) DO UPDATE SET sha = excluded.sha, read_at = excluded.read_at, rules = excluded.rules,
           valid_sha = excluded.valid_sha, valid_at = excluded.valid_at, error = NULL`,
        repo.slug,
        sha ?? null,
        now,
        JSON.stringify(checked.rules),
        sha ?? null,
        now,
      );
    // An invalid file drops what the last one said: nothing acts until the file checks again.
    else
      this.sql.exec(
        `INSERT INTO infra_scaling (repo, sha, read_at, error) VALUES (?, ?, ?, ?)
         ON CONFLICT (repo) DO UPDATE SET sha = excluded.sha, read_at = excluded.read_at, rules = NULL,
           valid_sha = NULL, valid_at = NULL, error = excluded.error`,
        repo.slug,
        sha ?? null,
        now,
        JSON.stringify(checked.error),
      );
  },

  /**
   * A repository's rules: none when it has no file or its file doesn't check.
   * @returns {ScalingRule[]}
   */
  infraScalingFor(repo) {
    const row = this.sql.exec('SELECT rules FROM infra_scaling WHERE repo = ?', repo).toArray()[0];
    return row?.rules ? JSON.parse(row.rules) : [];
  },

  /** Keeps one act or refusal, and drops the oldest past KEPT. */
  keepScalingAct(repo, { rule, environment, signal, resource, outcome, plan = null, why }, now) {
    this.sql.exec(
      'INSERT INTO infra_scaling_acts (repo, at, rule, environment, signal, resource, outcome, plan, why) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      repo,
      now,
      rule,
      environment,
      signal,
      resource,
      outcome,
      plan,
      why,
    );
    this.sql.exec(
      'DELETE FROM infra_scaling_acts WHERE repo = ? AND id NOT IN (SELECT id FROM infra_scaling_acts WHERE repo = ? ORDER BY id DESC LIMIT ?)',
      repo,
      repo,
      KEPT,
    );
  },

  /**
   * The signals stream's subscriber: offers each new signal about a resource to the rules of the repository its
   * environment belongs to. A match becomes one act through the environment's envelope, once per rule and signal key
   * within RUNBOOK_DEDUPE_MS; a refusal is kept and never stops the next signal or rule.
   * @param {import('./store-infra-signals.js').StoredSignal[]} signals oldest first
   */
  async scalingSignals(signals, now = Date.now()) {
    const repos = this.sql.exec('SELECT repo, rules FROM infra_scaling WHERE rules IS NOT NULL').toArray();
    const acted = [];
    if (!repos.length) return { acted };
    const rulesOf = new Map(repos.map((r) => [r.repo, /** @type {ScalingRule[]} */ (JSON.parse(r.rules))]));
    for (const signal of signals) {
      if (!signal.resource || now - Date.parse(signal.at) > RUNBOOK_FRESH_MS) continue;
      const env = signal.environmentId
        ? this.sql.exec('SELECT * FROM infra_environments WHERE id = ?', signal.environmentId).toArray()[0]
        : null;
      const rules = env ? rulesOf.get(env.repo) : null;
      if (!rules?.length) continue;
      const found = this.sql
        .exec(
          'SELECT kind, name, attrs FROM infra_inventory WHERE environment = ? AND rid = ?',
          env.id,
          signal.resource,
        )
        .toArray()[0];
      const resource = { id: signal.resource, name: found?.name ?? null, kind: found?.kind ?? null };
      const key = signalKey(signal);
      for (const rule of rules) {
        if (!ruleMatches(rule, { ...signal, environment: env.name }, resource)) continue;
        const seen = this.sql
          .exec('SELECT at FROM infra_scaling_seen WHERE repo = ? AND rule = ? AND key = ?', env.repo, rule.name, key)
          .toArray()[0];
        if (seen && now - seen.at < RUNBOOK_DEDUPE_MS) continue; // a duplicate
        this.sql.exec(
          'INSERT OR REPLACE INTO infra_scaling_seen (repo, rule, key, at) VALUES (?, ?, ?, ?)',
          env.repo,
          rule.name,
          key,
          now,
        );
        const kept = { rule: rule.name, environment: env.id, signal: signal.id, resource: signal.resource };
        const scales =
          found && rule.act === 'scale' ? this.infraProviderFor(env.provider)?.kinds[found.kind]?.scales : null;
        const current = scales ? JSON.parse(found.attrs ?? '{}')[scales] : null;
        const asked = ruleAct(rule, current ?? null);
        if ('unknown' in asked) {
          this.keepScalingAct(env.repo, { ...kept, outcome: 'refused', why: asked.unknown }, now);
          continue;
        }
        try {
          const act = await this.actInEnvelope(env.id, {
            repo: env.repo,
            resource: signal.resource,
            ...asked,
            by: 'board',
            rule: rule.name,
          });
          this.keepScalingAct(
            env.repo,
            { ...kept, outcome: act.inside ? 'inside' : 'outside', plan: act.plan.id, why: act.why },
            now,
          );
          acted.push({ rule: rule.name, signal: signal.id, inside: act.inside, plan: act.plan.id });
        } catch (error) {
          // A refusal is kept and never stops the next rule or signal; anything else is the provider's or a bug.
          const why = error instanceof AgentError ? error.message : `the act failed: ${error?.message ?? error}`;
          this.keepScalingAct(env.repo, { ...kept, outcome: 'refused', why }, now);
        }
      }
    }
    this.sql.exec('DELETE FROM infra_scaling_seen WHERE at < ?', now - 30 * DAY_MS);
    return { acted };
  },

  /** One repository's scaling rules as the API shows them, with their last acts. */
  scalingOut(repo) {
    const row = this.sql.exec('SELECT * FROM infra_scaling WHERE repo = ?', repo).toArray()[0];
    const rules = this.infraScalingFor(repo);
    const names = new Map(
      this.sql
        .exec('SELECT id, name FROM infra_environments WHERE repo = ?', repo)
        .toArray()
        .map((e) => [Number(e.id), e.name]),
    );
    const acts = this.sql
      .exec('SELECT * FROM infra_scaling_acts WHERE repo = ? ORDER BY id DESC LIMIT ?', repo, SHOWN)
      .toArray()
      .map((a) => ({
        at: new Date(Number(a.at)).toISOString(),
        rule: a.rule,
        environment: names.get(Number(a.environment)) ?? null,
        environmentId: Number(a.environment),
        signal: Number(a.signal),
        resource: a.resource,
        outcome: a.outcome,
        plan: a.plan ?? null,
        why: a.why,
      }));
    return {
      repo,
      path: SCALING_PATH,
      state: row?.error ? 'invalid' : row ? 'valid' : 'none',
      error: row?.error ? JSON.parse(row.error) : null,
      rules: rules.map((r) => ({ ...r, words: ruleWords(r) })),
      sha: row?.sha ?? null,
      readAt: row ? new Date(Number(row.read_at)).toISOString() : null,
      acts,
    };
  },

  /**
   * GET /api/infra/scaling[?repo=]: each repository's scaling rules. `state` is `valid`, `invalid` (with `error`, its
   * line and field, and no rules: nothing acts), or `none`; `acts` are the last acts and refusals, newest first.
   */
  scalingApi({ repo } = {}) {
    return this.run(async () => {
      const slug = repo ? String(repo).trim().toLowerCase() : null;
      const repos = slug ? [slug] : this.repos().map((r) => r.slug);
      return { status: 200, body: { scaling: repos.map((r) => this.scalingOut(r)) } };
    });
  },
};

// Scaling rules hear every batch the stream stores.
signalSubscribers.subscribe('scaling', (store, signals) => store.scalingSignals(signals));
