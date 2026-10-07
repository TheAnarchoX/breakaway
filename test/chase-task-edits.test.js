import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';
import { PROTOCOL } from '../src/mcp.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';

// IDEA-36 section 6 (BRK-214): every agent holding a task in an open chase changes the chase's other tasks under the
// cross-task rule, and deletes the ones agents added after the chase started; the rest it proposes in a ping.
const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
let made = 0;
const make = async (fields = {}) =>
  (
    await body(
      await api('tasks', {
        method: 'POST',
        body: [{ description: `Chase task ${made++}`, project: 'ops', tags: ['agent'], ...fields }],
      }),
    )
  ).tasks[0];
const edit = (ref, changes) => api(`tasks/${ref}`, { method: 'PATCH', body: changes });
const show = async (ref) => (await body(await api(`tasks/${ref}`))).task;
const chase = async (slug, on) => {
  const res = await api(`features/${slug}/chase`, { method: 'POST', body: { on } });
  expect(res.status).toBe(200);
};

/** A feature with a chase on, and an agent holding one of its tasks. */
async function chaseAgent(slug) {
  expect((await api('features', { method: 'POST', body: { slug } })).status).toBe(201);
  const own = await make({ tags: ['agent', slug] });
  const name = `claude-${own.wid.toLowerCase()}`;
  expect((await api(`tasks/${own.wid}/claim`, { method: 'POST', body: { agent: name } })).status).toBe(200);
  await chase(slug, true);
  return { own, name };
}

describe('chase agents and the chase’s tasks', () => {
  let spy;
  beforeAll(() => {
    // Nothing reaches the network: the chase firing a routine, or the alarm asking GitHub, gets a 404.
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 404 }));
  });
  afterAll(() => spy.mockRestore());

  it('changes each allowed field of an unclaimed open task of the chase, and the board notes it', async () => {
    const { own, name } = await chaseAgent('alpha');
    const target = await make({ tags: ['agent', 'alpha'], brief: 'Owner wrote this.', by: 'owner' });
    const blocker = await make();
    const res = await body(
      await edit(target.wid, {
        brief: 'Sharper.',
        done_when: 'Tests pass.',
        project: 'debt',
        horizon: 'next',
        addTags: ['docs'],
        removeTags: ['agent'],
        addDepends: [blocker.wid],
        by: name,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.task).toMatchObject({
      brief: 'Sharper.',
      doneWhen: 'Tests pass.',
      project: 'debt',
      horizon: 'next',
      tags: ['alpha', 'docs'],
    });
    expect(res.task.dependsOn.map((d) => d.wid)).toEqual([blocker.wid]);
    expect(res.task.comments.at(-1)).toMatchObject({
      by: 'board',
      text: `Changed by ${own.wid}: description, done when, area, horizon, tags, dependencies.`,
    });
    // The owner still wrote it: rewriting it in the chase doesn't make it the agent's.
    expect(res.task.briefBy).toBe('owner');
    expect((await edit(target.wid, { brief: 'Again.', by: name })).status).toBe(200);
    await chase('alpha', false);
    expect((await edit(target.wid, { brief: 'After the chase.', by: name })).status).toBe(403);
  });

  it('deletes a task an agent added after the chase started, and notes it', async () => {
    const { own, name } = await chaseAgent('beta');
    const added = await make({ tags: ['agent', 'beta'], brief: 'Split from mine.', by: 'claude-someone' });
    const res = await body(await edit(added.wid, { status: 'deleted', by: name }));
    expect(res.status).toBe(200);
    expect(res.task.status).toBe('deleted');
    expect(res.task.comments.at(-1)).toMatchObject({ by: 'board', text: `Deleted by ${own.wid}.` });
  });

  it('refuses to delete what the owner wrote, what was there before the chase, or a delete with other changes', async () => {
    const { name } = await chaseAgent('gamma');
    const owners = await make({ tags: ['agent', 'gamma'], brief: 'Owner wrote this.', by: 'owner' });
    const unwritten = await make({ tags: ['agent', 'gamma'] });
    const mixed = await make({ tags: ['agent', 'gamma'], brief: 'An agent wrote this.', by: 'claude-someone' });
    for (const [wid, changes, why] of [
      [owners.wid, { status: 'deleted' }, /agent added after the chase started/],
      [unwritten.wid, { status: 'deleted' }, /agent added after the chase started/],
      [mixed.wid, { status: 'deleted', horizon: 'next' }, /on its own/],
      [mixed.wid, { status: 'completed' }, /doesn't finish/],
    ]) {
      const res = await body(await edit(wid, { ...changes, by: name }));
      expect(res.status, JSON.stringify(changes)).toBe(403);
      expect(res.error).toMatch(why);
      expect(res.error).toMatch(/ping/);
      expect((await show(wid)).status).toBe('pending');
    }
    // Written by an agent, but before the chase started.
    await runInDurableObject(store(), (instance) => {
      instance.sql.exec("UPDATE features SET chase_started = ? WHERE slug = 'gamma'", Date.now() + 60_000);
    });
    const early = await body(await edit(mixed.wid, { status: 'deleted', by: name }));
    expect(early.status).toBe(403);
    expect(early.error).toMatch(/after the chase started/);
  });

  it('refuses a claimed task, an idea’s description, a horizon-* tag, autostart, a decision, and any other field', async () => {
    const { name } = await chaseAgent('delta');
    const claimed = await make({ tags: ['agent', 'delta'], brief: 'Mine.', by: 'claude-other' });
    await api(`tasks/${claimed.wid}/claim`, { method: 'POST', body: { agent: 'claude-other' } });
    for (const changes of [{ horizon: 'next' }, { status: 'deleted' }]) {
      const res = await body(await edit(claimed.wid, { ...changes, by: name }));
      expect(res.status).toBe(403);
      expect(res.error).toMatch(/unclaimed.*claude-other/);
    }
    const idea = await make({ project: 'ideas', tags: ['delta'], brief: 'An idea.', by: 'owner' });
    const ideaRes = await body(await edit(idea.wid, { brief: 'Rewritten.', by: name }));
    expect(ideaRes.status).toBe(403);
    expect(ideaRes.error).toMatch(/a chase agent .*idea/);

    const target = await make({ tags: ['agent', 'delta', 'horizon-auto'] });
    for (const changes of [
      { addTags: ['horizon-now'] },
      { autostart: 'yes' },
      { decision: { questions: [{ id: 'q', type: 'yesno', prompt: 'Ship it?' }] } },
      { pr: '12' },
    ]) {
      const res = await body(await edit(target.wid, { ...changes, by: name }));
      expect(res.status, JSON.stringify(changes)).toBe(403);
      expect(res.error).toMatch(/a chase agent .*ping/);
    }
    expect(await show(target.wid)).toMatchObject({ autostart: false, decision: null, priority: '', pr: null });
  });

  it('refuses tasks outside its chase and another repository’s, and gives agents outside a chase nothing new', async () => {
    const { name } = await chaseAgent('epsilon');
    const outside = await make({ brief: 'Owner wrote this.', by: 'owner' });
    expect((await edit(outside.wid, { brief: 'New.', by: name })).status).toBe(403);
    const agents = await make({ brief: 'An agent wrote this.', by: 'claude-someone' });
    const deleting = await body(await edit(agents.wid, { status: 'deleted', by: name }));
    expect(deleting.status).toBe(403);
    expect(deleting.error).toMatch(/ping/);

    // An agent with no task in the chase can't change or delete the chase's tasks.
    const inChase = await make({ tags: ['agent', 'epsilon'], brief: 'An agent wrote this.', by: 'claude-someone' });
    expect((await edit(inChase.wid, { brief: 'New.', by: 'claude-bystander' })).status).toBe(403);
    expect((await edit(inChase.wid, { status: 'deleted', by: 'claude-bystander' })).status).toBe(403);

    const registered = await api('repos', {
      method: 'POST',
      body: { slug: 'gadgets', github: 'acme/gadgets', areas: ['product:GDG'] },
    });
    expect(registered.status).toBe(201);
    const there = await make({ repo: 'gadgets', project: 'product', tags: ['agent', 'epsilon'] });
    const res = await body(await edit(there.wid, { horizon: 'next', by: name }));
    expect(res.status).toBe(403);
    expect(res.error).toMatch(/own repository.*gadgets/);
    expect((await show(inChase.wid)).status).toBe('pending');
  });
});

describe('a chase agent through MCP', () => {
  let spy;
  beforeAll(() => {
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 404 }));
  });
  afterAll(() => spy.mockRestore());

  /** MCP's modify_task, as `agent`: the tool's result. */
  async function modify(agent, args) {
    const res = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_API_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'X-Breakaway-Agent': agent,
        'X-Breakaway-Repo': 'widgets',
        'MCP-Protocol-Version': PROTOCOL,
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'modify_task',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'modify_task',
          arguments: args,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': PROTOCOL,
            'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    return (await res.json()).result;
  }

  it('changes an unclaimed task of its chase through modify_task, and an agent outside the chase is still refused', async () => {
    const { own, name } = await chaseAgent('zeta');
    const target = await make({ tags: ['agent', 'zeta'], brief: 'Owner wrote this.', by: 'owner' });
    const changed = await modify(name, {
      task: target.wid,
      brief: 'Sharper.',
      done_when: 'Tests pass.',
      tag: ['docs'],
    });
    expect(changed.isError).toBeUndefined();
    expect(changed.structuredContent.task).toMatchObject({ brief: 'Sharper.', doneWhen: 'Tests pass.' });
    expect(changed.structuredContent.task.tags).toContain('docs');
    expect((await show(target.wid)).comments.at(-1)).toMatchObject({
      by: 'board',
      text: `Changed by ${own.wid}: description, done when, tags.`,
    });

    // The store's rule still decides: never a field outside it, like the pull request.
    const pr = await modify(name, { task: target.wid, pr: 12 });
    expect(pr.isError).toBe(true);
    expect(pr.content[0].text).toMatch(/a chase agent .*ping/);

    // An agent with no task in the chase, or a task outside it, is refused as before.
    const bystander = await modify('claude-bystander', { task: target.wid, brief: 'Mine now.' });
    expect(bystander.isError).toBe(true);
    expect(bystander.content[0].text).toMatch(/only on a task you made/);
    const outside = await make({ brief: 'Owner wrote this.', by: 'owner' });
    const out = await modify(name, { task: outside.wid, tag: ['docs'] });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/unclaimed: claim it first/);
    expect(await show(target.wid)).toMatchObject({ brief: 'Sharper.', pr: null });
  });
});

describe('a ping proposal’s delete', () => {
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
  const owner = (path, input) =>
    SELF.fetch(`${ORIGIN}/api/${path}`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify(input ?? {}),
    });
  const ping = (wid, by, proposal) =>
    api(`tasks/${wid}/pings`, { method: 'POST', body: { by, kind: 'question', message: 'Drop this?', proposal } });

  it('is applied by the owner in one press, with its note', async () => {
    const own = await make();
    const by = 'claude-proposer';
    await api(`tasks/${own.wid}/claim`, { method: 'POST', body: { agent: by } });
    const target = await make({ brief: 'Owner wrote this.', by: 'owner' });
    const res = await body(await ping(own.wid, by, [{ type: 'delete', task: target.wid, note: 'Covered by mine.' }]));
    expect(res.status).toBe(201);
    expect(res.ping.proposal).toEqual([{ type: 'delete', task: target.wid, note: 'Covered by mine.' }]);
    expect(res.task.comments.at(-1).text).toMatch(/Proposal: delete 1 task\./);
    const applied = await body(await owner(`pings/${res.ping.id}/apply`));
    expect(applied.status).toBe(200);
    expect(applied.task.comments.at(-1).text).toBe(`Applied: deleted ${target.wid}.`);
    const gone = await show(target.wid);
    expect(gone.status).toBe('deleted');
    expect(gone.comments.at(-1)).toMatchObject({ by: 'owner', text: 'Covered by mine.' });
  });

  it('refuses a task that is claimed, closed, in the proposal twice, or the agent’s own', async () => {
    const own = await make();
    const by = 'claude-proposer-2';
    await api(`tasks/${own.wid}/claim`, { method: 'POST', body: { agent: by } });
    const claimed = await make();
    await api(`tasks/${claimed.wid}/claim`, { method: 'POST', body: { agent: 'claude-other' } });
    const closed = await make();
    await api(`tasks/${closed.wid}/done`, { method: 'POST', body: {} });
    const open = await make();
    for (const [proposal, why] of [
      [[{ type: 'delete', task: claimed.wid }], /claude-other/],
      [[{ type: 'delete', task: closed.wid }], /already completed/],
      [[{ type: 'delete', task: own.wid }], /you hold/],
      [
        [
          { type: 'delete', task: open.wid },
          { type: 'done', task: open.wid },
        ],
        /deleted and finished/,
      ],
      [[{ type: 'delete', task: open.wid, horizon: 'next' }], /unknown field/],
    ]) {
      const res = await body(await ping(own.wid, by, proposal));
      expect(res.status, JSON.stringify(proposal)).toBe(400);
      expect(res.error).toMatch(why);
    }
  });
});
