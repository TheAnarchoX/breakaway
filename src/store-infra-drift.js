/**
 * TaskStore's drift (docs/specs/IDEA-19-architect.md, "Drift"; BRK-184). On the cron, for each environment with a
 * provider and a desired state (BRK-180), the board asks the provider what it would change to bring what runs back to
 * the desired state. Anything it would change is drift: the board keeps what differs, shows it on the environment
 * (`driftCount`, `drift`), and makes one plan from it (by the board) through `makeInfraPlan`, so the plan and its audit
 * entry are BRK-178's. It never applies. Where the drift comes from decides what happens to the plan (BRK-246):
 * - a change by hand (what runs moved): a draft, source `drift`, that the owner puts in front of themselves, rejects,
 *   or turns into a task;
 * - a merged change (the desired state moved since the drift was last settled, or its file was added since the board
 *   started reading the repository and this is its first comparison): source `pull-request`, naming the merged pull
 *   request when the sync knows it, put in front of the owner with one push, unless the repository's policy lets it
 *   through.
 *
 * One drift, one plan: a comparison that finds an open plan covering the same changes (from drift, a pull request, or
 * anything else) makes none, and while an earlier plan from a comparison is still open it makes no other, saying
 * instead that the open one no longer matches. A frozen environment's drift is kept but not planned until it's
 * unfrozen. Observe-only environments (BRK-169) are never compared: they take no desired state.
 *
 * A delete isn't drift: it's a resource that runs but isn't in the desired state, which nobody owns. Each comparison
 * hands those to clean up (BRK-201, store-infra-cleanup.js), which flags them and proposes removing them after a grace
 * period, and drift's count, fingerprint, and plan leave them out.
 */
import { AgentError } from './store-agents.js';
import { install } from './install.js';
import { redact } from './redact.js';
import { runsTheBoard } from './infra-environments.js';
import { checkDesired, checkPlan } from './infra-provider.js';
import { keptDiff, planNumber } from './infra-plans.js';
import { keepsChange } from './infra-change-approval.js';
import {
  DRIFT_PER_TICK,
  DRIFT_PLAN_SOURCES,
  OPEN_PLAN_STATES,
  desiredFingerprint,
  desiredMoved,
  driftChanges,
  driftDue,
  driftFingerprint,
  driftResources,
  driftView,
  isDrift,
} from './infra-drift.js';

const OPEN = OPEN_PLAN_STATES.map(() => '?').join(', ');
/** Kept as `desired_hash` while an added file's first drift is unplanned: it matches no desired state, so it's a merge. */
const UNSETTLED_ADDED = 'added';

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraDriftMethods = {
  initInfraDrift() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS infra_drift (
        environment INTEGER PRIMARY KEY, repo TEXT NOT NULL, checked INTEGER NOT NULL, desired_sha TEXT,
        count INTEGER, resources TEXT, fingerprint TEXT, plan INTEGER, plan_matches INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
    `);
    // The desired state the drift was last settled against (BRK-246): a fingerprint, so a merged change is told apart.
    const have = new Set(
      this.sql
        .exec('PRAGMA table_info(infra_drift)')
        .toArray()
        .map((c) => c.name),
    );
    if (!have.has('desired_hash')) this.sql.exec('ALTER TABLE infra_drift ADD COLUMN desired_hash TEXT');
  },

  /** An environment's drift for its view: `driftCount` (null until compared) and the last comparison, or null. */
  driftFor(environmentId) {
    const row = this.sql.exec('SELECT * FROM infra_drift WHERE environment = ?', environmentId).toArray()[0];
    const drift = row ? { ...driftView(row), breakGlass: this.breakGlassFor(environmentId) } : null;
    return { driftCount: drift?.count ?? null, drift };
  },

  /**
   * Why an environment row can't be compared, or null when it can: it's observe only, or has no provider that's
   * connected, or no desired state.
   */
  driftRefusal(env) {
    if (env.observe_only || runsTheBoard(env, install(this.env).worker))
      return `${env.name} is observe only: Architect watches it and never compares it with a desired state`;
    if (!env.provider) return `${env.name} has no provider: the owner picks one on the board first`;
    if (!this.infraRegistry().has(env.provider))
      return `${env.provider} isn’t connected, so ${env.name} can’t be compared`;
    const desired = this.desiredStateFor(env);
    if (!desired)
      return `${env.name} has no desired state yet: add .github/breakaway-infra/${env.name}.json to ${env.repo}’s default branch`;
    // With no target, it's compared against the one Worker its file makes (BRK-309); none, or several, says so.
    return this.desiredTargetOf(env, desired).problem ?? null;
  },

  /**
   * Compares one environment's desired state with what runs, keeps the result, and makes a plan when there's drift no
   * open plan covers: a draft for a change by hand, one that waits for the owner for a merged change. A provider that
   * fails is kept as the comparison's error, not thrown, so the cron carries on and the environment shows it. Refused (409) on an environment that can't be compared.
   * @param {string | number} ref the environment's ID or name
   * @param {{ repo?: string | null }} [options]
   */
  async checkInfraDrift(ref, { repo = null } = {}) {
    const env = this.environmentRow(ref, repo);
    const refused = this.driftRefusal(env);
    if (refused) throw new AgentError(refused, 409);
    this.driftChecking ??= new Set();
    if (this.driftChecking.has(env.id))
      throw new AgentError(`${env.name} is being compared already: wait for that to finish`, 409);
    this.driftChecking.add(env.id);
    try {
      // An environment with no target is compared, and planned, with the one its desired state makes (BRK-309).
      return await this.compareDrift(this.desiredTargetOf(env).env);
    } finally {
      this.driftChecking.delete(env.id);
    }
  },

  /**
   * What the provider would change to bring what runs back to the environment's desired state: the drift, as a kept
   * diff. Throws when the provider fails. Break-glass (BRK-187) reads it too.
   */
  async driftDiff(env) {
    const provider = this.infraRegistry().get(env.provider);
    const ctx = {
      environment: env.name,
      scope: { target: env.target ?? this.desiredTargetOf(env).target },
      observeOnly: false,
      token: (await this.providerReadToken(env.provider)) ?? undefined,
    };
    return keptDiff(
      checkPlan(provider, await provider.plan(ctx, checkDesired(provider, this.desiredStateFor(env))), ctx),
    );
  },

  async compareDrift(env) {
    const provider = this.infraRegistry().get(env.provider);
    const desiredSha =
      this.sql
        .exec('SELECT valid_sha FROM infra_desired WHERE repo = ? AND environment = ?', env.repo, env.name)
        .toArray()[0]?.valid_sha ?? null;
    const last = this.sql.exec('SELECT * FROM infra_drift WHERE environment = ?', env.id).toArray()[0];
    const desiredHash = await desiredFingerprint(this.desiredStateFor(env));
    const added = this.sql
      .exec('SELECT added FROM infra_desired WHERE repo = ? AND environment = ?', env.repo, env.name)
      .toArray()[0]?.added;
    // Drift is settled when there's none, an open plan covers it, or a plan was made for it. Until then the desired
    // state it's settled against stays the last one, so a merged change that couldn't be planned yet still counts; an
    // added file's first comparison keeps a marker no desired state matches.
    const unsettled = last ? (last.desired_hash ?? null) : added ? UNSETTLED_ADDED : null;
    let diff;
    try {
      diff = await this.driftDiff(env);
    } catch (error) {
      // What differed last time stays on the environment, with why this comparison couldn't finish.
      return this.keepDrift(env, {
        desiredSha,
        count: last?.count ?? null,
        resources: last?.resources ?? null,
        fingerprint: last?.fingerprint ?? null,
        plan: last?.plan ?? null,
        planMatches: Boolean(last?.plan_matches),
        desiredHash: unsettled,
        error: `${provider.name} couldn’t compare ${env.repo}’s ${env.name}: ${redact(error?.message ?? error)}. The board tries again on the next check.`,
      });
    }
    // Changes the owner marked as break-glass (BRK-187) are never planned back: the board doesn't propose undoing them.
    const brokenGlass = await this.settleBreakGlass(env, diff);
    // What runs but isn't in the desired state is clean up's (BRK-201): flagged now, proposed for removal later.
    await this.settleUnowned(env, diff);
    const merged = desiredMoved(last, desiredHash, Boolean(added));
    // Changes from the console that merged into this desired state get their outcome from this compare (WEB-110).
    const settling = this.changesToSettle(env);
    const settle = (/** @type {{ empty?: boolean, plan?: number | null, held?: string | null }} */ found) =>
      this.settleMergedChanges(settling, { moved: merged, empty: false, ...found });
    // A change the owner approved on the console before it merged (BRK-260): its plan also keeps the deletes it asked
    // for, and is approved on that press when it's exactly what was approved (store-infra-change-approval.js).
    const approved = merged ? this.approvedMergedChange(env.id) : null;
    const keep = approved ? keepsChange(JSON.parse(approved.edits)) : isDrift;
    const removals = diff.changes.filter((c) => !isDrift(c) && keep(c)).length;
    /** What a plan of this comparison holds, as one fingerprint: the drift, and the approved change's deletes. */
    const planned = async (/** @type {any} */ d) => driftFingerprint({ ...d, changes: d.changes.filter(keep) });
    const wanted = await planned(diff);
    diff = driftChanges(diff);
    const fingerprint = await driftFingerprint(diff);
    const resources = JSON.stringify(driftResources(diff));
    if (diff.changes.length === 0 && !removals) {
      settle({ empty: true });
      return this.keepDrift(env, {
        desiredSha,
        count: 0,
        resources,
        fingerprint,
        plan: null,
        planMatches: false,
        desiredHash,
      });
    }

    // New drift (not what the last comparison found) reaches the routines that listen for it (BRK-293).
    if (diff.changes.length && fingerprint !== last?.fingerprint)
      this.infraEvent('drift.found', env, {
        fields: { count: diff.changes.length, source: merged ? 'pull-request' : 'drift' },
        dedupe: fingerprint,
        resourceKinds: diff.changes.map((c) => c.kind),
        cause: merged ? { pull: this.mergedPullAt(env.repo, desiredSha) } : {},
      });
    const open = this.sql
      .exec(
        `SELECT n, source, diff FROM infra_plans WHERE environment = ? AND state IN (${OPEN}) ORDER BY n DESC`,
        env.id,
        ...OPEN_PLAN_STATES,
      )
      .toArray();
    for (const p of open)
      if ((await planned(JSON.parse(p.diff))) === wanted) {
        settle({ plan: Number(p.n) });
        return this.keepDrift(env, {
          desiredSha,
          count: diff.changes.length,
          resources,
          fingerprint,
          plan: p.n,
          planMatches: true,
          desiredHash,
        });
      }
    const stale = open.find((p) => DRIFT_PLAN_SOURCES.includes(p.source));
    if (stale) {
      settle({ plan: Number(stale.n) });
      return this.keepDrift(env, {
        desiredSha,
        count: diff.changes.length,
        resources,
        fingerprint,
        plan: stale.n,
        planMatches: false,
        desiredHash: unsettled,
      });
    }

    // A frozen environment's drift is kept and shown, but planned only once it's unfrozen. Drift with a change marked
    // as break-glass is kept and shown, and planned only once the file says what runs (or the change is gone).
    if (env.frozen || brokenGlass) {
      settle({
        held: env.frozen
          ? `${env.name} is frozen: it’s planned once you unfreeze it`
          : 'a break-glass change holds it: it’s planned once the file says what runs',
      });
      return this.keepDrift(env, {
        desiredSha,
        count: diff.changes.length,
        resources,
        fingerprint,
        plan: null,
        planMatches: false,
        desiredHash: unsettled,
      });
    }
    const pull = merged ? this.mergedPullAt(env.repo, desiredSha) : null;
    let plan = null;
    let planMatches = false;
    let settled = unsettled;
    let error = null;
    try {
      let made = await this.makeInfraPlan(env.id, {
        source: merged ? 'pull-request' : 'drift',
        sourceRef: pull ? `#${pull}` : null,
        by: 'board',
        only: keep,
      });
      plan = planNumber(made.id);
      planMatches = (await driftFingerprint(driftChanges(made.diff))) === fingerprint;
      settled = desiredHash;
      // A merged change waits for the owner, with one push, unless the policy let it through (approved already).
      if (approved) made = await this.settleChangeApproval(approved, made);
      else if (merged && made.state === 'draft' && made.policy?.outcome !== 'refused')
        made = await this.waitForOwner(made.id, {
          by: 'board',
          summary: pull
            ? `pull request #${pull} merged a change to ${env.name}’s desired state`
            : `${env.name}’s desired state changed on the default branch`,
        });
      settle({ plan });
    } catch (e) {
      error = `the drift couldn’t become a plan: ${redact(e?.message ?? e)}`;
    }
    return this.keepDrift(env, {
      desiredSha,
      count: diff.changes.length,
      resources,
      fingerprint,
      plan,
      planMatches,
      desiredHash: settled,
      error,
    });
  },

  /** The pull request whose merge made `sha` the head of the repository's default branch, as the sync keeps it. */
  mergedPullAt(repo, sha) {
    if (!sha) return null;
    const row = this.sql
      .exec(
        `SELECT number FROM gh_pulls WHERE repo = ? AND state = 'merged' AND json_extract(data, '$.mergeSha') = ?
         LIMIT 1`,
        repo,
        sha,
      )
      .toArray()[0];
    return row ? Number(row.number) : null;
  },

  /** Keeps one environment's comparison, replacing the last, and returns it as the API shows it. */
  keepDrift(env, { desiredSha, count, resources, fingerprint, plan, planMatches, desiredHash, error = null }) {
    this.sql.exec(
      `INSERT INTO infra_drift (environment, repo, checked, desired_sha, count, resources, fingerprint, plan, plan_matches, error, desired_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (environment) DO UPDATE SET repo = excluded.repo, checked = excluded.checked,
         desired_sha = excluded.desired_sha, count = excluded.count, resources = excluded.resources,
         fingerprint = excluded.fingerprint, plan = excluded.plan, plan_matches = excluded.plan_matches,
         error = excluded.error, desired_hash = excluded.desired_hash`,
      env.id,
      env.repo,
      Date.now(),
      desiredSha,
      count,
      resources,
      fingerprint,
      plan,
      planMatches ? 1 : 0,
      error,
      desiredHash ?? null,
    );
    return this.driftOut(env);
  },

  driftOut(env) {
    const row = this.sql.exec('SELECT * FROM infra_drift WHERE environment = ?', env.id).toArray()[0];
    return {
      repo: env.repo,
      environment: { id: Number(env.id), name: env.name },
      ...driftView(row),
      breakGlass: this.breakGlassFor(env.id),
    };
  },

  /**
   * On the cron: forgets comparisons for environments that can no longer be compared, then compares the ones that are
   * due (infra-drift.js's driftDue), oldest comparison first, at most DRIFT_PER_TICK. One environment's failure never
   * stops the rest.
   * @param {number} [now]
   */
  async driftTick(now = Date.now()) {
    const environments = this.sql.exec('SELECT * FROM infra_environments ORDER BY id').toArray();
    const due = [];
    for (const env of environments) {
      const last = this.sql
        .exec('SELECT checked, desired_sha FROM infra_drift WHERE environment = ?', env.id)
        .toArray()[0];
      if (this.driftRefusal(env)) {
        if (last) this.sql.exec('DELETE FROM infra_drift WHERE environment = ?', env.id);
        this.forgetUnowned(env);
        continue;
      }
      const sha =
        this.sql
          .exec('SELECT valid_sha FROM infra_desired WHERE repo = ? AND environment = ?', env.repo, env.name)
          .toArray()[0]?.valid_sha ?? null;
      if (driftDue(last, sha, now)) due.push({ env, checked: last ? Number(last.checked) : 0 });
    }
    this.sql.exec('DELETE FROM infra_drift WHERE environment NOT IN (SELECT id FROM infra_environments)');
    this.sql.exec('DELETE FROM infra_cleanup WHERE environment NOT IN (SELECT id FROM infra_environments)');
    const compared = [];
    for (const { env } of due.sort((a, b) => a.checked - b.checked).slice(0, DRIFT_PER_TICK)) {
      try {
        compared.push(await this.checkInfraDrift(env.id));
      } catch {
        /* being compared already, or no longer comparable: the next tick looks again */
      }
    }
    return compared;
  },

  /** GET /api/infra/drift[?repo=]: every environment's last comparison, by repository then environment. */
  driftApi({ repo } = {}) {
    return this.run(async () => {
      const slug = repo ? String(repo).trim().toLowerCase() : null;
      const rows = this.sql
        .exec(
          `SELECT e.* FROM infra_drift d JOIN infra_environments e ON e.id = d.environment
           WHERE (? IS NULL OR e.repo = ?) ORDER BY e.repo, e.name`,
          slug,
          slug,
        )
        .toArray();
      return { status: 200, body: { drift: rows.map((env) => this.driftOut(env)) } };
    });
  },

  /** GET /api/infra/drift/<environment>[?repo=]: one environment's last comparison, by its ID or name. */
  driftOneApi(ref, { repo } = {}) {
    return this.run(async () => {
      const env = this.environmentRow(ref, repo ? String(repo).trim().toLowerCase() : null);
      const has = this.sql.exec('SELECT 1 FROM infra_drift WHERE environment = ?', env.id).toArray()[0];
      if (!has) {
        const refused = this.driftRefusal(env);
        throw new AgentError(
          refused ?? `${env.name} hasn’t been compared yet: the board compares it on its next check`,
          404,
        );
      }
      return { status: 200, body: { drift: this.driftOut(env) } };
    });
  },

  /**
   * POST /api/infra/drift/<environment>: compare it now. The owner's, from the signed-in browser only (the worker
   * refuses the bearer token); an agent's `by` is refused too. A plan it makes is the one the cron would make.
   */
  driftCheckApi(ref, body = {}) {
    return this.run(async () => {
      const repo = body.repo ? String(body.repo).trim().toLowerCase() : null;
      this.allowOn(
        body,
        'inventory.refresh',
        () => this.environmentRow(ref, repo).repo,
        'only the owner or the board compares an environment; agents read drift',
      );
      return { status: 200, body: { drift: await this.checkInfraDrift(ref, { repo }) } };
    });
  },
};
