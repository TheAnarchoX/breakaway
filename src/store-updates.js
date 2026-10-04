/**
 * TaskStore's updates (BRK-10): an install whose config names its install repository (`installRepository`) and
 * `channel` knows its version. On the cron, and when breakaway publishes a release, it reads the feed for its channel
 * (or, while the feed has nothing, breakaway's releases through the App, when breakaway is registered here), keeps
 * what it found for Connections' Version row, and on the `main` channel dispatches the install repository's deploy
 * workflow when there's a newer pre-release. On the stable channel it only reports: the install repository's update
 * pull request is the owner's to merge. An install without `installRepository` does none of this, and makes no call.
 */
import { GitHubClient, GitHubError, appCredentials, repoRef } from './github.js';
import { releaseOf } from './build.js';
import { install } from './install.js';
import { clip } from './connections.js';
import { verifyRelease } from './release-verify.js';
import { BREAKAWAY_REPO, DEPLOY_WORKFLOW, FEED_URL, UPDATE_BRANCH, isNewer, latestIn, tooOld } from './updates.js';

const STABLE_EVERY_MS = 3_600_000; // the cron looks for a stable release hourly; the main channel every run
const REDISPATCH_MS = 30 * 60_000; // a deploy for one version isn't started again sooner than this
const LANDED_MS = 45 * 60_000; // a dispatched deploy that hasn't landed after this needs attention
const RELEASE_DELAY_MS = 30_000; // after breakaway's release webhook: the feed and assets settle
const NOTICES_KEPT = 'board.version';

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const updatesMethods = {
  /** The install's update settings, or null for an install with no install repository (which does nothing). */
  updateSettings() {
    const { installRepository, channel } = install(this.env);
    return installRepository ? { installRepository, channel } : null;
  },

  /** What the last check kept, or null. */
  updateState() {
    return JSON.parse(this.meta('upd_state') ?? 'null');
  },

  /** breakaway's release webhook reached the board: look soon (the alarm runs the check). */
  async updatesReleased() {
    if (!this.updateSettings()) return;
    this.setMeta('upd_due', Date.now());
    const pending = await this.ctx.storage.getAlarm();
    if (!pending) await this.ctx.storage.setAlarm(Date.now() + RELEASE_DELAY_MS);
  },

  /** From the cron and the alarm: check when it's time. Never throws. */
  async updatesAutoCheck(source = 'cron') {
    const settings = this.updateSettings();
    if (!settings) return;
    const state = this.updateState();
    const due = this.meta('upd_due');
    const age = Date.now() - Number(state?.at ?? 0);
    if (!due && (source !== 'cron' || (settings.channel === 'stable' && age < STABLE_EVERY_MS))) return;
    this.setMeta('upd_due', null);
    try {
      await this.updatesCheck();
    } catch (error) {
      this.setMeta('upd_state', JSON.stringify({ ...(state ?? {}), at: Date.now(), error: clip(error.message) }));
    }
  },

  /** Reads the latest release in the channel, keeps it, and (on main) dispatches the deploy. */
  async updatesCheck() {
    const settings = this.updateSettings();
    if (!settings) return null;
    const running = releaseOf(this.env);
    const previous = this.updateState();
    const state = {
      at: Date.now(),
      channel: settings.channel,
      installRepository: settings.installRepository,
      running,
      latest: null,
      source: null,
      error: null,
      pullRequest: null,
      dispatch: previous?.dispatch ?? null,
      dispatchError: null,
    };
    const credentials = await appCredentials(this.env);
    const found = await this.updatesRead(settings.channel, credentials);
    state.latest = found.latest;
    state.source = found.source;
    state.error = found.error;
    const newer = isNewer(state.latest?.version, running);
    if (credentials && settings.channel === 'stable' && newer)
      state.pullRequest = await this.updatesPullRequest(credentials, settings).catch(() => null);
    if (credentials && settings.channel === 'main' && newer) await this.updatesDispatch(credentials, settings, state);
    if (!newer) state.dispatch = null;
    this.setMeta('upd_state', JSON.stringify(state));
    this.updatesNotice(state, newer);
    return state;
  },

  /** The feed first; breakaway's releases through the App when the feed has nothing for the channel or can't be read. */
  async updatesRead(channel, credentials) {
    let error = null;
    try {
      const res = await fetch(this.env.TASKS_UPDATE_FEED || FEED_URL, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`the update feed answered ${res.status}`);
      const latest = latestIn(await res.json(), channel);
      if (latest) return { latest, source: 'feed', error: null };
    } catch (e) {
      error = `couldn’t read the update feed: ${clip(e.message)}`;
    }
    const repo = this.repos().find(
      (r) => r.github.toLowerCase() === (this.env.TASKS_BREAKAWAY_REPO || BREAKAWAY_REPO).toLowerCase(),
    );
    if (credentials && repo) {
      try {
        const releases = await this.githubClient(credentials, repo).get('/releases?per_page=100');
        return { latest: latestIn(releases, channel), source: 'github', error: null };
      } catch (e) {
        error = `${error ?? 'the update feed has no release in this channel'}; breakaway’s releases couldn’t be read through the App: ${clip(e.message)}`;
      }
    }
    return { latest: null, source: null, error };
  },

  /**
   * For an install with no install repository (BRK-52): reads the feed for `channel` (by default the running version's),
   * verifies the newest release's signature, checksums, and `updatesFrom`, and keeps the verdict for Connections.
   * Installs nothing and sends nothing about the install. Not on a schedule: the owner turning self-update on (a later
   * task) is what starts it, so an install that hasn't asked makes no call.
   */
  async updatesVerify(channel) {
    if (this.updateSettings()) return null;
    const running = releaseOf(this.env);
    channel ??= /-main\./u.test(running) ? 'main' : 'stable';
    const found = await this.updatesRead(channel, null);
    const state = { at: Date.now(), channel, running, latest: found.latest, error: found.error, verdict: null };
    if (found.latest && isNewer(found.latest.version, running)) {
      const verdict = await verifyRelease(found.latest, { running });
      state.verdict =
        'step' in verdict
          ? { ok: false, step: verdict.step, message: verdict.message }
          : { ok: true, version: found.latest.version };
    }
    this.setMeta('upd_verified', JSON.stringify(state));
    return state;
  },

  /** What the last verification kept, or null. */
  updateVerified() {
    return JSON.parse(this.meta('upd_verified') ?? 'null');
  },

  /** The client for the install repository: its own token cache, since it needn't be registered on the board. */
  updatesClient(credentials, settings) {
    this.ghCache[`install:${settings.installRepository}`] ??= {};
    return new GitHubClient(
      credentials,
      repoRef(settings.installRepository),
      this.ghCache[`install:${settings.installRepository}`],
      this.env.TASKS_GITHUB_API || undefined,
    );
  },

  /** The install repository's open update pull request (the template's update workflow keeps one on breakaway/update). */
  async updatesPullRequest(credentials, settings) {
    const owner = settings.installRepository.split('/')[0];
    const pulls = await this.updatesClient(credentials, settings).get(
      `/pulls?state=open&head=${encodeURIComponent(`${owner}:${UPDATE_BRANCH}`)}`,
    );
    const pr = pulls[0];
    return pr ? { number: pr.number, title: clip(pr.title, 120), url: pr.html_url ?? null } : null;
  },

  /**
   * On the main channel with a newer pre-release: starts the install repository's deploy workflow on its default
   * branch, which checks the release and rolls back if it doesn't come up. A release that needs steps by hand, or one
   * the running version can't update from, is left to the owner. The same version isn't dispatched twice in 30 minutes;
   * the install repository's hourly update run is the fallback.
   */
  async updatesDispatch(credentials, settings, state) {
    const { latest, running } = state;
    if (latest.manual || tooOld(running, latest.updatesFrom)) return;
    const last = state.dispatch;
    if (last?.version === latest.version && Date.now() - last.at < REDISPATCH_MS) return;
    const client = this.updatesClient(credentials, settings);
    try {
      const info = await client.get('');
      await client.send('POST', `/actions/workflows/${DEPLOY_WORKFLOW}/dispatches`, {
        ref: info.default_branch || 'main',
      });
      state.dispatch = { version: latest.version, at: Date.now() };
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      state.dispatch = { version: latest.version, at: Date.now(), failed: true };
      state.dispatchError =
        error.status === 403 && /not accessible by integration/iu.test(error.reason ?? '')
          ? `the board’s GitHub App can’t start workflows on ${settings.installRepository}: install it there and give it read and write on Actions`
          : `GitHub refused to start ${DEPLOY_WORKFLOW} on ${settings.installRepository} (${error.status}): ${clip(error.reason ?? error.message)}`;
    }
  },

  /**
   * The inbox's note (an `fyi`, never a push): a newer stable release waits for the owner, once per release, and
   * it's resolved when the board runs it. The main channel deploys itself, so it makes none.
   */
  updatesNotice(state, newer) {
    const now = Date.now();
    const open = this.sql
      .exec(
        "SELECT id, detail FROM connection_notices WHERE conn = ? AND kind = 'update' AND resolved IS NULL",
        NOTICES_KEPT,
      )
      .toArray();
    const text =
      state.channel === 'stable' && newer
        ? `breakaway ${state.latest.version} is available on the stable channel; this board runs ${state.running}.${state.pullRequest ? ` Merge pull request #${state.pullRequest.number} on ${state.installRepository} to deploy it.` : ''}`
        : null;
    const mark = `breakaway ${state.latest?.version} is available`;
    for (const row of open) {
      if (text && String(row.detail).startsWith(mark)) {
        if (row.detail !== text) this.sql.exec('UPDATE connection_notices SET detail = ? WHERE id = ?', text, row.id);
        return;
      }
      this.sql.exec(
        'UPDATE connection_notices SET resolved = ?, resolution = ? WHERE id = ?',
        now,
        text ? 'replaced' : 'updated',
        row.id,
      );
    }
    if (text)
      this.sql.exec(
        "INSERT INTO connection_notices (conn, kind, name, detail, created) VALUES (?, 'update', 'Version', ?, ?)",
        NOTICES_KEPT,
        text,
        now,
      );
  },

  /** The Version row on Connections, from what the last check kept. Makes no call. */
  updateConnection(entry) {
    const running = releaseOf(this.env);
    const settings = this.updateSettings();
    if (!settings) return entry('board.version', 'board', 'Version', 'working', { detail: `Running ${running}.` });
    const state = this.updateState();
    const head = `Running ${running} on the ${settings.channel} channel`;
    if (!state)
      return entry('board.version', 'board', 'Version', 'working', {
        detail: `${head}; not checked for updates yet.`,
        update: { running, channel: settings.channel, installRepository: settings.installRepository },
      });
    const newer = isNewer(state.latest?.version, running);
    const update = {
      running,
      channel: settings.channel,
      installRepository: settings.installRepository,
      latest: state.latest,
      newer,
      pullRequest: state.pullRequest,
      deploying: newer && state.channel === 'main' && Boolean(state.dispatch && !state.dispatch.failed),
    };
    const repoLink = `https://github.com/${settings.installRepository}`;
    const link = state.pullRequest?.url ?? state.latest?.notes ?? repoLink;
    const stale = state.error && Date.now() - state.at > 2 * STABLE_EVERY_MS;
    if (state.dispatchError)
      return entry('board.version', 'board', 'Version', 'attention', {
        detail: `${head}; ${state.latest.version} is available, but ${state.dispatchError}.`,
        at: iso(state.at),
        fix: `Install the App on ${settings.installRepository} and give it read and write on Actions (docs/tasks.md#github). Until then, run Deploy from that repository’s Actions tab; its hourly update run also deploys it.`,
        link: repoLink,
        update,
      });
    if (!state.latest) {
      return entry('board.version', 'board', 'Version', stale ? 'attention' : 'working', {
        detail: `${head}; ${state.error ?? `no ${settings.channel} release to compare with yet`}.`,
        at: iso(state.at),
        fix: 'Press Check now. If it repeats, check the update feed and breakaway’s releases.',
        link: repoLink,
        update,
      });
    }
    if (!newer)
      return entry('board.version', 'board', 'Version', 'working', {
        detail: `${head}; it is the latest.`,
        at: iso(state.at),
        link: state.latest.notes ?? null,
        update,
      });
    const lands = state.dispatch && !state.dispatch.failed ? state.dispatch.at : null;
    if (settings.channel === 'main' && lands && Date.now() - lands > LANDED_MS) {
      return entry('board.version', 'board', 'Version', 'attention', {
        detail: `${head}; ${state.latest.version} was deployed from ${settings.installRepository} ${Math.round((Date.now() - lands) / 60_000)} minutes ago and isn’t running yet.`,
        at: iso(state.at),
        fix: `Open Actions on ${settings.installRepository}: the Deploy run says why it stopped. A release that needs steps by hand stops there on purpose.`,
        link: `${repoLink}/actions`,
        update,
      });
    }
    const how =
      settings.channel === 'main'
        ? state.latest.manual
          ? `it needs steps by hand: ${state.latest.manualSteps.join('; ') || 'see its notes'}`
          : tooOld(running, state.latest.updatesFrom)
            ? `this board is too old to update to it directly (from ${state.latest.updatesFrom})`
            : update.deploying
              ? 'its deploy has started'
              : 'it deploys by itself'
        : state.pullRequest
          ? `merge pull request #${state.pullRequest.number} on ${settings.installRepository} to deploy it`
          : `the update pull request on ${settings.installRepository} opens within the hour`;
    return entry('board.version', 'board', 'Version', 'working', {
      detail: `${head}; ${state.latest.version} is available: ${how}.`,
      at: iso(state.at),
      link,
      update,
    });
  },
};

const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);
