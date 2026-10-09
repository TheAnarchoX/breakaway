/**
 * TaskStore's environments (docs/specs/IDEA-19-architect.md, "Environments"; BRK-174): Architect's core object, a
 * named target in one of the board's repositories. A fresh install has none. Anyone signed in reads them; adding,
 * renaming, and removing one is the owner's (an agent's `by` is refused), and freeze, production gates, and observe
 * only are the signed-in board's alone (the worker refuses the bearer token). The environment that runs the board's
 * own install is observe only, always.
 */
import { AgentError } from './store-agents.js';
import { personWords } from './store-permissions.js';
import { InputError, resolveRef } from './model.js';
import { install } from './install.js';
import {
  checkEnvironmentKind,
  checkEnvironmentName,
  checkProvider,
  checkSwitch,
  checkTarget,
  environmentView,
  MAX_ENVIRONMENTS,
  runsTheBoard,
} from './infra-environments.js';
import { STAGING_FREEZE_NOTE, pauseSummary } from './infra-pause.js';
import { pipelineOf } from './release.js';

/** Every column after the first version's, so a store from before one was added gains it on start. */
const COLUMNS = {
  provider: 'TEXT',
  target: 'TEXT',
  task: 'TEXT',
  frozen: 'INTEGER NOT NULL DEFAULT 0',
  frozen_at: 'INTEGER',
  gates: 'INTEGER',
  observe_only: 'INTEGER NOT NULL DEFAULT 0',
  // The part it plays in its repository's pipeline, `staging` or `production`, when the board made it for one (BRK-195).
  pipeline: 'TEXT',
};

/** What an agent has always been told: environments are a person's to change (src/permissions.js decides who). */
const OWNER_WORDS = 'only the owner adds, changes, or removes an environment; agents read them';

/**
 * The fields an owner's change can move, in the audit trail's words, and how each value reads there.
 * @type {Array<[string, string, (v: any) => string]>}
 */
const CHANGED = [
  ['name', 'name', (v) => v],
  ['kind', 'kind', (v) => v],
  ['provider', 'provider', (v) => v ?? 'none'],
  ['target', 'target', (v) => v ?? 'none'],
  ['gates', 'production gates', (v) => (v ? 'on' : 'off')],
  ['observe_only', 'observe only', (v) => (v ? 'on' : 'off')],
];

/** What an owner's change moved, in words, or '' when it moved nothing the audit trail records (BRK-229). */
function changedWords(before, after) {
  return CHANGED.filter(([key]) => (before[key] ?? null) !== (after[key] ?? null))
    .map(([key, words, read]) => `${words} ${read(before[key])} → ${read(after[key])}`)
    .join('; ');
}

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraEnvironmentsMethods = {
  initInfraEnvironments() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS infra_environments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
        created INTEGER NOT NULL, edited INTEGER NOT NULL
      );
    `);
    const have = new Set(
      this.sql
        .exec('PRAGMA table_info(infra_environments)')
        .toArray()
        .map((c) => c.name),
    );
    for (const [column, type] of Object.entries(COLUMNS))
      if (!have.has(column)) this.sql.exec(`ALTER TABLE infra_environments ADD COLUMN ${column} ${type}`);
    // A row from before production gates were stored gets its kind's default.
    this.sql.exec("UPDATE infra_environments SET gates = (kind = 'production') WHERE gates IS NULL");
    this.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS infra_environments_name ON infra_environments (repo, name)');
  },

  /**
   * What an environment with no target is planned with from its desired state (BRK-309): `{ name, file, problem }`, or
   * null when it has a target, is observe only, or has no desired state.
   */
  desiredTargetView(row) {
    if (row.target || row.observe_only || !this.desiredStateFor(row)) return null;
    const at = this.desiredTargetOf(row);
    return { name: at.target, file: `${row.name}.json`, problem: at.problem ?? null };
  },

  environmentOut(row) {
    const map = row.task ? this.tasks.get(row.task) : null;
    const task = map ? { uuid: row.task, wid: map.wid ?? null, description: map.description ?? '' } : null;
    // The plan waiting for the owner (BRK-178) and the drift (BRK-184), so the card shows them without a second call.
    return {
      ...environmentView(row, { worker: install(this.env).worker, task }),
      waitingPlan: this.waitingInfraPlan(row.id),
      // With no target, the one its merged desired state makes, which Compare plans with (BRK-309), or why there's none.
      desiredTarget: this.desiredTargetView(row),
      ...this.driftFor(row.id),
      // Whether DEPLOYS_PAUSED on GitHub matches a pipeline production's freeze (BRK-236), else null.
      deploysPaused: this.deployPause(row),
      // What nobody owns there (BRK-201): flagged, and proposed for removal after the grace period.
      ...this.unownedFor(row.id),
      // What the deploy flow runs there (BRK-195): the live commit and version, and the last deploy.
      deploys: this.environmentDeploys(row),
    };
  },

  /** An environment by its ID, or by its name (within `repo` when more than one repository has it). */
  environmentRow(ref, repo) {
    const value = String(ref ?? '').trim();
    if (/^\d{1,9}$/u.test(value)) {
      const row = this.sql.exec('SELECT * FROM infra_environments WHERE id = ?', Number(value)).toArray()[0];
      if (row) return row;
    } else {
      const rows = this.sql
        .exec(
          'SELECT * FROM infra_environments WHERE name = ? AND (? IS NULL OR repo = ?)',
          value.toLowerCase(),
          repo ?? null,
          repo ?? null,
        )
        .toArray();
      if (rows.length > 1)
        throw new AgentError(
          `${rows.map((r) => r.repo).join(' and ')} each have an environment called ${value}: say which with ?repo=`,
          409,
        );
      if (rows[0]) return rows[0];
    }
    throw new AgentError(`no environment ${value.slice(0, 40)}${repo ? ` in ${repo}` : ''}`, 404);
  },

  /** A task given as the owner of a short-lived environment → its UUID, in the environment's own repository. */
  environmentTask(value, repo, kind) {
    if (value === null || value === '') return null;
    if (kind !== 'short-lived')
      throw new InputError('only a short-lived environment has a task that owns it; production and staging don’t');
    const uuid = resolveRef(value, this.tasks);
    if (!uuid) throw new InputError(`no task ${String(value).slice(0, 40)}`);
    const own = this.repoOfTask(this.tasks.get(uuid))?.slug;
    if (own !== repo)
      throw new InputError(
        `${this.tasks.get(uuid).wid ?? String(value)} is ${own}’s, and this environment is ${repo}’s`,
      );
    return uuid;
  },

  nameTaken(repo, name, id = null) {
    const row = this.sql.exec('SELECT id FROM infra_environments WHERE repo = ? AND name = ?', repo, name).toArray()[0];
    if (row && row.id !== id) throw new AgentError(`${repo} already has an environment called ${name}`, 409);
  },

  /** GET /api/infra/environments[?repo=]: every environment, by repository then name. */
  environmentsApi({ repo } = {}) {
    return this.run(async () => {
      const slug = repo ? String(repo).trim().toLowerCase() : null;
      const rows = this.sql
        .exec('SELECT * FROM infra_environments WHERE (? IS NULL OR repo = ?) ORDER BY repo, name', slug, slug)
        .toArray();
      return { status: 200, body: { environments: rows.map((row) => this.environmentOut(row)) } };
    });
  },

  environmentApi(ref, { repo } = {}) {
    return this.run(async () => ({
      status: 200,
      body: {
        environment: this.environmentOut(this.environmentRow(ref, repo ? String(repo).trim().toLowerCase() : null)),
      },
    }));
  },

  /** POST /api/infra/environments: the owner's. `gates` and `observeOnly` only come from the signed-in board. */
  environmentsCreateApi(body = {}) {
    return this.run(async () => {
      this.allowOn(body, 'environment.write', () => this.checkRepoSlug(body.repo), OWNER_WORDS);
      const repo = this.checkRepoSlug(body.repo);
      const name = checkEnvironmentName(body.name);
      const kind = checkEnvironmentKind(body.kind);
      const provider = checkProvider(body.provider);
      const target = checkTarget(body.target);
      const task = body.task === undefined ? null : this.environmentTask(body.task, repo, kind);
      const gates = body.gates === undefined ? kind === 'production' : checkSwitch(body.gates, 'gates');
      const observeOnly = body.observeOnly === undefined ? false : checkSwitch(body.observeOnly, 'observeOnly');
      this.nameTaken(repo, name);
      const count = this.sql.exec('SELECT COUNT(*) AS n FROM infra_environments WHERE repo = ?', repo).one().n;
      if (count >= MAX_ENVIRONMENTS)
        throw new AgentError(`${repo} has ${MAX_ENVIRONMENTS} environments already: remove one first`, 409);
      const now = Date.now();
      const row = this.sql
        .exec(
          'INSERT INTO infra_environments (repo, name, kind, provider, target, task, frozen, gates, observe_only, created, edited) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?) RETURNING *',
          repo,
          name,
          kind,
          provider,
          target,
          task,
          gates ? 1 : 0,
          observeOnly || runsTheBoard({ target }, install(this.env).worker) ? 1 : 0,
          now,
          now,
        )
        .one();
      // Adding, changing, and removing one goes in the audit trail too (BRK-229): it's where a plan applies.
      this.appendInfraAudit({
        kind: 'environment',
        repo,
        environment: row.name,
        environmentId: row.id,
        ...this.pressedBy(body),
        outcome: 'added',
        summary: `added by ${personWords(this.pressedBy(body).person)}: ${row.kind}, ${row.provider ?? 'no provider'} ${row.target ?? 'no target'}${row.observe_only ? ', observe only' : ''}`,
      });
      this.infraEvent('environment.created', row, { fields: { state: 'added' }, dedupe: `added:${row.id}` });
      return { status: 201, body: { environment: this.environmentOut(row) } };
    });
  },

  /**
   * PATCH /api/infra/environments/<id>: the owner's. `frozen`, `gates`, and `observeOnly` only come from the signed-in
   * board (the worker checks). The board's own install's environment keeps its target and stays observe only.
   */
  environmentsModifyApi(ref, body = {}) {
    return this.run(async () => {
      const where = body.repo ? String(body.repo).trim().toLowerCase() : null;
      this.allowOn(body, 'environment.write', () => this.environmentRow(ref, where).repo, OWNER_WORDS);
      if (body.frozen !== undefined)
        this.allowOn(body, 'environment.freeze', () => this.environmentRow(ref, where).repo);
      const row = this.environmentRow(ref, where);
      const worker = install(this.env).worker;
      const own = runsTheBoard(row, worker);
      const next = { ...row };
      if (body.name !== undefined) next.name = checkEnvironmentName(body.name);
      if (body.kind !== undefined) next.kind = checkEnvironmentKind(body.kind);
      if (body.provider !== undefined) next.provider = checkProvider(body.provider);
      if (body.target !== undefined) next.target = checkTarget(body.target);
      if (body.task !== undefined) next.task = this.environmentTask(body.task, row.repo, next.kind);
      else if (next.kind !== 'short-lived') next.task = null;
      if (body.gates !== undefined) next.gates = checkSwitch(body.gates, 'gates') ? 1 : 0;
      if (body.observeOnly !== undefined) next.observe_only = checkSwitch(body.observeOnly, 'observeOnly') ? 1 : 0;
      if (body.frozen !== undefined) {
        const frozen = checkSwitch(body.frozen, 'frozen');
        if (frozen !== Boolean(row.frozen)) {
          next.frozen = frozen ? 1 : 0;
          next.frozen_at = frozen ? Date.now() : null;
        }
      }
      if (own && next.target !== row.target)
        throw new AgentError(
          `${row.name} runs this board, so it stays pointed at it and observe only: add another environment instead`,
          409,
        );
      if (own && !next.observe_only)
        throw new AgentError(
          `${row.name} runs this board, so it’s always observe only: the board never applies to itself`,
          409,
        );
      if (runsTheBoard(next, worker)) next.observe_only = 1;
      if (next.name !== row.name) this.nameTaken(row.repo, next.name, row.id);
      const updated = this.sql
        .exec(
          'UPDATE infra_environments SET name = ?, kind = ?, provider = ?, target = ?, task = ?, frozen = ?, frozen_at = ?, gates = ?, observe_only = ?, edited = ? WHERE id = ? RETURNING *',
          next.name,
          next.kind,
          next.provider,
          next.target,
          next.task,
          next.frozen,
          next.frozen_at,
          next.gates,
          next.observe_only,
          Date.now(),
          row.id,
        )
        .one();
      const moved = changedWords(row, updated);
      if (moved)
        this.appendInfraAudit({
          kind: 'environment',
          repo: updated.repo,
          environment: updated.name,
          environmentId: updated.id,
          ...this.pressedBy(body),
          outcome: 'changed',
          summary: `changed by ${personWords(this.pressedBy(body).person)}: ${moved}`,
        });
      if (next.frozen === row.frozen) return { status: 200, body: { environment: this.environmentOut(updated) } };
      // One switch with DEPLOYS_PAUSED (BRK-236): the board's freeze already holds; then the pipeline's production
      // sets the variable, outside any transaction. Staging's freeze stops only plans, and says so.
      const frozen = Boolean(updated.frozen);
      const pause = this.deployPause(updated) ? await this.writeDeployPause(updated.repo, frozen) : null;
      const note =
        updated.pipeline === 'staging' && frozen && pipelineOf(this.repoBySlug(updated.repo))
          ? STAGING_FREEZE_NOTE
          : null;
      // A freeze or thaw goes in the audit trail (BRK-175, BRK-232), with what became of the pause.
      this.appendInfraAudit({
        kind: 'freeze',
        repo: updated.repo,
        environment: updated.name,
        environmentId: updated.id,
        ...this.pressedBy(body),
        outcome: frozen ? 'on' : 'off',
        ...(pause ? { summary: pauseSummary(frozen, pause) } : note ? { summary: note } : {}),
      });
      return { status: 200, body: { environment: this.environmentOut(updated), pause, note } };
    });
  },

  /** DELETE /api/infra/environments/<id>: the owner's; a frozen one stays until it's unfrozen. */
  environmentsDeleteApi(ref, body = {}) {
    return this.run(async () => {
      this.allowOn(
        body,
        'environment.write',
        () => this.environmentRow(ref, body.repo ? String(body.repo).trim().toLowerCase() : null).repo,
        OWNER_WORDS,
      );
      const row = this.environmentRow(ref, body.repo ? String(body.repo).trim().toLowerCase() : null);
      if (row.frozen)
        throw new AgentError(`${row.name} is frozen: unfreeze it first, on the board, if you mean to remove it`, 409);
      this.sql.exec('DELETE FROM infra_environments WHERE id = ?', row.id);
      this.appendInfraAudit({
        kind: 'environment',
        repo: row.repo,
        environment: row.name,
        environmentId: row.id,
        ...this.pressedBy(body),
        outcome: 'removed',
        summary: `removed by ${personWords(this.pressedBy(body).person)}`,
      });
      this.infraEvent('environment.removed', row, { fields: { state: 'removed' }, dedupe: `removed:${row.id}` });
      return { status: 200, body: { removed: this.environmentOut(row) } };
    });
  },
};
