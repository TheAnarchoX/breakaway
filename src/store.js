/**
 * TaskStore: the board's TaskChampion sync server and a replica of its tasks, in one SQLite
 * Durable Object (there is one instance, for the install's one client ID).
 *
 * As a sync server it follows taskchampion-sync-server (core/src/server.rs): a linear chain
 * of encrypted versions, each the child of the one before, plus the latest snapshot.
 *
 * As a replica it holds the derived sync key, decrypts every version as it's added, and keeps
 * the resulting tasks in the `tasks` table for the API and web app. Changes from the API are
 * written as ordinary encrypted versions, so every `task sync` picks them up.
 *
 * Every method that changes state runs synchronously after its first await, so Durable Object
 * input gates keep requests from interleaving: a claim is checked and set in one step.
 */
import { DurableObject } from 'cloudflare:workers';
import { NIL, isUuid, keyFromBase64, seal, unseal } from './crypto.js';
import { applyOp, decodeSegment, encodeSegment, encodeSnapshot } from './ops.js';
import {
  EARLIER,
  InputError,
  relatedOf,
  RefError,
  diffOps,
  nextWid,
  rank,
  resolveRef,
  view,
  withChanges,
} from './model.js';
import { secret } from './secrets.js';
import { githubMethods } from './store-github.js';
import { packagesMethods } from './store-packages.js';
import { DecisionError, summarize, validateAnswers } from './decision.js';
import { AgentError, agentsMethods, isRoutineMaker } from './store-agents.js';
import { routinesMethods } from './store-routines.js';
import { featuresMethods } from './store-features.js';
import { chaseMethods } from './store-chase.js';
import { attachmentsMethods } from './store-attachments.js';
import { pingsMethods } from './store-pings.js';
import { pushMethods } from './store-push.js';
import { messagesMethods } from './store-messages.js';
import { pelotonMethods } from './store-peloton.js';
import { specsMethods } from './store-specs.js';
import { pipelineMethods } from './store-pipeline.js';
import { statsMethods } from './store-stats.js';
import { reposMethods } from './store-repos.js';
import { repoSlugOf, SHARED_AREAS } from './repos.js';
import { connectionsMethods } from './store-connections.js';
import { infraSignalsMethods } from './store-infra-signals.js';
import { infraDeploySignalsMethods } from './store-infra-deploy-signals.js';
import { infraRunbooksMethods } from './store-infra-runbooks.js';
import { infraIncidentsMethods } from './store-infra-incidents.js';
import { githubStatusMethods } from './store-github-status.js';
import { selfUpdateMethods } from './store-selfupdate.js';
import { updatesMethods } from './store-updates.js';
import { wizardMethods } from './store-wizard.js';
import { kickoffsMethods } from './store-kickoffs.js';
import { isKickoffIdea } from './kickoff.js';
import { initMethods } from './store-init.js';
import { routineKeepMethods } from './store-routine-keep.js';
import { infraAuditMethods } from './store-infra-audit.js';
import { oauthMethods } from './store-oauth.js';
import { infraEnvironmentsMethods } from './store-infra-environments.js';
import { infraDeploysMethods } from './store-infra-deploys.js';
import { infraDesiredMethods } from './store-infra-desired.js';
import { infraInventoryMethods } from './store-infra-inventory.js';
import { infraLocksMethods } from './store-infra-locks.js';
import { infraCheckMethods } from './store-infra-check.js';
import { infraPlansMethods } from './store-infra-plans.js';
import { infraApprovalsMethods } from './store-infra-approvals.js';
import { infraPolicyMethods } from './store-infra-policy.js';
import { infraPullsMethods } from './store-infra-pulls.js';
import { infraDriftMethods } from './store-infra-drift.js';
import { infraBreakGlassMethods } from './store-infra-break-glass.js';
import { infraAdoptMethods } from './store-infra-adopt.js';
import { infraRunsMethods } from './store-infra-runs.js';
import { infraEnvelopesMethods } from './store-infra-envelopes.js';
import { infraCurrencyMethods } from './store-infra-currency.js';

/** Our own snapshot after this many versions, so replicas never have to send one. */
const SNAPSHOT_EVERY = 50;
/** Taskwarrior asks for a snapshot after these many versions or days (sync server defaults). */
const SNAPSHOT_VERSIONS = 100;
const SNAPSHOT_DAYS = 14;

const ok = (body, status = 200) => ({ status, body });
const fail = (status, message, extra = {}) => ({ status, body: { error: message, ...extra } });

/** The mixins in store-*.js add the rest of its methods, which the checker cannot see. */
export class TaskStore extends /** @type {new (ctx: any, env: any) => DurableObject & Record<string, any>} */ (
  DurableObject
) {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id TEXT NOT NULL UNIQUE,
        parent_version_id TEXT NOT NULL UNIQUE,
        segment BLOB NOT NULL,
        source TEXT NOT NULL,
        created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshot (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version_id TEXT NOT NULL,
        created INTEGER NOT NULL,
        versions_since INTEGER NOT NULL,
        data BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (uuid TEXT PRIMARY KEY, data TEXT NOT NULL);
    `);
    this.tasks = null;
    this.key = null;
    this.initGitHub();
    this.initPackages();
    this.initAgents();
    this.initRoutines();
    this.initFeatures();
    this.initChase();
    this.initAttachments();
    this.initPings();
    this.initPush();
    this.initMessages();
    this.initPeloton();
    this.initStats();
    this.initRepos();
    this.initConnections();
    this.initInfraSignals();
    this.initInfraRunbooks();
    this.initInfraIncidents();
    this.initKickoffs();
    this.initRoutineKeep();
    this.initOAuth();
    this.initInfraEnvironments();
    this.initInfraDesired();
    this.initInfraInventory();
    this.initInfraLocks();
    this.initInfraAudit();
    this.initInfraPlans();
    this.initInfraApprovals();
    this.initInfraDeploys();
    this.initInfraPolicy();
    this.initInfraPulls();
    this.initInfraDrift();
    this.initInfraBreakGlass();
    this.initInfraRuns();
    this.initInfraEnvelopes();
  }

  // ---- storage helpers -------------------------------------------------------------------

  meta(key) {
    return this.sql.exec('SELECT value FROM meta WHERE key = ?', key).toArray()[0]?.value ?? null;
  }

  setMeta(key, value) {
    if (value === null) this.sql.exec('DELETE FROM meta WHERE key = ?', key);
    else this.sql.exec('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', key, String(value));
  }

  latest() {
    return this.meta('latest_version_id') ?? NIL;
  }

  snapshotRow() {
    return this.sql.exec('SELECT version_id, created, versions_since FROM snapshot WHERE id = 1').toArray()[0] ?? null;
  }

  loadTasks() {
    if (!this.tasks) {
      this.tasks = new Map();
      for (const row of this.sql.exec('SELECT uuid, data FROM tasks')) this.tasks.set(row.uuid, JSON.parse(row.data));
    }
    return this.tasks;
  }

  saveTasks(uuids) {
    for (const uuid of uuids) {
      const map = this.tasks.get(uuid);
      if (map) this.sql.exec('INSERT OR REPLACE INTO tasks (uuid, data) VALUES (?, ?)', uuid, JSON.stringify(map));
      else {
        this.sql.exec('DELETE FROM tasks WHERE uuid = ?', uuid);
        this.sql.exec('DELETE FROM attachments WHERE task = ?', uuid);
      }
    }
  }

  /**
   * The sync credentials in use. They start as the Secrets Store values; after a rotation
   * (`rekey`) the Durable Object keeps the new ones itself, so the switch is atomic with the
   * re-encryption, and the Secrets Store is updated to match afterwards (health shows drift).
   */
  async credentials() {
    const [envClientId, envKey] = await Promise.all([
      secret(this.env, 'TASKS_CLIENT_ID'),
      secret(this.env, 'TASKS_SYNC_KEY'),
    ]);
    return {
      clientId: (this.meta('client_id') ?? envClientId).trim().toLowerCase(),
      key: (this.meta('sync_key') ?? envKey).trim(),
      secretsStoreInSync:
        !this.meta('client_id') ||
        (this.meta('client_id') === envClientId.trim().toLowerCase() && this.meta('sync_key') === envKey.trim()),
    };
  }

  async ready() {
    const { clientId, key } = await this.credentials();
    this.activeClientId = clientId;
    this.key ??= keyFromBase64(key);
    this.loadTasks();
  }

  /** Whether a replica's X-Client-Id is the install's current one. */
  async allowsClient(clientId) {
    const allowed = clientId === (await this.credentials()).clientId;
    if (allowed) this.connectionsReplicaSeen();
    return allowed;
  }

  /**
   * Rotates the sync credentials without losing history: every stored version and the snapshot
   * are decrypted with the current key and sealed again with the new one, keeping their version
   * IDs, in one transaction. Replicas keep syncing from where they were once they have the new
   * client ID and secret; the old ones get a 403.
   */
  async rekey(clientId, keyBase64) {
    await this.ready();
    if (!isUuid(clientId)) return fail(400, 'the new client ID must be a UUID');
    let newKey;
    try {
      newKey = keyFromBase64(keyBase64 ?? '');
    } catch {
      return fail(400, 'the new sync key must be 32 bytes in base64');
    }
    if (this.meta('replica_error'))
      return fail(
        409,
        "the task server can't read all of its history, so it can't re-encrypt it; fix that first (docs/tasks.md)",
      );
    const current = await this.credentials();
    if (clientId.toLowerCase() === current.clientId) return fail(400, 'use a new client ID');
    // Routines kept on the board are sealed with a key from the sync key (BRK-133): sealed again here, written below.
    const routines = await this.resealedRoutines(keyBase64.trim());
    const providerTokens = await this.resealedProviderTokens(keyBase64.trim());
    let count = 0;
    try {
      this.atomically(() => {
        for (const row of this.sql.exec('SELECT version_id, parent_version_id, segment FROM versions').toArray()) {
          const plain = unseal(this.key, row.parent_version_id, new Uint8Array(row.segment));
          this.sql.exec(
            'UPDATE versions SET segment = ? WHERE version_id = ?',
            seal(newKey, row.parent_version_id, plain),
            row.version_id,
          );
          count += 1;
        }
        const snap = this.sql.exec('SELECT version_id, data FROM snapshot WHERE id = 1').toArray()[0];
        if (snap) {
          const plain = unseal(this.key, snap.version_id, new Uint8Array(snap.data));
          this.sql.exec('UPDATE snapshot SET data = ? WHERE id = 1', seal(newKey, snap.version_id, plain));
        }
        for (const r of routines) this.sql.exec('UPDATE kept_routines SET sealed = ? WHERE slug = ?', r.sealed, r.slug);
        for (const t of providerTokens)
          this.sql.exec('UPDATE infra_connections SET sealed = ? WHERE provider = ?', t.sealed, t.provider);
        this.setMeta('client_id', clientId.toLowerCase());
        this.setMeta('sync_key', keyBase64.trim());
        this.setMeta('rekeyed_at', new Date().toISOString());
      });
    } catch (error) {
      return fail(500, `nothing changed: couldn't re-encrypt version ${count + 1} (${error.message})`);
    }
    this.key = newKey;
    this.activeClientId = clientId.toLowerCase();
    return ok({ versions: count, snapshot: Boolean(this.snapshotRow()) });
  }

  /**
   * Runs `fn` in one SQLite transaction. The in-memory task map is changed inside it too, so if
   * the transaction rolls back, the map is dropped and reloaded from SQLite on next use.
   */
  atomically(fn) {
    try {
      return this.ctx.storage.transactionSync(fn);
    } catch (error) {
      this.tasks = null;
      this.loadTasks();
      throw error;
    }
  }

  /** Stores a version as the new latest and counts it towards the next snapshot. */
  insertVersion(versionId, parentVersionId, segment, source) {
    this.sql.exec(
      'INSERT INTO versions (version_id, parent_version_id, segment, source, created) VALUES (?, ?, ?, ?, ?)',
      versionId,
      parentVersionId,
      segment,
      source,
      Date.now(),
    );
    this.setMeta('latest_version_id', versionId);
    this.sql.exec('UPDATE snapshot SET versions_since = versions_since + 1 WHERE id = 1');
  }

  /** Applies decrypted operations to the replica. */
  applyOps(ops) {
    const touched = new Set();
    for (const op of ops) if (applyOp(this.tasks, op)) touched.add(op.uuid);
    this.saveTasks(touched);
  }

  /** Writes our own changes as a new version, sealed like any replica's. `source`: api or github. */
  commit(ops, source = 'api') {
    if (!ops.length) return;
    const parent = this.latest();
    const versionId = crypto.randomUUID();
    this.atomically(() => {
      this.insertVersion(versionId, parent, seal(this.key, parent, encodeSegment(ops)), source);
      this.applyOps(ops);
    });
    this.maybeSnapshot();
    this.scheduleAgentsCheck();
  }

  /** Takes our own snapshot when there's none or it's getting old, unless the replica is broken. */
  maybeSnapshot() {
    if (this.meta('replica_error')) return;
    const snap = this.snapshotRow();
    if (snap && snap.versions_since < SNAPSHOT_EVERY) return;
    const versionId = this.latest();
    if (versionId === NIL) return;
    const data = seal(this.key, versionId, encodeSnapshot(this.tasks));
    this.sql.exec(
      'INSERT OR REPLACE INTO snapshot (id, version_id, created, versions_since, data) VALUES (1, ?, ?, 0, ?)',
      versionId,
      Date.now(),
      data,
    );
  }

  urgency() {
    const snap = this.snapshotRow();
    if (!snap) return 'high';
    const days = (Date.now() - snap.created) / 86_400_000;
    const level = (value, limit) => (value >= limit * 1.5 ? 2 : value >= limit ? 1 : 0);
    return ['none', 'low', 'high'][Math.max(level(days, SNAPSHOT_DAYS), level(snap.versions_since, SNAPSHOT_VERSIONS))];
  }

  // ---- the sync protocol -----------------------------------------------------------------

  async getChildVersion(parentVersionId) {
    const row = this.sql
      .exec('SELECT version_id, parent_version_id, segment FROM versions WHERE parent_version_id = ?', parentVersionId)
      .toArray()[0];
    if (row)
      return {
        status: 'ok',
        versionId: row.version_id,
        parentVersionId: row.parent_version_id,
        segment: new Uint8Array(row.segment),
      };
    const latest = this.latest();
    if (latest === parentVersionId || latest === NIL) return { status: 'notfound' };
    // The board never deletes a version, so the replica's base came from another server (CLD-195):
    // it can't sync again, only start over. Taskwarrior shows just "410 Gone", so Connections says so.
    this.connectionsReplicaGone();
    return { status: 'gone' };
  }

  async addVersion(clientId, parentVersionId, segment) {
    await this.ready();
    // Checked here, after the last await, so a rotation can't slip in between check and store.
    if (clientId !== this.activeClientId) return { status: 'forbidden' };
    const latest = this.latest();
    if (latest !== NIL && parentVersionId !== latest) return { status: 'conflict', expected: latest };
    const versionId = crypto.randomUUID();
    this.atomically(() => {
      this.insertVersion(versionId, parentVersionId, segment, 'replica');
      if (this.meta('replica_error')) return;
      try {
        this.applyOps(decodeSegment(unseal(this.key, parentVersionId, segment)));
      } catch (error) {
        // Still a valid version for the other replicas; we just can't read it. Health says so.
        this.setMeta('replica_error', `can't read version ${versionId}: ${error.message}`);
      }
    });
    this.assignMissingWids();
    this.maybeSnapshot();
    this.scheduleAgentsCheck();
    return { status: 'ok', versionId, urgency: this.urgency() };
  }

  async addSnapshot(clientId, versionId, data) {
    await this.ready();
    if (clientId !== this.activeClientId) return { status: 'forbidden' };
    const snap = this.snapshotRow();
    if (snap?.version_id === versionId) return { status: 'ok' };
    // Accept it only for one of the last few versions, newer than the snapshot we have.
    let vid = this.latest();
    for (let steps = 5; ; steps -= 1) {
      if (vid === versionId && versionId !== NIL) break;
      if (vid === snap?.version_id || steps <= 1 || vid === NIL) return { status: 'ok' };
      const parent = this.sql.exec('SELECT parent_version_id FROM versions WHERE version_id = ?', vid).toArray()[0];
      if (!parent) return { status: 'ok' };
      vid = parent.parent_version_id;
    }
    this.sql.exec(
      'INSERT OR REPLACE INTO snapshot (id, version_id, created, versions_since, data) VALUES (1, ?, ?, 0, ?)',
      versionId,
      Date.now(),
      data,
    );
    return { status: 'ok' };
  }

  async getSnapshot() {
    const row = this.sql.exec('SELECT version_id, data FROM snapshot WHERE id = 1').toArray()[0];
    return row ? { versionId: row.version_id, data: new Uint8Array(row.data) } : null;
  }

  // ---- the replica -----------------------------------------------------------------------

  /** Tasks added with `task add` in a known project get the next work ID, as a follow-up version. */
  assignMissingWids() {
    if (this.meta('replica_error')) return;
    const now = new Date();
    const working = new Map([...this.tasks].map(([uuid, map]) => [uuid, { ...map }]));
    const ops = [];
    for (const [uuid, map] of [...working].sort(([, a], [, b]) => Number(a.entry ?? 0) - Number(b.entry ?? 0))) {
      if (map.wid || map.status !== 'pending') continue;
      // The area's prefix in the task's repository (none in its `repo` means the default one).
      const prefix = this.prefixOfTask(map);
      if (!prefix) continue;
      const after = { ...map, wid: nextWid(prefix, working), modified: String(Math.floor(now.getTime() / 1000)) };
      working.set(uuid, after);
      ops.push(...diffOps(uuid, map, after, now.toISOString()));
    }
    this.commit(ops);
  }

  /** Rebuilds the tasks table from every version, after fixing the sync key. */
  async rebuild() {
    await this.ready();
    const tasks = new Map();
    let count = 0;
    try {
      for (const row of this.sql.exec('SELECT version_id, parent_version_id, segment FROM versions ORDER BY seq')) {
        const ops = decodeSegment(unseal(this.key, row.parent_version_id, new Uint8Array(row.segment)));
        for (const op of ops) applyOp(tasks, op);
        count += 1;
      }
    } catch (error) {
      return fail(500, `rebuild stopped after ${count} versions: ${error.message}`);
    }
    this.atomically(() => {
      this.sql.exec('DELETE FROM tasks');
      this.tasks = tasks;
      this.saveTasks(tasks.keys());
      this.setMeta('replica_error', null);
    });
    this.sql.exec('UPDATE snapshot SET versions_since = ? WHERE id = 1', SNAPSHOT_EVERY);
    this.maybeSnapshot();
    return ok({ versions: count, tasks: tasks.size });
  }

  views(filter = (/** @type {any} */ _t) => true) {
    const now = new Date();
    const blocking = new Map();
    const links = this.githubLinks();
    const agents = this.agentLinks();
    const shipped = this.shippedLinks();
    const fallback = this.defaultRepoSlug();
    const all = [...this.tasks].map(([uuid, map]) => {
      const github = this.githubFor(map, links);
      return {
        ...view(uuid, map, this.tasks, now),
        repo: map.repo || fallback,
        github,
        shipped: shipped.get(map.wid)?.live ?? null,
        staged: shipped.get(map.wid)?.staging ?? null,
        ships: shipped.get(map.wid)?.list ?? [],
        agentRun: this.agentFor(uuid, map, agents, github),
      };
    });
    for (const task of all) {
      if (task.status !== 'pending') continue;
      for (const dep of task.depends) blocking.set(dep, [...(blocking.get(dep) ?? []), task.uuid]);
    }
    return all.filter(filter).map((task) => ({ ...task, blocking: blocking.get(task.uuid) ?? [] }));
  }

  resolve(ref, tasks = this.tasks) {
    const uuid = resolveRef(ref, tasks);
    if (!uuid) throw new NotFound(`no task "${ref}"`);
    return uuid;
  }

  detail(uuid) {
    const task = this.views((t) => t.uuid === uuid)[0];
    const brief = (id) => {
      const map = this.tasks.get(id);
      return {
        uuid: id,
        wid: map?.wid ?? null,
        description: map?.description ?? '(missing task)',
        status: map?.status ?? 'missing',
      };
    };
    const relatedBy = [...this.tasks]
      .filter(([id, map]) => id !== uuid && relatedOf(map).includes(uuid) && !task.related.includes(id))
      .map(([id]) => id);
    return {
      ...task,
      pings: this.pingsFor(uuid),
      incident: this.incidentOfTask(uuid),
      dependsOn: task.depends.map(brief),
      blockingTasks: task.blocking.map(brief),
      relatedTasks: [...task.related, ...relatedBy].map(brief),
    };
  }

  /**
   * The one-time move to the task structure (IDEA-5, docs/specs/IDEA-5-task-structure.md), and safe to
   * run again. A task without a description whose first note was written within a minute of its
   * creation gets that note copied into `brief` (that note is what it was created with); every
   * note without an author is marked as an earlier note. Nothing is deleted. Returns the counts.
   */
  backfillStructure() {
    this.writable();
    const now = new Date();
    const stamp = now.toISOString();
    const ops = [];
    let briefs = 0;
    let marked = 0;
    for (const [uuid, before] of this.tasks) {
      const after = { ...before };
      const epochs = Object.keys(before)
        .filter((k) => k.startsWith('annotation_'))
        .map((k) => Number(k.slice(11)))
        .sort((a, b) => a - b);
      if (!before.brief && epochs.length && Math.abs(epochs[0] - Number(before.entry ?? 0)) <= 60) {
        after.brief = before[`annotation_${epochs[0]}`];
        briefs += 1;
      }
      for (const epoch of epochs) {
        if (after[`by_${epoch}`] === undefined) {
          after[`by_${epoch}`] = EARLIER;
          marked += 1;
        }
      }
      ops.push(...diffOps(uuid, before, after, stamp));
    }
    this.commit(ops, 'backfill');
    return { briefs, marked };
  }

  /** Runs an API action, turning expected errors into responses. */
  async run(action) {
    await this.ready();
    if (!this.meta('structure_backfilled') && !this.meta('replica_error')) {
      this.backfillStructure();
      this.setMeta('structure_backfilled', new Date().toISOString());
    }
    try {
      return await action();
    } catch (error) {
      if (error instanceof AgentError)
        return fail(error.status, error.message, {
          ...(error.forceable ? { forceable: true } : {}),
          ...(error.path ? { path: error.path } : {}),
        });
      if (error instanceof NotFound) return fail(404, error.message);
      if (error instanceof InputError || error instanceof RefError || error instanceof DecisionError)
        return fail(400, error.message);
      if (error instanceof Conflict) return fail(409, error.message, error.extra);
      if (error instanceof Forbidden) return fail(403, error.message);
      throw error;
    }
  }

  writable() {
    const problem = this.meta('replica_error');
    if (problem) throw new Conflict(`the task server can't read its history right now (${problem}); see docs/tasks.md`);
  }

  /** Applies changes to one task and commits them; returns the new detail. */
  change(uuid, changes, now = new Date(), source = 'api') {
    this.writable();
    const before = this.tasks.get(uuid);
    const after = withChanges(before, changes, now);
    this.commit(diffOps(uuid, before, after, now.toISOString()), source);
    return this.detail(uuid);
  }

  /**
   * Closes the `now` horizon in one version: finished tasks in now go to archive, then next
   * becomes now, then later becomes next. Open tasks in now stay in now. `dryRun` only counts.
   */
  closeHorizon({ dryRun = false } = {}) {
    return this.run(() => {
      this.writable();
      const now = new Date();
      const inHorizon = (h) => [...this.tasks].filter(([, m]) => m.horizon === h);
      const finished = ([, m]) => m.status === 'completed' || m.status === 'deleted';
      const archive = inHorizon('now').filter(finished);
      const carried = inHorizon('now').length - archive.length;
      const moves = [
        ...archive.map(([uuid]) => [uuid, 'archive']),
        ...inHorizon('next').map(([uuid]) => [uuid, 'now']),
        ...inHorizon('later').map(([uuid]) => [uuid, 'next']),
      ];
      const result = {
        archived: archive.length,
        carriedOver: carried,
        movedUp: moves.length - archive.length,
        dryRun: Boolean(dryRun),
      };
      if (dryRun || !moves.length) return ok(result);
      const ops = [];
      for (const [uuid, horizon] of moves) {
        const before = this.tasks.get(uuid);
        ops.push(...diffOps(uuid, before, withChanges(before, { horizon }, now), now.toISOString()));
      }
      this.commit(ops, 'horizon');
      return ok(result);
    });
  }

  depRefs(refs, tasks) {
    return (refs ?? []).map((ref) => this.resolve(ref, tasks));
  }

  // ---- API actions -----------------------------------------------------------------------

  async health() {
    await this.ready();
    const versions = this.sql.exec('SELECT COUNT(*) AS n FROM versions').one().n;
    const snap = this.snapshotRow();
    const pending = [...this.tasks.values()].filter((t) => t.status === 'pending').length;
    return ok({
      ok: !this.meta('replica_error'),
      latestVersion: this.latest(),
      versions,
      tasks: { total: this.tasks.size, pending },
      snapshot: snap
        ? {
            version: snap.version_id,
            created: new Date(snap.created).toISOString(),
            versionsSince: snap.versions_since,
          }
        : null,
      replicaError: this.meta('replica_error'),
      rekeyedAt: this.meta('rekeyed_at'),
      replicaGone: this.meta('conn_replica_gone')
        ? new Date(Number(this.meta('conn_replica_gone'))).toISOString()
        : null,
      secretsStoreInSync: (await this.credentials()).secretsStoreInSync,
      connections: this.connectionsSummary(), // the nav's count (CLD-121), from the last Connections report
    });
  }

  list(status = 'pending') {
    return this.run(() => {
      const want = status === 'all' ? null : status;
      const tasks = this.views((t) => !want || t.status === want);
      if (want === 'pending' || !want) tasks.sort(rank);
      else tasks.sort((a, b) => String(b.end).localeCompare(String(a.end)));
      return ok({ tasks });
    });
  }

  get(ref) {
    return this.run(() => ok({ task: this.detail(this.resolve(ref)) }));
  }

  /**
   * Whether an agent's edit of a task follows the cross-task rule (crossTaskRightsOf): its general task, or a task it
   * holds in an open chase the task is in too. MCP's modify_task leaves the check to update then.
   * @param {string} agent
   * @param {string} ref
   */
  crossTaskRightsApi(agent, ref) {
    return this.run(() => ok({ rights: this.crossTaskRightsOf(agent, this.resolve(ref)) }));
  }

  /** Creates one or more tasks in one version; later items may depend on earlier ones by work ID. */
  create(items) {
    return this.run(() => {
      this.writable();
      const now = new Date();
      const timestamp = now.toISOString();
      const working = new Map([...this.tasks].map(([uuid, map]) => [uuid, { ...map }]));
      const ops = [];
      const created = [];
      for (const item of items) {
        if (!item || typeof item !== 'object') throw new InputError('each task is an object');
        const { tags, depends, related, note, entry, end, ...rest } = item;
        const changes = pick(rest, [
          'brief',
          'done_when',
          'by',
          'description',
          'project',
          'priority',
          'horizon',
          'spec',
          'pr',
          'wid',
          'status',
          'due',
          'wait',
          'scheduled',
          'autostart',
          'alert',
          'decision',
        ]);
        // The task's repository (the default when none is given) decides which areas, and so prefixes, it may have.
        const repo = this.checkRepoSlug(rest.repo);
        const prefix = this.checkAreaPrefix(repo, changes.project);
        changes.repo = this.storedRepo(repo);
        if (changes.wid) {
          changes.wid = String(changes.wid).toUpperCase();
          this.checkWidPrefix(repo, changes.wid);
          if ([...working.values()].some((m) => m.wid === changes.wid)) {
            throw new Conflict(`${changes.wid} already exists`);
          }
        } else if (prefix) {
          changes.wid = nextWid(prefix, working);
        }
        // `note` is the old name for the description: it becomes the brief, and only a second text stays a comment.
        if (note && !changes.brief) changes.brief = String(note);
        const uuid = crypto.randomUUID();
        const after = withChanges(
          null,
          {
            ...changes,
            addTags: arrayOf(tags),
            addDepends: this.depRefs(arrayOf(depends), working),
            addRelated: this.depRefs(arrayOf(related), working),
            ...(note && changes.brief !== String(note) ? { annotate: note } : {}),
            entry: entry ? toSeconds(entry) : undefined,
            end: end ? toSeconds(end) : undefined,
          },
          now,
        );
        working.set(uuid, after);
        ops.push(...diffOps(uuid, null, after, timestamp));
        created.push(uuid);
      }
      this.commit(ops);
      return ok({ tasks: created.map((uuid) => this.detail(uuid)) }, 201);
    });
  }

  update(ref, input) {
    return this.run(() => {
      const uuid = this.resolve(ref);
      const changes = pick(input, [
        'description',
        'brief',
        'done_when',
        'by',
        'project',
        'priority',
        'horizon',
        'spec',
        'pr',
        'wid',
        'status',
        'due',
        'wait',
        'scheduled',
        'annotate',
        'autostart',
        'decision',
      ]);
      const repo = this.repoOfTask(this.tasks.get(uuid))?.slug ?? this.tasks.get(uuid).repo;
      if ('repo' in input && this.checkRepoSlug(input.repo) !== repo)
        throw new InputError('a task stays in its repository; make a new task there and link them with a dependency');
      if (changes.project) {
        const prefix = this.checkAreaPrefix(repo, changes.project);
        const current = this.tasks.get(uuid);
        // An open task with no work ID gets the next one in its area, once, when it gets that area (IDEA-30).
        if (!current.wid && !changes.wid && current.status === 'pending') {
          if (current.tag_general && changes.project in SHARED_AREAS)
            throw new InputError(`pick one of ${repo}'s own areas, not ${changes.project}`);
          changes.wid = nextWid(prefix, this.tasks);
        }
      }
      if (changes.wid) {
        changes.wid = String(changes.wid).toUpperCase();
        this.checkWidPrefix(repo, changes.wid);
        if ([...this.tasks].some(([other, m]) => other !== uuid && m.wid === changes.wid))
          throw new Conflict(`${changes.wid} already exists`);
      }
      if (input.related) {
        changes.addRelated = this.depRefs(arrayOf(input.related));
        changes.removeRelated = relatedOf(this.tasks.get(uuid)).filter((r) => !changes.addRelated.includes(r));
      }
      // A general agent editing another task (IDEA-30 section 2), or a chase agent editing another of its chase's
      // (IDEA-36 section 6), follows the cross-task rule instead.
      const general = this.crossTaskRightsOf(changes.by, uuid);
      if (general) {
        this.checkCrossTaskEdit(uuid, input, general);
        // The description stays the owner's when an agent rewrites it this way, so it never becomes one the agent made.
        if ('brief' in changes && !AGENT_NAME.test(this.tasks.get(uuid).brief_by ?? ''))
          Reflect.deleteProperty(changes, 'by');
      } else {
        this.checkBriefEdit(uuid, changes);
        this.checkAgentDelete(uuid, changes);
      }
      this.checkPrField(uuid, changes);
      if (input.addTags) changes.addTags = arrayOf(input.addTags);
      if (input.removeTags) changes.removeTags = arrayOf(input.removeTags);
      if (input.addDepends) changes.addDepends = this.depRefs(arrayOf(input.addDepends));
      if (input.removeDepends) changes.removeDepends = this.depRefs(arrayOf(input.removeDepends));
      if (input.addRelated)
        changes.addRelated = [...new Set([...(changes.addRelated ?? []), ...this.depRefs(arrayOf(input.addRelated))])];
      if (input.removeRelated)
        changes.removeRelated = [
          ...new Set([...(changes.removeRelated ?? []), ...this.depRefs(arrayOf(input.removeRelated))]),
        ];
      if (changes.addRelated?.includes(uuid)) throw new InputError("a task can't be related to itself");
      if (changes.addDepends?.includes(uuid)) throw new InputError("a task can't depend on itself");
      const before = this.detail(uuid);
      const task = this.change(uuid, changes);
      if (general) {
        const fields = CROSS_TASK_FIELDS.filter(([keys]) => keys.some((k) => k in input)).map(([, name]) => name);
        const its = general.wid ?? general.uuid.slice(0, 8);
        const note = changes.status === 'deleted' ? `Deleted by ${its}.` : `Changed by ${its}: ${fields.join(', ')}.`;
        return ok({ task: this.change(uuid, { annotate: note, by: 'board' }) });
      }
      // Editing the questions keeps the answers that still fit; say which ones went.
      if (changes.decision && before.decisionAnswers) {
        const dropped = Object.keys(before.decisionAnswers.answers).filter((id) => !task.decisionAnswers?.answers[id]);
        if (dropped.length)
          return ok({
            task: this.change(uuid, {
              annotate: `The questions changed, so these answers were dropped: ${dropped.join(', ')}.`,
              by: 'board',
            }),
          });
      }
      return ok({ task });
    });
  }

  /**
   * Submits a decision (IDEA-6): the owner's answers are checked against the questions, then in one
   * version stored, +decide removed, the task finished, and a plain summary added as a comment. Only
   * the owner submits: a request with no `by`, or `owner`, is theirs; an agent's name is refused.
   *
   * A kickoff's IDEA asks its decision on itself (BRK-134), so answering it keeps the IDEA open: its plan's pull
   * request closes it. A routine maker's task (BRK-220 section 3) asks on itself the same way and stays open too: its
   * agent finishes it when it hands over. `carryOn` is Send answers and carry on, theirs only: the same answers, then
   * the next run started on the task, or queued for room like any start. A plain Send answers on a routine maker
   * leaves it for a Start. worker.js takes `carryOn` from the signed-in browser only. A routine that isn't connected
   * refuses the press before anything is answered; a start refused after that (Claude said no) keeps the answers,
   * and `refusal` says why, for a Start later.
   */
  submitDecision(ref, body) {
    return this.run(async () => {
      const uuid = this.resolve(ref);
      ownerOnly(body?.by, body?.carryOn ? 'answer a decision and start the next run' : 'answer a decision');
      const task = this.detail(uuid);
      if (!task.decision) throw new InputError(`${label(task)} has no decision to answer`);
      const kickoff = isKickoffIdea(task);
      const maker = isRoutineMaker(task);
      // Both ask on the task their agent holds, so answering keeps it open for the next run.
      const keepOpen = kickoff || maker;
      if (body?.carryOn && !keepOpen)
        throw new InputError(
          `${label(task)} isn't a kickoff's idea or a routine maker's task: send its answers, then start an agent`,
        );
      if (task.status === 'completed' && task.decisionAnswers)
        throw new Conflict(`${label(task)} is already decided; reopen it to change an answer`, { task });
      if (task.status !== 'pending') throw new Conflict(`${label(task)} is ${task.status}`, { task });
      if (keepOpen && !task.tags.includes('decide'))
        throw new Conflict(`${label(task)}'s questions are already answered; reopen them to change an answer`, {
          task,
        });
      if (keepOpen && task.claim)
        throw new Conflict(`${label(task)} is claimed by ${task.claim}; answer once its agent has stopped`, { task });
      const answers = validateAnswers(task.decision, body?.answers);
      // The next run's own checks, before anything is answered: a routine that isn't connected refuses the press.
      const repo = body?.carryOn ? this.repoOfTask(this.tasks.get(uuid)) : null;
      if (repo) await this.checkRoutineReady(repo.slug);
      const answered = this.change(uuid, {
        decisionAnswers: { by: 'owner', at: new Date().toISOString(), answers },
        removeTags: ['decide'],
        ...(keepOpen ? {} : { status: 'completed' }),
        // A routine maker's task was made to start by itself; once answered it waits for carry on or a Start.
        ...(maker ? { autostart: null } : {}),
        claim: null,
        annotate: summarize(task.decision, answers),
        by: 'board',
      });
      if (!body?.carryOn) return ok({ task: answered });
      try {
        const started = await this.startAgent(
          uuid,
          maker ? { trigger: 'routines-carry-on', kind: 'routines' } : { trigger: 'kickoff', kind: 'kickoff' },
        );
        return ok({ ...started, waiting: null });
      } catch (error) {
        // Over the board's limits, or Claude's hourly one: the run waits for room and starts on its own.
        const queued = error instanceof AgentError && (error.forceable || error.status === 429);
        if (!(error instanceof AgentError)) throw error;
        if (!queued) return ok({ task: this.detail(uuid), run: null, waiting: null, refusal: error.message });
        const task = this.change(uuid, { autostart: 'yes' }, new Date(), 'agents');
        this.scheduleAgentsCheck();
        return ok({ task, run: null, waiting: error.message, forceable: Boolean(error.forceable) }, 202);
      }
    });
  }

  /**
   * Reopens a submitted decision: pending with +decide again, answers kept and editable. Owner only. A kickoff's
   * IDEA and a routine maker's task stay open when they're answered, so reopening one only puts +decide back, while
   * no agent holds it.
   */
  reopenDecision(ref, body) {
    return this.run(() => {
      const uuid = this.resolve(ref);
      ownerOnly(body?.by, 'reopen a decision');
      const task = this.detail(uuid);
      if (!task.decision || !task.decisionAnswers)
        throw new Conflict(`${label(task)} has no submitted decision`, { task });
      if ((isKickoffIdea(task) || isRoutineMaker(task)) && task.status === 'pending') {
        if (task.tags.includes('decide')) throw new Conflict(`${label(task)}'s questions are open already`, { task });
        if (task.claim) throw new Conflict(`${label(task)} is claimed by ${task.claim}`, { task });
        return ok({
          task: this.change(uuid, { addTags: ['decide'], annotate: 'Decision reopened by the owner.', by: 'board' }),
        });
      }
      if (task.status !== 'completed')
        throw new Conflict(`${label(task)} isn't decided; it's ${task.status}`, { task });
      return ok({
        task: this.change(uuid, {
          status: 'pending',
          addTags: ['decide'],
          annotate: 'Decision reopened by the owner.',
          by: 'board',
        }),
      });
    });
  }

  /**
   * `repo`, when the CLI sends it, is the checkout's repository (CLD-123): a task of another repository
   * is refused, so an agent can't build breakaway's task in another repository's checkout. `force` doesn't skip it.
   */
  claim(ref, agent, force = false, repo = null) {
    return this.run(() => {
      const uuid = this.resolve(ref);
      if (repo) this.checkClaimRepo(uuid, String(repo).toLowerCase());
      const result = this.claimUuid(uuid, agent, force);
      // The Add a repository wizard's first-task step (CLD-194): the first claim from a checkout of the task's own repository.
      if (repo && !this.meta(`setup_claimed:${String(repo).toLowerCase()}`))
        this.setMeta(`setup_claimed:${String(repo).toLowerCase()}`, uuid);
      return result;
    });
  }

  claimUuid(uuid, agent, force) {
    const name = agentName(agent);
    const task = this.detail(uuid);
    if (task.status !== 'pending') throw new Conflict(`${label(task)} is ${task.status}`, { task });
    if (task.claim === name) return ok({ task });
    if (task.claim && !force)
      throw new Conflict(`${label(task)} is claimed by ${task.claim} since ${task.start ?? 'an unknown time'}`, {
        task,
      });
    if (task.blocked && !force) {
      const by = task.dependsOn.filter((d) => task.blockedBy.includes(d.uuid)).map((d) => d.wid ?? d.uuid.slice(0, 8));
      throw new Conflict(`${label(task)} is blocked by ${by.join(', ')}`, { task });
    }
    return ok({ task: this.change(uuid, { claim: name, start: true }) });
  }

  release(ref, agent, force = false) {
    return this.run(() => {
      const uuid = this.resolve(ref);
      const task = this.detail(uuid);
      const name = agent ? agentName(agent) : null;
      if (task.claim && name !== task.claim && !force)
        throw new Conflict(`${label(task)} is claimed by ${task.claim}, not ${name ?? 'you'}`, { task });
      // A general agent that stops with no pull request has finished: its changes, if any, are on the board. A routine
      // maker that stops with its questions open hasn't: the owner's answers start it again (BRK-220 section 3).
      const asking = isRoutineMaker(task) && task.tags.includes('decide');
      if (task.tags.includes('general') && task.status === 'pending' && !task.pr && !asking)
        return ok({
          task: this.change(uuid, {
            claim: null,
            start: false,
            status: 'completed',
            annotate: 'Closed by the board: the agent released it with no pull request.',
            by: 'board',
          }),
        });
      return ok({ task: this.change(uuid, { claim: null, start: false }) });
    });
  }

  done(ref, note, by) {
    return this.run(() => {
      const uuid = this.resolve(ref);
      if (this.tasks.get(uuid).status === 'completed') return ok({ task: this.detail(uuid) });
      return ok({
        task: this.change(uuid, { status: 'completed', ...(note ? { annotate: note, by: commentAuthor(by) } : {}) }),
      });
    });
  }

  /**
   * Adds a comment (the old `annotate` route is an alias). `by` is who wrote it: the owner when it's empty,
   * an agent's name, or `board` / `routine:<slug>` for what the server writes.
   */
  comment(ref, text, by) {
    return this.run(() => {
      if (!text || !String(text).trim()) throw new InputError('a comment needs text');
      return ok({ task: this.change(this.resolve(ref), { annotate: String(text).trim(), by: commentAuthor(by) }) });
    });
  }

  /**
   * The edit rule for the description and done when (IDEA-5): the owner can edit anywhere; an agent only
   * on a task it made (it wrote the description) or is refining (`*-refine-*`, claimed by it). Everyone
   * else comments. A request with no `by` is the owner's (the web board and the CLI's owner).
   */
  checkBriefEdit(uuid, changes) {
    if (!('brief' in changes) && !('done_when' in changes)) return;
    const by = changes.by ? String(changes.by) : 'owner';
    if (by === 'owner' || by === 'board' || !/^(claude|codex)-/u.test(by)) return;
    const map = this.tasks.get(uuid);
    const refining = /^(claude|codex)-refine-/u.test(by) && map.claim === by;
    const made = map.brief_by === by;
    if (!refining && !made)
      throw new Forbidden(
        'an agent changes the description and done when only on a task it made or is refining; add a comment instead',
      );
  }

  /**
   * Whether an agent other than the task's holder may delete it: only under the chase rule (checkCrossTaskEdit).
   * Every other agent proposes it to the owner in a ping. The owner, the board, and the task's holder are unchanged.
   * @param {string} uuid
   * @param {Record<string, any>} changes
   */
  checkAgentDelete(uuid, changes) {
    if (changes.status !== 'deleted' || !AGENT_NAME.test(String(changes.by ?? ''))) return;
    if (this.tasks.get(uuid).claim === String(changes.by)) return;
    throw new Forbidden(
      `an agent deletes another task only when it's in the agent's open chase and an agent added it after the chase started; propose deleting ${label(this.detail(uuid))} to the owner in a ping instead`,
    );
  }

  /**
   * The task that gives an agent rights over another task, when it edits one: its general task (IDEA-30 section 1),
   * open, tagged general, and claimed by that name; or else a task it holds in an open chase that `uuid` is in too
   * (IDEA-36 section 6), with that chase's start. Null for the owner, the board, another agent, or an edit of its own
   * task.
   * @param {unknown} by
   * @param {string} uuid the task being edited
   * @returns {{ uuid: string, wid: string | null, kind: 'general' | 'chase', chaseStarted?: number } | null}
   */
  crossTaskRightsOf(by, uuid) {
    if (!by || !AGENT_NAME.test(String(by))) return null;
    const held = [...this.tasks].filter(([, m]) => m.claim === String(by) && m.status === 'pending');
    if (held.some(([own]) => own === uuid)) return null;
    for (const [own, m] of held) if (m.tag_general) return { uuid: own, wid: m.wid ?? null, kind: 'general' };
    if (!held.length || !this.chasing()) return null;
    // A chase the agent rides on (its own tasks and the blockers it pulled in) that holds the edited task too.
    let found = null;
    for (const { row, tasks } of this.openChases())
      if (tasks.has(uuid))
        for (const [own, m] of held)
          if (tasks.has(own) && (!found || Number(row.chase_started) < found.chaseStarted))
            found = { uuid: own, wid: m.wid ?? null, kind: 'chase', chaseStarted: Number(row.chase_started) };
    return found;
  }

  /**
   * The cross-task rule (IDEA-30 section 2, BRK-104 decision 1): a general agent may change the description,
   * done when, area, horizon, tags, and dependencies of an unclaimed, open task in its own repository that
   * isn't an idea. Never a horizon-* tag, autostart, or a decision, and nothing else: that goes to the owner
   * as a ping proposal. The board notes each change on the edited task (update).
   *
   * A chase agent has the same rights over its chase's other tasks (IDEA-36 section 6), and one more: it may delete
   * such a task, on its own, when an agent wrote it (`brief_by`) after the chase started. Never finishing one.
   * @param {string} uuid
   * @param {Record<string, any>} input the request's body
   * @param {{ uuid: string, kind: 'general' | 'chase', chaseStarted?: number }} own the agent's task that gives it the right
   */
  checkCrossTaskEdit(uuid, input, own) {
    const who = own.kind === 'chase' ? 'a chase agent' : 'a general agent';
    const refuse = (why) => {
      throw new Forbidden(`${who} ${why}; propose it to the owner in a ping instead`);
    };
    const map = this.tasks.get(uuid);
    const name = label(this.detail(uuid));
    const fallback = this.defaultRepoSlug();
    const ownMap = this.tasks.get(own.uuid);
    if ('decision' in input) refuse(`doesn't change a decision's questions or answers (${name})`);
    if ('autostart' in input) refuse(`doesn't change whether ${name} starts by itself`);
    if (map.status !== 'pending') refuse(`changes only open tasks, and ${name} is ${map.status}`);
    if (map.claim) refuse(`changes only unclaimed tasks, and ${map.claim} has ${name}`);
    if (map.project in SHARED_AREAS) refuse(`doesn't change ${name}, which is an idea or a routine run`);
    if (repoSlugOf(map, fallback) !== repoSlugOf(ownMap, fallback))
      refuse(`changes only tasks in its own repository, and ${name} is ${repoSlugOf(map, fallback)}'s`);
    if ('status' in input) {
      if (own.kind !== 'chase' || input.status !== 'deleted') refuse(`doesn't finish, delete, or reopen ${name}`);
      const other = Object.keys(input).filter((k) => k !== 'status' && k !== 'by');
      if (other.length) refuse(`deletes ${name} on its own, without changing ${other.join(', ')}`);
      // Entry is in seconds: a task added in the second the chase started counts as after it.
      const added = Number(map.entry) >= Math.floor(Number(own.chaseStarted) / 1000);
      if (!AGENT_NAME.test(map.brief_by ?? '') || !added)
        refuse(`deletes only a task an agent added after the chase started, and ${name} isn't one`);
      return;
    }
    const tags = [...arrayOf(input.addTags ?? []), ...arrayOf(input.removeTags ?? [])].map(String);
    if (tags.some((t) => t.startsWith('horizon-'))) refuse("doesn't change a horizon-* tag: that's the owner's choice");
    if ('project' in input && input.project in SHARED_AREAS) refuse(`doesn't move ${name} into ${input.project}`);
    const allowed = new Set(['by', ...CROSS_TASK_FIELDS.flatMap(([keys]) => keys)]);
    const other = Object.keys(input).filter((k) => !allowed.has(k));
    if (other.length)
      refuse(
        `changes only the description, done when, area, horizon, tags, and dependencies of another task, not ${other.join(', ')}`,
      );
    if (!CROSS_TASK_FIELDS.some(([keys]) => keys.some((k) => k in input))) refuse(`has nothing to change on ${name}`);
  }

  /**
   * A task's `pr` field closes it when that pull request merges (closingTasks in store-github.js). A
   * refinement's spec PR is only Part of the task, so while a refining agent holds it the field stays put.
   */
  checkPrField(uuid, changes) {
    if (!('pr' in changes) || !changes.pr) return;
    if (/^(claude|codex)-refine-/u.test(this.tasks.get(uuid).claim ?? '')) {
      throw new Forbidden(
        'a refinement’s pull request is Part of the task, so it doesn’t go in its pr field (merging it would finish the task); link it with "Part of <ID>." instead',
      );
    }
  }

  /**
   * Recent changes, newest first: one event per task per version, summarised from the
   * operations. `limit` counts versions; `before` pages back (the `next` of the last page).
   */
  /** @param {{ limit?: number, before?: any }} [options] */
  activity({ limit = 50, before } = {}) {
    return this.run(() => {
      const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
      const rows = before
        ? this.sql
            .exec(
              'SELECT seq, parent_version_id, segment, source, created FROM versions WHERE seq < ? ORDER BY seq DESC LIMIT ?',
              Number(before),
              n,
            )
            .toArray()
        : this.sql
            .exec('SELECT seq, parent_version_id, segment, source, created FROM versions ORDER BY seq DESC LIMIT ?', n)
            .toArray();
      const events = [];
      // Each event's task says its repository (IDEA-14 section 6), so the stream follows the board's switcher.
      const fallback = this.defaultRepoSlug();
      const brief = (uuid, map) => ({
        uuid,
        wid: map.wid ?? null,
        description: map.description,
        status: map.status,
        repo: repoSlugOf(map, fallback),
      });
      for (const row of rows) {
        const at = new Date(row.created).toISOString();
        if (row.source === 'backfill') continue;
        const source = row.source === 'replica' ? 'taskwarrior' : row.source;
        let ops;
        try {
          ops = decodeSegment(unseal(this.key, row.parent_version_id, new Uint8Array(row.segment)));
        } catch {
          events.push({ seq: row.seq, at, source, task: null, changes: [{ kind: 'unreadable' }] });
          continue;
        }
        if (row.source === 'horizon') {
          const set = ops.filter((o) => o.type === 'update' && o.property === 'horizon');
          const count = (v) => set.filter((o) => o.value === v).length;
          events.push({
            seq: row.seq,
            at,
            source,
            task: null,
            changes: [{ kind: 'horizon-closed', archived: count('archive'), movedUp: set.length - count('archive') }],
          });
          continue;
        }
        const byTask = new Map();
        for (const op of ops) byTask.set(op.uuid, [...(byTask.get(op.uuid) ?? []), op]);
        for (const [uuid, list] of [...byTask].reverse()) {
          const changes = summarise(list);
          if (!changes.length) continue;
          const now = this.tasks.get(uuid);
          const set = Object.fromEntries(list.filter((o) => o.type === 'update').map((o) => [o.property, o.value]));
          events.push({
            seq: row.seq,
            at,
            source,
            task: {
              uuid,
              wid: now?.wid ?? set.wid ?? null,
              description: now?.description ?? set.description ?? '(deleted task)',
              status: now?.status ?? 'gone',
              repo: repoSlugOf(now ?? set, fallback),
            },
            changes,
          });
        }
      }
      // GitHub events that happened in the same stretch of time as these versions.
      const upTo = before
        ? (this.sql.exec('SELECT created FROM versions WHERE seq = ?', Number(before)).toArray()[0]?.created ??
          Date.now())
        : Number.MAX_SAFE_INTEGER;
      const after = rows.length === n ? rows.at(-1).created : 0;
      const byWid = (wid) => {
        for (const [uuid, map] of this.tasks) if (map.wid === wid) return brief(uuid, map);
        return null;
      };
      for (const g of this.githubEvents(after, upTo)) {
        const { id, at, kind, wids = [], ...rest } = g;
        events.push({
          seq: null,
          id: `gh${id}`,
          at: new Date(at).toISOString(),
          source: 'github',
          task: wids.map(byWid).find(Boolean) ?? null,
          changes: [{ kind, ...rest }],
        });
      }
      for (const a of this.agentEvents(after, upTo)) {
        const map = this.tasks.get(a.task);
        events.push({
          seq: null,
          id: `ag${a.id}`,
          at: new Date(a.at).toISOString(),
          source: 'agents',
          task: map ? brief(a.task, map) : null,
          changes: [
            {
              kind: a.kind,
              trigger: a.trigger,
              ...(a.forced ? { forced: true } : {}),
              url: a.url,
              error: a.error,
              by: a.agent,
            },
          ],
        });
      }
      for (const e of this.routineEvents(after, upTo)) {
        const map = e.task ? this.tasks.get(e.task) : null;
        events.push({
          seq: null,
          id: `rt${e.id}`,
          at: new Date(e.at).toISOString(),
          source: 'routines',
          task: map ? brief(e.task, map) : null,
          changes: [{ kind: e.kind, routine: e.slug, detail: e.detail, ...(e.agent ? { by: e.agent } : {}) }],
        });
      }
      // A chase started, stopped, stalled, or ended (IDEA-28 section 3.9); its starts are agent runs above.
      for (const c of this.chaseEvents(after, upTo)) {
        events.push({
          seq: null,
          id: `ch${c.id}`,
          at: new Date(c.at).toISOString(),
          source: 'agents',
          task: null,
          changes: [{ kind: c.kind, feature: c.slug, detail: c.detail }],
        });
      }
      for (const p of this.pingEvents(after, upTo)) {
        const map = this.tasks.get(p.task);
        events.push({
          seq: null,
          id: `pg${p.id}`,
          at: new Date(p.at).toISOString(),
          source: 'pings',
          task: map ? brief(p.task, map) : null,
          changes: [{ kind: 'ping', pingKind: p.kind, text: p.message, by: p.agent }],
        });
      }
      for (const p of this.pingResolutions(after, upTo)) {
        const map = this.tasks.get(p.task);
        events.push({
          seq: null,
          id: `pr${p.id}`,
          at: new Date(p.at).toISOString(),
          source: 'pings',
          task: map ? brief(p.task, map) : null,
          changes: [{ kind: 'ping-resolved', pingKind: p.kind, how: p.how, by: 'owner' }],
        });
      }
      events.sort((a, b) => b.at.localeCompare(a.at));
      return ok({ events, next: rows.length === n ? rows.at(-1).seq : null });
    });
  }

  /**
   * The best ready task nobody has claimed: with every tag in `tags` (default: agent), none in
   * `without` (default: decide), optionally one project, horizon, or repository. Claims it when `claim`.
   */
  /** @param {{ agent?: string, tags?: string[], without?: string[], project?: string, horizon?: string, repo?: string, claim?: boolean }} [options] */
  next({ agent, tags = ['agent'], without = ['decide'], project, horizon, repo, claim = false } = {}) {
    return this.run(() => {
      const want = arrayOf(tags);
      const skip = arrayOf(without);
      const candidates = this.views(
        (t) =>
          t.ready &&
          !t.claim &&
          want.every((tag) => t.tags.includes(tag)) &&
          !skip.some((tag) => t.tags.includes(tag)) &&
          (!project || t.project === project) &&
          (!horizon || t.horizon === horizon) &&
          (!repo || t.repo === String(repo).toLowerCase()),
      ).sort(rank);
      if (!candidates.length) return ok({ task: null });
      if (!claim) return ok({ task: this.detail(candidates[0].uuid) });
      return this.claimUuid(candidates[0].uuid, agent, false);
    });
  }
}

/** Fields worth naming in the activity feed, in the order they're listed. */
const FIELDS = [
  ['description', 'title'],
  ['project', 'area'],
  ['horizon', 'horizon'],
  ['priority', 'priority'],
  ['tags', 'tags'],
  ['depends', 'dependencies'],
  ['spec', 'spec'],
  ['pr', 'pull request'],
  ['due', 'due'],
  ['wait', 'wait'],
  ['scheduled', 'scheduled'],
  ['related', 'related'],
];

/** One task's operations in one version → what happened, for people. */
function summarise(ops) {
  const created = ops.some((o) => o.type === 'create');
  if (ops.some((o) => o.type === 'delete')) return [{ kind: 'purged' }];
  const set = new Map();
  for (const op of ops) {
    if (op.type !== 'update') continue;
    const key = op.property.startsWith('tag_')
      ? 'tags'
      : op.property.startsWith('dep_')
        ? 'depends'
        : op.property.startsWith('rel_')
          ? 'related'
          : op.property;
    if (op.property.startsWith('annotation_') || op.property.startsWith('by_')) set.set(op.property, op.value);
    else set.set(key, op.value);
  }
  const changes = [];
  if (created) changes.push({ kind: 'created' });
  if (set.has('status') && !created) {
    const status = set.get('status');
    const tagged = ops.some((o) => o.type === 'update' && o.property === 'tag_decide' && o.value);
    const answered = set.get('decision_answers');
    if (status === 'completed' && answered) changes.push({ kind: 'decision-answered' });
    else if (status === 'pending' && tagged && set.has('decision_answers') === false)
      changes.push({ kind: 'decision-reopened' });
    else changes.push({ kind: status === 'completed' ? 'done' : status === 'deleted' ? 'deleted' : 'reopened' });
  }
  // A kickoff's IDEA stays open when its decision is answered or reopened (BRK-134): only +decide moves.
  const decideOp = ops.find((o) => o.type === 'update' && o.property === 'tag_decide');
  if (decideOp && !set.has('status') && !created) {
    if (!decideOp.value && set.get('decision_answers')) changes.push({ kind: 'decision-answered' });
    else if (
      decideOp.value &&
      [...set].some(([key, value]) => key.startsWith('annotation_') && /^Decision reopened/u.test(String(value)))
    )
      changes.push({ kind: 'decision-reopened' });
  }
  if (set.has('claim'))
    changes.push(set.get('claim') ? { kind: 'claimed', by: set.get('claim') } : { kind: 'released' });
  if (set.has('brief'))
    changes.push({
      kind: set.get('brief') === null ? 'brief-removed' : 'brief',
      ...(set.get('brief_by') ? { by: set.get('brief_by') } : {}),
    });
  if (set.has('done_when')) changes.push({ kind: 'done-when' });
  for (const [key, value] of set) {
    if (!key.startsWith('annotation_') || value === null) continue;
    const by = set.get(`by_${key.slice(11)}`);
    changes.push({ kind: 'note', text: value, ...(by && by !== EARLIER ? { by } : {}) });
  }
  if (!created) {
    const fields = FIELDS.filter(([key]) => set.has(key)).map(([, label]) => label);
    if (set.has('wid') && !fields.length && changes.length === 0)
      changes.push({ kind: 'numbered', wid: set.get('wid') });
    else if (set.has('wid')) fields.unshift('work ID');
    if (fields.length) changes.push({ kind: 'changed', fields });
  }
  return changes;
}

Object.assign(
  TaskStore.prototype,
  githubMethods,
  packagesMethods,
  agentsMethods,
  routinesMethods,
  featuresMethods,
  chaseMethods,
  attachmentsMethods,
  pingsMethods,
  pushMethods,
  messagesMethods,
  pelotonMethods,
  specsMethods,
  pipelineMethods,
  statsMethods,
  reposMethods,
  connectionsMethods,
  infraSignalsMethods,
  infraDeploySignalsMethods,
  infraRunbooksMethods,
  infraIncidentsMethods,
  githubStatusMethods,
  updatesMethods,
  selfUpdateMethods,
  wizardMethods,
  kickoffsMethods,
  initMethods,
  routineKeepMethods,
  oauthMethods,
  infraEnvironmentsMethods,
  infraDesiredMethods,
  infraInventoryMethods,
  infraLocksMethods,
  infraAuditMethods,
  infraPlansMethods,
  infraApprovalsMethods,
  infraDeploysMethods,
  infraCheckMethods,
  infraPolicyMethods,
  infraPullsMethods,
  infraDriftMethods,
  infraBreakGlassMethods,
  infraAdoptMethods,
  infraRunsMethods,
  infraEnvelopesMethods,
  infraCurrencyMethods,
);

// ---- agent API actions (thin wrappers that map errors to responses) --------------------------

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
const apiActions = {
  backfillStructureApi() {
    return this.run(() => ok(this.backfillStructure()));
  },
  agentsApi() {
    return this.run(async () => this.agentsOverview());
  },
  /** New agent: a task from a prompt, a decision's answers, a spec, or the next version, and an agent on it (the owner's). */
  agentsGeneralApi(body) {
    return this.run(async () => {
      ownerOnly(body?.by, 'start a general agent');
      const result = await this.startGeneral({
        prompt: body?.prompt,
        repo: body?.repo ?? null,
        force: Boolean(body?.force),
        decision: body?.decision ?? null,
        next: body?.next ?? null,
        version: body?.version ?? null,
        spec: body?.spec ?? null,
        note: typeof body?.note === 'string' ? body.note : null,
        dryRun: Boolean(body?.dryRun),
        chase: body?.chase ?? null,
        feature: body?.feature ?? null,
      });
      return ok(result, result.run ? 201 : result.already || result.dryRun ? 200 : 202);
    });
  },
  agentsStartApi(ref, note, mode, { force = false, by } = {}) {
    return this.run(async () => {
      if (force) ownerOnly(by, 'force start an agent');
      if (mode && !['build', 'refine', 'routine', 'general'].includes(mode))
        throw new AgentError('mode is build, refine, routine, or general', 400);
      const uuid = this.resolve(ref);
      // A general agent's task waiting for room starts as a general agent, whatever button asked, and a routine
      // maker's in the routines mode (startAgent).
      if (this.tasks.get(uuid)?.tag_general && (!mode || mode === 'build' || mode === 'general'))
        return ok(await this.startAgent(uuid, { trigger: 'general', kind: 'general', force: Boolean(force) }));
      // A run a trigger made and left waiting for the owner's Start: it starts as a routine run of its own routine.
      // So does a plain Start on one, since a build's payload would send the agent off to do the wrong thing.
      const routine =
        !mode || mode === 'build' || mode === 'routine'
          ? (this.sql.exec('SELECT slug FROM routine_runs WHERE task = ?', uuid).toArray()[0]?.slug ?? null)
          : null;
      if (mode === 'routine' && !routine) throw new AgentError('that task isn’t a routine run', 400);
      return ok(
        await this.startAgent(uuid, {
          trigger: 'manual',
          note,
          kind: routine ? 'routine' : (mode ?? 'build'),
          routine,
          force: Boolean(force),
        }),
      );
    });
  },
  featuresApi() {
    return this.run(() => ok(this.listFeatures()));
  },
  featureApi(slug) {
    return this.run(async () => ok({ feature: await this.featureWithChase(slug) }));
  },
  featureChaseApi(slug, body) {
    return this.run(async () => ok(await this.chaseFeature(slug, body ?? {})));
  },
  featuresCreateApi(body) {
    return this.run(async () => ok(await this.createFeature(body ?? {}), 201));
  },
  featuresModifyApi(slug, body) {
    return this.run(() => ok({ feature: this.modifyFeature(slug, body ?? {}) }));
  },
  featuresDeleteApi(slug, body) {
    return this.run(() => ok(this.deleteFeature(slug, body ?? {})));
  },
  releasePullApi(release, body) {
    return this.run(() => ok(this.pullRelease(release, body ?? {})));
  },
  routinesApi() {
    return this.run(() => ok(this.listRoutines()));
  },
  /**
   * Make with an agent (docs/specs/BRK-220-routines-with-an-agent.md, section 2): the owner's prompt becomes a routine
   * maker's task in repository `repo`, and an agent starts on it in the routines mode, or waits for room at the front
   * of the queue. The owner's only.
   */
  routinesAgentApi(body) {
    return this.run(async () => {
      ownerOnly(body?.by, 'start an agent that makes routines');
      const result = await this.startGeneral({
        prompt: body?.prompt,
        repo: body?.repo ?? null,
        force: Boolean(body?.force),
        maker: true,
      });
      return ok(result, result.run ? 201 : 202);
    });
  },
  routinesCreateApi(body) {
    return this.run(() => ok({ routine: this.createRoutine(body ?? {}) }, 201));
  },
  routinesModifyApi(slug, body) {
    return this.run(() => ok({ routine: this.modifyRoutine(slug, body ?? {}) }));
  },
  routinesRunApi(slug, body) {
    return this.run(async () => {
      // Run now is the owner's: a routine maker's first run comes from its triggers (BRK-220 section 5).
      this.ownerOnlyRoutines(body?.by, 'runs a routine');
      return ok(
        await this.runRoutine(slug, { note: body?.note ? String(body.note) : null, force: Boolean(body?.force) }),
      );
    });
  },
  routinesTriggerCreateApi(slug, body) {
    return this.run(async () => ok(await this.createTrigger(slug, body ?? {}), 201));
  },
  routinesTriggerRevokeApi(slug, id, body) {
    return this.run(() => ok(this.revokeTrigger(slug, id, body?.by)));
  },
  /** The public /fire endpoint: no owner token, a trigger's secret instead. Errors carry their status. */
  routinesFire(slug, secret, raw, source) {
    return this.run(async () => ok(await this.fireTrigger(slug, secret, raw, source), 202));
  },
  /** The webhook's part: routines of repository `slug` listening for this GitHub event. Never fails the webhook. */
  async githubRoutines(event, payload, slug = null) {
    try {
      return await this.githubRoutineEvent(event, payload, slug);
    } catch {
      return { started: [] };
    }
  },
  routinesSettingsApi(body) {
    return this.run(() => {
      this.ownerOnlyRoutines(body?.by, 'pauses routines or sets their daily cap');
      return ok({ settings: this.updateRoutineSettings(body ?? {}) });
    });
  },
  fixAlertApi(number, note, repo = null, { force = false, by } = {}) {
    return this.run(async () => {
      if (force) ownerOnly(by, 'force start an agent');
      return ok(await this.fixAlert(number, { note, repo, force: Boolean(force) }));
    });
  },
  reviewPullApi(number, note, repo = null, { force = false, by } = {}) {
    return this.run(async () => {
      ownerOnly(by, force ? 'force start an agent' : 'start an agent that reviews a pull request');
      return ok(await this.reviewPull(number, { note, repo, force: Boolean(force) }));
    });
  },
  /** `review <ID> --verdict …`: an agent's answer on the pull request that closes its task (BRK-111). */
  taskReviewApi(ref, body) {
    return this.run(async () =>
      ok(
        this.recordAgentReview(ref, {
          verdict: body?.verdict,
          note: body?.note,
          by: body?.by,
          pr: body?.pr ?? null,
        }),
        201,
      ),
    );
  },
  fixPrApi(number, body) {
    return this.run(async () => {
      if (body.force) ownerOnly(body.by, 'force start an agent');
      return ok(
        await this.fixPr(number, {
          problem: body.problem ? String(body.problem) : null,
          note: body.note ? String(body.note) : null,
          repo: body.repo ?? null,
          force: Boolean(body.force),
        }),
      );
    });
  },
  agentsNextApi(body) {
    return this.run(async () => ok(await this.startNext(body)));
  },
  agentsSettingsApi(body) {
    return this.run(async () => ok({ settings: await this.updateAgentSettings(body) }));
  },
  /** The session hook's post: its output in, and the owner's messages waiting for that agent out (IDEA-15). */
  sessionLogApi(ref, body) {
    return this.run(() => {
      const uuid = this.resolve(ref);
      // A task that finished or was released takes no more live output: tell the hook to drop its marker (BRK-87).
      const agent = String(body?.agent ?? '').trim();
      const map = this.tasks.get(uuid);
      if (agent && (map?.status !== 'pending' || map.claim !== agent))
        return ok({ added: 0, messages: [], peloton: [], released: true });
      const added = this.appendSessionLog(uuid, body ?? {});
      // `messages: false` is a post that can't hand them on (a Stop hook): they stay waiting, and so do peloton posts.
      if (body?.messages === false) return ok({ added, messages: [], peloton: [] }, 201);
      const peloton = this.takePeloton(agent);
      return ok(
        { added, messages: this.takeMessages(uuid, body?.agent), peloton: peloton.posts, pelotonMore: peloton.more },
        201,
      );
    });
  },
  messagesApi(ref) {
    return this.run(() => ok(this.messagesFor(this.resolve(ref))));
  },
  messageSendApi(ref, body) {
    return this.run(() => {
      const uuid = this.resolve(ref);
      const message = this.sendMessage(uuid, body?.text);
      return ok({ message, ...this.messagesFor(uuid) }, 201);
    });
  },
  /**
   * The idle hook asks here every few seconds; same rule and marking as the session post. Peloton posts come only
   * with an urgent one (IDEA-36 section 3): the owner's, a mention of the agent, or a reply to its own, so a busy
   * peloton doesn't wake an agent waiting on CI.
   */
  messagesWaitingApi(ref, agent) {
    return this.run(() => {
      const uuid = this.resolve(ref);
      const name = String(agent ?? '').trim();
      const peloton = this.holdsTask(name, uuid) ? this.takePeloton(name, { urgent: true }) : { posts: [], more: 0 };
      return ok({
        messages: this.takeMessages(uuid, agent, { poll: true }),
        peloton: peloton.posts,
        pelotonMore: peloton.more,
      });
    });
  },
  /** The peloton (IDEA-32): an agent's pelotons and what it hasn't seen, or every peloton for the board. */
  pelotonApi(agent) {
    return this.run(() => ok(agent === null ? this.pelotonList() : this.agentPelotons(agent)));
  },
  /** What's waiting for an agent now (IDEA-36 section 3): the CLI asks every few seconds while the agent waits. */
  pelotonListenApi(agent, task) {
    return this.run(() => ok(this.listenPeloton(agent, task)));
  },
  pelotonDetailApi(peloton) {
    return this.run(() => ok(this.pelotonDetail(peloton)));
  },
  pelotonPostApi(peloton, body) {
    return this.run(() => ok(this.postPeloton(peloton, body ?? {}), 201));
  },
  /** The owner's post (IDEA-36 section 7): the worker sends it here from the signed-in board only. */
  pelotonOwnerPostApi(peloton, body) {
    return this.run(() => ok(this.postPeloton(peloton, body ?? {}, { owner: true }), 201));
  },
  /** The chase's plan (IDEA-36 section 5): its revisions, and a revision by an agent or, from the board, the owner. */
  pelotonPlanApi(peloton) {
    return this.run(() => ok(this.planRevisions(peloton)));
  },
  pelotonPlanReviseApi(peloton, body) {
    return this.run(() => ok(this.revisePlan(peloton, body ?? {})));
  },
  /** The owner's revision: the worker sends it here from the signed-in board only. */
  pelotonOwnerPlanApi(peloton, body) {
    return this.run(() => ok(this.revisePlan(peloton, body ?? {}, { owner: true })));
  },
  sessionApi(ref, after) {
    return this.run(() => ok(this.sessionLog(this.resolve(ref), after)));
  },
};

Object.assign(TaskStore.prototype, apiActions);

class NotFound extends Error {}
class Forbidden extends Error {}

/** An agent's name on the board, as the board starts them. */
const AGENT_NAME = /^(claude|codex)-/u;
/**
 * What a general agent may change on another task (IDEA-30 section 2): the request's keys, and their name in the board's note.
 * @type {[string[], string][]}
 */
const CROSS_TASK_FIELDS = [
  [['brief'], 'description'],
  [['done_when'], 'done when'],
  [['project'], 'area'],
  [['horizon'], 'horizon'],
  [['addTags', 'removeTags'], 'tags'],
  [['addDepends', 'removeDepends'], 'dependencies'],
];
class Conflict extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.extra = extra;
  }
}

function pick(input, keys) {
  const out = {};
  for (const key of keys) if (input && key in input) out[key] = input[key];
  return out;
}

function arrayOf(value) {
  if (value === undefined || value === null || value === '') return [];
  return (Array.isArray(value) ? value : String(value).split(',')).map((v) => String(v).trim()).filter(Boolean);
}

function toSeconds(value) {
  const ms = typeof value === 'number' ? value * 1000 : Date.parse(value);
  if (Number.isNaN(ms)) throw new InputError(`"${value}" isn't a date`);
  return Math.floor(ms / 1000);
}

/** Who wrote a comment: an agent or routine name, `board`, or `owner` when nobody said. */
function commentAuthor(by) {
  const name = String(by ?? '').trim();
  if (!name) return 'owner';
  if (name === 'board' || /^routine:[\w-]{1,64}$/u.test(name)) return name;
  return agentName(name);
}

/** Deciding is the owner's: no `by`, or `owner`, is them; an agent's name isn't. */
function ownerOnly(by, what) {
  if (by !== undefined && by !== null && by !== '' && by !== 'owner')
    throw new Forbidden(`only the owner can ${what}; agents ask a question and read the answer`);
}

function agentName(agent) {
  const name = String(agent ?? '').trim();
  if (!/^[\w.@:/-]{1,64}$/u.test(name))
    throw new InputError('say who is claiming: a name of letters, digits, and . _ - @ : / (up to 64)');
  return name;
}

const label = (task) => task.wid ?? task.short;
