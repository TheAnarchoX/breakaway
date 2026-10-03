import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { comparePermissions, routineFix, summarizeDeliveries } from '../src/connections.js';
import { ORIGIN, TEST_API_TOKEN, TEST_CLIENT_ID, TEST_GITHUB_WEBHOOK_SECRET, TEST_SYNC_KEY } from './constants.js';
import { api, latestVersion, pushOps, sync, twCreate } from './helpers.js';

const REPO = '/repos/acme/samewave';
const encoder = new TextEncoder();
const ALL = {
  metadata: 'read',
  contents: 'write',
  pull_requests: 'write',
  checks: 'read',
  statuses: 'read',
  actions: 'write',
  deployments: 'read',
  vulnerability_alerts: 'read',
};

/** A pretend GitHub for the live checks; each test changes what it answers. */
const gh = {};
function reset() {
  Object.assign(gh, {
    app: 200,
    installed: true,
    suspended: false,
    permissions: { ...ALL },
    autoMerge: true,
    deliveries: [
      { id: 2, event: 'pull_request', delivered_at: '2026-10-02T09:00:00Z', status: 'OK', status_code: 202 },
    ],
    rate: { limit: 5000, remaining: 4900, reset: 1_790_000_000 },
    writes: [],
  });
}

function mockGitHub() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const reply = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const path = url.pathname;
    const method = init.method ?? 'GET';
    if (url.host !== 'api.github.com') throw new Error(`unexpected fetch to ${url}`);
    if (method !== 'GET' && !path.endsWith('/access_tokens')) {
      gh.writes.push([method, path]);
      return reply({ message: 'no writes here' }, 500);
    }
    if (path === '/app')
      return gh.app === 200
        ? reply({
            id: 424242,
            slug: 'samewave-tasks',
            name: 'samewave tasks',
            html_url: 'https://github.com/apps/samewave-tasks',
          })
        : reply({ message: 'A JSON web token could not be decoded' }, gh.app);
    if (path === '/app/hook/deliveries') return reply(gh.deliveries);
    if (path === `${REPO}/installation`) {
      return gh.installed
        ? reply({
            id: 77,
            permissions: gh.permissions,
            suspended_at: gh.suspended ? '2026-10-01T00:00:00Z' : null,
            html_url: 'https://github.com/settings/installations/77',
          })
        : reply({ message: 'Not Found' }, 404);
    }
    // breakaway has the App like samewave; scratch has nothing set up.
    if (path === '/repos/acme/breakaway/installation')
      return reply({
        id: 78,
        permissions: { ...ALL },
        suspended_at: null,
        html_url: 'https://github.com/settings/installations/78',
      });
    if (path === '/app/installations/78/access_tokens')
      return reply({ token: 'ghs_connectionscheck', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (path === '/repos/acme/breakaway') return reply({ full_name: 'acme/breakaway', allow_auto_merge: true });
    if (path === '/app/installations/77/access_tokens')
      return reply({ token: 'ghs_connectionscheck', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (path === REPO) return reply({ full_name: 'acme/samewave', allow_auto_merge: gh.autoMerge });
    if (path === '/rate_limit') return reply({ resources: { core: gh.rate } });
    return reply({ message: 'Not Found' }, 404);
  });
}

const stub = () => env.STORE.get(env.STORE.idFromName('samewave'));
const inStore = (fn) => runInDurableObject(stub(), (instance) => fn(instance));

/** A task claimed by `agent` with a run the board started `minutes` ago: an agent that is still running. Its uuid. */
async function runningAgent(agent, { minutes = 20, repo = null } = {}) {
  const body = {
    description: `What ${agent} works on`,
    project: repo ? 'product' : 'cloud',
    ...(repo ? { repo } : {}),
  };
  const { uuid } = (await (await api('tasks', { method: 'POST', body })).json()).tasks[0];
  expect((await api(`tasks/${uuid}/claim`, { method: 'POST', body: { agent } })).ok).toBe(true);
  await inStore((s) =>
    s.sql.exec(
      "INSERT INTO agent_runs (task, agent, trigger, status, started, repo) VALUES (?, ?, 'manual', 'started', ?, ?)",
      uuid,
      agent,
      Date.now() - minutes * 60_000,
      repo,
    ),
  );
  return uuid;
}
/** One live-output entry of `kind` on the task, as the session hook (or the CLI's claim) sends it. */
const said = (uuid, kind) =>
  inStore((s) => s.appendSessionLog(uuid, { agent: 'claude', entries: [{ kind, at: Date.now(), text: kind }] }));
/** Done with the task: its claim released (unless `agent` is null), finished, and its runs gone, so later tests start clean. */
async function finish(uuid, agent) {
  if (agent) await api(`tasks/${uuid}/release`, { method: 'POST', body: { agent } });
  await api(`tasks/${uuid}/done`, { method: 'POST', body: {} });
  await inStore((s) => s.sql.exec('DELETE FROM agent_runs WHERE task = ?', uuid));
}

/** The signed-in browser: the cookie from /login, from this origin. */
async function browser() {
  const res = await SELF.fetch(`${ORIGIN}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: TEST_API_TOKEN }),
  });
  const cookie = res.headers.get('Set-Cookie').split(';')[0];
  return () =>
    SELF.fetch(`${ORIGIN}/api/connections/check`, { method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN } });
}

/** Check now, as the owner presses it (the 30-second gap reset first). */
async function checkNow() {
  await inStore((s) => s.setMeta('conn_live_at', null));
  const res = await (await browser())();
  expect(res.status).toBe(200);
  return res.json();
}

const find = (report, id) => report.connections.find((c) => c.id === id);

describe('connections, the pure parts', () => {
  it('compares the App’s permissions with what the board needs', () => {
    expect(comparePermissions(ALL, { pipeline: true }).every((p) => p.ok)).toBe(true);
    const missing = comparePermissions({ ...ALL, contents: 'read', actions: 'read' }, { pipeline: true })
      .filter((p) => !p.ok)
      .map((p) => p.name);
    expect(missing).toEqual(['contents', 'actions']);
    // Actions and Deployments matter only where there's a deploy pipeline.
    expect(comparePermissions({ ...ALL, actions: undefined, deployments: undefined }).every((p) => p.ok)).toBe(true);
    expect(comparePermissions({ ...ALL, contents: 'admin' }).every((p) => p.ok)).toBe(true);
  });

  it('reads GitHub’s delivery log and names the fix for each failure', () => {
    const at = (status_code) => [
      {
        event: 'push',
        delivered_at: '2026-10-02T09:00:00Z',
        status: status_code ? 'Invalid HTTP Response' : 'timed out',
        status_code,
      },
    ];
    expect(summarizeDeliveries(at(202), ORIGIN).state).toBe('working');
    expect(summarizeDeliveries(at(401), ORIGIN).fix).toMatch(/webhook secret/u);
    expect(summarizeDeliveries(at(503), ORIGIN).fix).toMatch(/github-connect/u);
    expect(summarizeDeliveries(at(0), ORIGIN).fix).toMatch(/couldn't reach/u);
    expect(summarizeDeliveries(at(500), ORIGIN).fix).toMatch(/answered 500/u);
    expect(summarizeDeliveries([], ORIGIN).fix).toContain(`${ORIGIN}/github/webhook`);
    // A ping isn't a real delivery.
    expect(summarizeDeliveries([{ event: 'ping', status_code: 200 }], ORIGIN).state).toBe('attention');
  });

  it('tells routine failures apart', () => {
    expect(routineFix('the routine’s token was refused: connect the routine again')).toMatch(/new API token/u);
    expect(routineFix('Claude’s hourly limit for starting sessions is reached')).toMatch(/within the hour/u);
    expect(routineFix('the routine is paused on claude.ai')).toMatch(/resume/u);
    expect(routineFix('Claude couldn’t start the session (500: boom)')).toMatch(/Agents view/u);
  });
});

describe('GET /api/connections and Check now', () => {
  let spy;
  beforeEach(() => {
    reset();
    spy = mockGitHub();
  });
  afterEach(() => spy.mockRestore());

  it('shows every connection working when everything is wired up, and never a secret', async () => {
    await inStore((s) => {
      s.setMeta('gh_last_sync', Date.now());
      s.setMeta('gh_error', null);
      s.connectionsCronRan([]);
    });
    const report = await checkNow();
    const ids = report.connections.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'cloudflare.worker',
        'cloudflare.secrets',
        'cloudflare.cron',
        'cloudflare.sync',
        'github.app',
        'github.install',
        'github.permissions',
        'github.automerge',
        'github.webhook',
        'github.sync',
        'claude.routine',
        'claude.budget',
        'claude.output',
        'taskwarrior',
        'push',
      ]),
    );
    for (const id of [
      'cloudflare.secrets',
      'cloudflare.cron',
      'cloudflare.sync',
      'github.app',
      'github.install',
      'github.permissions',
      'github.automerge',
      'github.webhook',
      'github.sync',
      'claude.routine',
    ]) {
      expect(find(report, id), id).toMatchObject({ state: 'working', fix: null });
    }
    expect(find(report, 'github.sync').detail).toContain('4900 of 5000');
    expect(find(report, 'cloudflare.secrets').items.find((i) => i.name === 'TASKS_SYNC_KEY')).toMatchObject({
      state: 'set',
    });
    expect(report.checked).not.toBeNull();
    expect(report.cannotCheck.length).toBeGreaterThan(0);
    // Read only: nothing was written to GitHub.
    expect(gh.writes).toEqual([]);

    // The bearer token reads the same thing; nothing in it is a secret value.
    const res = await api('connections');
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const value of [
      TEST_API_TOKEN,
      TEST_SYNC_KEY,
      TEST_CLIENT_ID,
      TEST_GITHUB_WEBHOOK_SECRET,
      env.TASKS_GITHUB_KEY,
      env.TASKS_ROUTINE_TOKEN,
      env.TASKS_ROUTINE_URL,
      'sk-ant-oat01-breakaway-routine-token',
      env.TASKS_VAPID_KEY,
      'ghs_connectionscheck',
    ]) {
      expect(text).not.toContain(value);
    }
    await inStore((s) => {
      const stored = s.sql
        .exec("SELECT value FROM meta WHERE key LIKE 'conn_%'")
        .toArray()
        .map((r) => r.value)
        .join('\n');
      expect(stored).not.toContain('ghs_connectionscheck');
      expect(stored).not.toContain(env.TASKS_ROUTINE_TOKEN);
    });
  });

  it('keeps Check now for the signed-in browser, and rate limits it', async () => {
    expect((await api('connections/check', { method: 'POST' })).status).toBe(403);
    await inStore((s) => s.setMeta('conn_live_at', null));
    const press = await browser();
    expect((await press()).status).toBe(200);
    expect((await press()).status).toBe(429);
  });

  it('says which permissions are missing and how to grant them (CLD-56, CLD-104)', async () => {
    gh.permissions = { ...ALL, contents: 'read', pull_requests: 'read', actions: 'read' };
    const c = find(await checkNow(), 'github.permissions');
    expect(c.state).toBe('attention');
    expect(c.detail).toMatch(/Pull requests write.*Contents write.*Actions write/u);
    expect(c.fix).toMatch(/Pull requests to read and write, Contents to read and write, Actions to read and write/u);
    expect(c.fix).toMatch(/accept the new permissions on the installation/u);
    expect(c.items.filter((p) => !p.ok)).toHaveLength(3);
  });

  it('tells a missing installation, a suspended one, and auto-merge off apart', async () => {
    gh.installed = false;
    let report = await checkNow();
    expect(find(report, 'github.install')).toMatchObject({ state: 'off', repo: 'samewave' });
    expect(find(report, 'github.install').fix).toContain('https://github.com/apps/samewave-tasks/installations/new');
    expect(find(report, 'github.permissions')).toBeUndefined();

    gh.installed = true;
    gh.suspended = true;
    gh.autoMerge = false;
    report = await checkNow();
    expect(find(report, 'github.install')).toMatchObject({ state: 'attention' });
    expect(find(report, 'github.install').fix).toMatch(/Unsuspend/u);
    expect(find(report, 'github.automerge').state).toBe('attention');
    expect(find(report, 'github.automerge').fix).toMatch(/Allow auto-merge/u);
  });

  it('says when GitHub refuses the App’s key', async () => {
    gh.app = 401;
    const c = find(await checkNow(), 'github.app');
    expect(c.state).toBe('attention');
    expect(c.fix).toMatch(/new private key/u);
  });

  it('reads failed webhook deliveries, and counts refused signatures', async () => {
    gh.deliveries = [
      {
        event: 'check_run',
        delivered_at: '2026-10-02T10:00:00Z',
        status: 'Invalid HTTP Response: 401',
        status_code: 401,
      },
      { event: 'push', delivered_at: '2026-10-02T09:00:00Z', status: 'OK', status_code: 202 },
    ];
    const bad = await SELF.fetch(`${ORIGIN}/github/webhook`, {
      method: 'POST',
      headers: { 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': 'sha256=00' },
      body: '{}',
    });
    expect(bad.status).toBe(401);
    const c = find(await checkNow(), 'github.webhook');
    expect(c.state).toBe('attention');
    expect(c.detail).toMatch(/1 of the last 2 failed/u);
    expect(c.detail).toMatch(/refused signature/u);
    expect(c.fix).toMatch(/webhook secret/u);
  });

  it('says when the sync with GitHub is failing, late, or low on requests', async () => {
    await inStore((s) => {
      s.setMeta('gh_last_sync', Date.now());
      s.setMeta('gh_error', 'GitHub 401 on /repos/acme/samewave/pulls: Bad credentials');
    });
    let report = await checkNow();
    expect(find(report, 'github.sync')).toMatchObject({ state: 'attention' });
    expect(find(report, 'github.sync').fix).toMatch(/installation and permissions/u);

    await inStore((s) => {
      s.setMeta('gh_error', null);
      s.setMeta('gh_last_sync', Date.now() - 3_600_000);
    });
    report = await checkNow();
    expect(find(report, 'github.sync').fix).toMatch(/No sync in the last 15 minutes/u);

    await inStore((s) => s.setMeta('gh_last_sync', null));
    report = await checkNow();
    expect(find(report, 'github.sync').fix).toMatch(/repos init/u);

    await inStore((s) => s.setMeta('gh_last_sync', Date.now()));
    gh.rate = { limit: 5000, remaining: 12, reset: 1_790_000_000 };
    report = await checkNow();
    expect(find(report, 'github.sync').fix).toMatch(/Only 12 of 5000/u);
  });

  it('shows the App as not connected while its secrets are unset', async () => {
    const report = await inStore(async (s) => {
      const saved = s.env.TASKS_GITHUB_APP_ID;
      s.env.TASKS_GITHUB_APP_ID = 'unset';
      try {
        return await s.connectionsReport();
      } finally {
        s.env.TASKS_GITHUB_APP_ID = saved;
      }
    });
    const app = find(report, 'github.app');
    expect(app.state).toBe('off');
    expect(app.fix).toMatch(/github-connect/u);
    expect(find(report, 'cloudflare.secrets').items.find((i) => i.name === 'TASKS_GITHUB_APP_ID').state).toBe('unset');
  });
});

describe('Cloudflare, Claude, Taskwarrior, and push states', () => {
  const report = () => inStore((s) => s.connectionsReport());

  it('records the cron’s run and says when it’s late or failing', async () => {
    await inStore((s) => s.setMeta('conn_cron_last', null));
    expect(find(await report(), 'cloudflare.cron')).toMatchObject({
      state: 'attention',
      detail: 'no run recorded yet',
    });
    await inStore((s) =>
      s.connectionsCronRan(['GitHub 502 on /repos/x/pulls: Bad gateway, token ghp_abcdefghijklmnopqrstuvwxyz0123']),
    );
    const failing = find(await report(), 'cloudflare.cron');
    expect(failing.state).toBe('attention');
    expect(failing.detail).toContain('[redacted]');
    expect(failing.detail).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    await inStore((s) => s.connectionsCronRan([]));
    expect(find(await report(), 'cloudflare.cron').state).toBe('working');
  });

  it('runs and records the cron from the scheduled tick', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('{"message":"down"}', { status: 503 }));
    try {
      await inStore(async (s) => {
        s.setMeta('conn_cron_last', null);
        s.setMeta('conn_live_at', Date.now()); // the hourly live check isn't due
        await s.tick('cron');
      });
    } finally {
      spy.mockRestore();
    }
    const cron = find(await report(), 'cloudflare.cron');
    expect(cron.at).not.toBeNull();
    expect(cron.detail).toMatch(/last run failed: GitHub 503/u);
  });

  it('says when the sync server’s Secrets Store copy is out of date after a rotation', async () => {
    await inStore((s) => {
      s.setMeta('client_id', '11111111-1111-4111-8111-111111111111');
      s.setMeta('sync_key', 'other');
    });
    try {
      const c = find(await report(), 'cloudflare.sync');
      expect(c.state).toBe('attention');
      expect(c.fix).toMatch(/rotate-sync/u);
    } finally {
      await inStore((s) => {
        s.setMeta('client_id', null);
        s.setMeta('sync_key', null);
      });
    }
  });

  it('shows the routine’s last start, a refused token, routines switched off, and the shared budget', async () => {
    await inStore((s) =>
      s.sql.exec(
        "INSERT INTO agent_runs (task, agent, trigger, status, error, started) VALUES ('t1', 'claude-x', 'manual', 'failed', 'the routine’s token was refused: connect the routine again (npx breakaway agents-connect)', ?)",
        Date.now(),
      ),
    );
    let c = find(await report(), 'claude.routine');
    expect(c.state).toBe('attention');
    expect(c.fix).toMatch(/new API token/u);

    await inStore((s) => {
      s.sql.exec(
        "INSERT INTO agent_runs (task, agent, trigger, status, started) VALUES ('t2', 'claude-y', 'manual', 'started', ?)",
        Date.now(),
      );
      s.sql.exec(
        "INSERT INTO routines (slug, name, prompt, horizon, enabled, gap_minutes, daily_cap, edited_by, edited_at, created, disabled_reason) VALUES ('weekly', 'Weekly', 'x', 'now', 0, 60, 1, 'owner', 0, 0, 'it failed to start 3 times in a row')",
      );
    });
    c = find(await report(), 'claude.routine');
    expect(c.state).toBe('attention');
    expect(c.detail).toMatch(/switched off after failing to start: weekly/u);
    expect(c.fix).toMatch(/--enabled yes/u);
    expect(find(await report(), 'claude.budget').detail).toMatch(/starts this hour/u);

    await inStore((s) => s.sql.exec("DELETE FROM routines WHERE slug = 'weekly'"));
    expect(find(await report(), 'claude.routine').state).toBe('working');
  });

  it('shows the routine as not connected while its secrets are unset', async () => {
    const r = await inStore(async (s) => {
      const saved = s.env.TASKS_ROUTINE_TOKEN;
      s.env.TASKS_ROUTINE_TOKEN = 'unset';
      try {
        return await s.connectionsReport();
      } finally {
        s.env.TASKS_ROUTINE_TOKEN = saved;
      }
    });
    expect(find(r, 'claude.routine')).toMatchObject({ state: 'off' });
    expect(find(r, 'claude.routine').fix).toMatch(/agents-connect/u);
  });

  it('notices a running agent whose session never sends live output (the CLD-37 failure)', async () => {
    const fresh = await runningAgent('claude-new', { minutes: 2 });
    expect(find(await report(), 'claude.output').state).toBe('working');
    const quiet = await runningAgent('claude-q');
    const c = find(await report(), 'claude.output');
    expect(c.state).toBe('attention');
    expect(c.fix).toMatch(/session hook/u);
    // The "Claimed …" line comes from the CLI, not the hook: a session that sends only that is still quiet.
    await said(quiet, 'start');
    expect(find(await report(), 'claude.output').state).toBe('attention');
    await said(quiet, 'tool');
    expect(find(await report(), 'claude.output').state).toBe('working');
    await finish(fresh, 'claude-new');
    await finish(quiet, 'claude-q');
  });

  it('stops counting a quiet run once its agent is no longer running', async () => {
    const released = await runningAgent('claude-r');
    const done = await runningAgent('claude-d');
    const taken = await runningAgent('claude-t');
    expect(find(await report(), 'claude.output').detail).toMatch(/3 started sessions have sent nothing/u);
    await api(`tasks/${released}/release`, { method: 'POST', body: { agent: 'claude-r' } });
    await finish(done, 'claude-d');
    await api(`tasks/${taken}/claim`, { method: 'POST', body: { agent: 'codex-x', force: true } });
    expect(find(await report(), 'claude.output').state).toBe('working');
    await finish(released, null);
    await finish(taken, 'codex-x');
  });

  it('notes when a Taskwarrior replica last synced', async () => {
    await sync('snapshot');
    const c = find(await report(), 'taskwarrior');
    expect(c.state).toBe('working');
    expect(c.at).not.toBeNull();
  });

  it('says plainly when a replica asks for a version the board never had (410 Gone, CLD-195)', async () => {
    await pushOps(
      await latestVersion(),
      twCreate(crypto.randomUUID(), { description: 'so the board has a latest version' }),
    );
    expect((await sync(`get-child-version/${crypto.randomUUID()}`)).status).toBe(410);
    const c = find(await report(), 'taskwarrior');
    expect(c.state).toBe('attention');
    expect(c.detail).toMatch(/410 Gone/u);
    expect(c.fix).toMatch(/move its \.task\/ aside, then run scripts\/task sync/u);
    const health = await (await api('health')).json();
    expect(health.replicaGone).toMatch(/^\d{4}-/u);
    // A day later with no more 410s, the stuck replica was started again (or isn't used).
    await inStore((s) => s.setMeta('conn_replica_gone', Date.now() - 25 * 3_600_000));
    expect(find(await report(), 'taskwarrior').state).toBe('working');
  });

  it('says whether push is set up, subscribed, and sending', async () => {
    await inStore((s) => {
      s.sql.exec('DELETE FROM push_subscriptions');
      s.setMeta('conn_push_last', null);
    });
    let c = find(await report(), 'push');
    expect(c.state).toBe('attention');
    expect(c.fix).toMatch(/turn on Notifications/u);
    await inStore((s) => {
      s.sql.exec(
        "INSERT INTO push_subscriptions (endpoint, p256dh, auth, created) VALUES ('https://push.example.com/a', 'x', 'y', 0)",
      );
      s.connectionsPushSent({ sent: 0, gone: 0, failed: 1 });
    });
    c = find(await report(), 'push');
    expect(c.state).toBe('attention');
    expect(c.fix).toMatch(/refused the last notification/u);
    await inStore((s) => s.connectionsPushSent({ sent: 1, gone: 0, failed: 0 }));
    expect(find(await report(), 'push').state).toBe('working');

    const off = await inStore(async (s) => {
      const saved = s.env.TASKS_VAPID_PUBLIC;
      s.env.TASKS_VAPID_PUBLIC = 'unset';
      try {
        return await s.connectionsReport();
      } finally {
        s.env.TASKS_VAPID_PUBLIC = saved;
      }
    });
    expect(find(off, 'push')).toMatchObject({ state: 'off' });
    expect(find(off, 'push').fix).toMatch(/SAMEWAVE_TASKS_VAPID_KEY/u);
  });

  it('remembers since when each connection has been in its state', async () => {
    const first = find(await report(), 'cloudflare.worker');
    expect(first.since).not.toBeNull();
    expect(find(await report(), 'cloudflare.worker').since).toBe(first.since);
  });
});

describe('the nav’s count and the inbox’s notes (CLD-121)', () => {
  const report = () => inStore((s) => s.connectionsReport());
  const inbox = async () => (await (await api('pings')).json()).notices;
  const cron = 'cloudflare.cron';
  /** As if the cron's state changed `minutes` ago. */
  const aged = (minutes) =>
    inStore((s) =>
      s.sql.exec('UPDATE connection_states SET since = ? WHERE id = ?', Date.now() - minutes * 60_000, cron),
    );

  async function signedIn() {
    const res = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    return res.headers.get('Set-Cookie').split(';')[0];
  }

  it('counts only what needs attention, and health carries the count for the nav', async () => {
    const r = await report();
    expect(r.attention).toBe(r.connections.filter((c) => c.state === 'attention').length);
    expect(r.generated).not.toBeNull();
    const health = await (await api('health')).json();
    expect(health.connections).toEqual({ attention: r.attention, at: r.generated });
  });

  it('notes a connection that stays broken in the inbox once, and again when it works', async () => {
    await inStore((s) => s.connectionsCronRan(['boom']));
    await report();
    // A blip stays quiet: nothing until it has needed attention for 10 minutes.
    expect((await inbox()).filter((n) => n.connection === cron)).toEqual([]);
    await aged(11);
    await report();
    await report();
    const broke = (await inbox()).filter((n) => n.connection === cron);
    expect(broke).toHaveLength(1);
    expect(broke[0]).toMatchObject({ kind: 'broke', name: 'Cron (every 5 minutes)', resolved: null });
    expect(broke[0].detail).toContain('boom');

    await inStore((s) => s.connectionsCronRan([]));
    await report();
    const after = (await inbox()).filter((n) => n.connection === cron);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ kind: 'recovered', name: 'Cron (every 5 minutes)' });

    // Breaking again replaces the old "working again" note.
    await inStore((s) => s.connectionsCronRan(['boom again']));
    await report();
    await aged(11);
    await report();
    expect((await inbox()).filter((n) => n.connection === cron).map((n) => n.kind)).toEqual(['broke']);
  });

  it('never notes the shared budget, which rolls over by itself', async () => {
    await inStore((s) => {
      s.sql.exec("UPDATE connection_states SET since = ? WHERE id = 'claude.budget'", Date.now() - 3_600_000);
      s.connectionsNotify(
        [{ id: 'claude.budget', repo: null, name: 'Shared agent budget', state: 'attention', detail: '20 of 20' }],
        new Map([['claude.budget', { since: Date.now() - 3_600_000 }]]),
      );
    });
    expect((await inbox()).filter((n) => n.connection === 'claude.budget')).toEqual([]);
  });

  it('lets the signed-in browser dismiss a note, and only it', async () => {
    const id = await inStore(
      (s) =>
        s.sql
          .exec(
            "INSERT INTO connection_notices (conn, kind, name, detail, created) VALUES ('push', 'recovered', 'Push notifications', 'keys set', ?) RETURNING id",
            Date.now(),
          )
          .one().id,
    );
    expect((await api(`connections/notices/${id}/dismiss`, { method: 'POST' })).status).toBe(403);
    const cookie = await signedIn();
    const dismiss = (n) =>
      SELF.fetch(`${ORIGIN}/api/connections/notices/${n}/dismiss`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: ORIGIN },
      });
    const res = await dismiss(id);
    expect(res.status).toBe(200);
    expect((await res.json()).notice.resolved).toMatchObject({ how: 'dismissed' });
    expect((await inbox()).some((n) => n.id === id)).toBe(false);
    expect((await dismiss(999999)).status).toBe(404);
  });

  it('runs the report from the cron, so the count follows without opening the view', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('{"message":"down"}', { status: 503 }));
    try {
      await inStore(async (s) => {
        s.setMeta('conn_summary', null);
        s.setMeta('conn_live_at', Date.now());
        await s.tick('cron');
      });
    } finally {
      spy.mockRestore();
    }
    expect(await inStore((s) => s.connectionsSummary())).toMatchObject({ attention: expect.any(Number) });
  });
});

describe('the webhook records when it last heard from GitHub', () => {
  it('records a verified delivery', async () => {
    const payload = encoder.encode(JSON.stringify({ zen: 'x' }));
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(TEST_GITHUB_WEBHOOK_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = `sha256=${[...new Uint8Array(await crypto.subtle.sign('HMAC', key, payload))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    const res = await SELF.fetch(`${ORIGIN}/github/webhook`, {
      method: 'POST',
      headers: { 'X-GitHub-Event': 'ping', 'X-Hub-Signature-256': sig },
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(await inStore((s) => s.meta('conn_webhook_event'))).toBe('ping');
  });
});

describe('connections per repository (CLD-129)', () => {
  let spy;
  beforeEach(() => {
    reset();
    spy = mockGitHub();
  });
  afterEach(() => spy.mockRestore());

  /** A row as it would look anywhere: without the times that move between reports. */
  const plain = ({ at, since, ...rest }) => rest;
  const of = (report, id, repo) => report.connections.find((c) => c.id === id && c.repo === repo);
  /** breakaway, with the App and its routine (TASKS_ROUTINES in vitest.config.js), and scratch, with nothing set up. */
  async function register() {
    const have = new Set((await (await api('repos')).json()).repos.map((r) => r.slug));
    for (const body of [
      { slug: 'breakaway', github: 'acme/breakaway', areas: ['product:BRK'] },
      { slug: 'scratch', github: 'acme/scratch', areas: ['product:SCR'] },
    ]) {
      if (!have.has(body.slug)) expect((await api('repos', { method: 'POST', body })).status).toBe(201);
    }
  }
  const samewaveRows = (report) =>
    report.connections
      .filter((c) => (c.repo === 'samewave' || c.repo === null) && c.id !== 'github.webhook')
      .map(plain);

  it('shows a registered repository without the App or a routine as needing attention, with the fix, and leaves samewave’s rows alone', async () => {
    await inStore((s) => {
      s.setMeta('gh_last_sync', Date.now());
      s.setMeta('gh_error', null);
      s.connectionsCronRan([]);
    });
    const before = await checkNow();
    await register();
    const after = await checkNow();

    // samewave alone and samewave next to two others: the same rows, word for word.
    expect(samewaveRows(after)).toEqual(samewaveRows(before));
    expect(of(after, 'claude.routine', 'samewave')).toMatchObject({ name: 'Agent routine', state: 'working' });
    expect(of(after, 'claude.output', null)).toMatchObject({ name: 'Live output from sessions' });

    // scratch: the App isn't on it and it has no routine. Exactly that, with the fix.
    expect(of(after, 'github.install', 'scratch')).toMatchObject({
      state: 'attention',
      name: 'Installed on acme/scratch',
    });
    expect(of(after, 'github.install', 'scratch').fix).toContain(
      'https://github.com/apps/samewave-tasks/installations/new',
    );
    expect(of(after, 'github.permissions', 'scratch')).toBeUndefined();
    expect(of(after, 'github.automerge', 'scratch')).toBeUndefined();
    const routine = of(after, 'claude.routine', 'scratch');
    expect(routine).toMatchObject({ state: 'attention', name: 'Agent routine for scratch' });
    expect(routine.fix).toContain('npx breakaway agents-connect --repo scratch');
    expect(routine.fix).toContain('acme/scratch');
    expect(of(after, 'claude.output', 'scratch')).toBeUndefined();
    expect(of(after, 'github.sync', 'scratch')).toBeDefined();

    // breakaway: the App and its routine are set up, so its rows work.
    for (const id of ['github.install', 'github.permissions', 'github.automerge', 'claude.routine', 'claude.output']) {
      expect(of(after, id, 'breakaway'), id).toMatchObject({ state: 'working', fix: null });
    }
    expect(of(after, 'claude.routine', 'breakaway').name).toBe('Agent routine for breakaway');
    expect(of(after, 'claude.output', 'breakaway').name).toBe('Live output from breakaway’s sessions');
    expect(after.cannotCheck[0].name).toBe('Each routine’s cloud environment');
    // The whole count grows by exactly the new repositories' rows that need attention (sync, too, until they first sync).
    expect(after.attention).toBe(
      before.attention +
        after.connections.filter((c) => ['breakaway', 'scratch'].includes(c.repo) && c.state === 'attention').length,
    );
  });

  it('keeps each repository’s last start and live output to itself', async () => {
    await register();
    const quiet = await runningAgent('claude-b2', { repo: 'breakaway' });
    await inStore((s) => {
      s.sql.exec(
        "INSERT INTO agent_runs (task, agent, trigger, status, error, started, repo) VALUES ('brk-failed', 'claude-b', 'manual', 'failed', 'the routine’s token was refused: connect the routine again', ?, 'breakaway')",
        Date.now(),
      );
    });
    const report = await inStore((s) => s.connectionsReport());
    const brk = of(report, 'claude.routine', 'breakaway');
    expect(brk.state).toBe('attention');
    expect(brk.fix).toContain('agents-connect --repo breakaway');
    expect(of(report, 'claude.routine', 'samewave').state).toBe('working');
    expect(of(report, 'claude.output', 'breakaway').state).toBe('attention');
    expect(of(report, 'claude.output', null).state).toBe('working');
    await inStore((s) => s.sql.exec("DELETE FROM agent_runs WHERE task = 'brk-failed'"));
    await finish(quiet, 'claude-b2');
  });

  it('says when a webhook delivery last came about each repository', async () => {
    await register();
    await inStore((s) => {
      s.connectionsWebhookRepo('breakaway');
      s.connectionsWebhookRepo('nowhere');
    });
    const hook = find(await checkNow(), 'github.webhook');
    expect(hook.detail).toMatch(
      /last from each repository: samewave (never|\d{4}-), breakaway \d{4}-[^,]+, scratch never/u,
    );
    expect(hook.detail).not.toContain('nowhere');
  });
});
