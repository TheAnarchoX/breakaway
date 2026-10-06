/**
 * TaskStore's executor (docs/specs/IDEA-19-architect.md, "Executor"; BRK-183): the one path that changes
 * infrastructure, for a plan the owner approved and nothing else.
 *
 * Approving a plan queues its run (store-infra-approvals.js), and the tick starts it: the board re-checks the plan
 * (still approved, its digest still its diff's, not out of date) and its environment (not frozen, not observe only),
 * checks the runner's workflow is in the repository, takes the environment's lock (BRK-179), and starts
 * `.github/workflows/breakaway-infra.yml` on the default branch through the GitHub App's workflow_dispatch. A run that
 * can't start yet stays queued and says why; one waiting on another's lock starts when that lock is released.
 *
 * The run answers to `/api/infra/runs/<plan>` with its GitHub OIDC token (src/infra-runner.js has the contract): the
 * board hands the plan to the one run it started, once, and records each step it reports. After `applied`, it checks
 * the health of what changed through the provider; when that fails or can't be read, or the apply failed partway, it
 * starts a second run of the same workflow that applies the reverse of what was applied (BRK-171), so the board never
 * holds a write credential. When the provider can't tell the health of anything the plan touched yet (no traffic),
 * the plan is applied but unverified, with a warning signal. Every step is in the audit trail, the plan's state says
 * how it ended, and the lock is released with the outcome. A run that stops reporting is swept once its lock expires,
 * marked failed, and sent as a signal, so a production one opens an incident (BRK-197).
 */
import { AgentError } from './store-agents.js';
import { GitHubError, appCredentials } from './github.js';
import { install } from './install.js';
import { runsTheBoard } from './infra-environments.js';
import { checkApplyResult, checkHealth } from './infra-provider.js';
import { planId } from './infra-plans.js';
import { held } from './infra-locks.js';
import { RUN_STEPS, RUNNER_WORKFLOW, planDigest } from './infra-runner.js';
import { redact } from './redact.js';
import {
  OIDC_KEYS_URL,
  RETRY_MINUTES,
  RUN_LOCK_MINUTES,
  RunRefused,
  checkRunClaims,
  healthVerdict,
  rollbackDiff,
  runView,
  stepsSummary,
  verifyRunToken,
} from './infra-runs.js';

const SELECT = 'SELECT r.*, e.name AS env_name FROM infra_runs r JOIN infra_environments e ON e.id = r.environment';
const MINUTE = 60_000;
/** How long GitHub's OIDC keys are kept before they're read again. */
const KEYS_MS = 60 * MINUTE;
/** The soonest they're read again for a key the board doesn't know. */
const KEYS_FRESH_MS = 5 * MINUTE;
/** The runner's workflow, as GitHub's API names it. */
const WORKFLOW_FILE = RUNNER_WORKFLOW.split('/').pop();
/** The outcomes that leave a plan failed: in production, their signal is critical. */
const FAILED = ['failed', 'rollback failed', 'expired'];
/** How a signal words each outcome that sends one: every one but a clean apply. */
const SIGNAL_WORDS = {
  failed: 'failed',
  expired: 'failed',
  'rollback failed': 'failed and couldn’t be rolled back',
  'rolled back': 'was rolled back',
  unverified: 'applied, but its health isn’t known yet',
};

/** @param {string} message @param {number} [status] */
const refuse = (message, status = 409) => {
  throw new RunRefused(message, status);
};

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraRunsMethods = {
  initInfraRuns() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS infra_runs (
        n INTEGER PRIMARY KEY, environment INTEGER NOT NULL, repo TEXT NOT NULL, phase TEXT NOT NULL,
        lock_token TEXT, run_id TEXT, rollback_run_id TEXT, rollback_diff TEXT, rollback_digest TEXT, steps TEXT,
        rollback_steps TEXT,
        dispatched INTEGER, next_try INTEGER, error TEXT, outcome TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS infra_runs_by_phase ON infra_runs (phase, n);
    `);
  },

  /** A plan's run with its environment's name, or null. */
  runRow(ref) {
    const n = Number(String(ref ?? '').replace(/^plan-/u, ''));
    if (!Number.isSafeInteger(n) || n < 1) return null;
    return this.sql.exec(`${SELECT} WHERE r.n = ?`, n).toArray()[0] ?? null;
  },

  /** Changes a run's row: `fields` by column. */
  setRun(n, fields) {
    const cols = Object.keys(fields);
    this.sql.exec(
      `UPDATE infra_runs SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated = ? WHERE n = ?`,
      ...cols.map((c) => fields[c]),
      Date.now(),
      n,
    );
  },

  /** Asks the alarm to look at the queue in a moment: after an approval, and after a run ends. */
  async soonInfraRuns() {
    const at = await this.ctx.storage.getAlarm();
    if (!at || at > Date.now() + 3000) await this.ctx.storage.setAlarm(Date.now() + 2000);
  },

  /**
   * Queues an approved plan's run; the tick starts it. Refused for a plan that isn't approved and for an observe-only
   * environment. Queuing it again returns the run it has.
   * @param {string} ref the plan's ID
   */
  queueInfraRun(ref) {
    const plan = this.planRow(ref);
    const id = planId(Number(plan.n));
    const env = this.environmentRow(plan.environment);
    if (env.observe_only || runsTheBoard(env, install(this.env).worker))
      throw new AgentError(`${env.name} is observe only: nothing applies to it`, 409);
    const have = this.runRow(id);
    if (have) return runView(have);
    if (plan.state !== 'approved')
      throw new AgentError(`${id} is ${plan.state}: only a plan you approved is applied`, 409);
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO infra_runs (n, environment, repo, phase, created, updated) VALUES (?, ?, ?, 'queued', ?, ?)",
      plan.n,
      env.id,
      env.repo,
      now,
      now,
    );
    return runView(this.runRow(id));
  },

  /** What the alarm and the cron do: sweep runs that stopped reporting, then start what's queued. Never throws. */
  async infraRunsTick() {
    try {
      await this.sweepInfraRuns();
    } catch (error) {
      console.error(`executor sweep: ${error.message}`);
    }
    try {
      await this.startInfraRuns();
    } catch (error) {
      console.error(`executor start: ${error.message}`);
    }
  },

  /** Runs whose lock expired or went (the owner released it) without an end: marked failed, with a signal. */
  async sweepInfraRuns() {
    const now = Date.now();
    const rows = this.sql.exec(`${SELECT} WHERE r.phase NOT IN ('queued', 'done') ORDER BY r.n`).toArray();
    for (const row of rows) {
      const lock = this.lockRow(row.environment);
      if (lock && lock.token === row.lock_token && held(lock, now)) continue;
      await this.finishInfraRun(row, 'expired', {
        summary: `the run stopped reporting before ${row.env_name}’s lock ${lock?.token === row.lock_token ? 'expired' : 'was released'}; what it applied is unknown, so compare the environment for drift`,
      });
    }
  },

  /** Starts each queued run that's due, oldest first, one per environment. */
  async startInfraRuns() {
    const now = Date.now();
    const rows = this.sql
      .exec(`${SELECT} WHERE r.phase = 'queued' AND (r.next_try IS NULL OR r.next_try <= ?) ORDER BY r.n`, now)
      .toArray();
    const seen = new Set();
    for (const row of rows) {
      if (seen.has(row.environment)) continue;
      seen.add(row.environment);
      try {
        await this.startInfraRun(row);
      } catch (error) {
        this.setRun(row.n, { error: redact(error.message).slice(0, 300), next_try: now + RETRY_MINUTES * MINUTE });
      }
    }
  },

  /**
   * Starts one queued run, or leaves it queued saying why. `retry` false waits for the next tick that finds the reason
   * gone (a lock released), true for RETRY_MINUTES.
   */
  async startInfraRun(row) {
    const plan = this.planRow(row.n);
    const id = planId(Number(plan.n));
    if (plan.state !== 'approved') {
      this.sql.exec("DELETE FROM infra_runs WHERE n = ? AND phase = 'queued'", row.n);
      return;
    }
    const wait = (why, retry = true) =>
      this.setRun(row.n, {
        error: redact(why).slice(0, 300),
        next_try: retry ? Date.now() + RETRY_MINUTES * MINUTE : null,
      });
    const env = this.environmentRow(row.environment);
    if (env.observe_only || runsTheBoard(env, install(this.env).worker))
      return wait(`${env.name} is observe only: nothing applies to it`);
    if (env.frozen) return wait(`${env.name} is frozen: it applies once the owner unfreezes it`);
    const stale = this.outOfDatePlan(plan);
    if (stale)
      return wait(`${id} is out of date: ${stale}. Reject it, and the next plan is drafted from what’s there now.`);
    if ((await planDigest(JSON.parse(plan.diff))) !== plan.digest)
      return wait(`${id} isn’t the plan that was approved: reject it`);
    const lock = this.lockRow(env.id);
    if (held(lock, Date.now())) return wait(`waits for ${env.name}’s lock, held by ${lock.holder}`, false);
    const repo = this.repoBySlug(env.repo);
    if (!repo) return wait(`${env.repo} isn’t on the board`);
    const credentials = await appCredentials(this.env);
    if (!credentials) return wait('the board’s GitHub App isn’t connected');
    const client = this.githubClient(credentials, repo);
    const branch = repo.defaultBranch || 'main';
    try {
      await client.get(`/actions/workflows/${encodeURIComponent(WORKFLOW_FILE)}`);
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      return wait(
        error.status === 404
          ? `${repo.github} has no ${RUNNER_WORKFLOW} on ${branch}: render it with npx breakaway infra init and merge it`
          : `GitHub answered ${error.status} for ${RUNNER_WORKFLOW}: ${error.reason ?? error.message}`,
      );
    }
    let taken;
    try {
      taken = this.takeEnvironmentLock(env.id, { holder: `executor:${id}`, plan: id, minutes: RUN_LOCK_MINUTES });
    } catch (error) {
      if (error instanceof AgentError && error.status === 409) return wait(error.message, false);
      throw error;
    }
    const dispatched = Date.now();
    this.setRun(row.n, { phase: 'dispatched', lock_token: taken.token, dispatched, error: null, next_try: null });
    const undo = (why) => {
      this.setRun(row.n, { phase: 'queued', lock_token: null, dispatched: null });
      this.releaseEnvironmentLock(env.id, { token: taken.token, outcome: 'not started' });
      wait(why);
    };
    try {
      await this.dispatchRunner(client, branch, id, env.name);
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      return undo(`GitHub didn’t start ${RUNNER_WORKFLOW} (${error.status}): ${error.reason ?? error.message}`);
    }
    try {
      this.moveInfraPlan(id, 'applying', {
        by: 'executor',
        outcome: 'started',
        summary: `started ${RUNNER_WORKFLOW} on ${branch}; ${env.name} is locked for it`,
      });
    } catch (error) {
      if (!(error instanceof AgentError)) throw error;
      return undo(error.message);
    }
  },

  /** Starts the runner's workflow on the default branch for one plan: the GitHub App's workflow_dispatch, nothing else. */
  async dispatchRunner(client, branch, plan, environment) {
    await client.send('POST', `/actions/workflows/${encodeURIComponent(WORKFLOW_FILE)}/dispatches`, {
      ref: branch,
      inputs: { plan, environment },
    });
  },

  /**
   * GitHub's OIDC keys, kept an hour; `fresh` reads them again (a key GitHub rotated in), at most every few minutes, so
   * tokens naming made-up keys can't make the board ask GitHub on every call.
   */
  async runnerKeys(fresh = false) {
    const kept = this.runnerKeyCache;
    const age = kept ? Date.now() - kept.at : Number.POSITIVE_INFINITY;
    if (kept && (fresh ? age < KEYS_FRESH_MS : age < KEYS_MS)) return kept.keys;
    const res = await fetch(OIDC_KEYS_URL, { headers: { Accept: 'application/json' } });
    const body = res.ok ? await res.json().catch(() => null) : null;
    if (!Array.isArray(body?.keys)) refuse('the board couldn’t read GitHub’s OIDC keys: try the run again', 503);
    this.runnerKeyCache = { at: Date.now(), keys: body.keys };
    return body.keys;
  },

  /** The token's claims once it checks against GitHub's keys, reading them again once for a key it doesn't know. */
  async runnerClaims(token, audience) {
    try {
      return await verifyRunToken(token, { keys: await this.runnerKeys(), audience });
    } catch (error) {
      if (!(error instanceof RunRefused) || !/doesn’t list/u.test(error.message)) throw error;
      return verifyRunToken(token, { keys: await this.runnerKeys(true), audience });
    }
  },

  /**
   * GET and POST /api/infra/runs/<plan> from the apply runner, with its GitHub OIDC token (never the board's own sign
   * in). Nothing is said about a plan until the token checks out; then the claims must be the run the board started.
   * @param {string} ref the plan's ID
   * @param {{ method: string, token: string, origin: string, body?: Record<string, any> }} call
   */
  async infraRunnerApi(ref, { method, token, origin, body = {} }) {
    await this.ready();
    try {
      const claims = await this.runnerClaims(token, origin);
      const row = this.runRow(ref);
      if (!row || row.phase === 'queued' || row.phase === 'done')
        refuse(`${String(ref).slice(0, 40)} has no run waiting for it`, 404);
      const env = this.environmentRow(row.environment);
      const repo = this.repoBySlug(env.repo);
      if (!repo) refuse(`${env.repo} isn’t on the board`, 404);
      const rollback = row.phase.startsWith('rollback-');
      const bound = rollback ? row.rollback_run_id : row.run_id;
      const { run } = checkRunClaims(claims, {
        repository: repo.github,
        environment: env.name,
        branch: repo.defaultBranch || 'main',
        dispatched: Number(row.dispatched),
        run: bound,
      });
      const lock = this.lockRow(env.id);
      if (!lock || lock.token !== row.lock_token || !held(lock, Date.now()))
        refuse(`${env.name}’s lock for this run is gone: the run stops`);
      if (method === 'GET') return await this.runnerCheck(row, env, run);
      if (method === 'POST') return await this.runnerReport(row, env, run, body);
      return { status: 405, body: { error: 'the runner GETs its plan and POSTs its steps' } };
    } catch (error) {
      if (error instanceof RunRefused) return { status: error.status, body: { error: error.message } };
      if (error instanceof AgentError) return { status: error.status, body: { error: error.message } };
      throw error;
    }
  },

  /** The runner's check: the plan, handed once to the run the board started, after the board checks it again. */
  async runnerCheck(row, env, run) {
    const rollback = row.phase.startsWith('rollback-');
    if (row.phase !== (rollback ? 'rollback-dispatched' : 'dispatched'))
      refuse(`${planId(Number(row.n))} was already handed to run ${rollback ? row.rollback_run_id : row.run_id}`);
    const plan = this.planRow(row.n);
    const id = planId(Number(plan.n));
    const diff = JSON.parse(rollback ? row.rollback_diff : plan.diff);
    if (plan.state !== 'applying') refuse(`${id} is ${plan.state}, not applying`);
    // A rollback goes through a freeze, like Roll back; an apply doesn't.
    const problem = rollback
      ? null
      : env.frozen
        ? `${env.name} was frozen`
        : (this.outOfDatePlan(plan) ??
          ((await planDigest(diff)) === plan.digest ? null : 'it isn’t the plan that was approved'));
    if (problem) {
      await this.finishInfraRun(row, 'failed', { summary: `nothing applied: ${problem}` });
      refuse(`${id} won’t apply: ${problem}`);
    }
    this.setRun(
      row.n,
      rollback ? { rollback_run_id: run, phase: 'rollback-checked' } : { run_id: run, phase: 'checked' },
    );
    this.renewEnvironmentLock(env.id, { token: row.lock_token, minutes: RUN_LOCK_MINUTES });
    return {
      status: 200,
      body: { plan: { id, environment: env.name, state: plan.state, scope: { target: plan.target ?? null }, diff } },
    };
  },

  /** One step the runner reports: recorded, and after `applied` or `failed`, the health check, rollback, or end. */
  async runnerReport(row, env, run, body) {
    const rollback = row.phase.startsWith('rollback-');
    const stage = rollback ? 'rollback' : 'apply';
    const plan = this.planRow(row.n);
    const id = planId(Number(plan.n));
    const diff = JSON.parse(rollback ? row.rollback_diff : plan.diff);
    const step = String(body?.step ?? '');
    if (!RUN_STEPS.includes(step)) refuse(`a run reports ${RUN_STEPS.join(', ')}`, 400);
    if (String(body.run ?? '') !== run) refuse('the report is for another run', 400);
    if (body.digest !== (rollback ? row.rollback_digest : plan.digest))
      refuse(`run ${run} applies a plan other than the one approved: nothing it reports is kept`);
    const checked = rollback ? 'rollback-checked' : 'checked';
    const applying = rollback ? 'rollback-applying' : 'applying';
    if (row.phase !== checked && row.phase !== applying) refuse(`${id} isn’t waiting for run ${run}`);
    /** @type {Array<{ resource: string, op: string, ok: boolean, error?: string }> | null} */
    let steps = null;
    if (body.steps !== undefined) {
      try {
        steps = checkApplyResult(/** @type {any} */ ({ id: plan.provider }), diff, {
          ok: step === 'applied',
          steps: body.steps,
        }).steps.map((s) => (s.error ? { ...s, error: redact(String(s.error)).slice(0, 300) } : s));
      } catch (error) {
        refuse(`the run’s steps don’t match ${id}: ${error.message}`, 400);
      }
    }
    if (steps) this.setRun(row.n, { [rollback ? 'rollback_steps' : 'steps']: JSON.stringify(steps) });
    const audit = (outcome, summary) =>
      this.appendInfraAudit({
        kind: stage,
        repo: env.repo,
        environment: env.name,
        environmentId: env.id,
        plan: id,
        by: 'executor',
        outcome,
        summary,
      });
    this.renewEnvironmentLock(env.id, { token: row.lock_token, minutes: RUN_LOCK_MINUTES });

    if (step === 'applying') {
      if (row.phase !== checked) refuse(`run ${run} already said it’s applying`);
      this.setRun(row.n, { phase: applying });
      audit(
        'applying',
        `run ${run} is ${rollback ? 'rolling back' : 'applying'} ${diff.changes.length} change${diff.changes.length === 1 ? '' : 's'}`,
      );
      return { status: 200, body: { ok: true, phase: applying } };
    }

    if (step === 'applied') {
      if (row.phase !== applying) refuse(`run ${run} never said it was applying`);
      if (!steps) refuse('an applied run reports its steps', 400);
      if (rollback)
        return this.endReport(row, 'rolled back', {
          summary: `run ${run} rolled back ${stepsSummary(steps).replace(/ applied$/u, '')}`,
        });
      const health = await this.verifyInfraApply(env, plan, diff);
      if (!health.error && health.ok && health.touched > 0 && health.unknown.length === health.touched)
        return this.endReport(row, 'unverified', {
          summary: `run ${run}: ${stepsSummary(steps)}; ${plan.provider} can’t tell the health of ${health.unknown.join(', ')} yet, so it wasn’t rolled back`,
        });
      if (!health.error && health.ok)
        return this.endReport(row, 'applied', {
          summary: `run ${run}: ${stepsSummary(steps)}; the health check passed`,
        });
      const why = health.error
        ? `the health check couldn’t be read: ${health.error}`
        : `the health check failed: ${health.problems.join('; ')}`;
      audit('unhealthy', `run ${run}: ${stepsSummary(steps)}, but ${why}`);
      return this.startRollback(row, env, diff, steps, why);
    }

    // failed
    const said = body.error ? redact(String(body.error)).slice(0, 300) : null;
    if (rollback)
      return this.endReport(row, 'rollback failed', {
        summary: `run ${run} couldn’t roll back: ${steps ? stepsSummary(steps) : (said ?? 'it stopped')}`,
      });
    const why = `run ${run} failed: ${steps ? stepsSummary(steps) : (said ?? 'it stopped')}`;
    audit('failed', why);
    if (!steps?.some((s) => s.ok)) return this.endReport(row, 'failed', { summary: `${why}; nothing was applied` });
    return this.startRollback(row, env, diff, steps, why);
  },

  /** Ends a run from one of its reports, answering the runner. */
  async endReport(row, outcome, { summary }) {
    await this.finishInfraRun(row, outcome, { summary });
    return { status: 200, body: { ok: true, phase: 'done', outcome } };
  },

  /**
   * The health of what an apply changed, from the provider with the board's read-only token: healthVerdict()'s answer,
   * or `{ error }` when the provider couldn't be read, which fails the check like an unhealthy answer.
   */
  async verifyInfraApply(env, plan, diff) {
    try {
      const registry = this.infraRegistry();
      if (!registry.has(plan.provider)) return { error: `${plan.provider} isn’t connected` };
      const provider = registry.get(plan.provider);
      const ctx = {
        environment: env.name,
        scope: { target: plan.target ?? null },
        observeOnly: false,
        token: (await this.providerReadToken(plan.provider)) ?? undefined,
      };
      return healthVerdict(diff, checkHealth(provider, await provider.observe(ctx)));
    } catch (error) {
      return { error: redact(error?.message ?? String(error)).slice(0, 200) };
    }
  },

  /**
   * Starts the second run, which applies the reverse of what the first applied, under the same lock. With nothing it
   * can undo, the run ends failed and says why.
   */
  async startRollback(row, env, diff, steps, why) {
    const id = planId(Number(row.n));
    const back = rollbackDiff(diff, steps);
    if (!back.diff) return this.endReport(row, 'failed', { summary: `${why}; not rolled back: ${back.problem}` });
    const repo = this.repoBySlug(env.repo);
    const credentials = await appCredentials(this.env);
    if (!repo || !credentials)
      return this.endReport(row, 'rollback failed', {
        summary: `${why}; the board’s GitHub App can’t start the rollback`,
      });
    const dispatched = Date.now();
    this.setRun(row.n, {
      phase: 'rollback-dispatched',
      rollback_diff: JSON.stringify(back.diff),
      rollback_digest: await planDigest(back.diff),
      dispatched,
      error: redact(why).slice(0, 300),
    });
    const n = back.diff.changes.length;
    this.appendInfraAudit({
      kind: 'rollback',
      repo: env.repo,
      environment: env.name,
      environmentId: env.id,
      plan: id,
      by: 'executor',
      outcome: 'started',
      summary: `${why}; rolling back ${n} change${n === 1 ? '' : 's'} with a second run`,
    });
    try {
      await this.dispatchRunner(this.githubClient(credentials, repo), repo.defaultBranch || 'main', id, env.name);
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      return this.endReport(this.runRow(id), 'rollback failed', {
        summary: `${why}; GitHub didn’t start the rollback (${error.status}): ${error.reason ?? error.message}`,
      });
    }
    return { status: 200, body: { ok: true, phase: 'rollback-dispatched' } };
  },

  /**
   * Ends a run: the plan's state says how (applied; failed; failed, then rolled back), the audit trail why, the lock is
   * released with the outcome, and a failure is sent as a signal. Then the queue is looked at again.
   * @param {Record<string, any>} row
   * @param {string} outcome one of RUN_OUTCOMES
   * @param {{ summary: string }} input
   */
  async finishInfraRun(row, outcome, { summary }) {
    const id = planId(Number(row.n));
    const env = this.environmentRow(row.environment);
    const plan = this.planRow(row.n);
    if (plan.state === 'applying') {
      if (outcome === 'applied' || outcome === 'unverified')
        this.moveInfraPlan(id, 'applied', { by: 'executor', outcome, summary });
      else if (outcome === 'rolled back') {
        this.moveInfraPlan(id, 'failed', { by: 'executor', summary: row.error ?? summary });
        this.moveInfraPlan(id, 'rolled back', { by: 'executor', summary });
      } else this.moveInfraPlan(id, 'failed', { by: 'executor', outcome, summary });
    }
    const lock = this.lockRow(env.id);
    if (lock && lock.token === row.lock_token && held(lock, Date.now()))
      this.releaseEnvironmentLock(env.id, { token: row.lock_token, outcome });
    this.setRun(row.n, { phase: 'done', outcome, error: redact(summary).slice(0, 300), lock_token: null });
    if (FAILED.includes(outcome) || outcome === 'rolled back' || outcome === 'unverified')
      try {
        await this.recordSignals([
          {
            source: 'executor',
            environment: env.name,
            environmentId: env.id,
            resource: null,
            kind: 'alert',
            level: FAILED.includes(outcome) && env.kind === 'production' ? 'critical' : 'warning',
            value: null,
            at: new Date().toISOString(),
            text: `${id} ${SIGNAL_WORDS[outcome] ?? 'failed'}: ${summary}`,
          },
        ]);
      } catch (error) {
        console.error(`executor signal: ${error.message}`); /* the plan and the audit trail are the record */
      }
    await this.soonInfraRuns();
  },

  /** GET /api/infra/runs[?repo=&environment=]: the newest runs first, with where each is. */
  runsApi({ repo, environment } = {}) {
    return this.run(async () => {
      const slug = repo ? String(repo).trim().toLowerCase() : null;
      const envId = environment ? this.environmentRow(environment, slug).id : null;
      const rows = this.sql
        .exec(
          `${SELECT} WHERE (? IS NULL OR r.repo = ?) AND (? IS NULL OR r.environment = ?) ORDER BY r.n DESC LIMIT 100`,
          slug,
          slug,
          envId,
          envId,
        )
        .toArray();
      return { status: 200, body: { runs: rows.map(runView) } };
    });
  },

  /** GET /api/infra/runs/<plan>, signed in: the plan's run, or a 404 when it has none. */
  runApi(ref) {
    return this.run(async () => {
      const row = this.runRow(ref);
      if (!row) throw new AgentError(`${String(ref ?? '').slice(0, 40)} has no run`, 404);
      return { status: 200, body: { run: runView(row) } };
    });
  },
};
