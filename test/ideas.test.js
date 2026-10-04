import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const fires = [];

const idea = (text, extra = {}) =>
  api('tasks', {
    method: 'POST',
    body: {
      description: text.split('\n')[0],
      project: 'ideas',
      horizon: 'now',
      tags: ['agent', 'idea', 'horizon-auto'],
      note: text,
      ...extra,
    },
  });

describe('ideas', () => {
  let spy;
  beforeEach(() => {
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url !== FIRE) return new Response('{"message":"Not Found"}', { status: 404 });
      fires.push(JSON.parse(init.body).text);
      return Response.json({
        claude_code_session_id: `session_${fires.length}`,
        claude_code_session_url: `https://claude.ai/code/session_${fires.length}`,
      });
    });
  });
  afterEach(() => spy.mockRestore());

  it('gives ideas their own area and work IDs', async () => {
    const first = await body(await idea('A QR code for room links\nSo people can join from a phone.'));
    expect(first.status).toBe(201);
    expect(first.tasks[0]).toMatchObject({
      wid: 'IDEA-1',
      project: 'ideas',
      tags: ['agent', 'horizon-auto', 'idea'],
      autostart: false,
    });
    expect(first.tasks[0].brief).toMatch(/join from a phone/);
    expect((await body(await idea('Another one'))).tasks[0].wid).toBe('IDEA-2');
  });

  it('leaves an idea waiting unless the owner turned auto-start on when writing it', async () => {
    await runDurableObjectAlarm(env.STORE.get(env.STORE.idFromName('widgets')));
    expect(fires).toHaveLength(0);
    const t = (await body(await api('tasks/IDEA-1'))).task;
    expect(t.claim).toBeNull();
  });

  it('starts an idea’s agent by itself when the owner chose that, and hands it the idea’s work ID', async () => {
    const made = await body(await idea('Show who is in a room as avatars', { autostart: 'yes' }));
    expect(made.tasks[0]).toMatchObject({ wid: 'IDEA-3', autostart: true });
    await runDurableObjectAlarm(env.STORE.get(env.STORE.idFromName('widgets')));
    expect(fires).toHaveLength(1);
    expect(fires[0]).toMatch(/Task: IDEA-3\nTitle: Show who is in a room as avatars\nAgent name: claude-idea-3/);
    expect((await body(await api('tasks/IDEA-3'))).task).toMatchObject({ claim: 'claude-idea-3', active: true });
  });

  it('can still start a waiting idea by hand', async () => {
    const res = await body(await api('agents/start', { method: 'POST', body: { ref: 'IDEA-1' } }));
    expect(res.status).toBe(200);
    expect(fires.at(-1)).toMatch(/Task: IDEA-1/);
  });
});
