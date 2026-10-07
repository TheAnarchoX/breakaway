import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { api } from './helpers.js';

// BRK-274: agents plan the roadmap (features' releases, titles, and briefs, pulls, ideas, and priority), every change
// kept with its agent and before and after, and the owner undoes one with a press.
const body = async (res) => ({ status: res.status, ...(await res.json()) });
const make = async (fields = {}) =>
  (await body(await api('tasks', { method: 'POST', body: [{ description: 'A task', project: 'ops', ...fields }] })))
    .tasks[0];
const edit = async (ref, changes) => body(await api(`tasks/${ref}`, { method: 'PATCH', body: changes }));
const task = async (ref) => (await body(await api(`tasks/${ref}`))).task;
const feature = async (slug) => (await body(await api(`features/${slug}`))).feature;
const changeFeature = async (slug, changes) => body(await api(`features/${slug}`, { method: 'PATCH', body: changes }));
const planned = async () =>
  (await body(await api('activity?limit=200'))).events.filter((e) => e.changes[0]?.kind === 'agent_planned');

/** The owner's press on the signed-in web board. */
async function undo(id) {
  const login = await SELF.fetch(`${ORIGIN}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: TEST_API_TOKEN }),
  });
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  return body(
    await SELF.fetch(`${ORIGIN}/api/planning/${id}/undo`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: '{}',
    }),
  );
}

/** A general agent holding its task, as the board starts one. */
async function generalAgent() {
  const own = await make({ description: 'Plan the roadmap', project: undefined, tags: ['agent', 'general'] });
  const name = `claude-${own.uuid.slice(0, 8)}`;
  expect((await api(`tasks/${own.uuid}/claim`, { method: 'POST', body: { agent: name } })).status).toBe(200);
  return { own, name };
}

describe('agents plan features (BRK-274)', () => {
  it('aims a feature at a release, retitles it, and the owner undoes it in one press', async () => {
    await api('features', { method: 'POST', body: { slug: 'captaincy', title: 'Captaincy' } });
    const res = await changeFeature('captaincy', { release: '2.1.0', title: 'The road captain', by: 'claude-x-1' });
    expect(res.status).toBe(200);
    expect(res.feature).toMatchObject({ release: '2.1.0', title: 'The road captain', editedBy: 'claude-x-1' });

    const page = await feature('captaincy');
    expect(page.planning).toHaveLength(1);
    const [change] = page.planning;
    expect(change).toMatchObject({ agent: 'claude-x-1', kind: 'feature', undone: null });
    expect(change.changes).toEqual([
      { field: 'title', name: 'title', before: 'Captaincy', after: 'The road captain' },
      { field: 'release', name: 'release', before: null, after: '2.1.0' },
    ]);
    const events = await planned();
    expect(events[0].changes[0]).toMatchObject({ id: change.id, by: 'claude-x-1', of: 'feature' });

    // Only the signed-in web board undoes it.
    const token = await body(await api(`planning/${change.id}/undo`, { method: 'POST', body: {} }));
    expect(token.status).toBe(403);
    const undone = await undo(change.id);
    expect(undone.status).toBe(200);
    expect(undone.change.undone).toMatchObject({ by: 'owner' });
    expect(await feature('captaincy')).toMatchObject({ release: null, title: 'Captaincy' });
    expect((await undo(change.id)).status).toBe(409);
    expect((await undo(99999)).status).toBe(404);
  });

  it('keeps an agent’s release on a new feature, and refuses to undo what changed since', async () => {
    const added = await body(
      await api('features', { method: 'POST', body: { slug: 'conduct', release: '2.2.0', by: 'claude-x-1' } }),
    );
    expect(added.status).toBe(201);
    expect(added.feature.release).toBe('2.2.0');
    const [change] = (await feature('conduct')).planning;
    expect(change.changes).toEqual([{ field: 'release', name: 'release', before: null, after: '2.2.0' }]);
    await changeFeature('conduct', { release: '2.3.0' });
    const refused = await undo(change.id);
    expect(refused.status).toBe(409);
    expect(refused.error).toMatch(/release has changed since claude-x-1/u);
    expect((await feature('conduct')).release).toBe('2.3.0');
  });

  it('leaves shipping, planned dates, and deleting to the owner', async () => {
    await api('features', { method: 'POST', body: { slug: 'owners', title: 'Owners' } });
    for (const changes of [{ state: 'shipped' }, { plannedStart: '2026-11-01' }]) {
      const res = await changeFeature('owners', { ...changes, by: 'claude-x-1' });
      expect(res.status, JSON.stringify(changes)).toBe(403);
    }
    expect((await body(await api('features/owners', { method: 'DELETE', body: { by: 'claude-x-1' } }))).status).toBe(
      403,
    );
    // The owner's own changes aren't kept: nothing to undo.
    await changeFeature('owners', { release: '3.0.0' });
    expect((await feature('owners')).planning).toEqual([]);
  });

  it('pulls a release into next, and undoing puts each task back where it was', async () => {
    await api('features', { method: 'POST', body: { slug: 'runners', title: 'Runners', release: '4.0.0' } });
    const a = await make({ horizon: 'later', tags: ['runners'] });
    const b = await make({ horizon: 'now', tags: ['runners'] });
    const res = await body(
      await api('releases/4.0.0/pull', { method: 'POST', body: { into: 'next', by: 'claude-x-1' } }),
    );
    expect(res.status).toBe(200);
    expect(res.tasks.map((t) => t.wid)).toEqual([a.wid]);
    expect((await task(a.wid)).horizon).toBe('next');
    const [change] = (await feature('runners')).planning;
    expect(change).toMatchObject({ kind: 'pull', release: '4.0.0', into: 'next' });
    expect(change.tasks).toEqual([expect.objectContaining({ wid: a.wid, before: 'later' })]);
    expect((await undo(change.id)).status).toBe(200);
    expect((await task(a.wid)).horizon).toBe('later');
    expect((await task(b.wid)).horizon).toBe('now');
  });
});

describe('agents plan ideas and priority (BRK-274)', () => {
  it('tags an idea with a feature, sets its horizon, priority, and dependencies, noted and undoable', async () => {
    const { own, name } = await generalAgent();
    await api('features', { method: 'POST', body: { slug: 'studio', title: 'Studio' } });
    const idea = await make({ project: 'ideas', brief: 'An idea.', by: 'owner', horizon: 'later' });
    const blocker = await make({ description: 'Blocker' });
    const res = await edit(idea.wid, {
      addTags: ['studio'],
      horizon: 'next',
      priority: 'H',
      addDepends: [blocker.wid],
      by: name,
    });
    expect(res.status).toBe(200);
    expect(res.task).toMatchObject({ horizon: 'next', priority: 'H', tags: ['studio'] });
    expect(res.task.comments.at(-1).text).toBe(
      `Changed by ${own.uuid.slice(0, 8)}: horizon, priority, tags, dependencies.`,
    );
    // It shows on the feature its tag put the idea in, and in Activity with the idea.
    const [change] = (await feature('studio')).planning;
    expect(change).toMatchObject({ agent: name, kind: 'task', task: { wid: idea.wid } });
    expect(change.changes).toEqual(
      expect.arrayContaining([
        { field: 'horizon', name: 'horizon', before: 'later', after: 'next' },
        { field: 'priority', name: 'priority', before: '', after: 'H' },
        { field: 'tags', name: 'tags', added: ['studio'], removed: [] },
        { field: 'depends', name: 'dependencies', added: [blocker.wid], removed: [] },
      ]),
    );
    expect((await planned()).find((e) => e.id === `pl${change.id}`).task.wid).toBe(idea.wid);

    expect((await undo(change.id)).status).toBe(200);
    const back = await task(idea.wid);
    expect(back).toMatchObject({ horizon: 'later', priority: '', tags: [], depends: [] });
    expect(back.comments.at(-1).text).toBe(`You undid ${name}’s change: horizon, priority, tags, dependencies.`);
  });

  it('never rewrites, finishes, or deletes an idea, or gives it a tag that isn’t a feature', async () => {
    const { name } = await generalAgent();
    const idea = await make({ project: 'ideas', brief: 'An idea.', by: 'owner', tags: ['horizon-auto'] });
    for (const changes of [
      { brief: 'Rewritten.' },
      { done_when: 'Shipped.' },
      { project: 'ops' },
      { status: 'completed' },
      { status: 'deleted' },
      { addTags: ['not-a-feature'] },
      { removeTags: ['horizon-auto'] },
      { autostart: 'yes' },
    ]) {
      const res = await edit(idea.wid, { ...changes, by: name });
      expect(res.status, JSON.stringify(changes)).toBe(403);
      expect(res.error).toMatch(/ping/u);
    }
    expect(await task(idea.wid)).toMatchObject({ brief: 'An idea.', status: 'pending', tags: ['horizon-auto'] });
  });

  it('sets the priority of an unclaimed open task in its repository, and the owner undoes it', async () => {
    const { name } = await generalAgent();
    const target = await make({ priority: 'L' });
    const res = await edit(target.wid, { priority: 'H', by: name });
    expect(res.status).toBe(200);
    const event = (await planned()).find((e) => e.task?.wid === target.wid);
    expect(event.changes[0].changes).toEqual([{ field: 'priority', name: 'priority', before: 'L', after: 'H' }]);
    // Someone changed it since: undo says so and leaves it.
    await edit(target.wid, { priority: 'M' });
    expect((await undo(event.changes[0].id)).status).toBe(409);
    expect((await task(target.wid)).priority).toBe('M');

    const claimed = await make();
    await api(`tasks/${claimed.wid}/claim`, { method: 'POST', body: { agent: 'claude-other' } });
    expect((await edit(claimed.wid, { priority: 'H', by: name })).status).toBe(403);
  });

  it('keeps no record of an agent’s changes to its own work', async () => {
    const { own, name } = await generalAgent();
    const before = (await planned()).length;
    await edit(own.uuid, { priority: 'H', by: name });
    const made = await make({ description: 'Made by the agent', brief: 'Mine.', by: name });
    await edit(made.wid, { horizon: 'next', by: name });
    expect((await planned()).length).toBe(before);
  });
});
