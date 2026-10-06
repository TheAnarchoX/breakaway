import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, boardApi, setPipeline } from './helpers.js';
import { FROZEN_PROMOTE, PAUSE_PERMISSION, STAGING_FREEZE_NOTE, pauseSync, pausedValue } from '../src/infra-pause.js';
import { comparePermissions } from '../src/connections.js';

// Freeze and DEPLOYS_PAUSED as one switch (BRK-235's decision; BRK-236), against a pretend GitHub that keeps the
// repository's variables. Its own file: the environments, Deployments, and audit entries it makes must not mix with
// the other tests'.
const REPO = '/repos/acme/widgets';
const VARIABLE = `${REPO}/actions/variables/DEPLOYS_PAUSED`;
const gh = { variables: {}, deployments: [], statuses: {}, writes: [], refuse: null };
const inStore = (fn) => runInDurableObject(env.STORE.get(env.STORE.idFromName('widgets')), (instance) => fn(instance));
const body = async (res) => ({ status: res.status, ...(await res.json()) });

function mockGitHub() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const reply = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const path = url.pathname;
    const method = init.method ?? 'GET';
    if (url.host !== 'api.github.com') throw new Error(`unexpected fetch to ${url}`);
    if (path === `${REPO}/installation`) return reply({ id: 77 });
    if (path.startsWith('/app/installations/'))
      return reply({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    // No Variables permission: GitHub refuses reads and writes of variables alike.
    if (path.startsWith(`${REPO}/actions/variables`) && gh.refuse)
      return reply({ message: 'Resource not accessible by integration' }, 403);
    if (method !== 'GET') {
      const sent = init.body ? JSON.parse(init.body) : null;
      gh.writes.push([method, path, sent]);
      if (path === VARIABLE && method === 'PATCH') {
        if (!('DEPLOYS_PAUSED' in gh.variables)) return reply({ message: 'Not Found' }, 404);
        gh.variables.DEPLOYS_PAUSED = sent.value;
        return new Response(null, { status: 204 });
      }
      if (path === `${REPO}/actions/variables` && method === 'POST') {
        gh.variables[sent.name] = sent.value;
        return reply({}, 201);
      }
      return new Response(null, { status: 204 });
    }
    if (path === VARIABLE)
      return 'DEPLOYS_PAUSED' in gh.variables
        ? reply({ name: 'DEPLOYS_PAUSED', value: gh.variables.DEPLOYS_PAUSED })
        : reply({ message: 'Not Found' }, 404);
    if (path === `${REPO}/deployments`) return reply(gh.deployments);
    const m = /\/deployments\/(\d+)\/statuses$/u.exec(path);
    if (m) return reply(gh.statuses[m[1]] ?? []);
    if (path === `${REPO}/actions/runs`) return reply({ workflow_runs: [] });
    if (['/pulls', '/commits', '/releases', '/tags', '/dependabot/alerts'].some((p) => path === `${REPO}${p}`))
      return reply([]);
    if (/\/compare\//u.test(path)) return reply({ commits: [], files: [] });
    return reply({ message: 'Not Found' }, 404);
  });
}

let next = 9000;
/** Adds a Deployment, newest first as GitHub lists them, with its latest status. */
function record(environment, sha, state, description, task = 'deploy') {
  next += 1;
  gh.statuses[next] = [
    { state, description, created_at: new Date().toISOString(), log_url: 'https://github.com/x/actions/runs/9' },
  ];
  gh.deployments = [
    { id: next, environment, sha, task, created_at: new Date().toISOString(), creator: { login: 'bot' } },
    ...gh.deployments,
  ];
}
const sync = async () => {
  const res = await body(await api('github/sync', { method: 'POST' }));
  expect(res.status).toBe(200);
  return res;
};
const byName = async () => {
  const res = await body(await api('infra/environments?repo=widgets'));
  return Object.fromEntries(res.environments.map((e) => [e.name, e]));
};
const freeze = async (name, frozen) => {
  const { [name]: env } = await byName();
  return body(await boardApi(`infra/environments/${env.id}`, { method: 'PATCH', body: { frozen } }));
};
const freezes = async () => (await body(await api('infra/audit?repo=widgets&kind=freeze'))).entries;
const flow = async () => (await body(await api('github?repo=widgets'))).flow;

describe('the deploy pause, pure', () => {
  it('reads only true as paused, as the workflows do', () => {
    expect(pausedValue('true')).toBe(true);
    for (const value of ['false', 'TRUE', '1', '', null, undefined]) expect(pausedValue(value)).toBe(false);
  });

  it('follows GitHub when it changed, writes the board’s freeze again when it didn’t, and lets a pause win at first', () => {
    expect(pauseSync({ github: true, board: true, last: false })).toBe('agree');
    // Set or cleared on GitHub by hand since they last agreed: the board follows.
    expect(pauseSync({ github: true, board: false, last: false })).toBe('follow');
    expect(pauseSync({ github: false, board: true, last: true })).toBe('follow');
    // Frozen on the board, but the write never reached GitHub: write it again, never undo the freeze.
    expect(pauseSync({ github: false, board: true, last: false })).toBe('push');
    expect(pauseSync({ github: true, board: false, last: true })).toBe('push');
    // Never agreed yet: the paused side wins either way.
    expect(pauseSync({ github: true, board: false, last: null })).toBe('follow');
    expect(pauseSync({ github: false, board: true, last: null })).toBe('push');
  });

  it('asks for read and write on Variables, only where there’s a pipeline', () => {
    const all = Object.fromEntries(comparePermissions({}, { pipeline: true }).map((p) => [p.name, p.need]));
    expect(all.variables).toBe('write');
    const missing = comparePermissions({ ...all, variables: 'read' }, { pipeline: true }).filter((p) => !p.ok);
    expect(missing.map((p) => [p.label, p.for])).toEqual([
      ['Variables', 'syncing Freeze with the deploy pause (DEPLOYS_PAUSED)'],
    ]);
    expect(comparePermissions({ ...all, variables: undefined }).some((p) => p.name === 'variables')).toBe(false);
  });
});

describe('freeze and DEPLOYS_PAUSED as one switch', () => {
  let spy;
  beforeEach(() => {
    spy = mockGitHub();
    gh.writes = [];
    gh.refuse = null;
  });
  afterEach(() => spy.mockRestore());

  it('gives a pipeline’s production the pause’s state, and leaves an unset variable alone', async () => {
    await setPipeline();
    await sync();
    const { production, staging } = await byName();
    expect(production).toMatchObject({ frozen: false, deploysPaused: { variable: 'DEPLOYS_PAUSED', synced: true } });
    expect(staging.deploysPaused).toBeNull();
    expect(gh.writes).toEqual([]);
    expect(await freezes()).toEqual([]);
  });

  it('sets DEPLOYS_PAUSED when production is frozen, clears it when it’s unfrozen, and audits each', async () => {
    const on = await freeze('production', true);
    expect(on).toMatchObject({
      status: 200,
      environment: { frozen: true, deploysPaused: { synced: true, error: null } },
      pause: { variable: 'DEPLOYS_PAUSED', value: true, synced: true, error: null },
      note: null,
    });
    // Never set before: the PATCH finds nothing, so the board makes it.
    expect(gh.writes).toEqual([
      ['PATCH', VARIABLE, { name: 'DEPLOYS_PAUSED', value: 'true' }],
      ['POST', `${REPO}/actions/variables`, { name: 'DEPLOYS_PAUSED', value: 'true' }],
    ]);
    expect(gh.variables.DEPLOYS_PAUSED).toBe('true');
    const off = await freeze('production', false);
    expect(off.pause).toMatchObject({ value: false, synced: true });
    expect(gh.variables.DEPLOYS_PAUSED).toBe('false');
    const [thaw, frozen] = await freezes();
    expect(frozen).toMatchObject({
      environment: 'production',
      by: 'owner',
      outcome: 'on',
      summary: 'DEPLOYS_PAUSED set to true on GitHub: Promote waits.',
    });
    expect(thaw).toMatchObject({
      outcome: 'off',
      summary: 'DEPLOYS_PAUSED set to false on GitHub: Promote can run again.',
    });
    // A sync afterwards finds the two agreeing and changes nothing.
    gh.writes = [];
    await sync();
    expect(gh.writes).toEqual([]);
    expect(await freezes()).toHaveLength(2);
  });

  it('freezes production when DEPLOYS_PAUSED is set on GitHub, and unfreezes it when it’s cleared, as the board', async () => {
    gh.variables.DEPLOYS_PAUSED = 'true';
    await sync();
    expect((await byName()).production).toMatchObject({ frozen: true, deploysPaused: { synced: true } });
    expect((await freezes())[0]).toMatchObject({
      environment: 'production',
      by: 'board',
      outcome: 'on',
      summary: 'DEPLOYS_PAUSED was set to true on GitHub, so production is frozen too.',
    });
    // Frozen this way, every plan is refused like any freeze, and the board writes nothing back.
    expect(gh.writes).toEqual([]);
    gh.variables.DEPLOYS_PAUSED = 'false';
    await sync();
    expect((await byName()).production.frozen).toBe(false);
    expect((await freezes())[0]).toMatchObject({
      by: 'board',
      outcome: 'off',
      summary: 'DEPLOYS_PAUSED was cleared on GitHub, so production is unfrozen too.',
    });
  });

  it('refuses the board’s Promote on a frozen production, at the store and the route, and still rolls back', async () => {
    const A = 'a'.repeat(40);
    const B = 'b'.repeat(40);
    const V = (n) => `${String(n).repeat(8)}-1111-2222-3333-444455556666`;
    const artifact = `artifact ${'d'.repeat(64)}`;
    record('widgets-staging', A, 'success', `pre-release · version ${V(1)} · ${artifact}`);
    record('widgets', A, 'success', `version ${V(1)}`);
    record('widgets-staging', B, 'success', `pre-release · version ${V(2)} · ${artifact}`);
    record('widgets', B, 'success', `version ${V(2)}`);
    record('widgets-staging', 'c'.repeat(40), 'success', `pre-release · version ${V(3)} · ${artifact}`);
    await sync();
    expect((await flow()).promote).toMatchObject({ allowed: true, frozen: false });
    await freeze('production', true);
    expect((await flow()).promote).toMatchObject({ allowed: false, reason: FROZEN_PROMOTE, frozen: true });
    gh.writes = [];
    const refused = await body(
      await boardApi('github/promote', { method: 'POST', body: { sha: 'c'.repeat(40), repo: 'widgets' } }),
    );
    expect(refused).toMatchObject({ status: 409, error: FROZEN_PROMOTE });
    const store = await inStore((s) => s.githubRelease('promote', { sha: 'c'.repeat(40), repo: 'widgets' }));
    expect(store).toMatchObject({ status: 409, body: { error: FROZEN_PROMOTE } });
    expect(gh.writes).toEqual([]);
    // Roll back is never refused (30 Sep 2026): the frozen production still goes back.
    const back = await body(
      await boardApi('github/rollback', { method: 'POST', body: { reason: 'sign-in is broken', repo: 'widgets' } }),
    );
    expect(back).toMatchObject({ status: 200, ok: true });
    expect(gh.writes.map(([m, p]) => [m, p])).toEqual([['POST', `${REPO}/actions/workflows/rollback.yml/dispatches`]]);
    await freeze('production', false);
    expect((await flow()).promote).toMatchObject({ allowed: true, frozen: false });
  });

  it('freezes staging without touching DEPLOYS_PAUSED, and says merges keep deploying it', async () => {
    gh.writes = [];
    const on = await freeze('staging', true);
    expect(on).toMatchObject({ status: 200, pause: null, note: STAGING_FREEZE_NOTE, environment: { frozen: true } });
    expect(gh.writes).toEqual([]);
    expect((await flow()).promote.frozen).toBe(false);
    expect((await freezes())[0]).toMatchObject({ environment: 'staging', outcome: 'on', summary: STAGING_FREEZE_NOTE });
    const off = await freeze('staging', false);
    expect(off).toMatchObject({ pause: null, note: null });
  });

  it('keeps the freeze on the board when the App can’t write variables, shows a Connections fix, and catches up', async () => {
    gh.refuse = true;
    const on = await freeze('production', true);
    expect(on).toMatchObject({
      status: 200,
      environment: { frozen: true, deploysPaused: { synced: false, error: PAUSE_PERMISSION } },
      pause: { value: true, synced: false, error: PAUSE_PERMISSION },
    });
    expect((await freezes())[0].summary).toMatch(
      /^Couldn’t set DEPLOYS_PAUSED on GitHub .*the freeze holds on the board/u,
    );
    // The board still refuses Promote: the freeze holds whatever GitHub says.
    expect((await flow()).promote).toMatchObject({ allowed: false, frozen: true });
    // A sync that can't read the variable leaves the freeze as it is.
    await sync();
    expect((await byName()).production.frozen).toBe(true);
    const rows = await inStore((s) =>
      s.githubRepoConnections(
        s.repoBySlug('widgets'),
        { installed: true, suspended: false, permissions: { metadata: 'read' }, autoMerge: true },
        { slug: 'widgets-tasks', name: 'widgets tasks' },
        new Date().toISOString(),
      ),
    );
    const pause = rows.find((r) => r.id === 'github.pause');
    expect(pause).toMatchObject({
      state: 'attention',
      detail: `the deploy pause can’t be synced: ${PAUSE_PERMISSION}`,
    });
    expect(pause.fix).toMatch(/Variables to read and write/u);
    expect(rows.find((r) => r.id === 'github.permissions').detail).toMatch(/Variables write/u);
    // Once the permission is granted, the next sync writes the freeze the board kept: it never undoes it.
    gh.refuse = null;
    gh.writes = [];
    await sync();
    expect(gh.variables.DEPLOYS_PAUSED).toBe('true');
    expect((await byName()).production).toMatchObject({ frozen: true, deploysPaused: { synced: true, error: null } });
    const after = await inStore((s) =>
      s.githubRepoConnections(
        s.repoBySlug('widgets'),
        { installed: true, suspended: false, permissions: { metadata: 'read' }, autoMerge: true },
        { slug: 'widgets-tasks', name: 'widgets tasks' },
        new Date().toISOString(),
      ),
    );
    expect(after.some((r) => r.id === 'github.pause')).toBe(false);
    await freeze('production', false);
  });

  it('keeps freeze the signed-in board’s: the bearer token can’t freeze', async () => {
    const { production } = await byName();
    const res = await api(`infra/environments/${production.id}`, { method: 'PATCH', body: { frozen: true } });
    expect(res.status).toBe(403);
    expect((await byName()).production.frozen).toBe(false);
  });
});
