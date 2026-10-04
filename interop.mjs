#!/usr/bin/env node
/**
 * pnpm tasks:interop — checks the task server against real Taskwarrior (3.x on PATH).
 *
 * Starts the Worker locally with `wrangler dev` and throwaway credentials, then drives two and
 * later three Taskwarrior replicas and the JSON API, and checks they all agree: tasks made in
 * Taskwarrior show up in the API with a work ID, API changes and claims reach Taskwarrior,
 * conflicting edits converge, and a fresh replica starts from the server's own snapshot.
 * The Worker runs as another install (INSTALL below, through src/install.js), with its own names,
 * Durable Object, and breakaway's secrets prefix, so the board is checked end to end outside a legacy install.
 * Nothing touches the real board.
 */
import { spawn, spawnSync } from 'node:child_process';
import { pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { wranglerConfig } from './src/install.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.INTEROP_PORT ?? 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const clientId = randomUUID();
const secret = randomBytes(24).toString('base64url');
const token = randomBytes(24).toString('base64url');
const key = pbkdf2Sync(
  Buffer.from(secret),
  Buffer.from(clientId.replaceAll('-', ''), 'hex'),
  600000,
  32,
  'sha256',
).toString('base64');
const work = mkdtempSync(join(tmpdir(), 'tasks-interop-'));
/** The install interop runs as: none of the legacy install's names. */
const INSTALL = {
  name: 'interop board',
  worker: 'interop-board',
  url: 'https://board.interop.test',
  store: 'interop',
  docs: 'https://docs.interop.test',
  repository: 'interop/widgets',
};
const config = join(work, 'wrangler.json');
writeFileSync(config, JSON.stringify(wranglerConfig(INSTALL, { local: true, root: HERE })));

let failed = false;
const step = (name) => console.log(`\n· ${name}`);

// ---- the local server --------------------------------------------------------------------

const server = spawn(
  'npx',
  [
    'wrangler',
    'dev',
    '-c',
    config,
    '--port',
    String(PORT),
    '--ip',
    '127.0.0.1',
    '--persist-to',
    join(work, 'state'),
    '--show-interactive-dev-session=false',
    '--var',
    `TASKS_CLIENT_ID:${clientId}`,
    '--var',
    `TASKS_SYNC_KEY:${key}`,
    '--var',
    `TASKS_API_TOKEN:${token}`,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
);
let serverLog = '';
server.stdout.on('data', (d) => {
  serverLog += d;
});
server.stderr.on('data', (d) => {
  serverLog += d;
});

function stop() {
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  rmSync(work, { recursive: true, force: true });
}

async function waitForServer() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/session`);
      if (res.status === 401) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev didn't start:\n${serverLog}`);
}

// ---- helpers -----------------------------------------------------------------------------

async function api(method, path, body) {
  const res = await fetch(`${BASE}/api/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.error}`);
  return data;
}

function replica(name, creds = { clientId, secret }) {
  const dir = join(work, name);
  const rc = join(dir, 'taskrc');
  spawnSync('mkdir', ['-p', dir]);
  const configure = ({ clientId: id, secret: s }) =>
    writeFileSync(
      rc,
      [
        `include ${join(HERE, 'taskrc')}`,
        `data.location=${join(dir, 'data')}`,
        `sync.server.url=${BASE}`,
        `sync.server.client_id=${id}`,
        `sync.encryption_secret=${s}`,
        'confirmation=off',
        'verbose=nothing',
        '',
      ].join('\n'),
    );
  configure(creds);
  // TASKDATA overrides data.location, and direnv exports the checkout's .task/: without this, every
  // replica here would be that one, synced to this throwaway server and stuck on 410 Gone after (CLD-195).
  const env = { ...process.env, TASKRC: rc, TASKDATA: join(dir, 'data') };
  const task = (...args) => {
    const res = spawnSync('task', args, { encoding: 'utf8', env });
    // Taskwarrior exits 1 when a report or filter matches nothing.
    if (res.status !== 0 && !(res.status === 1 && !res.stderr.trim()))
      throw new Error(`[${name}] task ${args.join(' ')}\n${res.stdout}${res.stderr}`);
    return res.stdout;
  };
  return {
    task,
    configure,
    sync: () => task('sync'),
    trySync: () => spawnSync('task', ['sync'], { encoding: 'utf8', env }).status,
    exportAll: () => JSON.parse(task('rc.json.array=on', 'export')),
    byDescription(description) {
      return this.exportAll().find((t) => t.description === description);
    },
  };
}

/** The fields every replica and the API must agree on. */
function comparable(tasks) {
  return tasks
    .map((t) => ({
      uuid: t.uuid,
      description: t.description,
      status: t.status,
      project: t.project ?? null,
      wid: t.wid ?? null,
      claim: t.claim ?? null,
      tags: [...(t.tags ?? [])].sort(),
      depends: [...(t.depends ?? [])].sort(),
      annotations: (t.annotations ?? []).map((a) => a.description ?? a.text).sort(),
    }))
    .sort((a, b) => a.uuid.localeCompare(b.uuid));
}

async function apiTasks() {
  const { tasks } = await api('GET', 'tasks?status=all');
  return tasks.filter((t) => t.status !== 'deleted');
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed = true;
    console.log(`  ✗ ${name}\n${String(error.stack ?? error).replace(/^/gmu, '    ')}`);
  }
}

// ---- the run -----------------------------------------------------------------------------

try {
  const version = spawnSync('task', ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) throw new Error('Taskwarrior (task) is not installed');
  console.log(`Taskwarrior ${version.stdout.trim()}, server on ${BASE}`);
  await waitForServer();

  step('the install');
  await check('the Worker runs as the configured install', async () => {
    assert.deepEqual((await api('GET', 'session')).install, {
      name: INSTALL.name,
      url: INSTALL.url,
      docs: INSTALL.docs,
    });
  });
  const a = replica('a');
  const b = replica('b');

  step('Taskwarrior → server');
  a.task('add', 'From replica A', 'project:ops', '+agent', 'horizon:now', 'priority:H');
  a.task('add', 'Loose end', '+owner');
  a.sync();
  await check('the API sees tasks added in Taskwarrior, with a work ID for known projects', async () => {
    const tasks = await apiTasks();
    const fromA = tasks.find((t) => t.description === 'From replica A');
    assert.equal(fromA.wid, 'OPS-1');
    assert.deepEqual(fromA.tags, ['agent']);
    assert.equal(fromA.horizon, 'now');
    assert.equal(tasks.find((t) => t.description === 'Loose end').wid, null);
  });

  step('server → Taskwarrior');
  await api('POST', 'tasks', {
    description: 'From the API',
    project: 'ops',
    tags: ['agent'],
    depends: ['OPS-1'],
    note: 'made over HTTP',
  });
  await api('POST', 'tasks/OPS-2/comments', { text: 'a comment over HTTP', by: 'interop-agent' });
  await api('POST', 'tasks/OPS-1/claim', { agent: 'interop-agent' });
  a.sync();
  await check('Taskwarrior gets the work ID, the claim, the new task, and its dependency', () => {
    const fromA = a.byDescription('From replica A');
    assert.equal(fromA.wid, 'OPS-1');
    assert.equal(fromA.claim, 'interop-agent');
    assert.ok(fromA.start, 'claiming starts the task');
    const fromApi = a.byDescription('From the API');
    assert.equal(fromApi.wid, 'OPS-2');
    assert.deepEqual(fromApi.depends, [fromA.uuid]);
    assert.equal(fromApi.brief, 'made over HTTP');
    assert.equal(fromApi.annotations[0].description, 'a comment over HTTP');
    assert.match(a.task('+BLOCKED', 'uuids'), new RegExp(fromApi.uuid, 'u'));
  });
  await check('the project reports run', () => {
    for (const report of ['board', 'agent', 'claimed', 'owner']) a.task(report);
    assert.match(a.task('claimed'), /interop-agent/u);
    assert.doesNotMatch(a.task('agent'), /From replica A/u); // claimed, so not offered
  });

  step('repositories');
  await api('POST', 'repos', { slug: 'breakaway', github: 'acme/breakaway', areas: ['ops:BOPS'] });
  a.task('add', 'Breakaway from Taskwarrior', 'project:ops', 'repo:breakaway');
  a.task('add', 'Default repository task from Taskwarrior', 'project:ops');
  a.sync();
  await api('POST', 'tasks', {
    description: 'Breakaway from the API',
    project: 'ops',
    repo: 'breakaway',
    depends: ['OPS-1'],
  });
  a.sync();
  await check(
    'a task with a repo gets its repository’s work ID, and one without stays the default repository’s',
    async () => {
      const tasks = await apiTasks();
      assert.equal(tasks.find((t) => t.description === 'Breakaway from Taskwarrior').wid, 'BOPS-1');
      assert.equal(tasks.find((t) => t.description === 'Breakaway from the API').wid, 'BOPS-2');
      const plain = tasks.find((t) => t.description === 'Default repository task from Taskwarrior');
      assert.equal(plain.wid, 'OPS-3');
      assert.equal(plain.repo, 'widgets');
      assert.equal(a.byDescription('Default repository task from Taskwarrior').repo, undefined);
      assert.equal(a.byDescription('Breakaway from the API').repo, 'breakaway');
      assert.equal(a.byDescription('Breakaway from the API').wid, 'BOPS-2');
      assert.deepEqual(a.byDescription('Breakaway from the API').depends, [a.byDescription('From replica A').uuid]);
      const inBreakaway = a.task('repo:breakaway', 'uuids').trim().split(/\s+/u);
      assert.equal(inBreakaway.length, 2);
      assert.ok(a.task('board').includes('BOPS-1'));
    },
  );

  step('messages to a running agent');
  const login = await fetch(`${BASE}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: BASE, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  });
  const cookie = (login.headers.get('Set-Cookie') ?? '').split(';')[0];
  const sendAs = (headers) =>
    fetch(`${BASE}/api/tasks/OPS-1/messages`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Also update the runbook.' }),
    });
  await check('only the signed-in board sends; the token gets 403', async () => {
    assert.equal((await sendAs({ Authorization: `Bearer ${token}` })).status, 403);
    assert.equal((await sendAs({ Cookie: cookie, Origin: BASE })).status, 201);
  });
  await check('the claim’s agent gets it once, and it never reaches Taskwarrior', async () => {
    assert.deepEqual((await api('GET', 'tasks/OPS-1/messages/waiting?agent=someone-else')).messages, []);
    const first = await api('GET', 'tasks/OPS-1/messages/waiting?agent=interop-agent');
    assert.deepEqual(
      first.messages.map((m) => m.text),
      ['Also update the runbook.'],
    );
    assert.deepEqual((await api('POST', 'tasks/OPS-1/session', { agent: 'interop-agent', entries: [] })).messages, []);
    assert.equal((await api('GET', 'tasks/OPS-1/messages')).messages[0].status, 'delivered');
    a.sync();
    assert.doesNotMatch(JSON.stringify(a.byDescription('From replica A')), /runbook/u);
  });

  step('a second replica');
  b.sync();
  await check('a fresh replica matches the first', () => {
    assert.deepEqual(comparable(b.exportAll()), comparable(a.exportAll()));
  });
  const opsOne = a.byDescription('From replica A').uuid;
  b.task(opsOne, 'done');
  b.task(a.byDescription('From the API').uuid, 'annotate', 'noted in B');
  b.sync();
  a.sync();
  await check('finishing in one replica unblocks everywhere', async () => {
    const tasks = await apiTasks();
    assert.equal(tasks.find((t) => t.wid === 'OPS-1').status, 'completed');
    const two = tasks.find((t) => t.wid === 'OPS-2');
    assert.equal(two.blocked, false);
    assert.equal(two.ready, true);
    assert.match(a.task('+READY', 'uuids'), new RegExp(two.uuid, 'u'));
  });

  step('conflicting edits');
  const loose = a.byDescription('Loose end').uuid;
  a.task(loose, 'modify', 'priority:L');
  await new Promise((r) => setTimeout(r, 50));
  b.task(loose, 'modify', 'priority:M', '+later');
  await api('PATCH', `tasks/${loose}`, { horizon: 'next' });
  a.sync();
  b.sync();
  a.sync();
  await check('everyone converges on the same state', async () => {
    const fromApi = comparable(await apiTasks());
    assert.deepEqual(comparable(a.exportAll()), fromApi);
    assert.deepEqual(comparable(b.exportAll()), fromApi);
    const t = a.exportAll().find((x) => x.uuid === loose);
    assert.equal(t.priority, 'M'); // the later edit wins
    assert.equal(t.horizon, 'next');
  });

  step('closing a horizon');
  await api('PATCH', `tasks/${loose}`, { horizon: 'now', status: 'completed' });
  await api('POST', 'horizons/close', {});
  a.sync();
  b.sync();
  await check('replicas see archive as a horizon value', async () => {
    assert.equal(a.exportAll().find((x) => x.uuid === loose).horizon, 'archive');
    assert.equal(b.exportAll().find((x) => x.uuid === loose).horizon, 'archive');
    assert.deepEqual(comparable(b.exportAll()), comparable(await apiTasks()));
  });

  step('snapshots');
  for (let i = 0; i < 55; i += 1) await api('POST', 'tasks', { description: `Bulk ${i}`, project: 'debt' });
  const c = replica('c');
  c.sync();
  a.sync();
  await check("a replica that starts from the server's snapshot matches", async () => {
    const health = await api('GET', 'health');
    assert.equal(health.ok, true);
    assert.ok(health.snapshot.versionsSince < 55, 'the server took a newer snapshot');
    assert.deepEqual(comparable(c.exportAll()), comparable(a.exportAll()));
    assert.deepEqual(comparable(c.exportAll()), comparable(await apiTasks()));
  });

  step('rotating the sync credentials');
  const rotated = { clientId: randomUUID(), secret: randomBytes(24).toString('base64url') };
  const rotatedKey = pbkdf2Sync(
    Buffer.from(rotated.secret),
    Buffer.from(rotated.clientId.replaceAll('-', ''), 'hex'),
    600000,
    32,
    'sha256',
  ).toString('base64');
  b.task('add', 'Made before the rotation, synced after', 'project:ops');
  await api('POST', 'admin/rekey', { clientId: rotated.clientId, key: rotatedKey });
  await check('a replica with the old credentials is refused, and keeps its unsynced work', () => {
    assert.notEqual(b.trySync(), 0);
    assert.ok(b.byDescription('Made before the rotation, synced after'));
  });
  a.configure(rotated);
  b.configure(rotated);
  a.task('add', 'After the rotation', 'project:ops');
  a.sync();
  b.sync();
  a.sync();
  const d = replica('d', rotated);
  d.sync();
  await check('replicas carry on from where they were with the new credentials, and everyone converges', async () => {
    const fromApi = comparable(await apiTasks());
    assert.ok(fromApi.some((t) => t.description === 'Made before the rotation, synced after'));
    assert.ok(fromApi.some((t) => t.description === 'After the rotation'));
    assert.deepEqual(comparable(a.exportAll()), fromApi);
    assert.deepEqual(comparable(b.exportAll()), fromApi);
    assert.deepEqual(comparable(d.exportAll()), fromApi);
    assert.equal((await api('GET', 'health')).ok, true);
  });
} catch (error) {
  failed = true;
  console.error(`\n${error.stack ?? error}`);
} finally {
  stop();
}

console.log(failed ? '\nInterop check FAILED.' : '\nInterop check passed.');
process.exit(failed ? 1 : 0);
