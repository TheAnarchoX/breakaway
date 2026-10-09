import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));

describe('messages to a running agent (IDEA-15)', () => {
  let cookie;
  let wid;
  beforeAll(async () => {
    const res = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    cookie = res.headers.get('Set-Cookie').split(';')[0];
    const created = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'Write the runbook', project: 'ops', who: 'agent', horizon: 'now' },
          { description: 'Nobody has this', project: 'ops', who: 'agent', horizon: 'now' },
        ],
      }),
    );
    wid = created.tasks[0].wid;
    expect((await api(`tasks/${wid}/claim`, { method: 'POST', body: { agent: 'claude-msg-1' } })).status).toBe(200);
  });
  const send = (ref, text, origin = ORIGIN) =>
    SELF.fetch(`${ORIGIN}/api/tasks/${ref}/messages`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  const list = async (ref) =>
    body(await SELF.fetch(`${ORIGIN}/api/tasks/${ref}/messages`, { headers: { Cookie: cookie } }));
  const hookPost = (ref, agent) =>
    api(`tasks/${ref}/session`, {
      method: 'POST',
      body: { agent, entries: [{ kind: 'tool', tool: 'Bash', title: 'Run the tests' }] },
    });
  const waiting = (ref, agent) => api(`tasks/${ref}/messages/waiting?agent=${encodeURIComponent(agent)}`);

  it('only the signed-in board can send: the bearer token gets 403, and so does another origin', async () => {
    const token = await api(`tasks/${wid}/messages`, { method: 'POST', body: { text: 'Do something else' } });
    expect(token.status).toBe(403);
    expect((await token.json()).error).toMatch(/only the signed-in web board/);
    expect((await send(wid, 'Cross', 'https://evil.example')).status).toBe(403);
    expect((await list(wid)).messages).toEqual([]);
  });

  it('checks the text', async () => {
    expect((await send(wid, '   ')).status).toBe(400);
    expect((await send(wid, 'x'.repeat(2001))).status).toBe(400);
  });

  it('refuses a task with no running agent', async () => {
    const res = await body(await send(`${wid.split('-')[0]}-${Number(wid.split('-')[1]) + 1}`, 'Hello'));
    expect(res.status).toBe(409);
    expect(res.error).toMatch(/no running agent.*no agent holds it/);
  });

  it('queues a message for the agent that holds the claim and shows it waiting', async () => {
    const res = await body(await send(wid, '  Also update the runbook.  '));
    expect(res.status).toBe(201);
    expect(res.message).toMatchObject({
      agent: 'claude-msg-1',
      text: 'Also update the runbook.',
      status: 'waiting',
      delivered: null,
    });
    const shown = await list(wid);
    expect(shown).toMatchObject({ canSend: true, agent: 'claude-msg-1' });
    expect(shown.messages.map((m) => m.status)).toEqual(['waiting']);
    // The token can read them (the CLI and agents can see what was sent).
    expect((await body(await api(`tasks/${wid}/messages`))).messages).toHaveLength(1);
  });

  it('delivers only to the claim’s agent, once, through the session post', async () => {
    expect((await body(await hookPost(wid, 'claude-other'))).messages).toEqual([]);
    expect((await body(await waiting(wid, 'claude-other'))).messages).toEqual([]);
    const first = await body(await hookPost(wid, 'claude-msg-1'));
    expect(first.status).toBe(201);
    expect(first.added).toBe(1);
    expect(first.messages).toEqual([expect.objectContaining({ text: 'Also update the runbook.' })]);
    expect((await body(await hookPost(wid, 'claude-msg-1'))).messages).toEqual([]);
    expect((await body(await waiting(wid, 'claude-msg-1'))).messages).toEqual([]);
    const [m] = (await list(wid)).messages;
    expect(m.status).toBe('delivered');
    expect(m.delivered).toEqual(expect.any(String));
  });

  it('leaves messages waiting when the post says it can’t hand them on (a Stop hook)', async () => {
    await send(wid, 'Check the docs too.');
    const stop = await body(
      await api(`tasks/${wid}/session`, {
        method: 'POST',
        body: { agent: 'claude-msg-1', messages: false, entries: [{ kind: 'message', text: 'Done for now' }] },
      }),
    );
    expect(stop).toMatchObject({ status: 201, added: 1, messages: [] });
    expect((await body(await hookPost(wid, 'claude-msg-1'))).messages.map((x) => x.text)).toEqual([
      'Check the docs too.',
    ]);
  });

  it('delivers through the idle hook’s wait too, from the same queue', async () => {
    await send(wid, 'Don’t touch the migration.');
    const got = await body(await waiting(wid, 'claude-msg-1'));
    expect(got.messages.map((x) => x.text)).toEqual(['Don’t touch the migration.']);
    expect((await body(await hookPost(wid, 'claude-msg-1'))).messages).toEqual([]);
  });

  it('holds at most 10 waiting messages', async () => {
    for (let i = 0; i < 10; i += 1) expect((await send(wid, `Note ${i}`)).status).toBe(201);
    const over = await body(await send(wid, 'One more'));
    expect(over.status).toBe(429);
    expect(over.error).toMatch(/wait for the agent to receive the first ones/);
    expect((await body(await waiting(wid, 'claude-msg-1'))).messages).toHaveLength(10);
    expect((await send(wid, 'Room again')).status).toBe(201);
  });

  it('says when the agent is idle and nothing is listening', async () => {
    await runInDurableObject(store(), (s) => {
      s.sql.exec('UPDATE agent_logs SET at = ?', Date.now() - 10 * 60_000);
      s.sql.exec('DELETE FROM agent_message_polls');
    });
    expect((await list(wid)).idle).toBe(true);
    await waiting(wid, 'claude-msg-1'); // a wait hook asking means it's listening
    expect((await list(wid)).idle).toBe(false);
  });

  it('forgets messages after 14 days', async () => {
    await runInDurableObject(store(), (s) => {
      s.sql.exec('UPDATE agent_messages SET sent = ? WHERE text = ?', Date.now() - 15 * 86_400_000, 'Room again');
    });
    const texts = (await list(wid)).messages.map((m) => m.text);
    expect(texts).not.toContain('Room again');
    expect(texts).toContain('Also update the runbook.');
  });

  it('never hands a message to the next agent once the claim changes, and shows it not delivered', async () => {
    await send(wid, 'For the first agent only');
    await api(`tasks/${wid}/release`, { method: 'POST', body: { agent: 'claude-msg-1' } });
    let shown = await list(wid);
    expect(shown.canSend).toBe(false);
    expect(shown.messages.at(-1)).toMatchObject({ text: 'For the first agent only', status: 'undelivered' });
    expect((await send(wid, 'Anyone?')).status).toBe(409);
    await api(`tasks/${wid}/claim`, { method: 'POST', body: { agent: 'claude-msg-2' } });
    expect((await body(await hookPost(wid, 'claude-msg-2'))).messages).toEqual([]);
    shown = await list(wid);
    expect(shown.messages.at(-1).status).toBe('undelivered');
  });
});
