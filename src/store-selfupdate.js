/**
 * TaskStore's self-update (BRK-53, docs/specs/IDEA-20-self-updating-installs.md, sections 2 and 3): an install with
 * no install repository, whose owner turned self-update on, installs a release from the board. The owner's Cloudflare
 * token is a Worker secret (TASKS_UPDATE_TOKEN) that only this install holds. One update runs at a time, started only
 * by the owner's press (the route is cookie-only). Steps: verify the release (signature, checksums, updatesFrom), upload
 * it as a Worker version with the bindings the running Worker has, deploy it, and check that the new code answers.
 * A failure before the deploy leaves the running version untouched; a failed check deploys the previous version.
 * The state is kept in meta, and the check runs from the alarm, because a deploy restarts this Durable Object.
 */
import { releaseOf } from './build.js';
import { Cloudflare, CloudflareError } from './cloudflare-deploy.js';
import { WORKER_FIRST, install } from './install.js';
import { shapeOfInstall, shapeProblems } from './release-shape.js';
import { verifyRelease } from './release-verify.js';
import { assetFiles, untar, workerModules } from './self-update-bundle.js';
import { AgentError } from './store-agents.js';
import { clip } from './connections.js';
import { isNewer } from './updates.js';

export const TOKEN_BINDING = 'TASKS_UPDATE_TOKEN';
const CHECK_FOR_MS = 60_000; // the new code must answer within a minute (spec section 3, step 4)
const CHECK_EVERY_MS = 5_000;
const STALE_MS = 15 * 60_000; // an update that has shown no progress this long no longer blocks another
const ACCOUNT = /^[0-9a-f]{32}$/u;

const REFUSED = 'Cloudflare refused the token. Make a new one with Workers Scripts: edit and paste it here.';
/** Bindings whose values the API never returns: the version keeps them. */
const KEPT = ['secret_text', 'secret_key'];

/** @param {any} error @param {string} step */
const failure = (error, step) => {
  if (error instanceof CloudflareError)
    return { step, message: error.refused ? REFUSED : `Cloudflare said: ${clip(error.message, 200)}` };
  return { step, message: clip(error?.message ?? String(error), 300) };
};

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const selfUpdateMethods = {
  /** Whether this install may update itself: one with no install repository (those update from their repository). */
  selfUpdateAllowed() {
    return !install(this.env).installRepository;
  },

  selfUpdateConfig() {
    return JSON.parse(this.meta('selfupd_cfg') ?? 'null');
  },

  /** What the last update did, or null. */
  selfUpdateState() {
    return JSON.parse(this.meta('selfupd') ?? 'null');
  },

  saveSelfUpdate(state) {
    this.setMeta('selfupd', JSON.stringify({ ...state, at: Date.now() }));
  },

  /** The Cloudflare client from the stored account and the token secret, or null while self-update is off. */
  async selfUpdateClient() {
    const config = this.selfUpdateConfig();
    const token = this.env[TOKEN_BINDING];
    if (!config || typeof token !== 'string' || !token) return null;
    return new Cloudflare({
      token,
      accountId: config.accountId,
      worker: install(this.env).worker,
      fetchImpl: fetch,
    });
  },

  /** For Connections: whether self-update is on and what the last update did. Makes no call. */
  selfUpdateApi() {
    return this.run(() => ({
      status: 200,
      body: {
        selfUpdate: {
          allowed: this.selfUpdateAllowed(),
          enabled: Boolean(this.selfUpdateConfig() && this.env[TOKEN_BINDING]),
          state: this.selfUpdateState(),
        },
      },
    }));
  },

  /**
   * Turns self-update on: checks the token reaches this Worker, then keeps it as this Worker's secret and the account
   * ID beside it. The token is never shown again and never leaves for anywhere but Cloudflare.
   */
  selfUpdateEnable({ token, accountId } = {}) {
    return this.run(async () => {
      if (!this.selfUpdateAllowed())
        throw new AgentError('This install has a repository, which updates it. Self-update is off for it.', 409);
      if (typeof token !== 'string' || token.trim().length < 20 || token.length > 200)
        throw new AgentError('Paste the Cloudflare API token (Workers Scripts: edit).', 400);
      if (typeof accountId !== 'string' || !ACCOUNT.test(accountId.trim().toLowerCase()))
        throw new AgentError('The account ID is 32 characters of letters and digits: copy it from Cloudflare.', 400);
      const cf = new Cloudflare({
        token: token.trim(),
        accountId: accountId.trim().toLowerCase(),
        worker: install(this.env).worker,
        fetchImpl: fetch,
      });
      try {
        await cf.settings();
        await cf.putSecret(TOKEN_BINDING, token.trim());
      } catch (error) {
        throw new AgentError(
          failure(error, 'token').message,
          error instanceof CloudflareError && error.refused ? 400 : 502,
        );
      }
      this.setMeta('selfupd_cfg', JSON.stringify({ accountId: cf.account, enabled: Date.now() }));
      return { status: 200, body: { selfUpdate: { enabled: true } } };
    });
  },

  /** Turns it off: this Worker stops using the token, and the owner is told to delete it on Cloudflare. */
  selfUpdateDisable() {
    return this.run(async () => {
      const cf = await this.selfUpdateClient();
      this.setMeta('selfupd_cfg', null);
      if (cf) await cf.deleteSecret(TOKEN_BINDING).catch(() => {});
      return {
        status: 200,
        body: {
          selfUpdate: { enabled: false },
          message: 'Self-update is off. Delete the API token on Cloudflare: breakaway can’t.',
        },
      };
    });
  },

  /**
   * The owner's press: refuses a second update, then runs the first steps in the background. `wait` (tests) returns
   * after the Worker is deployed instead of when it is started.
   */
  selfUpdateStart({ wait = false, origin = null } = {}) {
    return this.run(async () => {
      if (!this.selfUpdateAllowed())
        throw new AgentError('This install has a repository, which updates it. Self-update is off for it.', 409);
      const cf = await this.selfUpdateClient();
      if (!cf) throw new AgentError('Self-update is off. Turn on updates and paste a Cloudflare token first.', 409);
      const previous = this.selfUpdateState();
      if (
        previous &&
        ['running', 'checking'].includes(previous.status) &&
        Date.now() - Number(previous.at ?? 0) < STALE_MS
      )
        throw new AgentError('An update is already running. Wait for it to finish.', 409);
      const state = { status: 'running', step: 'verify', from: releaseOf(this.env), startedAt: Date.now(), origin };
      this.saveSelfUpdate(state);
      const work = this.selfUpdateRun(cf, state);
      if (wait) await work;
      else this.ctx.waitUntil(work);
      return { status: 202, body: { selfUpdate: { state: this.selfUpdateState() } } };
    });
  },

  /** Steps 1 to 3. Never throws: what failed is kept for the board. */
  async selfUpdateRun(cf, state) {
    const step = (name) => this.saveSelfUpdate(Object.assign(state, { step: name }));
    try {
      const running = state.from;
      const channel = /-main\./u.test(running) ? 'main' : 'stable';
      const found = await this.updatesRead(channel, null);
      if (!found.latest)
        throw Object.assign(new Error(found.error ?? 'The update feed has no release in this channel.'), {
          feed: true,
        });
      if (!isNewer(found.latest.version, running)) {
        this.saveSelfUpdate({ ...state, status: 'idle', step: null, message: 'Up to date.' });
        return;
      }
      const verdict = await verifyRelease(found.latest, { running, publicKey: this.releasePublicKey });
      if ('step' in verdict) {
        this.saveSelfUpdate({ ...state, status: 'failed', step: 'verify', message: verdict.message });
        return;
      }
      const version = verdict.manifest.version;
      state.target = version;
      const settings = await cf.settings();
      const problems = shapeProblems(verdict.manifest.shape, shapeOfInstall(settings, await cf.schedules()));
      if (problems.length) {
        const steps = verdict.manifest.manualSteps?.length ? ` ${verdict.manifest.manualSteps.join(' ')}` : '';
        this.saveSelfUpdate({
          ...state,
          status: 'failed',
          step: 'release',
          message: `${version} needs steps by hand: ${problems.join('; ')}.${steps} Nothing changed.`,
        });
        return;
      }

      step('upload');
      const files = untar(verdict.bundle);
      const code = workerModules(files);
      const assets = assetFiles(files);
      const previousId = await cf.current();
      if (!previousId)
        throw new Error('Cloudflare doesn’t say which version is running, so there would be nothing to go back to.');
      state.previousId = previousId;
      const jwt = await cf.uploadAssets(assets);
      const bindings = (settings.bindings ?? []).filter(
        (b) => !KEPT.includes(b.type) && b.type !== 'assets' && b.name !== 'BREAKAWAY_VERSION',
      );
      bindings.push({ type: 'plain_text', name: 'BREAKAWAY_VERSION', text: version });
      bindings.push({ type: 'assets', name: 'ASSETS' });
      const targetId = await cf.uploadVersion(code, {
        compatibility_date: settings.compatibility_date,
        compatibility_flags: settings.compatibility_flags ?? [],
        ...(settings.observability ? { observability: settings.observability } : {}),
        bindings,
        keep_bindings: KEPT,
        assets: { jwt, config: { run_worker_first: settings.assets?.config?.run_worker_first ?? WORKER_FIRST } },
        annotations: { 'workers/message': `breakaway ${version}`, 'workers/tag': version },
      });
      state.targetId = targetId;

      step('deploy');
      await cf.deploy(targetId, `breakaway ${version}`);
      this.saveSelfUpdate({ ...state, status: 'checking', step: 'check', deadline: Date.now() + CHECK_FOR_MS });
      await this.selfUpdateSchedule(CHECK_EVERY_MS);
    } catch (error) {
      const { step: at, message } = failure(error, state.step);
      this.saveSelfUpdate({
        ...state,
        status: 'failed',
        step: at,
        message: error?.feed
          ? `Can’t read the update feed. The board keeps running as it is; try again later.`
          : `${at === 'deploy' ? 'Cloudflare wouldn’t deploy the new version' : 'The update stopped'} (${message}). The board is still on ${state.from}.`,
      });
    }
  },

  /** Wakes the alarm no later than `ms` from now, without pushing back one that is due sooner. */
  async selfUpdateSchedule(ms) {
    const due = Date.now() + ms;
    const pending = await this.ctx.storage.getAlarm();
    if (!pending || pending > due) await this.ctx.storage.setAlarm(due);
  },

  /**
   * Step 4, from the alarm and the cron: once the new code runs (the release it reports is the one deployed), the
   * update is done; if it hasn't within a minute, the previous version is deployed again. Never throws.
   */
  async selfUpdateTick() {
    const state = this.selfUpdateState();
    if (state?.status !== 'checking') return;
    try {
      if (await this.selfUpdateHealthy(state)) {
        this.saveSelfUpdate({ ...state, status: 'done', step: null, message: `Updated to ${state.target}.` });
        return;
      }
      if (Date.now() < state.deadline) {
        await this.selfUpdateSchedule(CHECK_EVERY_MS);
        return;
      }
      const cf = await this.selfUpdateClient();
      if (!cf) throw new Error('the token is gone, so the previous version can’t be deployed');
      await cf.deploy(state.previousId, `breakaway ${state.target} failed its check`);
      this.saveSelfUpdate({
        ...state,
        status: 'rolledback',
        step: null,
        message: `The update failed its check and was rolled back to ${state.from}.`,
      });
    } catch (error) {
      this.saveSelfUpdate({
        ...state,
        status: 'failed',
        step: 'rollback',
        message: `The update failed its check, and going back failed too (${failure(error, 'rollback').message}). On Cloudflare, open this Worker’s Deployments and roll back to the previous version.`,
      });
    }
  },

  /** The new code answers: this very code reports the deployed release, and the public ping doesn't say otherwise. */
  async selfUpdateHealthy(state) {
    if (releaseOf(this.env) !== state.target) return false;
    const origin = this.env.TASKS_INSTALL?.url ?? state.origin;
    if (!origin) return true;
    try {
      const res = await fetch(`${origin.replace(/\/$/u, '')}/api/ping`);
      const body = res.ok ? await res.json() : null;
      return !(body && typeof body.release === 'string' && body.release !== state.target);
    } catch {
      return true; // the Worker can't always reach its own address; what it reports itself is the check
    }
  },

  /** The Roll back button: deploys the version the last update replaced. */
  selfUpdateRollback() {
    return this.run(async () => {
      const cf = await this.selfUpdateClient();
      if (!cf) throw new AgentError('Self-update is off. Turn on updates and paste a Cloudflare token first.', 409);
      const state = this.selfUpdateState();
      if (state && ['running', 'checking'].includes(state.status) && Date.now() - Number(state.at ?? 0) < STALE_MS)
        throw new AgentError('An update is running. Wait for it to finish.', 409);
      if (state?.status !== 'done' || !state.previousId) throw new AgentError('There is no update to roll back.', 409);
      try {
        await cf.deploy(state.previousId, `breakaway rolled back from ${state.target}`);
      } catch (error) {
        throw new AgentError(`Couldn’t roll back. ${failure(error, 'rollback').message}`, 502);
      }
      this.saveSelfUpdate({
        ...state,
        status: 'rolledback',
        step: null,
        message: `Rolled back to ${state.from}.`,
      });
      return { status: 200, body: { selfUpdate: { state: this.selfUpdateState() } } };
    });
  },
};
