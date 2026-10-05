import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { CLI_VERSION } from '../src/cli-version.js';
import { releaseOf } from '../src/build.js';
import { unreadableSecrets } from '../src/secrets.js';
import { api, latestVersion, pushOps, readChild, twCreate } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });

// Tests in a file share one Durable Object, so this file builds up one board.
describe('task API', () => {
  it('answers a public ping with nothing about tasks', async () => {
    const res = await api('ping', { token: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      version: null,
      release: pkg.version,
      secrets: { ok: true, unreadable: [] },
    });
  });

  it('names the bindings whose secrets can’t be read, and never a value', async () => {
    const throwing = { get: async () => Promise.reject(new Error('Secrets Worker: Failed to fetch secret')) };
    const env = { TASKS_SYNC_KEY: throwing, TASKS_API_TOKEN: { get: async () => 'never-shown' }, TASKS_VAPID_KEY: 'x' };
    expect(await unreadableSecrets(env)).toEqual(['TASKS_SYNC_KEY']);
    expect(await unreadableSecrets({})).toEqual([]);
  });

  it('reports the release it is, and lets a deploy name a promoted stable', async () => {
    expect(releaseOf({})).toBe(pkg.version);
    expect(releaseOf({ BREAKAWAY_VERSION: '1.4.0' })).toBe('1.4.0');
    expect((await (await api('health')).json()).release).toBe(pkg.version);
  });

  it('needs the token', async () => {
    expect((await api('tasks', { token: null })).status).toBe(401);
    expect((await api('tasks', { token: 'wrong' })).status).toBe(401);
  });

  it('creates tasks with the next work ID, in one version Taskwarrior can read', async () => {
    const before = await latestVersion();
    const res = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          {
            description: 'Publish security.txt',
            project: 'ops',
            tags: ['agent'],
            horizon: 'now',
            priority: 'H',
            note: 'Contact: hello@',
          },
          {
            description: 'Check it on the site',
            project: 'ops',
            tags: 'agent,owner',
            horizon: 'now',
            depends: ['OPS-1'],
          },
        ],
      }),
    );
    expect(res.status).toBe(201);
    expect(res.tasks.map((t) => t.wid)).toEqual(['OPS-1', 'OPS-2']);
    expect(res.tasks[1]).toMatchObject({ blocked: true, dependsOn: [{ wid: 'OPS-1', status: 'pending' }] });
    expect(res.tasks[0]).toMatchObject({ brief: 'Contact: hello@', comments: [] });

    const { ops } = await readChild(before);
    const props = Object.fromEntries(
      ops.filter((o) => o.uuid === res.tasks[1].uuid && o.type === 'update').map((o) => [o.property, o.value]),
    );
    expect(props).toMatchObject({
      description: 'Check it on the site',
      tag_agent: 'x',
      tag_owner: 'x',
      tags: 'agent,owner',
      wid: 'OPS-2',
      horizon: 'now',
      status: 'pending',
    });
    expect(props[`dep_${res.tasks[0].uuid}`]).toBe('x');
  });

  it('refuses a work ID that is taken, an unknown project, and a missing description', async () => {
    expect((await api('tasks', { method: 'POST', body: { description: 'x', wid: 'OPS-1' } })).status).toBe(409);
    expect((await api('tasks', { method: 'POST', body: { description: 'x', project: 'nope' } })).status).toBe(400);
    expect((await api('tasks', { method: 'POST', body: { project: 'ops' } })).status).toBe(400);
  });

  it('finds tasks by work ID in any case, or by UUID prefix', async () => {
    const res = await body(await api('tasks/ops-1'));
    expect(res.task.wid).toBe('OPS-1');
    expect(res.task.blockingTasks.map((t) => t.wid)).toEqual(['OPS-2']);
    expect((await body(await api(`tasks/${res.task.short}`))).task.wid).toBe('OPS-1');
    expect((await api('tasks/OPS-99')).status).toBe(404);
  });

  it('lets one agent claim a task, and tells the next who has it', async () => {
    const first = await body(await api('tasks/OPS-1/claim', { method: 'POST', body: { agent: 'claude-a' } }));
    expect(first).toMatchObject({ status: 200, task: { claim: 'claude-a', active: true } });
    const again = await api('tasks/OPS-1/claim', { method: 'POST', body: { agent: 'claude-a' } });
    expect(again.status).toBe(200);
    const second = await body(await api('tasks/OPS-1/claim', { method: 'POST', body: { agent: 'codex-b' } }));
    expect(second.status).toBe(409);
    expect(second.error).toMatch(/claimed by claude-a/);
  });

  it('settles two claims sent at the same moment: exactly one wins', async () => {
    await api('tasks', { method: 'POST', body: { description: 'Race me', project: 'debt', tags: ['agent'] } });
    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map((n) => api('tasks/DEBT-1/claim', { method: 'POST', body: { agent: `agent-${n}` } })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
  });

  it("won't claim a blocked task without force, or a claim without a name", async () => {
    const blocked = await body(await api('tasks/OPS-2/claim', { method: 'POST', body: { agent: 'codex-b' } }));
    expect(blocked.status).toBe(409);
    expect(blocked.error).toMatch(/blocked by OPS-1/);
    expect((await api('tasks/OPS-2/claim', { method: 'POST', body: {} })).status).toBe(400);
  });

  it('releases only your own claim, unless forced', async () => {
    expect((await api('tasks/OPS-1/release', { method: 'POST', body: { agent: 'codex-b' } })).status).toBe(409);
    const res = await body(await api('tasks/OPS-1/release', { method: 'POST', body: { agent: 'claude-a' } }));
    expect(res.task).toMatchObject({ claim: null, active: false });
  });

  it('hands out the best ready task and claims it atomically', async () => {
    const peek = await body(await api('next', { method: 'POST', body: {} }));
    expect(peek.task.wid).toBe('OPS-1'); // horizon now, priority H
    const res = await body(await api('next', { method: 'POST', body: { agent: 'claude-a', claim: true } }));
    expect(res.task).toMatchObject({ wid: 'OPS-1', claim: 'claude-a' });
    const after = await body(
      await api('next', { method: 'POST', body: { agent: 'codex-b', claim: true, project: 'ops' } }),
    );
    expect(after.task).toBeNull(); // OPS-2 is still blocked
  });

  it('finishing unblocks what depended on it', async () => {
    const done = await body(
      await api('tasks/OPS-1/done', { method: 'POST', body: { note: 'Served at /.well-known/security.txt' } }),
    );
    expect(done.task).toMatchObject({ status: 'completed', active: false, claim: 'claude-a' });
    expect(done.task.end).not.toBeNull();
    expect((await body(await api('tasks/OPS-2'))).task).toMatchObject({ blocked: false, ready: true });
    const pending = await body(await api('tasks'));
    expect(pending.tasks.map((t) => t.wid)).not.toContain('OPS-1');
    const completed = await body(await api('tasks?status=completed'));
    expect(completed.tasks.map((t) => t.wid)).toContain('OPS-1');
  });

  it('modifies tags, dependencies, and fields', async () => {
    const res = await body(
      await api('tasks/OPS-2', {
        method: 'PATCH',
        body: {
          addTags: ['decide'],
          removeTags: ['owner'],
          priority: 'M',
          spec: 'docs/specs/OPS-2-check.md',
          due: '2026-10-10',
        },
      }),
    );
    expect(res.task).toMatchObject({
      tags: ['agent', 'decide'],
      priority: 'M',
      spec: 'docs/specs/OPS-2-check.md',
      due: '2026-10-10T00:00:00.000Z',
    });
    expect((await api('tasks/OPS-2', { method: 'PATCH', body: { addDepends: ['OPS-2'] } })).status).toBe(400);
    expect((await api('tasks/OPS-2', { method: 'PATCH', body: { horizon: 'soon' } })).status).toBe(400);
    const clash = await body(await api('tasks/OPS-2', { method: 'PATCH', body: { wid: 'ops-1' } }));
    expect(clash.status).toBe(409);
    expect(clash.error).toMatch(/OPS-1 already exists/);
  });

  it('gives a work ID to tasks added with `task add`', async () => {
    const uuid = crypto.randomUUID();
    const parent = await latestVersion();
    expect(
      (
        await pushOps(
          parent,
          twCreate(uuid, { description: 'Added in Taskwarrior', project: 'ops', tag_agent: 'x', tags: 'agent' }),
        )
      ).status,
    ).toBe(200);
    expect((await body(await api(`tasks/${uuid}`))).task.wid).toBe('OPS-3');
    const noProject = crypto.randomUUID();
    await pushOps(await latestVersion(), twCreate(noProject, { description: 'No project' }));
    expect((await body(await api(`tasks/${noProject}`))).task.wid).toBeNull();
  });

  it('takes its own snapshot as API changes pile up, so replicas never have to', async () => {
    for (let i = 0; i < 52; i += 1) await api('tasks', { method: 'POST', body: { description: `Bulk ${i}` } });
    const { snapshot } = await body(await api('health'));
    expect(snapshot.versionsSince).toBeLessThan(50);
  });

  it('reports its health', async () => {
    const res = await body(await api('health'));
    expect(res).toMatchObject({ ok: true, replicaError: null });
    expect(res.versions).toBeGreaterThan(5);
    expect(res.snapshot.version).toMatch(/[0-9a-f-]{36}/u);
  });

  it('says which CLI version it carries, so an older copy can warn (CLD-193), and which release it is (BRK-148)', async () => {
    const res = await api('health');
    expect(res.headers.get('X-Tasks-Cli')).toBe(String(CLI_VERSION));
    expect(res.headers.get('X-Tasks-Release')).toBe(pkg.version);
    expect((await res.json()).cli).toBe(CLI_VERSION);
    // Every API answer has it, refusals too, so whatever command the CLI runs can tell.
    expect((await api('tasks/NOPE-999')).headers.get('X-Tasks-Cli')).toBe(String(CLI_VERSION));
  });

  it('lists every task with status all, the count health gives, so an export is complete (CLD-193)', async () => {
    const all = await body(await api('tasks?status=all'));
    const health = await body(await api('health'));
    expect(all.tasks.length).toBe(health.tasks.total);
  });
});
