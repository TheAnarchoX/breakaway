/**
 * TaskStore's desired state (docs/specs/IDEA-19-architect.md, "Desired state"; BRK-180). During a sync, the board
 * reads each repository's `.github/breakaway-infra/<environment>.json` from its default branch, once per new commit
 * there, the way the pipeline file is read (store-pipeline.js), and checks each with infra-desired.js. It keeps the
 * last valid copy of each file and the error of the last read, so an invalid file shows what's wrong while the
 * environment keeps what it had. A file for an environment that doesn't exist shows as one to add; one for an
 * observe-only environment (the board's own install, BRK-169) is refused, and never handed to a plan. Read only:
 * the desired state changes by pull request, never through the board.
 */
import { GitHubError } from './github.js';
import {
  checkDesiredFile,
  DESIRED_DIR,
  DESIRED_MAX_BYTES,
  DESIRED_MAX_FILES,
  environmentOfFile,
} from './infra-desired.js';
import { AgentError } from './store-agents.js';
import { environmentView } from './infra-environments.js';
import { install } from './install.js';

/** The commit and branch the last read was of, per repository. */
const READ = 'infra_desired_read';
const decode = (b64) =>
  new TextDecoder().decode(Uint8Array.from(atob(String(b64 ?? '').replace(/\s+/gu, '')), (c) => c.charCodeAt(0)));

/** A read GitHub answers 404 (not there) or 403 (not readable) to is nothing found, not a failure. */
async function orNull(promise) {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof GitHubError && [403, 404].includes(error.status)) return null;
    throw error;
  }
}

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraDesiredMethods = {
  initInfraDesired() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS infra_desired (
        repo TEXT NOT NULL, file TEXT NOT NULL, environment TEXT, provider TEXT,
        sha TEXT, read_at INTEGER NOT NULL,
        desired TEXT, valid_sha TEXT, valid_at INTEGER,
        error TEXT,
        PRIMARY KEY (repo, file)
      );
    `);
    // 1 when the file first appeared on a read after the repository had been read before: merged since the board was
    // watching, not there from the start. Drift's first comparison of it is a merged change (BRK-246).
    const have = new Set(
      this.sql
        .exec('PRAGMA table_info(infra_desired)')
        .toArray()
        .map((c) => c.name),
    );
    if (!have.has('added')) this.sql.exec('ALTER TABLE infra_desired ADD COLUMN added INTEGER NOT NULL DEFAULT 0');
  },

  /** The registered provider an environment names, else null. */
  infraProviderFor(id) {
    const registry = this.infraRegistry();
    return id && registry.has(id) ? registry.get(id) : null;
  },

  /**
   * During a sync: read the repository's desired-state files again when its default branch has a new commit (`sha`).
   * A GitHub failure other than 403 or 404 throws, and the next sync tries again.
   */
  async readDesiredStates(client, repo, sha) {
    const branch = repo.defaultBranch || 'main';
    const kept = JSON.parse(this.ghMeta(READ, repo.slug) ?? 'null');
    if (sha && kept && kept.sha === sha && kept.branch === branch) return;
    const ref = `?ref=${encodeURIComponent(branch)}`;
    const list = await orNull(client.get(`/contents/${DESIRED_DIR}${ref}`));
    // The policy (BRK-181) is in the same folder: read from this listing, so a repository without one costs no call.
    await this.readInfraPolicy(client, repo, sha, Array.isArray(list) ? list : []);
    await this.readInfraScaling(client, repo, sha, Array.isArray(list) ? list : []);
    await this.readShortLivedTemplate(client, repo, sha, Array.isArray(list) ? list : []);
    // So is the list of risky paths (BRK-280).
    await this.readRiskyPaths(client, repo, sha, Array.isArray(list) ? list : []);
    const files = (Array.isArray(list) ? list : [])
      .filter((e) => e?.type === 'file' && environmentOfFile(e.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, DESIRED_MAX_FILES);
    const read = [];
    for (const entry of files) {
      const of = environmentOfFile(entry.name);
      if ('problem' in of) {
        read.push({ file: entry.name, environment: null, error: { line: null, field: null, message: of.problem } });
        continue;
      }
      if (entry.size > DESIRED_MAX_BYTES) {
        read.push({
          file: entry.name,
          environment: of.environment,
          error: {
            line: null,
            field: null,
            message: `the file is over ${DESIRED_MAX_BYTES / 1024} KB: split it, or trim it`,
          },
        });
        continue;
      }
      const got = await orNull(client.get(`/contents/${DESIRED_DIR}/${encodeURIComponent(entry.name)}${ref}`));
      if (!got || Array.isArray(got) || got.type !== 'file') continue;
      const row = this.sql
        .exec('SELECT * FROM infra_environments WHERE repo = ? AND name = ?', repo.slug, of.environment)
        .toArray()[0];
      const checked = checkDesiredFile(decode(got.content), {
        provider: this.infraProviderFor(row?.provider),
        expectProvider: row?.provider ?? null,
      });
      read.push({ file: entry.name, environment: of.environment, ...checked });
    }
    const now = Date.now();
    // A file the board finds on its first read of the repository was there from the start; one found later was added.
    const added = kept ? 1 : 0;
    this.ctx.storage.transactionSync(() => {
      const names = read.map((r) => r.file);
      for (const old of this.sql.exec('SELECT file FROM infra_desired WHERE repo = ?', repo.slug).toArray())
        if (!names.includes(old.file))
          this.sql.exec('DELETE FROM infra_desired WHERE repo = ? AND file = ?', repo.slug, old.file);
      for (const r of read) {
        if (r.ok)
          this.sql.exec(
            `INSERT INTO infra_desired (repo, file, environment, provider, sha, read_at, desired, valid_sha, valid_at, error, added)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
             ON CONFLICT (repo, file) DO UPDATE SET environment = excluded.environment, provider = excluded.provider,
               sha = excluded.sha, read_at = excluded.read_at, desired = excluded.desired, valid_sha = excluded.valid_sha,
               valid_at = excluded.valid_at, error = NULL`,
            repo.slug,
            r.file,
            r.environment,
            r.provider,
            sha ?? null,
            now,
            JSON.stringify(r.desired),
            sha ?? null,
            now,
            added,
          );
        // An invalid file keeps the last valid copy, its provider, and when it was valid.
        else
          this.sql.exec(
            `INSERT INTO infra_desired (repo, file, environment, sha, read_at, error, added) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (repo, file) DO UPDATE SET environment = excluded.environment, sha = excluded.sha,
               read_at = excluded.read_at, error = excluded.error`,
            repo.slug,
            r.file,
            r.environment,
            sha ?? null,
            now,
            JSON.stringify(r.error),
            added,
          );
      }
    });
    this.setGhMeta(READ, repo.slug, JSON.stringify({ sha: sha ?? null, branch }));
  },

  /**
   * One file's desired state as the API shows it, checked against the environment it's for as it is now:
   * - `valid`: the file checks, and the environment exists and can be applied to;
   * - `invalid`: the last read has an error (`error`); `desired` is the last valid copy, if there was one;
   * - `to-add`: no environment has the file's name in its repository: add it on the board, or rename the file;
   * - `refused`: the environment is observe only, so it takes no desired state, and `desired` is null.
   */
  desiredOut(row) {
    const env = row.environment
      ? this.sql
          .exec('SELECT * FROM infra_environments WHERE repo = ? AND name = ?', row.repo, row.environment)
          .toArray()[0]
      : null;
    // The plain view, not environmentOut: that reads the desired state too (BRK-309).
    const view = env ? environmentView(env, { worker: install(this.env).worker }) : null;
    let error = row.error ? JSON.parse(row.error) : null;
    if (!error && view?.provider && row.provider && row.provider !== view.provider)
      error = {
        line: null,
        field: 'provider',
        message: `provider is ${row.provider}, and the environment runs on ${view.provider}: change one so they match`,
      };
    let state = error ? 'invalid' : 'valid';
    let problem = null;
    if (row.environment && !view) {
      state = 'to-add';
      problem = `${row.repo} has no environment called ${row.environment}: add it on the board, or rename the file`;
    } else if (view?.observeOnly) {
      state = 'refused';
      problem = view.runsTheBoard
        ? `${view.name} runs this board, so it’s observe only: Architect never applies to it, and it takes no desired state`
        : `${view.name} is observe only: Architect watches it and never applies to it, so it takes no desired state`;
    }
    return {
      repo: row.repo,
      environment: row.environment ?? null,
      environmentId: view?.id ?? null,
      path: `${DESIRED_DIR}/${row.file}`,
      state,
      problem,
      error,
      provider: row.provider ?? null,
      desired: state === 'refused' || !row.desired ? null : JSON.parse(row.desired),
      sha: row.sha ?? null,
      readAt: new Date(row.read_at).toISOString(),
      validSha: row.valid_sha ?? null,
      validAt: row.valid_at ? new Date(row.valid_at).toISOString() : null,
    };
  },

  /**
   * The desired state a plan works from for an environment row (BRK-178): the last valid copy of its file, or null
   * when it has none, or it's observe only.
   * @returns {import('./infra-provider.js').DesiredState | null}
   */
  desiredStateFor(envRow) {
    const row = this.sql
      .exec('SELECT * FROM infra_desired WHERE repo = ? AND environment = ?', envRow.repo, envRow.name)
      .toArray()[0];
    if (!row) return null;
    const view = this.desiredOut(row);
    return view.state === 'refused' ? null : view.desired;
  },

  /** GET /api/infra/desired[?repo=]: every desired-state file the last reads found, by repository then file. */
  desiredApi({ repo } = {}) {
    return this.run(async () => {
      const slug = repo ? String(repo).trim().toLowerCase() : null;
      const rows = this.sql
        .exec('SELECT * FROM infra_desired WHERE (? IS NULL OR repo = ?) ORDER BY repo, file', slug, slug)
        .toArray();
      return { status: 200, body: { desired: rows.map((row) => this.desiredOut(row)) } };
    });
  },

  /** GET /api/infra/desired/<environment>[?repo=]: one environment's, by its name (or its ID). */
  desiredOneApi(ref, { repo } = {}) {
    return this.run(async () => {
      const slug = repo ? String(repo).trim().toLowerCase() : null;
      let name = String(ref ?? '')
        .trim()
        .toLowerCase();
      let where = slug;
      if (/^\d{1,9}$/u.test(name)) {
        const env = this.environmentRow(name, slug);
        name = env.name;
        where = env.repo;
      }
      const rows = this.sql
        .exec('SELECT * FROM infra_desired WHERE environment = ? AND (? IS NULL OR repo = ?)', name, where, where)
        .toArray();
      if (rows.length > 1)
        throw new AgentError(
          `${rows.map((r) => r.repo).join(' and ')} each have a desired state for ${name}: say which with ?repo=`,
          409,
        );
      if (!rows[0])
        throw new AgentError(
          `no desired state for ${name.slice(0, 40)}${where ? ` in ${where}` : ''}: add ${DESIRED_DIR}/${name.slice(0, 40)}.json on the default branch`,
          404,
        );
      return { status: 200, body: { desired: this.desiredOut(rows[0]) } };
    });
  },
};
