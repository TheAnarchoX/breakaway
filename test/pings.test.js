import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { looksLikeSecret } from '../src/ping.js';

const make = async (description, extra = {}) => {
  const res = await api('tasks', {
    method: 'POST',
    body: { description, project: 'cloud', horizon: 'now', tags: ['agent'], ...extra },
  });
  return (await res.json()).tasks[0].wid;
};
const held = async (description, by = 'claude-ping', { depends, ...extra } = {}) => {
  const wid = await make(description, extra);
  await api(`tasks/${wid}/claim`, { method: 'POST', body: { agent: by } });
  if (depends) await api(`tasks/${wid}`, { method: 'PATCH', body: { addDepends: depends } });
  return wid;
};
const ping = (wid, body, by = 'claude-ping') => api(`tasks/${wid}/pings`, { method: 'POST', body: { by, ...body } });
const newTask = (ref, extra = {}) => ({
  type: 'add',
  ref,
  title: `Follow-up ${ref}`,
  project: 'cloud',
  horizon: 'now',
  tags: ['owner'],
  brief: 'What and why.',
  done_when: 'It is done.',
  ...extra,
});

describe('pings', () => {
  it('stores a ping, writes the comment, and shows it on the task and in the open list', async () => {
    const wid = await held('Needs the owner');
    const res = await ping(wid, { kind: 'blocked', message: 'Needs a dashboard change only you can make.' });
    expect(res.status).toBe(201);
    const { ping: made, task } = await res.json();
    expect(made).toMatchObject({
      task: wid,
      kind: 'blocked',
      by: 'claude-ping',
      push: true,
      proposal: null,
      resolved: null,
    });
    expect(task.comments.at(-1)).toMatchObject({
      by: 'claude-ping',
      text: 'Ping (blocked): Needs a dashboard change only you can make.',
    });
    const shown = (await (await api(`tasks/${wid}`)).json()).task;
    expect(shown.pings).toHaveLength(1);
    const open = await (await api('pings')).json();
    expect(open.pings.find((p) => p.id === made.id)).toMatchObject({ task: wid, taskTitle: 'Needs the owner' });
  });

  it('sends no push for fyi, and only the holder can ping', async () => {
    const wid = await held('Holder only');
    expect((await (await ping(wid, { kind: 'fyi', message: 'Good to know.' })).json()).ping.push).toBe(false);
    expect((await ping(wid, { kind: 'blocked', message: 'From someone else' }, 'claude-other')).status).toBe(403);
    const free = await make('Nobody holds it');
    expect((await ping(free, { kind: 'blocked', message: 'Not mine' })).status).toBe(403);
    expect((await api(`tasks/${wid}/pings`, { method: 'POST', body: { kind: 'fyi', message: 'no by' } })).status).toBe(
      400,
    );
  });

  it('refuses a bad kind, an empty or long message, and a message that holds a token', async () => {
    const wid = await held('Checks');
    expect((await ping(wid, { kind: 'shout', message: 'x' })).status).toBe(400);
    expect((await ping(wid, { kind: 'blocked', message: '  ' })).status).toBe(400);
    expect((await ping(wid, { kind: 'blocked', message: 'x'.repeat(501) })).status).toBe(400);
    const secret = await ping(wid, {
      kind: 'blocked',
      message: 'Use ghp_abcdefghijklmnopqrstuvwxyz0123456789 to log in',
    });
    expect(secret.status).toBe(400);
    expect((await secret.json()).error).toMatch(/token or key/);
    expect(looksLikeSecret('merged as 0123456789abcdef0123456789abcdef01234567')).toBe(false);
    expect(looksLikeSecret('See CLD-111 and docs/specs/IDEA-12-agent-pings.md please')).toBe(false);
  });

  it('drops a repeat, then caps pings at 3 per task and 10 per agent a day', async () => {
    const wid = await held('Chatty', 'claude-chatty');
    const first = await (await ping(wid, { kind: 'question', message: 'One' }, 'claude-chatty')).json();
    const again = await ping(wid, { kind: 'question', message: 'One' }, 'claude-chatty');
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ dropped: 'duplicate', ping: { id: first.ping.id } });
    expect((await ping(wid, { kind: 'question', message: 'Two' }, 'claude-chatty')).status).toBe(201);
    expect((await ping(wid, { kind: 'question', message: 'Three' }, 'claude-chatty')).status).toBe(201);
    const fourth = await ping(wid, { kind: 'question', message: 'Four' }, 'claude-chatty');
    expect(fourth.status).toBe(429);
    expect((await fourth.json()).error).toMatch(/3 pings in a day/);
    // 3 used on this task; the agent has 7 more across other tasks, then the agent cap applies.
    for (let i = 0; i < 7; i++) {
      const other = await held(`Other ${i}`, 'claude-chatty');
      expect((await ping(other, { kind: 'fyi', message: `n${i}` }, 'claude-chatty')).status).toBe(201);
    }
    const last = await held('One too many', 'claude-chatty');
    const capped = await ping(last, { kind: 'fyi', message: 'late' }, 'claude-chatty');
    expect(capped.status).toBe(429);
    expect((await capped.json()).error).toMatch(/10 pings in a day/);
  });

  it('resolves a ping when its task is finished', async () => {
    const wid = await held('Will finish');
    const { ping: made } = await (await ping(wid, { kind: 'done', message: 'Looks finished.' })).json();
    await api(`tasks/${wid}/done`, { method: 'POST', body: {} });
    const open = (await (await api('pings')).json()).pings;
    expect(open.find((p) => p.id === made.id)).toBeUndefined();
    const shown = (await (await api(`tasks/${wid}`)).json()).task;
    expect(shown.pings[0].resolved.how).toBe('task-finished');
  });

  it('shows up in Activity', async () => {
    const wid = await held('Logged');
    await ping(wid, { kind: 'blocked', message: 'Logged for the owner' });
    const { events } = await (await api('activity?limit=20')).json();
    const event = events.find((e) => e.source === 'pings' && e.task?.wid === wid);
    expect(event.changes[0]).toMatchObject({ kind: 'ping', pingKind: 'blocked', by: 'claude-ping' });
  });
});

describe('proposals', () => {
  it('keeps a good proposal, cleaned up, with a summary comment', async () => {
    const wid = await held('Has a proposal');
    const other = await make('Waits for nothing');
    const res = await ping(wid, {
      kind: 'blocked',
      message: 'Needs an owner task first.',
      proposal: {
        changes: [newTask('n1', { depends: [other.toLowerCase()] }), { type: 'depend', task: wid, add: ['n1'] }],
      },
    });
    expect(res.status).toBe(201);
    const { ping: made, task } = await res.json();
    expect(made.proposal).toHaveLength(2);
    expect(made.proposal[0]).toMatchObject({ type: 'add', ref: 'n1', depends: [other] });
    expect(made.proposal[1]).toEqual({ type: 'depend', task: wid, add: ['n1'], remove: [] });
    expect(task.comments.at(-1).text).toMatch(/Proposal: add 1 task, change 1 dependency\./);
  });

  const refused = async (proposal, pattern, wid) => {
    const target = wid ?? (await held(`Refuses ${Math.random()}`));
    const res = await ping(target, { kind: 'blocked', message: `Try ${Math.random()}`, proposal });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(pattern);
  };

  it('refuses cycles and redundant dependencies, naming the path', async () => {
    const c = await make('C');
    const b = await make('B', { depends: [c] });
    const a = await held('A', 'claude-ping', { depends: [b] });
    await refused([{ type: 'depend', task: c, add: [a] }], new RegExp(`cycle \\(${c} → ${a} → ${b} → ${c}\\)`), a);
    await refused(
      [{ type: 'depend', task: a, add: [c] }],
      new RegExp(`${a} already waits for ${c} through ${a} → ${b} → ${c}, so the dependency is redundant`),
      a,
    );
    await refused([{ type: 'depend', task: a, add: [b] }], /already waits for/, a);
    await refused([{ type: 'depend', task: a, add: [a] }], /can't wait for itself/, a);
    await refused([newTask('n1', { depends: ['n2'] }), newTask('n2', { depends: ['n1'] })], /cycle/, a);
  });

  it('allows removing a redundant edge in the same proposal, and warns when a task stops waiting', async () => {
    const c = await make('C2');
    const b = await make('B2', { depends: [c] });
    const a = await held('A2', 'claude-ping', { depends: [b] });
    const res = await ping(a, {
      kind: 'stale',
      message: 'Nothing to wait for now.',
      proposal: [{ type: 'depend', task: a, remove: [b] }],
    });
    expect(res.status).toBe(201);
    expect((await res.json()).ping.warnings).toEqual([`${a} would no longer wait for anything`]);
    await refused([{ type: 'depend', task: a, remove: [c] }], /doesn't wait for/, a);
  });

  it('refuses autostart, horizon tags, unknown fields and types, missing pieces, and too much', async () => {
    const wid = await held('Strict');
    await refused([newTask('n1', { autostart: 'yes' })], /can't set autostart/, wid);
    await refused([newTask('n1', { tags: ['agent', 'horizon-now'] })], /horizon tags are the owner's/, wid);
    await refused([newTask('n1', { colour: 'red' })], /unknown field "colour"/, wid);
    await refused([{ type: 'explode' }], /type is one of/, wid);
    await refused([newTask('n1', { done_when: '' })], /done_when is needed/, wid);
    await refused([newTask('n1', { project: 'nope' })], /project is one of/, wid);
    await refused([newTask('n1', { tags: ['later'] })], /agent, owner, or decide/, wid);
    await refused([newTask('n1', { brief: 'Use ghp_abcdefghijklmnopqrstuvwxyz0123456789' })], /token or key/, wid);
    await refused([], /no changes/, wid);
    await refused(
      Array.from({ length: 11 }, (_, i) => newTask(`n${i}`)),
      /up to 10 changes/,
      wid,
    );
    await refused(
      [
        newTask('n1', { brief: 'x'.repeat(10_000) }),
        newTask('n2', { brief: 'x'.repeat(10_000) }),
        newTask('n3', { brief: 'x'.repeat(1_000) }),
      ],
      /up to 20 KB/,
      wid,
    );
    await refused([newTask('n1'), newTask('n1')], /used twice/, wid);
    await refused('not a list', /list of changes/, wid);
  });

  it('checks modify, done, and release targets', async () => {
    const wid = await held('Targets');
    const other = await make('Somebody else’s');
    const done = await make('Already done');
    await api(`tasks/${done}/done`, { method: 'POST', body: {} });
    const held2 = await held('Held by another', 'claude-busy');
    await refused([{ type: 'modify', task: wid, horizon: 'next' }], /you hold/, wid);
    await refused([{ type: 'modify', task: other, addTags: ['horizon-next'] }], /horizon tags are the owner's/, wid);
    await refused([{ type: 'modify', task: other }], /say what changes/, wid);
    await refused([{ type: 'done', task: done }], /already completed/, wid);
    await refused(
      [
        { type: 'done', task: other },
        { type: 'done', task: other },
      ],
      /finished twice/,
      wid,
    );
    await refused([{ type: 'release', task: held2 }], /only for the task the ping is about/, wid);
    await refused([{ type: 'done', task: 'NOPE-1' }], /no task "NOPE-1"/, wid);
    const ok = await ping(wid, {
      kind: 'stale',
      message: 'Does not reproduce any more.',
      proposal: [
        { type: 'modify', task: other, horizon: 'next', removeTags: ['agent'], addTags: ['owner'] },
        { type: 'done', task: wid, note: 'Behaves as expected' },
        { type: 'release', task: wid },
      ],
    });
    expect(ok.status).toBe(201);
    expect((await ok.json()).ping.proposal.map((c) => c.type)).toEqual(['modify', 'done', 'release']);
  });
});

describe('applying, dismissing, and handling a ping', () => {
  let cookie;
  beforeAll(async () => {
    const res = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    cookie = res.headers.get('Set-Cookie').split(';')[0];
  });
  const owner = (path, body) =>
    SELF.fetch(`${ORIGIN}/api/${path}`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  const task = async (wid) => (await (await api(`tasks/${wid}`)).json()).task;
  let agents = 0;
  const proposed = async (proposal, wid) => {
    const by = wid ? (await task(wid)).claim : `claude-apply-${agents++}`;
    const target = wid ?? (await held(`Applies ${Math.random()}`, by));
    const res = await ping(target, { kind: 'blocked', message: `Apply ${Math.random()}`, proposal }, by);
    expect(res.status).toBe(201);
    return { wid: target, id: (await res.json()).ping.id };
  };

  it('is the owner only: a bearer token gets a 403 and nothing changes', async () => {
    const { wid, id } = await proposed([{ type: 'done', task: await make('Stays open') }]);
    for (const action of ['apply', 'dismiss', 'handled']) {
      const res = await api(`pings/${id}/${action}`, { method: 'POST', body: {} });
      expect(res.status).toBe(403);
    }
    expect((await task(wid)).pings[0].resolved).toBeNull();
    const cross = await SELF.fetch(`${ORIGIN}/api/pings/${id}/apply`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(cross.status).toBe(403);
  });

  it('applies every change in one step, wires the new tasks, comments on the task, and logs it', async () => {
    const other = await make('Gets edited', { tags: ['agent'] });
    const wid = await held('Needs a follow-up', `claude-own-${agents++}`);
    const { id } = await proposed(
      [
        newTask('n1'),
        newTask('n2', { depends: ['n1'] }),
        { type: 'depend', task: wid, add: ['n2'] },
        { type: 'modify', task: other, horizon: 'next', addTags: ['owner'] },
      ],
      wid,
    );
    const res = await owner(`pings/${id}/apply`);
    expect(res.status).toBe(200);
    const { ping: done, created, task: shown } = await res.json();
    expect(done.resolved.how).toBe('applied');
    expect(created).toHaveLength(2);
    const [first, second] = created;
    expect(shown.dependsOn.map((d) => d.wid)).toEqual([second]);
    expect((await task(second)).dependsOn.map((d) => d.wid)).toEqual([first]);
    expect(shown.comments.at(-1)).toMatchObject({
      by: 'board',
      text: `Applied: added ${first}, ${second}; ${wid} now waits for ${second}; edited ${other}.`,
    });
    expect(await task(other)).toMatchObject({ horizon: 'next', tags: expect.arrayContaining(['agent', 'owner']) });
    const { events } = await (await api('activity?limit=5')).json();
    expect(events[0].source).toBe('api');
    expect(
      events.flatMap((e) => e.task?.wid ?? []).filter((w) => [first, second, wid, other].includes(w)).length,
    ).toBeGreaterThanOrEqual(4);
    expect((await owner(`pings/${id}/apply`)).status).toBe(409);
  });

  it('applies only the ticked changes, with an edited new task', async () => {
    const a = await make('Finish me');
    const b = await make('Not me');
    const { id } = await proposed([
      { type: 'done', task: a, note: 'Behaves as expected' },
      { type: 'done', task: b },
      newTask('n1'),
    ]);
    const res = await owner(`pings/${id}/apply`, { chosen: [0, 2], edits: { 2: { title: 'Edited title' } } });
    expect(res.status).toBe(200);
    const { created } = await res.json();
    expect(await task(a)).toMatchObject({ status: 'completed' });
    expect((await task(a)).comments.at(-1).text).toBe('Behaves as expected');
    expect((await task(b)).status).toBe('pending');
    expect((await task(created[0])).description).toBe('Edited title');
  });

  it('applies nothing when a chosen change no longer holds', async () => {
    const a = await make('Will change under it');
    const b = await make('Another');
    const wid = await held('Holder', `claude-own-${agents++}`);
    const { id } = await proposed([newTask('n1'), { type: 'done', task: a }, { type: 'done', task: b }], wid);
    await api(`tasks/${b}/done`, { method: 'POST', body: {} });
    const before = (await (await api('tasks?status=all')).json()).tasks.length;
    const res = await owner(`pings/${id}/apply`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/^nothing was applied: .*already completed/);
    expect((await (await api('tasks?status=all')).json()).tasks.length).toBe(before);
    expect((await task(a)).status).toBe('pending');
    expect((await task(wid)).pings[0].resolved).toBeNull();
    // Unticking the stale change makes it apply.
    expect((await owner(`pings/${id}/apply`, { chosen: [0, 1] })).status).toBe(200);
  });

  it('refuses a bad choice or edit, and a chosen change whose new task depends on one left out', async () => {
    const { id } = await proposed([newTask('n1'), newTask('n2', { depends: ['n1'] })]);
    for (const body of [
      { chosen: [] },
      { chosen: [5] },
      { chosen: [0, 0] },
      { chosen: 'all' },
      { edits: [] },
      { edits: { 0: { tags: ['later'] } } },
      { chosen: [1] },
    ]) {
      expect([400, 409]).toContain((await owner(`pings/${id}/apply`, body)).status);
    }
    expect((await (await api('pings')).json()).pings.find((p) => p.id === id)).toBeTruthy();
  });

  it('dismisses, and logs it; handled is for pings without a proposal', async () => {
    const { wid, id } = await proposed([{ type: 'done', task: await make('Left alone') }]);
    expect((await owner(`pings/${id}/handled`)).status).toBe(400);
    const res = await owner(`pings/${id}/dismiss`);
    expect(res.status).toBe(200);
    expect((await res.json()).ping.resolved.how).toBe('dismissed');
    expect((await owner(`pings/${id}/apply`)).status).toBe(409);
    expect((await owner(`pings/${id}/dismiss`)).status).toBe(409);
    expect((await task(wid)).status).toBe('pending');

    const plain = await held('No proposal', `claude-own-${agents++}`);
    const made = (
      await (await ping(plain, { kind: 'question', message: 'Just so you know' }, (await task(plain)).claim)).json()
    ).ping;
    expect((await owner(`pings/${made.id}/apply`)).status).toBe(400);
    expect((await (await owner(`pings/${made.id}/handled`)).json()).ping.resolved.how).toBe('handled');
    const { events } = await (await api('activity?limit=50')).json();
    expect(
      events.find((e) => e.changes[0]?.kind === 'ping-resolved' && e.task?.wid === plain).changes[0],
    ).toMatchObject({ how: 'handled', by: 'owner' });
    expect((await owner('pings/9999/dismiss')).status).toBe(404);
  });

  it('can finish and release the task it is about in the same step', async () => {
    const wid = await held('Behaves as expected', `claude-own-${agents++}`);
    const { id } = await proposed([{ type: 'done', task: wid, note: 'Cannot reproduce' }], wid);
    expect((await owner(`pings/${id}/apply`)).status).toBe(200);
    const shown = await task(wid);
    expect(shown.status).toBe('completed');
    expect(shown.pings[0].resolved.how).toBe('applied');
    const held2 = await held('Stale claim', `claude-own-${agents++}`);
    const again = await proposed([{ type: 'release', task: held2 }], held2);
    expect((await owner(`pings/${again.id}/apply`)).status).toBe(200);
    expect((await task(held2)).claim).toBeFalsy();
  });
});
