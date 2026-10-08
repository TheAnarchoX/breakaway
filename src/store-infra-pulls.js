/**
 * TaskStore's plans from pull requests (docs/specs/IDEA-19-architect.md, "Change"; BRK-185). During a sync, each open
 * pull request whose head moved is looked at once: when it changes a desired-state or policy file, the board reads
 * those files at its head, makes the plan each changed environment would make with the same computation as `npx
 * breakaway infra check` (previewInfraPlan), checks it against the policy at the head, and posts the result as one
 * check on the head commit. The board's pull request page shows the same, from what's kept here.
 *
 * A pull request's plan is a preview: it has no ID, no state, and no audit entry, so it can't wait for the owner, be
 * approved, or be applied. Merging applies nothing: the plan the board makes from the default branch does that, once
 * the owner approves it. Only repositories with an environment the board may plan for are looked at, so a repository
 * without Architect costs no call.
 */
import { GitHubError } from './github.js';
import { install } from './install.js';
import { checkDesiredFile, DESIRED_DIR, DESIRED_MAX_BYTES, desiredPath } from './infra-desired.js';
import { checkPolicyFile, DEFAULT_POLICY, POLICY_PATH } from './infra-policy.js';
import { comparePolicies } from './infra-policy-changes.js';
import { runsTheBoard } from './infra-environments.js';
import { redact } from './redact.js';
import { RUNNER_WORKFLOW } from './infra-runner.js';
import { runnerNote } from './infra-runner-render.js';
import {
  INFRA_CHECK_NAME,
  infraConclusion,
  infraFilesIn,
  infraSummary,
  infraTitle,
  MAX_ENVIRONMENTS_PER_PULL,
  MAX_PULLS_PER_SYNC,
} from './infra-pulls.js';

/** A pull request's files are read up to this many pages of 100. */
const FILE_PAGES = 3;
/** A closed pull request's last check is kept this long, for its page. */
const KEEP_CLOSED_MS = 30 * 24 * 60 * 60_000;

const decode = (b64) =>
  new TextDecoder().decode(Uint8Array.from(atob(String(b64 ?? '').replace(/\s+/gu, '')), (c) => c.charCodeAt(0)));

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
export const infraPullsMethods = {
  initInfraPulls() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS infra_pulls (
        repo TEXT NOT NULL, number INTEGER NOT NULL, sha TEXT NOT NULL, checked_at INTEGER NOT NULL,
        touched INTEGER NOT NULL, conclusion TEXT, title TEXT, result TEXT,
        check_id INTEGER, check_url TEXT, error TEXT,
        PRIMARY KEY (repo, number)
      );
    `);
  },

  /** The environments of a repository the board may plan for: not observe only, and not the board's own install. */
  plannableEnvironments(slug) {
    const worker = install(this.env).worker;
    return this.sql
      .exec('SELECT * FROM infra_environments WHERE repo = ? ORDER BY name', slug)
      .toArray()
      .filter((env) => !env.observe_only && !runsTheBoard(env, worker));
  },

  /**
   * During a sync: check the open pull requests whose head moved since they were last looked at, up to
   * MAX_PULLS_PER_SYNC (the rest wait for the next sync). A GitHub failure other than a missing file or a refused
   * check throws, and the next sync tries that pull request again.
   * @param {any} client the repository's GitHub client
   * @param {{ slug: string }} repo
   * @param {any[]} pulls GitHub's list, newest update first
   */
  async checkInfraPulls(client, repo, pulls) {
    const open = (pulls ?? []).filter((p) => p.state === 'open' && p.head?.sha);
    const now = Date.now();
    this.sql.exec(
      `DELETE FROM infra_pulls WHERE repo = ? AND checked_at < ? AND number NOT IN (SELECT value FROM json_each(?))`,
      repo.slug,
      now - KEEP_CLOSED_MS,
      JSON.stringify(open.map((p) => p.number)),
    );
    if (!this.plannableEnvironments(repo.slug).length) return;
    const seen = new Map(
      this.sql
        .exec('SELECT number, sha FROM infra_pulls WHERE repo = ?', repo.slug)
        .toArray()
        .map((r) => [Number(r.number), r.sha]),
    );
    const due = open.filter((p) => seen.get(p.number) !== p.head.sha).slice(0, MAX_PULLS_PER_SYNC);
    for (const pull of due) await this.checkInfraPull(client, repo, pull);
  },

  /** One pull request at its head: what it changes in the folder, the plans, and the check. */
  async checkInfraPull(client, repo, pull) {
    const sha = pull.head.sha;
    const files = [];
    for (let page = 1; page <= FILE_PAGES; page += 1) {
      // A pull request GitHub won't list the files of (gone since the list was read) has nothing to plan.
      const batch = (await orNull(client.get(`/pulls/${pull.number}/files?per_page=100&page=${page}`))) ?? [];
      files.push(...batch);
      if (batch.length < 100) break;
    }
    const changed = infraFilesIn(files);
    if (!changed.touched) {
      this.keepInfraPull(repo.slug, pull.number, sha, { touched: false });
      return;
    }

    const ref = `?ref=${encodeURIComponent(sha)}`;
    const read = async (path) => {
      const got = await orNull(client.get(`/contents/${path.split('/').map(encodeURIComponent).join('/')}${ref}`));
      if (!got || Array.isArray(got) || got.type !== 'file') return null;
      if (Number(got.size ?? 0) > DESIRED_MAX_BYTES) return { tooBig: true };
      return { text: decode(got.content) };
    };

    // The policy at the head decides, as it would once merged; one that doesn't check fails closed to the default.
    const policyText = await read(POLICY_PATH);
    const policyFile = !policyText
      ? null
      : policyText.tooBig
        ? {
            ok: false,
            error: { line: null, field: null, message: `the file is over ${DESIRED_MAX_BYTES / 1024} KB: trim it` },
          }
        : checkPolicyFile(policyText.text);
    const policyOf =
      policyFile && 'policy' in policyFile
        ? { policy: policyFile.policy, from: /** @type {const} */ ('repository'), sha }
        : { sha: null, error: policyFile && 'error' in policyFile ? policyFile.error : null };

    // Each changed environment's file; a policy change reaches every environment with a desired state.
    const wanted = new Map(changed.environments.map((e) => [e.environment, e]));
    if (changed.policy)
      for (const env of this.plannableEnvironments(repo.slug))
        if (!wanted.has(env.name) && this.desiredStateFor(env))
          wanted.set(env.name, { environment: env.name, path: desiredPath(env.name), removed: false });
    const list = [...wanted.values()];
    const planned = list.slice(0, MAX_ENVIRONMENTS_PER_PULL);

    /** @type {import('./infra-pulls.js').EnvironmentCheck[]} */
    const environments = [];
    for (const want of planned)
      environments.push(await this.checkInfraPullEnvironment(repo, want, read, policyOf, pull.number));

    // What a policy change loosens and tightens, in words (WEB-123): the policy at the base against the one at the head.
    let policyLines = null;
    if (changed.policy && policyFile && 'policy' in policyFile) {
      const base = pull.base?.sha
        ? await orNull(
            client.get(
              `/contents/${POLICY_PATH.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(pull.base.sha)}`,
            ),
          )
        : null;
      const was = base && !Array.isArray(base) && base.type === 'file' ? checkPolicyFile(decode(base.content)) : null;
      policyLines = comparePolicies(was && 'policy' in was ? was.policy : DEFAULT_POLICY, policyFile.policy, {
        environments: this.plannableEnvironments(repo.slug).map((e) => ({ name: e.name, kind: e.kind ?? null })),
        currency: this.infraCurrency().currency,
      }).lines;
    }
    const check = {
      environments,
      policy: changed.policy
        ? {
            path: POLICY_PATH,
            ok: !policyFile || 'policy' in policyFile,
            error: policyFile && 'error' in policyFile ? policyFile.error : null,
            lines: policyLines,
          }
        : null,
      problems: changed.problems,
      skipped: list.length - planned.length,
      runner: await this.pullRunnerNote(repo, pull, files, environments, read),
    };
    // A fork's pull request gets a check without the plan's detail (BRK-253): the check is public, the board isn't.
    const named = (side) => String(side?.repo?.full_name ?? '').toLowerCase();
    const outside = !named(pull.head) || named(pull.head) !== named(pull.base);
    const conclusion = infraConclusion(check);
    const title = infraTitle(check);
    const home = this.homeUrl();
    const page = home ? `${home}/#/github?pr=${repo.slug}:${pull.number}` : null;

    let posted = null;
    let error = null;
    try {
      const run = await client.send('POST', '/check-runs', {
        name: INFRA_CHECK_NAME,
        head_sha: sha,
        status: 'completed',
        conclusion,
        completed_at: new Date().toISOString(),
        ...(page ? { details_url: page } : {}),
        output: { title, summary: infraSummary(check, { page, outside }) },
      });
      posted = { id: run?.id ?? null, url: run?.html_url ?? null };
    } catch (e) {
      // Without the App's Checks write permission the board still shows the plan on its own page.
      if (!(e instanceof GitHubError) || e.status !== 403) throw e;
      error =
        'GitHub refused the check: give the GitHub App the Checks permission (read and write) and accept it on GitHub';
    }
    this.keepInfraPull(repo.slug, pull.number, sha, {
      touched: true,
      conclusion,
      title,
      result: check,
      check: posted,
      error,
    });
  },

  /**
   * What the plan check says about the apply workflow (BRK-307): nothing when no environment is planned or the pull
   * request brings the workflow itself; the board's own change's note, kept when it proposed it; else the workflow at
   * the head, read once, against the environments planned.
   * @returns {Promise<string | null>}
   */
  async pullRunnerNote(repo, pull, files, environments, read) {
    const names = environments.filter((e) => e.state === 'planned').map((e) => e.environment);
    if (!names.length || files.some((f) => f.filename === RUNNER_WORKFLOW)) return null;
    const change = this.sql
      .exec(
        'SELECT runner FROM infra_changes WHERE repo = ? AND pull = ? AND runner IS NOT NULL ORDER BY n DESC LIMIT 1',
        repo.slug,
        Number(pull.number),
      )
      .toArray()[0];
    if (change) return JSON.parse(String(change.runner)).note ?? null;
    const there = await read(RUNNER_WORKFLOW);
    if (there?.tooBig) return null;
    return runnerNote(there ? there.text : null, names);
  },

  /**
   * One environment's part of a pull request's check, from its file at the head. An environment with no target is
   * planned with the one the board's change for this pull request gives it, else the one Worker its file makes
   * (BRK-298), as the console's preview and Approve plan it; `target` names it then.
   * @returns {Promise<import('./infra-pulls.js').EnvironmentCheck>}
   */
  async checkInfraPullEnvironment(repo, want, read, policyOf, number = null) {
    const env = this.sql
      .exec('SELECT * FROM infra_environments WHERE repo = ? AND name = ?', repo.slug, want.environment)
      .toArray()[0];
    const base = {
      environment: want.environment,
      environmentId: env ? Number(env.id) : null,
      path: want.path,
      problem: null,
      error: null,
      preview: null,
      target: null,
    };
    if (env && (env.observe_only || runsTheBoard(env, install(this.env).worker)))
      return {
        ...base,
        state: 'refused',
        problem: `${env.name} is observe only: Architect watches it and never applies to it, so it takes no desired state.`,
      };
    if (want.removed)
      return {
        ...base,
        state: 'removed',
        problem: `The pull request removes \`${want.path}\`: once it’s merged, the board stops comparing ${want.environment} with a desired state, and changes nothing there.`,
      };
    const file = await read(want.path);
    if (!file)
      return {
        ...base,
        state: 'removed',
        problem: `\`${want.path}\` isn’t at the pull request’s head: the board changes nothing in ${want.environment}.`,
      };
    if (file.tooBig)
      return {
        ...base,
        state: 'invalid',
        error: {
          line: null,
          field: null,
          message: `the file is over ${DESIRED_MAX_BYTES / 1024} KB: split it, or trim it`,
        },
      };
    const provider = env ? this.infraProviderFor(env.provider) : null;
    const checked = checkDesiredFile(file.text, { provider, expectProvider: env?.provider ?? null });
    if ('error' in checked) return { ...base, state: 'invalid', error: checked.error };
    if (!env)
      return {
        ...base,
        state: 'to-add',
        problem: `${repo.slug} has no environment called ${want.environment}: add it on the board, or rename the file. Nothing is planned until then.`,
      };
    const change = env.target
      ? null
      : this.sql
          .exec(
            'SELECT target FROM infra_changes WHERE environment = ? AND pull = ? AND target IS NOT NULL ORDER BY n DESC LIMIT 1',
            Number(env.id),
            Number(number),
          )
          .toArray()[0];
    const at = this.infraPlanTarget(env, checked.desired, change?.target ?? null);
    if (at.problem) return { ...base, state: 'failed', problem: at.problem };
    const target = at.target
      ? change
        ? { name: at.target, from: /** @type {const} */ ('change') }
        : { name: at.target, from: /** @type {const} */ ('desired'), label: at.label }
      : null;
    try {
      const preview = await this.previewInfraPlan(at.env, checked.desired, policyOf);
      return { ...base, state: 'planned', preview, target };
    } catch (error) {
      return { ...base, state: 'failed', problem: redact(String(error?.message ?? error)) };
    }
  },

  /** Keeps what the board found on a pull request at a commit, replacing what it found before. */
  keepInfraPull(
    slug,
    number,
    sha,
    { touched, conclusion = null, title = null, result = null, check = null, error = null },
  ) {
    this.sql.exec(
      `INSERT INTO infra_pulls (repo, number, sha, checked_at, touched, conclusion, title, result, check_id, check_url, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo, number) DO UPDATE SET sha = excluded.sha, checked_at = excluded.checked_at,
         touched = excluded.touched, conclusion = excluded.conclusion, title = excluded.title, result = excluded.result,
         check_id = excluded.check_id, check_url = excluded.check_url, error = excluded.error`,
      slug,
      number,
      sha,
      Date.now(),
      touched ? 1 : 0,
      conclusion,
      title,
      result ? JSON.stringify(result) : null,
      check?.id ?? null,
      check?.url ?? null,
      error,
    );
  },

  /**
   * A pull request's infrastructure check as its page shows it, or null when the board hasn't seen it change a
   * desired-state or policy file. `sha` is the commit it's of: the page says so when the branch has moved since.
   */
  infraPullOut(slug, number) {
    const row = this.sql
      .exec('SELECT * FROM infra_pulls WHERE repo = ? AND number = ? AND touched = 1', slug, Number(number))
      .toArray()[0];
    if (!row) return null;
    return {
      name: INFRA_CHECK_NAME,
      sha: row.sha,
      checkedAt: new Date(row.checked_at).toISOString(),
      conclusion: row.conclusion,
      title: row.title,
      ...JSON.parse(row.result ?? '{}'),
      check: row.check_id ? { id: row.check_id, url: row.check_url } : null,
      error: row.error ?? null,
      folder: DESIRED_DIR,
    };
  },
};
