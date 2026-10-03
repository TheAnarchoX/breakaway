import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wranglerConfig } from '../src/install.js';
import { FEED_URL, isNewer, latestIn, tooOld } from '../src/updates.js';

const INSTALL = 'acme/board-install';
const feed = (main, stable = null, extra = {}) => ({
  channels: {
    stable,
    main: main && {
      version: main,
      notes: `https://example.test/notes/${main}`,
      manual: false,
      updatesFrom: '0.1.0',
      ...extra,
    },
  },
});
const stableEntry = (version) => ({
  version,
  notes: `https://example.test/notes/${version}`,
  manual: false,
  updatesFrom: '0.1.0',
});

/** A pretend feed and GitHub; each test changes what they answer. */
const world = {};
function reset() {
  Object.assign(world, {
    feed: feed('0.2.0-main.5'),
    feedStatus: 200,
    pulls: [],
    dispatchStatus: 204,
    dispatchReason: null,
    calls: [],
    fetched: [],
  });
}

function mock() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = init.method ?? 'GET';
    const reply = (data, status = 200) =>
      new Response(status === 204 ? null : JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    world.fetched.push(`${method} ${url.host}${url.pathname}`);
    if (url.host === new URL(FEED_URL).host)
      return world.feedStatus === 200 ? reply(world.feed) : reply({}, world.feedStatus);
    if (url.host !== 'api.github.com') throw new Error(`unexpected fetch to ${url}`);
    const path = url.pathname;
    if (path === `/repos/${INSTALL}/installation`) return reply({ id: 91 });
    if (path === '/repos/acme/breakaway/installation') return reply({ id: 78 });
    if (/^\/app\/installations\/\d+\/access_tokens$/u.test(path))
      return reply({ token: 'ghs_updates', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (path === `/repos/${INSTALL}`) return reply({ default_branch: 'trunk' });
    if (path === `/repos/${INSTALL}/pulls`) return reply(world.pulls);
    if (path === `/repos/${INSTALL}/actions/workflows/deploy.yml/dispatches` && method === 'POST') {
      world.calls.push(JSON.parse(init.body));
      return world.dispatchStatus === 204
        ? reply(null, 204)
        : reply({ message: world.dispatchReason ?? 'nope' }, world.dispatchStatus);
    }
    if (path === '/repos/acme/breakaway/releases') return reply(world.releases ?? []);
    return reply({ message: 'Not Found' }, 404);
  });
}

const stub = () => env.STORE.get(env.STORE.idFromName('samewave'));
/** Runs `fn` as a board that runs `running` and follows `channel` of `installRepository`. */
const asInstall = (settings, fn) =>
  runInDurableObject(stub(), async (instance) => {
    const own = instance.env;
    const config = settings.installRepository
      ? wranglerConfig({
          name: 'board',
          worker: 'board',
          installRepository: settings.installRepository,
          channel: settings.channel,
        }).vars.TASKS_INSTALL
      : own.TASKS_INSTALL;
    try {
      instance.env = { ...own, TASKS_INSTALL: config, BREAKAWAY_VERSION: settings.running ?? '0.2.0-main.3' };
      instance.setMeta('upd_state', null);
      instance.setMeta('upd_due', null);
      instance.sql.exec("DELETE FROM connection_notices WHERE kind = 'update'");
      return await fn(instance);
    } finally {
      instance.env = own;
    }
  });
const entryOf = (id, group, name, state, extra = {}) => ({ id, group, name, state, ...extra });
const versionRow = (s) => s.updateConnection(entryOf);
const row = versionRow;

describe('updates, the pure parts', () => {
  it('reads the latest release in a channel from the feed or from GitHub’s list', () => {
    expect(latestIn(feed('0.2.0-main.5'), 'main')).toMatchObject({
      version: '0.2.0-main.5',
      manual: false,
      updatesFrom: '0.1.0',
    });
    expect(latestIn(feed('0.2.0-main.5'), 'stable')).toBeNull();
    const releases = [
      { tag_name: 'v0.2.0-main.2', prerelease: true, html_url: 'u2' },
      { tag_name: 'v0.2.0-main.10', prerelease: true, html_url: 'u10' },
      { tag_name: 'v0.2.0-main.11', prerelease: true, draft: true },
      { tag_name: 'v0.1.0', prerelease: false, html_url: 'u1' },
    ];
    expect(latestIn(releases, 'main')).toMatchObject({ version: '0.2.0-main.10', notes: 'u10' });
    expect(latestIn(releases, 'stable')).toMatchObject({ version: '0.1.0' });
    expect(latestIn('nothing', 'main')).toBeNull();
  });

  it('compares versions by number, never by date, and skips what isn’t a version', () => {
    expect(isNewer('0.2.0-main.10', '0.2.0-main.9')).toBe(true);
    expect(isNewer('0.2.0-main.3', '0.2.0-main.3')).toBe(false);
    expect(isNewer('0.2.0', '0.2.0-main.9')).toBe(true);
    expect(isNewer('0.2.0', 'dev')).toBe(false);
    expect(tooOld('0.1.0', '0.2.0')).toBe(true);
    expect(tooOld('0.2.0-main.1', '0.1.0')).toBe(false);
  });
});

describe('an install with an install repository', () => {
  let spy;
  beforeEach(() => {
    reset();
    spy = mock();
  });
  afterEach(() => spy.mockRestore());

  it('on main dispatches the install repository’s deploy for a newer pre-release, once', async () => {
    await asInstall({ installRepository: INSTALL, channel: 'main' }, async (s) => {
      await s.updatesCheck();
      expect(world.calls).toEqual([{ ref: 'trunk' }]);
      expect(row(s)).toMatchObject({ state: 'working' });
      expect(versionRow(s).detail).toContain('0.2.0-main.5 is available: its deploy has started');
      expect(versionRow(s).update).toMatchObject({
        running: '0.2.0-main.3',
        channel: 'main',
        latest: { version: '0.2.0-main.5' },
        deploying: true,
      });
      // The next cron run, minutes later, doesn't start it again.
      await s.updatesAutoCheck('cron');
      expect(world.calls).toHaveLength(1);
      // No inbox note: the main channel deploys itself.
      expect(s.connectionNotices().filter((n) => n.kind === 'update')).toEqual([]);
    });
  });

  it('dispatches again for a newer pre-release, and tries the same one again after half an hour', async () => {
    await asInstall({ installRepository: INSTALL, channel: 'main' }, async (s) => {
      await s.updatesCheck();
      world.feed = feed('0.2.0-main.6');
      await s.updatesCheck();
      expect(world.calls).toHaveLength(2);
      const state = s.updateState();
      s.setMeta(
        'upd_state',
        JSON.stringify({ ...state, dispatch: { ...state.dispatch, at: Date.now() - 31 * 60_000 } }),
      );
      await s.updatesCheck();
      expect(world.calls).toHaveLength(3);
    });
  });

  it('does nothing on main when it already runs the latest, and clears what it had started', async () => {
    await asInstall({ installRepository: INSTALL, channel: 'main', running: '0.2.0-main.5' }, async (s) => {
      await s.updatesCheck();
      expect(world.calls).toEqual([]);
      expect(versionRow(s).detail).toBe('Running 0.2.0-main.5 on the main channel; it is the latest.');
      expect(s.updateState().dispatch).toBeNull();
    });
  });

  it('leaves a release that needs steps by hand, or that this version can’t update from, to the owner', async () => {
    await asInstall({ installRepository: INSTALL, channel: 'main' }, async (s) => {
      world.feed = feed('0.2.0-main.5', null, { manual: true, manualSteps: ['move the Durable Object'] });
      await s.updatesCheck();
      expect(world.calls).toEqual([]);
      expect(versionRow(s).detail).toContain('needs steps by hand: move the Durable Object');
      world.feed = feed('0.2.0-main.6', null, { updatesFrom: '0.2.0-main.4' });
      await s.updatesCheck();
      expect(world.calls).toEqual([]);
      expect(versionRow(s).detail).toContain('too old to update to it directly');
    });
  });

  it('says what to do when the App can’t start workflows, and when a deploy never lands', async () => {
    await asInstall({ installRepository: INSTALL, channel: 'main' }, async (s) => {
      world.dispatchStatus = 403;
      world.dispatchReason = 'Resource not accessible by integration';
      await s.updatesCheck();
      const bad = versionRow(s);
      expect(bad).toMatchObject({ state: 'attention' });
      expect(bad.fix).toContain('read and write on Actions');
      world.dispatchStatus = 204;
      s.setMeta('upd_state', null);
      await s.updatesCheck();
      expect(versionRow(s).state).toBe('working');
      const state = s.updateState();
      s.setMeta(
        'upd_state',
        JSON.stringify({ ...state, dispatch: { ...state.dispatch, at: Date.now() - 50 * 60_000 } }),
      );
      expect(versionRow(s)).toMatchObject({ state: 'attention', link: `https://github.com/${INSTALL}/actions` });
    });
  });

  it('on stable only reports: the update pull request, and one inbox note per release without a push', async () => {
    await asInstall({ installRepository: INSTALL, channel: 'stable', running: '0.1.0' }, async (s) => {
      world.feed = feed(null, stableEntry('0.2.0'));
      world.pulls = [
        { number: 7, title: 'Update breakaway to 0.2.0', html_url: `https://github.com/${INSTALL}/pull/7` },
      ];
      await s.updatesCheck();
      expect(world.calls).toEqual([]);
      expect(world.fetched.some((f) => f.includes('/pulls'))).toBe(true);
      expect(versionRow(s).detail).toContain('0.2.0 is available: merge pull request #7');
      expect(versionRow(s).link).toBe(`https://github.com/${INSTALL}/pull/7`);
      const notes = () => s.connectionNotices().filter((n) => n.kind === 'update');
      expect(notes()).toHaveLength(1);
      expect(notes()[0]).toMatchObject({ name: 'Version', detail: expect.stringContaining('Merge pull request #7') });
      await s.updatesCheck();
      expect(notes()).toHaveLength(1);
      // A newer release replaces the note; running it resolves it.
      world.feed = feed(null, stableEntry('0.3.0'));
      world.pulls = [];
      await s.updatesCheck();
      expect(notes()).toHaveLength(1);
      expect(notes()[0].detail).toContain('0.3.0 is available');
      s.env.BREAKAWAY_VERSION = '0.3.0';
      await s.updatesCheck();
      expect(notes()).toEqual([]);
    });
  });

  it('looks for a stable release hourly, the main channel on every cron run, and at once after breakaway’s release webhook', async () => {
    await asInstall({ installRepository: INSTALL, channel: 'stable', running: '0.1.0' }, async (s) => {
      world.feed = feed(null, stableEntry('0.2.0'));
      await s.updatesAutoCheck('cron');
      const first = world.fetched.length;
      await s.updatesAutoCheck('cron');
      expect(world.fetched.length).toBe(first);
      await s.updatesReleased();
      await s.updatesAutoCheck('alarm');
      expect(world.fetched.length).toBeGreaterThan(first);
      expect(s.meta('upd_due')).toBeNull();
    });
    await asInstall({ installRepository: INSTALL, channel: 'main' }, async (s) => {
      await s.updatesAutoCheck('cron');
      const first = world.fetched.length;
      await s.updatesAutoCheck('cron');
      expect(world.fetched.length).toBeGreaterThan(first);
      // An alarm without a release webhook looks at nothing.
      const before = world.fetched.length;
      await s.updatesAutoCheck('alarm');
      expect(world.fetched.length).toBe(before);
    });
  });

  it('reads breakaway’s releases through the App when the feed has nothing and breakaway is registered', async () => {
    await asInstall({ installRepository: INSTALL, channel: 'main' }, async (s) => {
      world.feed = feed(null);
      world.releases = [
        {
          tag_name: 'v0.2.0-main.9',
          prerelease: true,
          html_url: 'https://github.com/acme/breakaway/releases/tag/v0.2.0-main.9',
        },
      ];
      s.env.TASKS_BREAKAWAY_REPO = 'acme/breakaway';
      // Not registered here: the feed is all there is.
      expect(await s.updatesCheck()).toMatchObject({ source: null, latest: null });
      s.sql.exec(
        "INSERT INTO repos (slug, github, name, default_branch, areas, is_default, created, edited) VALUES ('bka', 'acme/breakaway', 'breakaway', 'main', '[]', 0, 1, 1)",
      );
      s.repoCache = null;
      try {
        expect(await s.updatesCheck()).toMatchObject({ source: 'github', latest: { version: '0.2.0-main.9' } });
        expect(world.calls).toEqual([{ ref: 'trunk' }]);
      } finally {
        s.sql.exec("DELETE FROM repos WHERE slug = 'bka'");
        s.repoCache = null;
      }
    });
  });

  it('keeps a feed that can’t be read as a plain row, and tries again', async () => {
    await asInstall({ installRepository: INSTALL, channel: 'main' }, async (s) => {
      world.feedStatus = 500;
      await s.updatesCheck();
      const r = versionRow(s);
      expect(r.state).toBe('working');
      expect(r.detail).toContain('couldn’t read the update feed');
      expect(world.calls).toEqual([]);
    });
  });
});

describe('an install without an install repository', () => {
  it('makes no call, writes nothing, and its Version row says only what runs', async () => {
    reset();
    const spy = mock();
    try {
      await asInstall({ installRepository: null }, async (s) => {
        expect(await s.updatesCheck()).toBeNull();
        await s.updatesAutoCheck('cron');
        await s.updatesReleased();
        expect(world.fetched).toEqual([]);
        expect(s.meta('upd_due')).toBeNull();
        expect(versionRow(s)).toMatchObject({ id: 'board.version', state: 'working', detail: 'Running 0.2.0-main.3.' });
        expect(versionRow(s).update).toBeUndefined();
      });
    } finally {
      spy.mockRestore();
    }
  });
});
