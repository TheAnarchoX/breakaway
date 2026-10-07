/**
 * TaskStore's changes from the console (docs/specs/BRK-258-plan-from-the-board.md; BRK-259). The owner edits an
 * environment on its console; POST /api/infra/environments/<id>/changes with `{ edits }` answers the plan those edits
 * would make, writing nothing, and with `{ edits, propose: true }` the board commits the new desired state through its
 * GitHub App, on a branch of its own, and opens the pull request, so the plan check (BRK-185) makes the plan as it
 * does on anyone's. Desired state still lives in the repository and changes by pull request: the board never commits
 * to the default branch, holds no provider write credentials, and applies nothing here.
 *
 * One open change per environment: proposing again while it's open replaces its commit (the only branch the board
 * ever moves by force) and resets any approval. A pull request someone else pushes to stops being the board's (`taken
 * over`), and one closed or merged on GitHub is followed during the sync. Every write is the owner's press, cookie-only
 * in worker.js with the `by` check second, and appends a `change` entry to the audit trail with the environment.
 */
import { AgentError } from './store-agents.js';
import { GitHubError, appCredentials, fromBase64 } from './github.js';
import { install } from './install.js';
import { checkTarget, runsTheBoard } from './infra-environments.js';
import { DESIRED_MAX_BYTES, desiredPath, checkDesiredFile } from './infra-desired.js';
import { checkTemplate, TEMPLATE_FILE, TEMPLATES_DIR } from './infra-templates.js';
import { creatableKinds, targetKinds } from './infra-provider.js';
import { planView } from './infra-plans.js';
import { redact } from './redact.js';
import {
  applyEdits,
  changeBody,
  changeBranch,
  changeCommitMessage,
  changeTarget,
  changeTitle,
  checkChangedFile,
  checkEdits,
  desiredText,
  LIVE_STATES,
  mergeOutcome,
  outcomeSummary,
  PREVIEW_CACHE_MS,
  readHasMerge,
  PREVIEWS_PER_MINUTE,
  writablePath,
} from './infra-changes.js';
import SHIPPED from './infra-shipped-templates.json' with { type: 'json' };

const MINUTE = 60_000;
/** A repository's template is read again after this long. */
const TEMPLATE_CACHE_MS = 5 * MINUTE;
/** How many fresh branch names a proposal tries before it says the names are taken. */
const BRANCH_TRIES = 3;
/** The changes an environment's list shows. */
const LIST_LIMIT = 20;

/** Whether `by` is the owner's: none, or `owner`. Anything else is an agent's name, and is refused. */
const owners = (by) => by === undefined || by === null || by === '' || by === 'owner';
const refPath = (b) => b.split('/').map(encodeURIComponent).join('/');

/** A read GitHub answers 404 (not there) to is nothing found. */
async function orNull(promise) {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return null;
    throw error;
  }
}

/** A refusal with the problems, on the edits they belong to. */
function unfit(problems, extra = {}) {
  const first = problems[0];
  return {
    status: 422,
    body: {
      error: `${first.edit === null ? 'The change' : `Edit ${first.edit + 1}`} doesn’t fit: ${first.message}`,
      problems,
      ...extra,
    },
  };
}

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraChangesMethods = {
  initInfraChanges() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS infra_changes (
        n INTEGER PRIMARY KEY, environment INTEGER NOT NULL, repo TEXT NOT NULL, name TEXT NOT NULL,
        edits TEXT NOT NULL, lines TEXT NOT NULL, base_sha TEXT, commit_sha TEXT, branch TEXT NOT NULL,
        pull INTEGER, pull_url TEXT, digest TEXT, policy TEXT, approval TEXT,
        state TEXT NOT NULL, why TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS infra_changes_environment ON infra_changes (environment, state);
    `);
    // What a merge became (WEB-110): the merge's commit and when, then the outcome the first compare after it found.
    const have = new Set(
      this.sql
        .exec('PRAGMA table_info(infra_changes)')
        .toArray()
        .map((c) => c.name),
    );
    if (!have.has('merge_sha')) this.sql.exec('ALTER TABLE infra_changes ADD COLUMN merge_sha TEXT');
    if (!have.has('merged_at')) this.sql.exec('ALTER TABLE infra_changes ADD COLUMN merged_at INTEGER');
    if (!have.has('outcome')) this.sql.exec('ALTER TABLE infra_changes ADD COLUMN outcome TEXT');
    // How many changes its plan has (BRK-286): none, and it merges instead of asking for an approval.
    if (!have.has('changes')) this.sql.exec('ALTER TABLE infra_changes ADD COLUMN changes INTEGER');
    // The target it gives an environment that has none (BRK-291), set when the owner approves it or it merges.
    if (!have.has('target')) this.sql.exec('ALTER TABLE infra_changes ADD COLUMN target TEXT');
  },

  /** Environment `ref`'s row, when the board may change it from the console; else a 409 saying why not. */
  changeEnvironment(ref, repo = null) {
    const env = this.environmentRow(ref, repo ? String(repo).trim().toLowerCase() : null);
    if (env.observe_only || runsTheBoard(env, install(this.env).worker))
      throw new AgentError('Observe only: the board watches it and never changes it.', 409);
    if (!env.provider || !this.infraProviderFor(env.provider))
      throw new AgentError(
        `${env.name} has no connected provider: pick one on the board and connect it on Connections first`,
        409,
      );
    return env;
  },

  /** The environment's open change (open or approved), or null. */
  liveChangeRow(envId) {
    return (
      this.sql
        .exec(
          `SELECT * FROM infra_changes WHERE environment = ? AND state IN (SELECT value FROM json_each(?)) ORDER BY n DESC LIMIT 1`,
          Number(envId),
          JSON.stringify(LIVE_STATES),
        )
        .toArray()[0] ?? null
    );
  },

  /** A change as the API shows it. */
  changeOut(row) {
    return {
      n: Number(row.n),
      repo: row.repo,
      environment: { id: Number(row.environment), name: row.name },
      edits: JSON.parse(row.edits),
      lines: JSON.parse(row.lines),
      head: row.base_sha ?? null,
      commit: row.commit_sha ?? null,
      branch: row.branch,
      pull: row.pull ? { number: Number(row.pull), url: row.pull_url ?? null } : null,
      digest: row.digest ?? null,
      changes: row.changes ?? null,
      target: row.target ?? null,
      policy: row.policy ? JSON.parse(row.policy) : null,
      approval: row.approval ? JSON.parse(row.approval) : null,
      state: row.state,
      why: row.why ?? null,
      merged: row.merged_at ? new Date(row.merged_at).toISOString() : null,
      outcome: row.outcome ? JSON.parse(row.outcome) : null,
      created: new Date(row.created).toISOString(),
      updated: new Date(row.updated).toISOString(),
    };
  },

  /** Keeps how many changes the plan at a change's head has, as the board last made it. */
  keepChangePlan(n, preview) {
    this.sql.exec('UPDATE infra_changes SET changes = ? WHERE n = ?', Number(preview.changes ?? 0), Number(n));
  },

  /** Moves a change to `state`, with why, and its audit entry. */
  moveInfraChange(row, state, { by, outcome, why = null, summary }) {
    const now = Date.now();
    this.sql.exec('UPDATE infra_changes SET state = ?, why = ?, updated = ? WHERE n = ?', state, why, now, row.n);
    this.appendInfraAudit({
      kind: 'change',
      repo: row.repo,
      environment: row.name,
      environmentId: Number(row.environment),
      by,
      outcome,
      summary,
    });
  },

  /**
   * Where an environment with no file yet starts: the board's draft of what runs (BRK-240), or, with no target and so
   * nothing the board could see running, an empty file, so the change builds it from nothing (BRK-291).
   * @returns {{ file: Record<string, any>, from: 'draft' | 'empty' }}
   */
  changeStart(env) {
    if (!env.target) return { file: { version: 1, provider: env.provider, resources: [] }, from: 'empty' };
    return { file: JSON.parse(this.infraDraftOf(env).json), from: 'draft' };
  },

  /**
   * The file a preview replays the edits onto: the last valid copy the sync read from the default branch, at its
   * commit, or where an environment with no file yet starts (changeStart). A file that doesn't check at the head is
   * refused: the console changes a file that checks.
   */
  changeBaseKept(env) {
    const row = this.sql
      .exec('SELECT * FROM infra_desired WHERE repo = ? AND environment = ?', env.repo, env.name)
      .toArray()[0];
    if (!row) return { ...this.changeStart(env), sha: null };
    if (row.error || !row.desired) {
      const error = row.error ? JSON.parse(row.error) : null;
      throw new AgentError(
        `${desiredPath(env.name)} doesn’t check on the default branch${error?.message ? `: ${error.message}` : ''}. Fix it first; the console changes a file that checks.`,
        409,
      );
    }
    const desired = JSON.parse(row.desired);
    return {
      file: { version: 1, ...(row.provider ? { provider: row.provider } : {}), resources: desired.resources },
      sha: row.sha ?? null,
      from: 'file',
    };
  },

  /**
   * The templates the edits add from, by name: the repository's own (CLI-15, read from its default branch when the
   * board can reach GitHub), else the one breakaway ships of that name.
   * @param {Record<string, any>} env
   * @param {import('./infra-changes.js').Edit[]} edits
   * @param {{ client?: any, repo?: any, ref?: string | null }} [github]
   * @returns {Promise<Map<string, import('./infra-changes.js').FoundTemplate>>}
   */
  async changeTemplates(env, edits, { client = null, repo = null, ref = null } = {}) {
    const names = [...new Set(edits.filter((e) => e.op === 'add').map((e) => /** @type {any} */ (e).template))];
    const out = new Map();
    this.infraTemplateCache ??= new Map();
    for (const name of names) {
      const key = `${env.repo}\n${name}\n${ref ?? ''}`;
      const kept = this.infraTemplateCache.get(key);
      if (kept && Date.now() - kept.at < TEMPLATE_CACHE_MS) {
        if (kept.found) out.set(name, kept.found);
        continue;
      }
      let found = null;
      if (client && repo) found = await this.repositoryTemplate(client, repo, name, ref);
      if (!found && Object.hasOwn(SHIPPED, name)) {
        const files = /** @type {Record<string, string>} */ (/** @type {any} */ (SHIPPED)[name]);
        const checked = checkTemplate(files[TEMPLATE_FILE] ?? '');
        found =
          'error' in checked
            ? { error: checked.error }
            : { template: checked.template, sources: files, from: /** @type {const} */ ('breakaway') };
      }
      this.infraTemplateCache.set(key, { at: Date.now(), found });
      if (found) out.set(name, found);
    }
    return out;
  },

  /** One of the repository's templates at `ref` (its default branch when null), with its code files, or null. */
  async repositoryTemplate(client, repo, name, ref) {
    const at = `?ref=${encodeURIComponent(ref ?? repo.defaultBranch ?? 'main')}`;
    const dir = `${TEMPLATES_DIR}/${name}`;
    const read = async (file) => {
      const got = await orNull(client.get(`/contents/${refPath(`${dir}/${file}`)}${at}`));
      if (!got || Array.isArray(got) || got.type !== 'file') return null;
      if (Number(got.size ?? 0) > DESIRED_MAX_BYTES) return { tooBig: true };
      return { text: fromBase64(got.content) };
    };
    const main = await read(TEMPLATE_FILE);
    if (!main) return null;
    if (main.tooBig) return { error: `${TEMPLATE_FILE} is over ${DESIRED_MAX_BYTES / 1024} KB` };
    const checked = checkTemplate(main.text);
    if ('error' in checked) return { error: checked.error };
    /** @type {Record<string, string>} */
    const sources = {};
    for (const f of checked.template.files) {
      const got = await read(f.from);
      if (!got) return { error: `it names ${f.from}, and ${dir} has no such file` };
      if (got.tooBig) return { error: `${f.from} is over ${DESIRED_MAX_BYTES / 1024} KB` };
      sources[f.from] = got.text;
    }
    return { template: checked.template, sources, from: /** @type {const} */ ('repository') };
  },

  /** The GitHub client for an environment's repository, or null when GitHub isn't connected. */
  async changeGitHub(env) {
    const credentials = await appCredentials(this.env);
    const repo = this.githubRepo(env.repo);
    if (!credentials || !repo) return null;
    return { client: this.githubClient(credentials, repo), repo };
  },

  /**
   * Counts one plan for an environment's change, or answers when to ask again once it has had PREVIEWS_PER_MINUTE
   * this minute. Kept in memory: a store that restarts starts counting again.
   * @returns {number | null} seconds to wait, or null when it may plan now
   */
  countChangePreview(envId) {
    this.infraChangePreviews ??= new Map();
    const now = Date.now();
    const recent = (this.infraChangePreviews.get(envId) ?? []).filter((at) => now - at < MINUTE);
    if (recent.length >= PREVIEWS_PER_MINUTE) return Math.max(1, Math.ceil((recent[0] + MINUTE - now) / 1000));
    recent.push(now);
    this.infraChangePreviews.set(envId, recent);
    return null;
  },

  /**
   * The plan a change makes from `base`, the edits replayed onto it: the preview of the file's text (changePreviewOf,
   * the same computation the approval makes at the pull request's head) and its digest, or a 422 with the problems on
   * their edits, or a 429 with `retryAfter`. The same edits on the same head come from a minute-long cache, unless
   * `fresh`: a proposal plans what it commits as it is now, so its digest is the one Approve finds at the head. An
   * environment with no target gets the one the change adds (BRK-291), or the one of several the owner `chose`, and
   * is planned as if it had it.
   * @returns {Promise<{ status: number, body: Record<string, any> } | { ok: true, preview: Record<string, any>,
   *   desired: any, text: string, files: Array<{ path: string, text: string }>, lines: string[],
   *   dropped: Array<{ edit: number, line: string }>, target: { name: string | null, choices: string[] } }>}
   */
  async planInfraChange(env, edits, base, github = null, { fresh = false, chose = null } = {}) {
    const templates = await this.changeTemplates(env, edits, github ?? {});
    const provider = this.infraProviderFor(env.provider);
    const creatable = edits.some((e) => e.op === 'create') && provider ? creatableKinds(provider) : {};
    const made = applyEdits({
      file: base.file,
      edits,
      templates,
      environment: env.name,
      names: (kind) => (typeof provider?.editable === 'function' ? provider.editable(kind)?.name : null),
      seen: edits.some((e) => e.op === 'rename' || e.op === 'create')
        ? this.inventoryRows('WHERE i.environment = ?', env.id)
        : [],
      creatable: (kind) => creatable[kind] ?? null,
      fields: (kind) => (typeof provider?.editable === 'function' ? provider.editable(kind)?.fields : null),
    });
    const head = { head: base.sha, from: base.from, lines: made.lines, dropped: made.dropped };
    if (made.problems.length) return unfit(made.problems, head);
    const text = desiredText(made.file);
    const checked = checkChangedFile(text, {
      provider,
      expectProvider: env.provider,
      touched: made.touched,
      file: made.file,
    });
    if ('problem' in checked) return unfit([checked.problem], head);
    const kinds = provider ? targetKinds(provider) : [];
    const target = changeTarget({
      target: env.target ?? null,
      file: made.file,
      kinds,
      environment: env.name,
      chose,
      label: (provider ? creatableKinds(provider)[kinds[0]]?.label : null) ?? kinds[0],
    });
    const named = { name: target.name, choices: target.choices };
    if (target.problem) return unfit([target.problem], { ...head, target: named });
    const lines = target.line ? [...made.lines, target.line] : made.lines;

    this.infraChangeCache ??= new Map();
    const key = `${env.id}\n${base.sha ?? base.from}\n${target.name ?? ''}\n${text}\n${JSON.stringify(made.files)}`;
    const kept = this.infraChangeCache.get(key);
    let preview = !fresh && kept && Date.now() - kept.at < PREVIEW_CACHE_MS ? kept.preview : null;
    if (!preview) {
      const wait = this.countChangePreview(Number(env.id));
      if (wait !== null)
        return {
          status: 429,
          body: {
            error: `${env.name} has been planned ${PREVIEWS_PER_MINUTE} times in the last minute: ask again in ${wait} seconds`,
            retryAfter: wait,
            ...head,
          },
        };
      const planned = await this.changePreviewOf(env, text, target.name);
      if (planned.error)
        return unfit([{ edit: null, field: planned.error.field, message: planned.error.message }], head);
      preview = planned.preview;
      for (const [k, v] of this.infraChangeCache)
        if (Date.now() - v.at >= PREVIEW_CACHE_MS) this.infraChangeCache.delete(k);
      this.infraChangeCache.set(key, { at: Date.now(), preview });
    }
    return {
      ok: true,
      preview,
      desired: checked.desired,
      text,
      files: made.files,
      lines,
      dropped: made.dropped,
      target: named,
    };
  },

  /**
   * POST /api/infra/environments/<id>/changes: the owner's, from the signed-in board. `{ edits }` answers `{ preview,
   * head, from, lines, dropped, files, target }` and writes nothing; `{ edits, propose: true }` opens (or replaces)
   * the change's pull request and answers `{ change, preview }`. `target` is the owner's pick of the new environment's
   * target when the change adds several (BRK-291); the answer's `target` names the one it gets and the choices.
   */
  infraChangesApi(ref, body = {}) {
    return this.run(async () => {
      if (!owners(body.by)) throw new AgentError('only the owner changes an environment from the board', 403);
      const env = this.changeEnvironment(ref, body.repo ?? null);
      const checked = checkEdits(body.edits);
      if ('problem' in checked) return unfit([checked.problem]);
      const chose = checkTarget(body.target);
      if (body.propose === true) return this.proposeInfraChange(env, checked.edits, chose);
      const github = checked.edits.some((e) => e.op === 'add') ? await this.changeGitHub(env) : null;
      const base = this.changeBaseKept(env);
      const planned = await this.planInfraChange(env, checked.edits, base, github, { chose });
      if (!('ok' in planned)) return planned;
      return {
        status: 200,
        body: {
          head: base.sha,
          from: base.from,
          lines: planned.lines,
          dropped: planned.dropped,
          files: planned.files.map((f) => f.path),
          target: planned.target,
          preview: planned.preview,
        },
      };
    });
  },

  /** Propose the change: one at a time per environment. */
  async proposeInfraChange(env, edits, chose = null) {
    this.infraProposing ??= new Set();
    const id = Number(env.id);
    if (this.infraProposing.has(id))
      throw new AgentError(`The board is already proposing ${env.name}’s change: wait a moment`, 409);
    this.infraProposing.add(id);
    try {
      const github = await this.changeGitHub(env);
      if (!github)
        throw new AgentError(
          `Connect GitHub on Connections first: the board proposes ${env.name}’s change as a pull request`,
          409,
        );
      return await this.openInfraChange(env, edits, github, chose);
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      return {
        status: 502,
        body: {
          error: `GitHub refused ${env.name}’s change: ${redact(error.reason ?? error.message)}. Check the App can write to ${env.repo}’s repository (Connections), then propose again; your edits are kept.`,
          github: error.status,
        },
      };
    } finally {
      this.infraProposing.delete(id);
    }
  },

  async openInfraChange(env, edits, { client, repo }, chose = null) {
    const branchOf = repo.defaultBranch || 'main';
    let live = this.liveChangeRow(env.id);
    // The change already open: still the board's? Merged, closed, or pushed to by someone else, it isn't.
    if (live?.pull) {
      const pull = await orNull(client.get(`/pulls/${live.pull}`));
      if (!pull)
        this.moveInfraChange(live, 'closed', {
          by: 'board',
          outcome: 'closed',
          why: 'its pull request is gone from GitHub',
          summary: `#${live.pull} is gone from GitHub; nothing changes`,
        });
      if (!pull || this.followInfraChange(live, pull)) live = null;
      // Replacing resets an approval (BRK-260): auto-merge it turned on must not merge the new commit.
      else if (pull.auto_merge) await this.stopChangeAutoMerge(client, pull);
    }

    const head = (await client.get(`/git/ref/heads/${refPath(branchOf)}`))?.object?.sha;
    if (!head) throw new AgentError(`${branchOf} has no commit yet: push one first`, 409);
    const path = desiredPath(env.name);
    const got = await orNull(client.get(`/contents/${refPath(path)}?ref=${encodeURIComponent(head)}`));
    /** @type {{ file: Record<string, any>, sha: string, from: 'file' | 'draft' | 'empty' }} */
    let base;
    let before = null;
    if (!got || Array.isArray(got) || got.type !== 'file') {
      base = { ...this.changeStart(env), sha: head };
    } else {
      if (Number(got.size ?? 0) > DESIRED_MAX_BYTES)
        throw new AgentError(`${path} is over ${DESIRED_MAX_BYTES / 1024} KB: trim it first`, 409);
      before = fromBase64(got.content);
      const ok = checkDesiredFile(before, { expectProvider: env.provider });
      if ('error' in ok)
        throw new AgentError(
          `${path} doesn’t check at ${branchOf}’s head: ${ok.error.message}. Fix it first; the console changes a file that checks.`,
          409,
        );
      base = { file: JSON.parse(before), sha: head, from: 'file' };
    }

    const planned = await this.planInfraChange(env, edits, base, { client, repo, ref: head }, { fresh: true, chose });
    if (!('ok' in planned)) return planned;
    if (before !== null && planned.text === desiredText(base.file) && !planned.files.length)
      throw new AgentError(
        planned.dropped.length
          ? `Nothing to propose: every edit was dropped (${planned.dropped[0].line})`
          : `Nothing to propose: the edits leave ${path} as it is`,
        409,
      );
    // A template's code file goes in only where the repository has nothing yet, as infra add refuses it.
    for (const f of planned.files) {
      if (!writablePath(f.path))
        return unfit([{ edit: null, field: 'template', message: `${f.path} is the board’s to leave alone` }]);
      const there = await orNull(client.get(`/contents/${refPath(f.path)}?ref=${encodeURIComponent(head)}`));
      if (there)
        return unfit([
          { edit: null, field: 'inputs', message: `${f.path} is already in the repository: pick another name` },
        ]);
    }

    let n = live ? Number(live.n) : this.reserveChangeNumber();
    let branch = live?.branch ?? changeBranch(env.name, n);
    const created = base.from === 'draft';
    const title =
      created && !planned.lines.length ? `Describe ${env.name} as code` : changeTitle(env.name, planned.lines);
    const message = created && !planned.lines.length ? title : changeCommitMessage(env.name, planned.lines);

    const commit = await client.get(`/git/commits/${encodeURIComponent(head)}`);
    const tree = await client.send('POST', '/git/trees', {
      base_tree: commit?.tree?.sha,
      tree: [
        { path, mode: '100644', type: 'blob', content: planned.text },
        ...planned.files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.text })),
      ],
    });
    const made = await client.send('POST', '/git/commits', { message, tree: tree.sha, parents: [head] });
    // The open change's branch moves by force: its head is the commit the board wrote (followInfraChange checked).
    if (live) await client.send('PATCH', `/git/refs/heads/${refPath(branch)}`, { sha: made.sha, force: true });
    else
      for (let tries = 1; ; tries += 1) {
        try {
          await client.send('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: made.sha });
          break;
        } catch (error) {
          if (!(error instanceof GitHubError) || error.status !== 422) throw error;
          // A branch of that name the board didn't make for this change (a person's, or another install's) is
          // never moved: the next number gets a branch of its own.
          if (tries >= BRANCH_TRIES)
            throw new AgentError(
              `${env.repo} already has branches named like ${changeBranch(env.name, '<n>')} that the board didn’t make for this change: delete the ones you don’t need, then propose again`,
              409,
            );
          n = this.reserveChangeNumber();
          branch = changeBranch(env.name, n);
        }
      }
    const home = this.homeUrl();
    const page = home ? `${home}/#/infrastructure/${env.id}` : null;
    const description = changeBody({
      environment: env.name,
      lines: planned.lines,
      dropped: planned.dropped,
      files: planned.files.map((f) => f.path),
      preview: planned.preview,
      page,
      created,
      empty: base.from === 'empty',
    });
    const pull = live
      ? await client.send('PATCH', `/pulls/${live.pull}`, { title, body: description })
      : await client.send('POST', '/pulls', { title, head: branch, base: branchOf, body: description });

    const now = Date.now();
    const policy = planned.preview.policy ? JSON.stringify(planned.preview.policy) : null;
    if (live)
      this.sql.exec(
        `UPDATE infra_changes SET edits = ?, lines = ?, base_sha = ?, commit_sha = ?, digest = ?, changes = ?, policy = ?,
           target = ?, approval = NULL, state = 'open', why = NULL, updated = ? WHERE n = ?`,
        JSON.stringify(edits),
        JSON.stringify(planned.lines),
        head,
        made.sha,
        planned.preview.digest,
        Number(planned.preview.changes ?? 0),
        policy,
        planned.target.name,
        now,
        n,
      );
    else
      this.sql.exec(
        `INSERT INTO infra_changes (n, environment, repo, name, edits, lines, base_sha, commit_sha, branch, pull, pull_url,
           digest, changes, policy, target, approval, state, why, created, updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'open', NULL, ?, ?)`,
        n,
        Number(env.id),
        env.repo,
        env.name,
        JSON.stringify(edits),
        JSON.stringify(planned.lines),
        head,
        made.sha,
        branch,
        Number(pull.number),
        pull.html_url ?? null,
        planned.preview.digest,
        Number(planned.preview.changes ?? 0),
        policy,
        planned.target.name,
        now,
        now,
      );
    this.appendInfraAudit({
      kind: 'change',
      repo: env.repo,
      environment: env.name,
      environmentId: Number(env.id),
      by: 'owner',
      outcome: live ? 'replaced' : 'proposed',
      summary: `${live ? 'replaced' : 'proposed'} by the owner as #${pull.number}: ${title}${live?.approval ? '; its approval is reset' : ''}`,
    });
    // The plan check (BRK-185) posts on the pull request at the next sync: ask for it now.
    await this.githubWebhook('pull_request', live ? 'synchronize' : 'opened', { slug: env.repo });
    const row = this.sql.exec('SELECT * FROM infra_changes WHERE n = ?', n).toArray()[0];
    return { status: live ? 200 : 201, body: { change: this.changeOut(row), preview: planned.preview } };
  },

  /** The next change's number: synchronous, so two proposals never share one. */
  reserveChangeNumber() {
    const kept = Number(this.meta('infra_change_seq') ?? 0);
    const max = Number(this.sql.exec('SELECT COALESCE(MAX(n), 0) AS n FROM infra_changes').toArray()[0].n);
    const n = Math.max(kept, max) + 1;
    this.setMeta('infra_change_seq', n);
    return n;
  },

  /**
   * Follows a live change's pull request as GitHub reads it: merged, closed, or pushed to by someone else (taken
   * over). Returns true when the change stopped being the board's open one.
   */
  followInfraChange(row, pull) {
    const ref = `#${row.pull}`;
    if (pull.merged_at || pull.merged) {
      this.moveInfraChange(row, 'merged', { by: 'board', outcome: 'merged', summary: `${ref} merged on GitHub` });
      this.keepChangeMerge(row.n, pull.merge_commit_sha ?? null, pull.merged_at ? Date.parse(pull.merged_at) : null);
      // Merged on GitHub without an approval on the board: its plan still needs the target it gives.
      this.giveChangeTarget(row, 'board');
      return true;
    }
    if (pull.state === 'closed') {
      this.moveInfraChange(row, 'closed', {
        by: 'board',
        outcome: 'closed',
        why: 'closed on GitHub',
        summary: `${ref} was closed on GitHub; nothing changes`,
      });
      return true;
    }
    if (row.commit_sha && pull.head?.sha && pull.head.sha !== row.commit_sha) {
      this.moveInfraChange(row, 'taken over', {
        by: 'board',
        outcome: 'taken over',
        why: 'someone else pushed to its branch',
        summary: `${ref} has a commit the board didn’t write, so it’s an ordinary pull request now`,
      });
      return true;
    }
    return false;
  },

  /**
   * Gives a change's environment the target the change adds (BRK-291), when it still has none: on the owner's
   * approval, or when the change merges on GitHub without one. The plan made from the merge, discovery, and health
   * follow it from then on. A target that would be the board's own Worker is never given.
   * @param {Record<string, any>} row the change's row
   * @param {'owner' | 'board'} by
   */
  giveChangeTarget(row, by) {
    if (!row.target) return;
    const env = this.sql.exec('SELECT * FROM infra_environments WHERE id = ?', Number(row.environment)).toArray()[0];
    if (!env || env.target || runsTheBoard({ target: row.target }, install(this.env).worker)) return;
    this.sql.exec(
      "UPDATE infra_environments SET target = ?, edited = ? WHERE id = ? AND (target IS NULL OR target = '')",
      row.target,
      Date.now(),
      env.id,
    );
    this.appendInfraAudit({
      kind: 'environment',
      repo: env.repo,
      environment: env.name,
      environmentId: Number(env.id),
      by,
      outcome: 'changed',
      summary: `${env.name}’s target is ${row.target}, from ${row.pull ? `#${row.pull}` : `change ${row.n}`}${by === 'owner' ? ', approved by the owner' : ', merged on GitHub'}`,
    });
  },

  /** Keeps what GitHub says of a change's merge: its commit and when (WEB-110). */
  keepChangeMerge(n, sha, at) {
    this.sql.exec(
      'UPDATE infra_changes SET merge_sha = ?, merged_at = ? WHERE n = ?',
      sha ?? null,
      Number.isFinite(at) ? at : Date.now(),
      Number(n),
    );
  },

  /**
   * The environment's merged changes whose outcome isn't known yet and whose merge the desired state the board last
   * read includes, so this compare is the one after their merge (WEB-110).
   */
  changesToSettle(env) {
    const read = this.sql
      .exec('SELECT sha, read_at FROM infra_desired WHERE repo = ? AND environment = ?', env.repo, env.name)
      .toArray()[0];
    if (!read) return [];
    return this.sql
      .exec(
        "SELECT * FROM infra_changes WHERE environment = ? AND state = 'merged' AND outcome IS NULL",
        Number(env.id),
      )
      .toArray()
      .filter((row) =>
        readHasMerge(
          { sha: read.sha ?? null, readAt: read.read_at ?? null },
          { mergeSha: row.merge_sha ?? null, mergedAt: row.merged_at ?? row.updated },
        ),
      );
  },

  /**
   * Records what a compare found for the merged changes it settles: nothing to apply, the plan that covers them, or
   * why the environment holds them. Each gets its audit entry.
   * @param {Record<string, any>[]} rows changesToSettle's
   * @param {{ moved: boolean, empty: boolean, plan?: number | string | null, held?: string | null }} compare
   */
  settleMergedChanges(rows, { moved, empty, plan = null, held = null }) {
    if (!rows.length) return;
    const view = plan === null ? null : planView(this.planRow(plan), { full: false });
    const outcome = mergeOutcome({ moved, empty, plan: view, held });
    for (const row of rows) {
      this.sql.exec(
        'UPDATE infra_changes SET outcome = ?, updated = ? WHERE n = ?',
        JSON.stringify(outcome),
        Date.now(),
        row.n,
      );
      this.appendInfraAudit({
        kind: 'change',
        repo: row.repo,
        environment: row.name,
        environmentId: Number(row.environment),
        ...(outcome.plan ? { plan: outcome.plan } : {}),
        by: 'board',
        outcome: outcome.kind === 'nothing' ? 'nothing to apply' : outcome.kind,
        summary: outcomeSummary(row.pull ? `#${row.pull}` : `change ${row.n}`, outcome),
      });
    }
  },

  /** During a sync: follow the repository's live changes in GitHub's list of pull requests (no extra call). */
  followInfraChanges(slug, pulls) {
    const rows = this.sql
      .exec(
        `SELECT * FROM infra_changes WHERE repo = ? AND pull IS NOT NULL AND state IN (SELECT value FROM json_each(?))`,
        slug,
        JSON.stringify(LIVE_STATES),
      )
      .toArray();
    for (const row of rows) {
      const pull = (pulls ?? []).find((p) => Number(p.number) === Number(row.pull));
      if (pull) this.followInfraChange(row, pull);
    }
  },

  /** GET /api/infra/environments/<id>/changes[?repo=]: the open change, if any, and the recent ones. */
  infraChangesListApi(ref, { repo } = {}) {
    return this.run(async () => {
      const env = this.environmentRow(ref, repo ? String(repo).trim().toLowerCase() : null);
      const live = this.liveChangeRow(env.id);
      const rows = this.sql
        .exec('SELECT * FROM infra_changes WHERE environment = ? ORDER BY n DESC LIMIT ?', Number(env.id), LIST_LIMIT)
        .toArray();
      return {
        status: 200,
        body: { open: live ? this.changeOut(live) : null, changes: rows.map((r) => this.changeOut(r)) },
      };
    });
  },

  /** A change by its number, or a 404. */
  changeRow(ref) {
    const n = Number(ref);
    const row = Number.isSafeInteger(n)
      ? this.sql.exec('SELECT * FROM infra_changes WHERE n = ?', n).toArray()[0]
      : null;
    if (!row) throw new AgentError(`no change ${String(ref).slice(0, 20)}`, 404);
    return row;
  },

  /**
   * GET /api/infra/changes?repo=&pull=: the latest change whose pull request is `pull` in `repo`, or null, with its
   * environment's name and freeze, for the pull request page's Approve and Reject (WEB-105).
   */
  infraChangeByPullApi({ repo, pull } = {}) {
    return this.run(async () => {
      const number = Number(pull);
      if (!Number.isSafeInteger(number) || number < 1)
        throw new AgentError('send the pull request’s number as pull', 400);
      const slug = String(repo || this.defaultRepoSlug())
        .trim()
        .toLowerCase();
      const row = this.sql
        .exec('SELECT * FROM infra_changes WHERE repo = ? AND pull = ? ORDER BY n DESC LIMIT 1', slug, number)
        .toArray()[0];
      if (!row) return { status: 200, body: { change: null, environment: null } };
      const env = this.environmentRow(String(row.environment), null);
      return {
        status: 200,
        body: {
          change: this.changeOut(row),
          environment: { id: Number(env.id), name: env.name, frozen: Boolean(env.frozen) },
        },
      };
    });
  },

  /** GET /api/infra/changes/<n>: one change. */
  infraChangeApi(ref) {
    return this.run(async () => ({ status: 200, body: { change: this.changeOut(this.changeRow(ref)) } }));
  },

  /**
   * POST /api/infra/changes/<n>/reject: the owner's, from the signed-in board. The board closes the change's pull
   * request and deletes its branch; nothing changes.
   */
  infraChangeRejectApi(ref, body = {}) {
    return this.run(async () => {
      if (!owners(body.by)) throw new AgentError('only the owner rejects a change, from the board', 403);
      const row = this.changeRow(ref);
      if (!LIVE_STATES.includes(row.state))
        throw new AgentError(`change ${row.n} is ${row.state}, so there’s nothing to reject`, 409);
      const env = this.environmentRow(String(row.environment), null);
      const github = await this.changeGitHub(env);
      if (!github) throw new AgentError('Connect GitHub on Connections first: rejecting closes its pull request', 409);
      try {
        if (row.pull) {
          const pull = await orNull(github.client.get(`/pulls/${row.pull}`));
          if (pull && this.followInfraChange(row, pull))
            throw new AgentError(
              `#${row.pull} changed on GitHub: it’s ${this.changeRow(row.n).state} now, so the board leaves it`,
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
        return {
          status: 502,
          body: {
            error: `GitHub refused to close #${row.pull}: ${redact(error.reason ?? error.message)}. Close it on GitHub, or check the App can write to ${row.repo}’s repository (Connections).`,
            github: error.status,
          },
        };
      }
      this.moveInfraChange(row, 'rejected', {
        by: 'owner',
        outcome: 'rejected',
        why: 'rejected by the owner',
        summary: `rejected by the owner; #${row.pull} is closed and nothing changes`,
      });
      return { status: 200, body: { change: this.changeOut(this.changeRow(row.n)) } };
    });
  },

  /**
   * GET /api/infra/environments/<id>/templates[?repo=]: what Add from a template lists: the repository's templates on
   * its default branch, by folder, and breakaway's own where the repository has none of that name, each with its
   * title, description, and inputs.
   */
  infraChangeTemplatesApi(ref, { repo } = {}) {
    return this.run(async () => {
      const env = this.environmentRow(ref, repo ? String(repo).trim().toLowerCase() : null);
      const github = await this.changeGitHub(env);
      const names = new Set(Object.keys(SHIPPED));
      if (github) {
        const at = `?ref=${encodeURIComponent(github.repo.defaultBranch || 'main')}`;
        const list = await orNull(github.client.get(`/contents/${refPath(TEMPLATES_DIR)}${at}`));
        for (const e of Array.isArray(list) ? list : []) if (e?.type === 'dir') names.add(String(e.name));
      }
      const edits = [...names].sort().map((template) => ({ op: /** @type {const} */ ('add'), template, inputs: {} }));
      const found = await this.changeTemplates(env, edits, github ?? {});
      const templates = [];
      for (const [name, t] of [...found].sort(([a], [b]) => a.localeCompare(b)))
        templates.push(
          'error' in t
            ? { name, error: t.error }
            : {
                name,
                from: t.from,
                title: t.template.title,
                description: t.template.description,
                inputs: t.template.inputs,
                files: t.template.files.map((f) => f.to),
              },
        );
      return { status: 200, body: { templates, folder: TEMPLATES_DIR } };
    });
  },
};
