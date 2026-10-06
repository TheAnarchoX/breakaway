/**
 * TaskStore's policy (docs/specs/IDEA-19-architect.md, "Policy"; BRK-181). During a sync, when a repository's default
 * branch has a new commit, the desired-state read (store-infra-desired.js) hands over the folder's listing, and the
 * board reads `.github/breakaway-infra/policy.json` from it when it's there, checked with infra-policy.js. A repository
 * without one has the default policy, and costs no extra call. An invalid file fails closed: the repository has the
 * default until it's fixed, so a typo in a tightened rule never leaves a looser one in force, and the error shows on the
 * policy and on every plan it decides. Read only: the policy changes by pull request.
 *
 * Every plan is checked against its repository's policy when it's made (store-infra-plans.js), and the result is kept
 * on the plan.
 */
import {
  checkPolicyFile,
  DEFAULT_POLICY,
  evaluatePolicy,
  POLICY_FILE,
  POLICY_MAX_BYTES,
  POLICY_PATH,
} from './infra-policy.js';
import { DESIRED_DIR } from './infra-desired.js';
import { GitHubError } from './github.js';

/** @typedef {import('./infra-policy.js').Policy} Policy */

const decode = (b64) =>
  new TextDecoder().decode(Uint8Array.from(atob(String(b64 ?? '').replace(/\s+/gu, '')), (c) => c.charCodeAt(0)));

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraPolicyMethods = {
  initInfraPolicy() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS infra_policy (
        repo TEXT PRIMARY KEY, sha TEXT, read_at INTEGER NOT NULL,
        policy TEXT, valid_sha TEXT, valid_at INTEGER,
        error TEXT
      );
    `);
  },

  /**
   * During a sync, from the desired-state read: `listing` is the folder's entries on the default branch at `sha` (an
   * empty list when there's no folder). No policy.json: the repository has the default, and its row goes. A GitHub
   * failure other than 403 or 404 throws, and the next sync tries again.
   */
  async readInfraPolicy(client, repo, sha, listing) {
    const entry = (Array.isArray(listing) ? listing : []).find((e) => e?.type === 'file' && e.name === POLICY_FILE);
    if (!entry) {
      this.sql.exec('DELETE FROM infra_policy WHERE repo = ?', repo.slug);
      return;
    }
    let checked;
    if (entry.size > POLICY_MAX_BYTES)
      checked = {
        ok: false,
        error: { line: null, field: null, message: `the file is over ${POLICY_MAX_BYTES / 1024} KB: trim it` },
      };
    else {
      const branch = repo.defaultBranch || 'main';
      let got = null;
      try {
        got = await client.get(`/contents/${DESIRED_DIR}/${POLICY_FILE}?ref=${encodeURIComponent(branch)}`);
      } catch (error) {
        if (!(error instanceof GitHubError && [403, 404].includes(error.status))) throw error;
      }
      if (!got || Array.isArray(got) || got.type !== 'file') {
        this.sql.exec('DELETE FROM infra_policy WHERE repo = ?', repo.slug);
        return;
      }
      checked = checkPolicyFile(decode(got.content));
    }
    const now = Date.now();
    if (checked.ok)
      this.sql.exec(
        `INSERT INTO infra_policy (repo, sha, read_at, policy, valid_sha, valid_at, error) VALUES (?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (repo) DO UPDATE SET sha = excluded.sha, read_at = excluded.read_at, policy = excluded.policy,
           valid_sha = excluded.valid_sha, valid_at = excluded.valid_at, error = NULL`,
        repo.slug,
        sha ?? null,
        now,
        JSON.stringify(checked.policy),
        sha ?? null,
        now,
      );
    // An invalid file drops what the last one said: the default decides until the file checks again.
    else
      this.sql.exec(
        `INSERT INTO infra_policy (repo, sha, read_at, error) VALUES (?, ?, ?, ?)
         ON CONFLICT (repo) DO UPDATE SET sha = excluded.sha, read_at = excluded.read_at, policy = NULL,
           valid_sha = NULL, valid_at = NULL, error = excluded.error`,
        repo.slug,
        sha ?? null,
        now,
        JSON.stringify(checked.error),
      );
  },

  /**
   * The policy a repository's plans are checked against: its file, or the default when it has none or it doesn't
   * check, with the file's error.
   * @returns {{ policy: Policy, from: 'default' | 'repository', sha: string | null, error: import('./infra-policy.js').PolicyError | null }}
   */
  infraPolicyFor(repo) {
    const row = this.sql.exec('SELECT * FROM infra_policy WHERE repo = ?', repo).toArray()[0];
    if (row?.policy)
      return { policy: JSON.parse(row.policy), from: 'repository', sha: row.valid_sha ?? null, error: null };
    return {
      policy: DEFAULT_POLICY,
      from: 'default',
      sha: row?.sha ?? null,
      error: row?.error ? JSON.parse(row.error) : null,
    };
  },

  /**
   * A plan checked against its repository's policy, for an environment row as it is now.
   * @param {Record<string, any>} env the environment's row
   * @param {{ diff: import('./infra-provider.js').PlanDiff, cost: import('./infra-plans.js').CostChange, provider?: any }} plan
   */
  checkInfraPolicy(env, { diff, cost, provider = null }) {
    const { policy, from, sha, error } = this.infraPolicyFor(env.repo);
    const view = this.environmentOut(env);
    return evaluatePolicy(
      policy,
      {
        environment: { name: env.name, kind: env.kind, frozen: view.frozen, gates: view.gates },
        diff,
        cost,
        provider,
        currency: this.infraCurrency().currency,
      },
      { policy: from, sha, error },
    );
  },

  /** One repository's policy as the API shows it. */
  policyOut(repo) {
    const row = this.sql.exec('SELECT * FROM infra_policy WHERE repo = ?', repo).toArray()[0];
    const { policy, from, error } = this.infraPolicyFor(repo);
    return {
      repo,
      path: POLICY_PATH,
      policy: from,
      state: error ? 'invalid' : row ? 'valid' : 'none',
      error,
      rules: policy,
      currency: this.currencyOut(),
      sha: row?.sha ?? null,
      readAt: row ? new Date(row.read_at).toISOString() : null,
    };
  },

  /**
   * GET /api/infra/policy[?repo=]: each repository's policy. `policy` says which decides (`repository`, or `default`
   * when it has no file or its file has an error); `state` is `valid`, `invalid` (with `error`), or `none`.
   */
  policyApi({ repo } = {}) {
    return this.run(async () => {
      const slug = repo ? String(repo).trim().toLowerCase() : null;
      const repos = slug ? [slug] : this.repos().map((r) => r.slug);
      return { status: 200, body: { policies: repos.map((r) => this.policyOut(r)) } };
    });
  },
};
