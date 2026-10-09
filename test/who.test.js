import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { LEGACY_WHO_TAGS, diffOps, legacyWho, view, whoFromTags, withChanges } from '../src/model.js';
import { api, latestVersion, pushOps, readChild, twCreate } from './helpers.js';

// Who does it (BRK-330): `who` and `assignee` replace the +agent, +owner, and +decide tags.

const NOW = new Date('2026-10-09T12:00:00Z');
const body = async (res) => ({ status: res.status, ...(await res.json()) });
const inStore = (fn) => runInDurableObject(env.STORE.get(env.STORE.idFromName('widgets')), fn);
const add = (task) => api('tasks', { method: 'POST', body: task });
const patch = (ref, changes) => api(`tasks/${ref}`, { method: 'PATCH', body: changes });

describe('who does it, in the model', () => {
  it('stores who and assignee as properties and shows them', () => {
    const map = withChanges(null, { description: 'Check the site', who: 'person', assignee: 'owner' }, NOW);
    expect(map).toMatchObject({ who: 'person', assignee: 'owner' });
    expect(map.tags).toBeUndefined();
    expect(view('u', map, new Map(), NOW)).toMatchObject({ who: 'person', assignee: 'owner', tags: [] });
    expect(view('u', { description: 'x' }, new Map(), NOW)).toMatchObject({ who: null, assignee: null });
  });

  it('refuses a who it doesn’t know, and an assignee on a task that isn’t a person’s', () => {
    expect(() => withChanges(null, { description: 'x', who: 'robot' }, NOW)).toThrow(/agent, person, or decision/);
    expect(() => withChanges(null, { description: 'x', who: 'agent', assignee: 'owner' }, NOW)).toThrow(
      /only a person's task has an assignee/,
    );
    expect(() => withChanges(null, { description: 'x', who: 'person', assignee: 'Not Me' }, NOW)).toThrow(
      /a person's handle, or owner/,
    );
  });

  it('drops the assignee when the task stops being a person’s', () => {
    const person = withChanges(null, { description: 'x', who: 'person', assignee: 'ana' }, NOW);
    const agent = withChanges(person, { who: 'agent' }, NOW);
    expect(agent.who).toBe('agent');
    expect(agent.assignee).toBeUndefined();
    expect(withChanges(person, { assignee: null }, NOW)).toMatchObject({ who: 'person' });
  });

  it('makes a task with questions a decision', () => {
    const asked = withChanges(
      null,
      { description: 'Pick one', who: 'person', assignee: 'owner', decision: [{ id: 'a', type: 'yesno', prompt: 'Ok?' }] },
      NOW,
    );
    expect(asked.who).toBe('decision');
    expect(asked.assignee).toBeUndefined();
    // The core told agents to add a decision with --tag owner until BRK-330.
    const old = withChanges(null, { description: 'Pick', addTags: ['owner'], decision: [{ id: 'a', type: 'yesno', prompt: 'Ok?' }] }, NOW);
    expect(old).toMatchObject({ who: 'decision' });
    expect(old.assignee).toBeUndefined();
  });

  // The input mapping (BRK-330): an older CLI, prompt, or Taskwarrior replica still says who with a tag.
  it('maps each tag who replaced onto who, and never stores the tag', () => {
    for (const [tag, meant] of Object.entries(LEGACY_WHO_TAGS)) {
      const map = withChanges(null, { description: 'x', addTags: [tag, 'docs'] }, NOW);
      expect(map).toMatchObject({ ...meant, tags: 'docs', tag_docs: 'x' });
      expect(map[`tag_${tag}`]).toBeUndefined();
    }
  });

  it('lets a decision win, then an agent, then a person, as the board read the tags', () => {
    expect(whoFromTags(['owner', 'decide'])).toEqual({ who: 'decision' });
    expect(whoFromTags(['owner', 'agent'])).toEqual({ who: 'agent' });
    expect(whoFromTags(['owner'])).toEqual({ who: 'person', assignee: 'owner' });
    expect(whoFromTags(['docs'])).toBeNull();
  });

  it('clears who when an older CLI removes the tag that named it, and nothing else', () => {
    const agent = withChanges(null, { description: 'x', who: 'agent' }, NOW);
    expect(withChanges(agent, { removeTags: ['agent'] }, NOW).who).toBeUndefined();
    expect(withChanges(agent, { removeTags: ['owner'] }, NOW).who).toBe('agent');
    // structure.js's old ping template: +owner on, +agent off.
    expect(withChanges(agent, { addTags: ['owner'], removeTags: ['agent'] }, NOW)).toMatchObject({
      who: 'person',
      assignee: 'owner',
    });
  });

  it('keeps a person’s assignee when an older +owner arrives', () => {
    const ana = withChanges(null, { description: 'x', who: 'person', assignee: 'ana' }, NOW);
    expect(withChanges(ana, { addTags: ['owner'] }, NOW)).toMatchObject({ who: 'person', assignee: 'ana' });
  });

  it('moves a stored task off the tags, and leaves one without them as it is', () => {
    const old = { description: 'x', tags: 'decide,docs,owner', tag_decide: 'x', tag_docs: 'x', tag_owner: 'x' };
    const moved = legacyWho(old);
    expect(moved).toEqual({ description: 'x', tags: 'docs', tag_docs: 'x', who: 'decision' });
    const plain = { description: 'y', tags: 'docs', tag_docs: 'x' };
    expect(legacyWho(plain)).toBe(plain);
  });
});

describe('who does it, on the board', () => {
  it('migrates every stored task once, in one version Taskwarrior reads', async () => {
    const uuids = { a: crypto.randomUUID(), o: crypto.randomUUID(), d: crypto.randomUUID() };
    const before = await inStore(async (store) => {
      await store.ready();
      store.loadTasks();
      const stamp = NOW.toISOString();
      const raw = (uuid, tag) => ({
        description: `Old ${tag}`,
        status: 'pending',
        entry: '1790596800',
        tags: `${tag},docs`,
        [`tag_${tag}`]: 'x',
        tag_docs: 'x',
      });
      // Written before BRK-330, straight into history, as an older board did.
      store.commit([
        ...diffOps(uuids.a, null, raw(uuids.a, 'agent'), stamp),
        ...diffOps(uuids.o, null, raw(uuids.o, 'owner'), stamp),
        ...diffOps(uuids.d, null, raw(uuids.d, 'decide'), stamp),
      ]);
      store.setMeta('who_migrated', null);
      return store.latest();
    });
    const { tasks } = await body(await api('tasks'));
    const by = (uuid) => tasks.find((t) => t.uuid === uuid);
    expect(by(uuids.a)).toMatchObject({ who: 'agent', assignee: null, tags: ['docs'] });
    expect(by(uuids.o)).toMatchObject({ who: 'person', assignee: 'owner', tags: ['docs'] });
    expect(by(uuids.d)).toMatchObject({ who: 'decision', assignee: null, tags: ['docs'] });
    const { ops } = await readChild(before);
    const of = (uuid) => Object.fromEntries(ops.filter((o) => o.uuid === uuid).map((o) => [o.property, o.value]));
    expect(of(uuids.o)).toEqual({ who: 'person', assignee: 'owner', tag_owner: null, tags: 'docs' });
    const flagged = await inStore(async (store) => store.meta('who_migrated'));
    expect(flagged).toBeTruthy();
  });

  it('maps a tag a Taskwarrior replica adds, and takes it off again', async () => {
    const uuid = crypto.randomUUID();
    const parent = await latestVersion();
    const pushed = await pushOps(
      parent,
      twCreate(uuid, { description: 'From an old habit', tag_owner: 'x', tag_docs: 'x', tags: 'docs,owner' }),
    );
    expect(pushed.status).toBe(200);
    const { task } = await body(await api(`tasks/${uuid}`));
    expect(task).toMatchObject({ who: 'person', assignee: 'owner', tags: ['docs'] });
    // The board's follow-up version, which the replica syncs next.
    const { ops } = await readChild(pushed.headers.get('X-Version-Id'));
    expect(ops.filter((o) => o.uuid === uuid).map((o) => [o.property, o.value])).toEqual(
      expect.arrayContaining([
        ['who', 'person'],
        ['tag_owner', null],
      ]),
    );
  });

  it('takes an older CLI’s tags on add and modify, and stores only who', async () => {
    const made = (await body(await add({ description: 'Old CLI add', tags: ['owner', 'docs'] }))).tasks[0];
    expect(made).toMatchObject({ who: 'person', assignee: 'owner', tags: ['docs'] });
    const changed = (await body(await patch(made.uuid, { addTags: ['agent'], removeTags: ['owner'] }))).task;
    expect(changed).toMatchObject({ who: 'agent', assignee: null, tags: ['docs'] });
  });

  it('offers next only what an agent does, and reads an older CLI’s tags as who', async () => {
    const project = 'compliance';
    const made = (
      await body(
        await add([
          { description: 'For a person', project, horizon: 'now', priority: 'H', who: 'person' },
          { description: 'For a decision', project, horizon: 'now', priority: 'H', who: 'decision' },
          { description: 'For an agent', project, horizon: 'now', priority: 'H', who: 'agent', tags: ['docs'] },
        ]),
      )
    ).tasks;
    const next = async (b) => (await body(await api('next', { method: 'POST', body: { project, ...b } }))).task;
    expect((await next({})).uuid).toBe(made[2].uuid);
    expect((await next({ tags: ['agent'], without: ['decide'] })).uuid).toBe(made[2].uuid);
    expect((await next({ tags: ['agent', 'docs'] })).uuid).toBe(made[2].uuid);
    expect((await next({ who: 'person' })).uuid).toBe(made[0].uuid);
    expect(await next({ tags: ['agent', 'nope'] })).toBeNull();
  });

  it('assigns a person’s task to the owner, or to a member or maintainer of its repository', async () => {
    const repo = await inStore(async (store) => {
      await store.ready();
      const now = Date.now();
      const person = (handle, role) => {
        store.sql.exec(
          'INSERT INTO people (handle, name, webauthn_id, invited_by, created) VALUES (?, ?, ?, ?, ?)',
          handle,
          handle,
          `wa-${handle}`,
          'owner',
          now,
        );
        if (role) store.sql.exec('INSERT INTO grants (handle, repo, role) VALUES (?, ?, ?)', handle, '*', role);
      };
      person('mia', 'member');
      person('max', 'maintainer');
      person('val', 'viewer');
      person('nil', null);
      return store.defaultRepoSlug();
    });
    const assign = async (assignee) =>
      body(await add({ description: `For ${assignee}`, who: 'person', assignee }));
    expect((await assign('owner')).status).toBe(201);
    expect((await assign('mia')).tasks[0]).toMatchObject({ who: 'person', assignee: 'mia' });
    expect((await assign('max')).status).toBe(201);
    const viewer = await assign('val');
    expect(viewer.status).toBe(400);
    expect(viewer.error).toBe(
      `val is a viewer in ${repo}: a person's task goes to a member or a maintainer there, or the owner`,
    );
    expect((await assign('nil')).error).toMatch(/has no role/);
    expect((await assign('nobody')).error).toMatch(/nobody on the board has the handle nobody/);
    const open = (await body(await add({ description: 'Anyone’s', who: 'person' }))).tasks[0];
    expect(open).toMatchObject({ who: 'person', assignee: null });
    expect((await body(await patch(open.uuid, { assignee: 'val' }))).status).toBe(400);
    expect((await body(await patch(open.uuid, { assignee: 'mia' }))).task.assignee).toBe('mia');
  });

  it('shows who does it changing in Activity', async () => {
    const made = (await body(await add({ description: 'Watch me', project: 'ops', who: 'agent' }))).tasks[0];
    await patch(made.wid, { who: 'person', assignee: 'owner' });
    const { events } = await body(await api('activity?limit=5'));
    const mine = events.find((e) => e.task.uuid === made.uuid);
    expect(mine.changes).toEqual([{ kind: 'changed', fields: ['who does it', 'assignee'] }]);
  });
});
