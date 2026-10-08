/**
 * TaskStore's short-lived environments (docs/specs/IDEA-19-architect.md, "Short-lived environments"; BRK-200): a task
 * asks for an environment of its own, with the `+environment` tag or the owner's press on the board, and the board
 * makes it from the repository's template (infra-short-lived.js) through a plan, owned by the task. When the task
 * closes, or once it has stayed open past the grace period, the board makes the plan that removes it; once that plan
 * is applied, the environment goes.
 *
 * Nothing here applies anything, and nothing skips the owner: both plans go through policy (BRK-181) like any other.
 * Under the default policy both wait for the owner, with a push; a repository's policy may let the plan that makes one
 * through with an allow rule for `environmentKinds: ["short-lived"]`, and the plan that removes one is all deletes, so
 * the destructive guard always asks. A request only asks: the tag on many tasks makes at most MAX_SHORT_LIVED at once
 * in a repository, and the cap on environments still holds.
 *
 * The board does it all from the alarm and the cron (`shortLivedTick`), so a task closed from the board, the CLI, a
 * merged pull request, or Taskwarrior is noticed alike. Every environment it adds or removes is in the audit trail
 * (kind `environment`), and the plans write theirs.
 */
import { AgentError } from './store-agents.js';
import { install } from './install.js';
import { redact } from './redact.js';
import { tagsOf } from './model.js';
import { GitHubError } from './github.js';
import { DESIRED_MAX_BYTES } from './infra-desired.js';
import { MAX_ENVIRONMENTS, runsTheBoard } from './infra-environments.js';
import { planNumber } from './infra-plans.js';
import {
  ASK_TAG,
  checkShortLivedTemplate,
  GRACE_MS,
  MAX_SHORT_LIVED,
  REFUSED_RETRY_MS,
  renderShortLived,
  RETRY_MS,
  SHORT_LIVED_FILE,
  SHORT_LIVED_PATH,
  shortLivedName,
  shortLivedNext,
  shortLivedView,
} from './infra-short-lived.js';

/** How many requests one tick looks at: each may ask a provider for a plan. */
const PER_TICK = 5;

const decode = (b64) =>
  new TextDecoder().decode(Uint8Array.from(atob(String(b64 ?? '').replace(/\s+/gu, '')), (c) => c.charCodeAt(0)));

/** Whether a task is closed for its environment: done, deleted, or gone from the board. */
const closedTask = (map) => !map || map.status === 'completed' || map.status === 'deleted';

/** A refusal in words, without the provider's secrets. */
const why = (error) => redact(String(error?.message ?? error)).slice(0, 300);

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraShortLivedMethods = {
  initInfraShortLived() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS infra_short_lived_template (
        repo TEXT PRIMARY KEY, sha TEXT, read_at INTEGER NOT NULL,
        template TEXT, valid_sha TEXT, valid_at INTEGER, error TEXT
      );
      CREATE TABLE IF NOT EXISTS infra_short_lived (
        task TEXT PRIMARY KEY, repo TEXT NOT NULL, name TEXT NOT NULL, environment INTEGER,
        state TEXT NOT NULL, asked_by TEXT NOT NULL, create_plan INTEGER, remove_plan INTEGER,
        error TEXT, next_try INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS infra_short_lived_by_repo ON infra_short_lived (repo, state);
    `);
  },

  /**
   * During a sync, from the desired-state read: `listing` is the folder's entries on the default branch at `sha`. No
   * template: the repository's row goes, and a task that asks is told to add one. An invalid template keeps the last
   * valid copy, the way a desired-state file does. A GitHub failure other than 403 or 404 throws.
   */
  async readShortLivedTemplate(client, repo, sha, listing) {
    const entry = (Array.isArray(listing) ? listing : []).find(
      (e) => e?.type === 'file' && e.name === SHORT_LIVED_FILE,
    );
    if (!entry) {
      this.sql.exec('DELETE FROM infra_short_lived_template WHERE repo = ?', repo.slug);
      return;
    }
    let checked;
    if (entry.size > DESIRED_MAX_BYTES)
      checked = {
        ok: false,
        error: { line: null, field: null, message: `the file is over ${DESIRED_MAX_BYTES / 1024} KB: trim it` },
      };
    else {
      let got = null;
      try {
        got = await client.get(`/contents/${SHORT_LIVED_PATH}?ref=${encodeURIComponent(repo.defaultBranch || 'main')}`);
      } catch (error) {
        if (!(error instanceof GitHubError && [403, 404].includes(error.status))) throw error;
      }
      if (!got || Array.isArray(got) || got.type !== 'file') {
        this.sql.exec('DELETE FROM infra_short_lived_template WHERE repo = ?', repo.slug);
        return;
      }
      const text = decode(got.content);
      const first = checkShortLivedTemplate(text);
      checked = first.ok
        ? checkShortLivedTemplate(text, { provider: this.infraProviderFor(first.template.provider) })
        : first;
    }
    this.keepShortLivedTemplate(repo.slug, sha ?? null, checked);
  },

  /** Keeps a template's check: a valid one replaces the last, an invalid one keeps it and says what's wrong. */
  keepShortLivedTemplate(repo, sha, checked) {
    const now = Date.now();
    if (checked.ok)
      this.sql.exec(
        `INSERT INTO infra_short_lived_template (repo, sha, read_at, template, valid_sha, valid_at, error)
         VALUES (?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (repo) DO UPDATE SET sha = excluded.sha, read_at = excluded.read_at, template = excluded.template,
           valid_sha = excluded.valid_sha, valid_at = excluded.valid_at, error = NULL`,
        repo,
        sha,
        now,
        JSON.stringify(checked.template),
        sha,
        now,
      );
    else
      this.sql.exec(
        `INSERT INTO infra_short_lived_template (repo, sha, read_at, error) VALUES (?, ?, ?, ?)
         ON CONFLICT (repo) DO UPDATE SET sha = excluded.sha, read_at = excluded.read_at, error = excluded.error`,
        repo,
        sha,
        now,
        JSON.stringify(checked.error),
      );
  },

  /** A repository's template as the API shows it: `valid`, `invalid` (with `error`; the last valid one still serves), or `none`. */
  shortLivedTemplateOut(repo) {
    const row = this.sql.exec('SELECT * FROM infra_short_lived_template WHERE repo = ?', repo).toArray()[0];
    return {
      repo,
      path: SHORT_LIVED_PATH,
      state: !row ? 'none' : row.error ? 'invalid' : 'valid',
      error: row?.error ? JSON.parse(row.error) : null,
      template: row?.template ? JSON.parse(row.template) : null,
      sha: row?.valid_sha ?? null,
      readAt: row ? new Date(row.read_at).toISOString() : null,
    };
  },

  shortLivedRow(uuid) {
    return this.sql.exec('SELECT * FROM infra_short_lived WHERE task = ?', uuid).toArray()[0] ?? null;
  },

  shortLivedOut(row) {
    const map = this.tasks.get(row.task);
    return shortLivedView(row, {
      task: map ? { uuid: row.task, wid: map.wid ?? null, description: map.description ?? '' } : null,
    });
  },

  setShortLived(uuid, fields) {
    const keys = Object.keys(fields);
    this.sql.exec(
      `UPDATE infra_short_lived SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated = ? WHERE task = ?`,
      ...keys.map((k) => fields[k]),
      Date.now(),
      uuid,
    );
  },

  /**
   * A task asks for its environment: the board adds it, kind short-lived and owned by the task, from the repository's
   * template, then makes the plan that makes it. Refused, with words, when the repository has no valid template, its
   * provider isn't connected, the repository is at its cap, or the name is taken. A task asks once: asking again
   * returns what it has, unless its last request was refused or its environment was removed.
   * @param {string} uuid
   * @param {{ by: 'owner' | 'tag' }} input
   */
  async askShortLived(uuid, { by }) {
    const map = this.tasks.get(uuid);
    if (!map) throw new AgentError('no such task', 404);
    if (closedTask(map)) throw new AgentError(`${map.wid ?? 'the task'} is closed, so it gets no environment`, 409);
    const had = this.shortLivedRow(uuid);
    if (had && !['refused', 'removed'].includes(had.state)) return had;
    const repo = this.repoOfTask(map)?.slug ?? this.defaultRepoSlug();
    const name = shortLivedName({ uuid, wid: map.wid ?? null });
    const now = Date.now();
    const refuse = (message) => {
      this.sql.exec(
        `INSERT INTO infra_short_lived (task, repo, name, environment, state, asked_by, error, next_try, created, updated)
         VALUES (?, ?, ?, NULL, 'refused', ?, ?, ?, ?, ?)
         ON CONFLICT (task) DO UPDATE SET repo = excluded.repo, name = excluded.name, environment = NULL,
           state = 'refused', asked_by = excluded.asked_by, create_plan = NULL, remove_plan = NULL,
           error = excluded.error, next_try = excluded.next_try, updated = excluded.updated`,
        uuid,
        repo,
        name,
        by,
        message,
        now + REFUSED_RETRY_MS,
        now,
        now,
      );
      throw new AgentError(message, 409);
    };
    const template = this.shortLivedTemplateOut(repo).template;
    if (!template)
      refuse(`${repo} has no template for short-lived environments: add ${SHORT_LIVED_PATH} to its default branch`);
    if (!this.infraRegistry().has(template.provider))
      refuse(`${template.provider} isn’t connected, so ${repo} can’t make short-lived environments on it`);
    const count = (where) =>
      this.sql.exec(`SELECT COUNT(*) AS n FROM infra_environments WHERE repo = ?${where}`, repo).one().n;
    if (count(" AND kind = 'short-lived'") >= MAX_SHORT_LIVED)
      refuse(`${repo} has ${MAX_SHORT_LIVED} short-lived environments already: close a task that has one first`);
    if (count('') >= MAX_ENVIRONMENTS)
      refuse(`${repo} has ${MAX_ENVIRONMENTS} environments already: the owner removes one first`);
    if (this.sql.exec('SELECT id FROM infra_environments WHERE repo = ? AND name = ?', repo, name).toArray()[0])
      refuse(`${repo} already has an environment called ${name}`);
    let made;
    try {
      made = renderShortLived(template, name);
    } catch (error) {
      refuse(`${SHORT_LIVED_PATH} doesn’t make an environment called ${name}: ${why(error)}`);
    }
    if (runsTheBoard({ target: made.target }, install(this.env).worker))
      refuse(`${SHORT_LIVED_PATH} points at the Worker that runs this board, and the board never applies to itself`);

    let env;
    this.ctx.storage.transactionSync(() => {
      env = this.sql
        .exec(
          `INSERT INTO infra_environments (repo, name, kind, provider, target, task, frozen, gates, observe_only, created, edited)
           VALUES (?, ?, 'short-lived', ?, ?, ?, 0, 0, 0, ?, ?) RETURNING *`,
          repo,
          name,
          made.provider,
          made.target,
          uuid,
          now,
          now,
        )
        .one();
      this.sql.exec(
        `INSERT INTO infra_short_lived (task, repo, name, environment, state, asked_by, created, updated)
         VALUES (?, ?, ?, ?, 'creating', ?, ?, ?)
         ON CONFLICT (task) DO UPDATE SET repo = excluded.repo, name = excluded.name, environment = excluded.environment,
           state = 'creating', asked_by = excluded.asked_by, create_plan = NULL, remove_plan = NULL, error = NULL,
           next_try = NULL, created = excluded.created, updated = excluded.updated`,
        uuid,
        repo,
        name,
        env.id,
        by,
        now,
        now,
      );
      this.appendInfraAudit({
        kind: 'environment',
        repo,
        environment: name,
        environmentId: env.id,
        by: by === 'owner' ? 'owner' : 'board',
        outcome: 'added',
        summary: `short-lived, for ${map.wid ?? 'a task'}, from ${SHORT_LIVED_PATH}${by === 'tag' ? ` (the task’s +${ASK_TAG} tag)` : ''}; nothing exists until its plan is applied`,
      });
      this.infraEvent('environment.created', env, {
        fields: { state: 'added', source: 'short-lived', ...(map.wid ? { task: map.wid } : {}) },
        dedupe: `added:${env.id}`,
        cause: { wid: map.wid ?? null },
      });
    });
    await this.shortLivedCreate(this.shortLivedRow(uuid), env, now);
    return this.shortLivedRow(uuid);
  },

  /**
   * Makes the plan that makes a task's environment, from the template as it is now, and puts it in front of the owner
   * unless the repository's policy let it through. A provider that doesn't answer, or a frozen environment, is tried
   * again later.
   */
  async shortLivedCreate(row, env, now) {
    const template = this.shortLivedTemplateOut(row.repo).template;
    if (!template) {
      this.setShortLived(row.task, {
        error: `${row.repo} has no template any more: add ${SHORT_LIVED_PATH} back`,
        next_try: now + REFUSED_RETRY_MS,
      });
      return;
    }
    const map = this.tasks.get(row.task);
    try {
      const { desired } = renderShortLived(template, env.name);
      const plan = await this.makeInfraPlan(env.id, {
        source: 'short-lived',
        sourceRef: map?.wid ?? null,
        by: 'board',
        desired,
      });
      this.setShortLived(row.task, { create_plan: planNumber(plan.id), error: null, next_try: null });
      if (plan.state === 'draft')
        await this.waitForOwner(plan.id, {
          by: 'board',
          summary: `${map?.wid ?? 'a task'} asked for its own environment`,
        });
    } catch (error) {
      // Already there (made by hand, or a plan before): nothing to make.
      if (error instanceof AgentError && /already matches/u.test(error.message))
        this.setShortLived(row.task, { state: 'ready', error: null, next_try: null });
      else this.setShortLived(row.task, { error: why(error), next_try: now + RETRY_MS });
    }
  },

  /**
   * Makes the plan that removes a task's environment: everything its provider has in the environment's scope goes. It
   * is all deletes, so the destructive guard always asks for the owner. When nothing is there, the environment goes
   * at once.
   */
  async shortLivedRemove(row, env, now, reason) {
    try {
      if (env.frozen)
        throw new AgentError(`${env.name} is frozen: nothing changes there until the owner unfreezes it`, 409);
      const { stored } = await this.computeInfraPlan(env, { resources: [] });
      if (stored.changes.length === 0) {
        this.shortLivedGone(row, env, `nothing was there to remove; ${reason}`);
        return;
      }
      const map = this.tasks.get(row.task);
      const plan = await this.makeInfraPlan(env.id, {
        source: 'short-lived',
        sourceRef: map?.wid ?? null,
        by: 'board',
        desired: { resources: [] },
      });
      this.setShortLived(row.task, {
        state: 'removing',
        remove_plan: planNumber(plan.id),
        error: null,
        next_try: null,
      });
      if (plan.state === 'draft') await this.waitForOwner(plan.id, { by: 'board', summary: reason });
    } catch (error) {
      this.setShortLived(row.task, { error: why(error), next_try: now + RETRY_MS });
    }
  },

  /** The environment is gone: its row goes, with an audit entry, and the request stays as removed. */
  shortLivedGone(row, env, summary) {
    this.ctx.storage.transactionSync(() => {
      if (env) {
        this.sql.exec('DELETE FROM infra_environments WHERE id = ?', env.id);
        this.appendInfraAudit({
          kind: 'environment',
          repo: env.repo,
          environment: env.name,
          environmentId: env.id,
          by: 'board',
          outcome: 'removed',
          summary,
        });
        const wid = this.tasks.get(row.task)?.wid ?? null;
        this.infraEvent('environment.removed', env, {
          fields: { state: 'removed', source: 'short-lived', ...(wid ? { task: wid } : {}) },
          dedupe: `removed:${env.id}`,
          cause: { wid },
        });
      }
      this.setShortLived(row.task, { state: 'removed', environment: null, error: null, next_try: null });
    });
  },

  /**
   * From the alarm and the cron: take new requests (open tasks tagged +environment that haven't asked), then move each
   * request on (shortLivedNext). A request that fails says why, and the next tick tries again.
   * @param {number} [now]
   */
  async shortLivedTick(now = Date.now()) {
    let budget = PER_TICK;
    const known = new Set(
      this.sql
        .exec('SELECT task FROM infra_short_lived')
        .toArray()
        .map((r) => r.task),
    );
    for (const [uuid, map] of this.tasks) {
      if (budget <= 0) break;
      if (known.has(uuid) || closedTask(map) || !tagsOf(map).includes(ASK_TAG)) continue;
      budget -= 1;
      try {
        await this.askShortLived(uuid, { by: 'tag' });
      } catch {
        /* refused: the request says why */
      }
    }
    const rows = this.sql.exec("SELECT * FROM infra_short_lived WHERE state <> 'removed' ORDER BY updated").toArray();
    for (const row of rows) {
      if (budget <= 0) break;
      try {
        if (row.state === 'refused') {
          // A tag's request is looked at again in a while: the template or the cap may have changed.
          const map = this.tasks.get(row.task);
          if (row.next_try > now || closedTask(map) || !tagsOf(map).includes(ASK_TAG)) continue;
          budget -= 1;
          try {
            await this.askShortLived(row.task, { by: row.asked_by });
          } catch {
            /* still refused */
          }
          continue;
        }
        budget -= await this.shortLivedStep(row, now);
      } catch (error) {
        this.setShortLived(row.task, { error: why(error), next_try: now + RETRY_MS });
      }
    }
  },

  /** Moves one request on; returns how many provider calls' worth of the tick's budget it took (0 or 1). */
  async shortLivedStep(row, now) {
    const env = row.environment
      ? this.sql.exec('SELECT * FROM infra_environments WHERE id = ?', row.environment).toArray()[0]
      : null;
    const stateOf = (n) =>
      n ? (this.sql.exec('SELECT state FROM infra_plans WHERE n = ?', n).toArray()[0]?.state ?? null) : null;
    const map = this.tasks.get(row.task);
    const closed = closedTask(map);
    const next = shortLivedNext(row, {
      closed,
      environment: Boolean(env),
      createPlan: stateOf(row.create_plan),
      removePlan: stateOf(row.remove_plan),
      now,
    });
    const wid = map?.wid ?? 'its task';
    switch (next) {
      case 'create':
        await this.shortLivedCreate(row, env, now);
        return 1;
      case 'ready':
        this.setShortLived(row.task, { state: 'ready' });
        return 0;
      case 'reject-create':
        this.moveInfraPlan(`plan-${row.create_plan}`, 'rejected', {
          by: 'board',
          summary: `${wid} closed before its environment was made, so it isn’t needed`,
        });
        return 0;
      case 'remove':
        await this.shortLivedRemove(
          row,
          env,
          now,
          closed ? `${wid} closed` : `${wid} has had it for ${Math.round(GRACE_MS / 86_400_000)} days`,
        );
        return 1;
      case 'removed':
        this.shortLivedGone(row, env, env ? `its removal plan-${row.remove_plan} was applied` : 'removed by the owner');
        return 0;
      case 'keep':
        // The owner rejected the removal, or it failed: the environment stays for another grace period.
        this.setShortLived(row.task, {
          state: 'ready',
          remove_plan: null,
          created: now,
          next_try: now + GRACE_MS,
        });
        return 0;
      default:
        return 0;
    }
  },

  /** GET /api/infra/short-lived[?repo=]: every request, newest first, with each repository's template. */
  shortLivedApi({ repo } = {}) {
    return this.run(async () => {
      const slug = repo ? String(repo).trim().toLowerCase() : null;
      const rows = this.sql
        .exec('SELECT * FROM infra_short_lived WHERE (? IS NULL OR repo = ?) ORDER BY created DESC', slug, slug)
        .toArray();
      const repos = slug ? [slug] : this.repos().map((r) => r.slug);
      return {
        status: 200,
        body: {
          shortLived: rows.map((row) => this.shortLivedOut(row)),
          templates: repos.map((r) => this.shortLivedTemplateOut(r)),
        },
      };
    });
  },

  /**
   * POST /api/infra/short-lived/<task>: the owner's press, from the signed-in board only (the worker refuses the
   * bearer token; an agent's `by` is refused here too). Agents ask with the +environment tag instead.
   */
  shortLivedAskApi(ref, body = {}) {
    return this.run(async () => {
      if (body.by !== undefined && body.by !== null && body.by !== '' && body.by !== 'owner')
        throw new AgentError('only the owner asks from the board; an agent tags its task +environment', 403);
      const uuid = this.resolve(ref);
      const row = await this.askShortLived(uuid, { by: 'owner' });
      return { status: 201, body: { shortLived: this.shortLivedOut(row) } };
    });
  },
};
