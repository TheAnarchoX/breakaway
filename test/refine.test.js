import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const fires = [];
let failWith = null;

const refine = (ref, note) => api('agents/start', { method: 'POST', body: { ref, mode: 'refine', note } });
const build = (ref) => api('agents/start', { method: 'POST', body: { ref } });
const task = async (ref) => (await body(await api(`tasks/${ref}`))).task;

describe('refining a task with an agent', () => {
  let spy;
  beforeEach(() => {
    failWith = null;
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url !== FIRE) return new Response('{"message":"Not Found"}', { status: 404 });
      fires.push(JSON.parse(init.body).text);
      if (failWith) return new Response(JSON.stringify({ error: { message: 'no' } }), { status: failWith });
      return Response.json({
        claude_code_session_id: `session_${fires.length}`,
        claude_code_session_url: `https://claude.ai/code/session_${fires.length}`,
      });
    });
  });
  afterEach(() => spy.mockRestore());

  it('sets up tasks to refine', async () => {
    const res = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'Vague product idea', project: 'product', tags: ['agent'], horizon: 'later' },
          { description: 'Which host?', project: 'ops', tags: ['owner', 'decide'], horizon: 'now' },
          { description: 'Owner chore', project: 'ops', tags: ['owner'], horizon: 'now' },
          { description: 'Done already', project: 'debt', tags: ['agent'], horizon: 'now' },
          { description: 'Claimed one', project: 'debt', tags: ['agent'], horizon: 'now' },
        ],
      }),
    );
    expect(res.tasks.map((t) => t.wid)).toEqual(['PRD-1', 'OPS-1', 'OPS-2', 'DEBT-1', 'DEBT-2']);
    await api('tasks/DEBT-1/done', { method: 'POST', body: {} });
    await api('agents/settings', { method: 'PATCH', body: { max: 6 } });
    await api('tasks/DEBT-2/claim', { method: 'POST', body: { agent: 'someone' } });
  });

  it('needs the owner’s request', async () => {
    for (const note of [undefined, '', '   ']) {
      const res = await body(await refine('PRD-1', note));
      expect(res.status).toBe(400);
      expect(res.error).toMatch(/what it should look at or change/);
    }
    expect(fires).toHaveLength(0);
  });

  it('refuses tasks that are done or claimed, and says why', async () => {
    expect((await body(await refine('DEBT-1', 'x'))).error).toMatch(/isn’t open/);
    expect((await body(await refine('DEBT-2', 'x'))).error).toMatch(/someone has it/);
    expect(fires).toHaveLength(0);
  });

  it('refines a +decide task and one that isn’t tagged +agent, which a build refuses', async () => {
    expect((await body(await build('OPS-1'))).status).toBe(409);
    const res = await body(await refine('OPS-1', 'Lay out the options.'));
    expect(res.status).toBe(200);
    expect(res.run).toMatchObject({ agent: 'claude-refine-ops-1', kind: 'refine', status: 'started' });
    expect(res.task).toMatchObject({ claim: 'claude-refine-ops-1', session: 'https://claude.ai/code/session_1' });
    expect((await body(await refine('OPS-2', 'Split it up.'))).status).toBe(200);
  });

  it('hands the routine the mode, the agent name, and the request', async () => {
    const text = fires[0];
    expect(text).toMatch(/^Task: OPS-1\nTitle: Which host\?\nAgent name: claude-refine-ops-1\nStarted: by hand/);
    expect(text).toContain('Mode: refine');
    expect(text).toContain('Refinement request:\nLay out the options.');
    expect(text).not.toContain('Note from the owner');
  });

  it('adds an Attachments line only when the task has images', async () => {
    const made = await body(
      await api('tasks', {
        method: 'POST',
        body: { description: 'Has pictures', project: 'ops', tags: ['owner'], horizon: 'now' },
      }),
    );
    const wid = made.tasks[0].wid;
    expect(fires.at(-1)).not.toContain('Attachments:');
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    for (let i = 0; i < 2; i++) {
      const res = await SELF.fetch(`${ORIGIN}/api/tasks/${wid}/attachments`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_API_TOKEN}`,
          'Content-Type': 'image/png',
          'X-Attachment-Name': `shot${i}.png`,
        },
        body: PNG,
      });
      expect(res.status).toBe(201);
    }
    expect((await body(await refine(wid, 'Look at the pictures.'))).status).toBe(200);
    expect(fires.at(-1)).toMatch(/Mode: refine\nAttachments: 2\n\nRefinement request:\nLook at the pictures\./);
    // Let go, so this run doesn't count against the running limit in the tests after it.
    await api(`tasks/${wid}/release`, { method: 'POST', body: { agent: `claude-refine-${wid.toLowerCase()}` } });
  });

  it('keeps a build’s payload as it was, with no mode line', async () => {
    await build('PRD-1');
    expect(fires.at(-1)).not.toContain('Mode:');
    expect(fires.at(-1)).toContain('Agent name: claude-prd-1');
  });

  it('is the lock: no build or second refine while a refine run holds the task', async () => {
    await api('tasks', {
      method: 'POST',
      body: { description: 'Buildable', project: 'brand', tags: ['agent'], horizon: 'now' },
    });
    expect((await body(await refine('BRD-1', 'Tighten it.'))).status).toBe(200);
    expect((await body(await build('BRD-1'))).error).toMatch(/claude-refine-brd-1 has it/);
    expect((await body(await refine('BRD-1', 'again'))).error).toMatch(/claude-refine-brd-1 has it/);
  });

  it('gives the task back when Claude won’t start the session, and a build can start after', async () => {
    await api('tasks', {
      method: 'POST',
      body: { description: 'Refine me', project: 'compliance', tags: ['agent'], horizon: 'now' },
    });
    failWith = 429;
    const res = await body(await refine('CMP-1', 'Try.'));
    expect(res.status).toBe(429);
    expect((await task('CMP-1')).claim).toBeNull();
    failWith = null;
    expect((await body(await refine('CMP-1', 'Try again.'))).status).toBe(200);
  });

  it('keeps a refinement’s pull request out of the task’s pr field, so merging it doesn’t finish the task', async () => {
    const res = await body(await api('tasks/OPS-1', { method: 'PATCH', body: { pr: '125' } }));
    expect(res.status).toBe(403);
    expect(res.error).toMatch(/Part of/);
    expect((await task('OPS-1')).pr ?? null).toBeNull();
    // Once the refinement lets go, the build's pull request goes in the field as usual.
    await api('tasks', {
      method: 'POST',
      body: { description: 'Refine then build', project: 'debt', tags: ['agent'], horizon: 'now' },
    });
    expect((await body(await refine('DEBT-3', 'Sharpen it.'))).status).toBe(200);
    await api('tasks/DEBT-3/release', { method: 'POST', body: { agent: 'claude-refine-debt-3' } });
    expect((await api('tasks/DEBT-3', { method: 'PATCH', body: { pr: '126' } })).status).toBe(200);
    expect((await task('DEBT-3')).pr).toBe('126');
  });

  it('counts a refine run against the running limit', async () => {
    const overview = await body(await api('agents'));
    expect(overview.running.map((r) => r.wid)).toEqual(expect.arrayContaining(['OPS-1', 'OPS-2']));
    expect(overview.recent.find((r) => r.wid === 'OPS-1')).toMatchObject({ kind: 'refine' });
  });
});
