import { describe, expect, it } from 'vitest';
import { api } from './helpers.js';

// IDEA-30 section 2 (BRK-125): a general agent edits other open tasks in its repository directly, each change noted.
const body = async (res) => ({ status: res.status, ...(await res.json()) });
const make = async (fields = {}) =>
  (await body(await api('tasks', { method: 'POST', body: [{ description: 'A task', project: 'ops', ...fields }] })))
    .tasks[0];
const edit = (ref, changes) => api(`tasks/${ref}`, { method: 'PATCH', body: changes });

/** A general agent holding its task, as the board starts one: tagged general, claimed by claude-<short>. */
async function generalAgent() {
  const own = await make({ description: 'Tidy the ops tasks', project: undefined, tags: ['agent', 'general'] });
  const name = `claude-${own.uuid.slice(0, 8)}`;
  expect((await api(`tasks/${own.uuid}/claim`, { method: 'POST', body: { agent: name } })).status).toBe(200);
  return { own, name };
}

describe('cross-task edits by a general agent', () => {
  it('changes each allowed field of an unclaimed open task, and the board notes it', async () => {
    const { own, name } = await generalAgent();
    const target = await make({ brief: 'Owner wrote this.', by: 'owner', tags: ['agent'] });
    const blocker = await make({ description: 'Blocker' });
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
      tags: ['docs'],
    });
    expect(res.task.dependsOn.map((d) => d.wid)).toEqual([blocker.wid]);
    expect(res.task.comments.at(-1)).toMatchObject({
      by: 'board',
      text: `Changed by ${own.uuid.slice(0, 8)}: description, done when, area, horizon, tags, dependencies.`,
    });
  });

  it('names only the fields it changed, and its task by its work ID once it has one', async () => {
    const { own, name } = await generalAgent();
    const wid = (await body(await edit(own.uuid, { project: 'ops', by: name }))).task.wid;
    const target = await make();
    const res = await body(await edit(target.wid, { horizon: 'later', by: name }));
    expect(res.status).toBe(200);
    expect(res.task.comments.at(-1).text).toBe(`Changed by ${wid}: horizon.`);
    // Its own task isn't a cross-task edit: no note.
    const self = await body(await edit(own.uuid, { horizon: 'now', by: name }));
    expect(self.task.comments).toEqual([]);
  });

  it('refuses a claimed, closed, or idea task', async () => {
    const { name } = await generalAgent();
    const claimed = await make();
    await api(`tasks/${claimed.wid}/claim`, { method: 'POST', body: { agent: 'claude-other' } });
    const claimedRes = await body(await edit(claimed.wid, { horizon: 'next', by: name }));
    expect(claimedRes.status).toBe(403);
    expect(claimedRes.error).toMatch(/unclaimed.*claude-other/);

    const closed = await make();
    await api(`tasks/${closed.wid}/done`, { method: 'POST', body: {} });
    const closedRes = await body(await edit(closed.wid, { brief: 'x', by: name }));
    expect(closedRes.status).toBe(403);
    expect(closedRes.error).toMatch(/only open tasks/);

    const idea = await make({ project: 'ideas', brief: 'An idea.', by: 'owner' });
    const ideaRes = await body(await edit(idea.wid, { brief: 'Rewritten.', by: name }));
    expect(ideaRes.status).toBe(403);
    expect(ideaRes.error).toMatch(/idea/);
    expect((await body(await api(`tasks/${idea.wid}`))).task.brief).toBe('An idea.');
  });

  it('refuses a horizon-* tag, autostart, a decision, and any other field', async () => {
    const { name } = await generalAgent();
    const target = await make({ tags: ['horizon-auto'] });
    for (const changes of [
      { addTags: ['horizon-now'] },
      { removeTags: ['horizon-auto'] },
      { autostart: 'yes' },
      { decision: { questions: [{ id: 'q', type: 'yesno', prompt: 'Ship it?' }] } },
      { priority: 'H' },
      { pr: '12' },
      { project: 'ideas' },
    ]) {
      const res = await body(await edit(target.wid, { ...changes, by: name }));
      expect(res.status, JSON.stringify(changes)).toBe(403);
      expect(res.error).toMatch(/ping/);
    }
    const after = (await body(await api(`tasks/${target.wid}`))).task;
    expect(after).toMatchObject({ tags: ['horizon-auto'], autostart: false, decision: null, priority: '', pr: null });
    expect(after.comments).toEqual([]);
  });

  it('leaves other agents on today’s rule', async () => {
    const owned = await make({ brief: 'Owner wrote this.', by: 'owner' });
    expect((await edit(owned.wid, { brief: 'New.', by: 'claude-a' })).status).toBe(403);
    // A general task its agent no longer holds gives no rights.
    const { own, name } = await generalAgent();
    await api(`tasks/${own.uuid}/claim`, { method: 'POST', body: { agent: 'claude-x', force: true } });
    expect((await edit(owned.wid, { brief: 'New.', by: name })).status).toBe(403);
    // Other fields stay open to any agent, unnoted.
    const res = await body(await edit(owned.wid, { horizon: 'next', priority: 'H', by: 'claude-a' }));
    expect(res.status).toBe(200);
    expect(res.task.comments).toEqual([]);
  });

  it('refuses another repository’s task', async () => {
    const registered = await api('repos', {
      method: 'POST',
      body: { slug: 'gadgets', github: 'acme/gadgets', areas: ['product:GDG'] },
    });
    expect(registered.status).toBe(201);
    const { name } = await generalAgent();
    const there = await make({ repo: 'gadgets', project: 'product' });
    const res = await body(await edit(there.wid, { horizon: 'next', by: name }));
    expect(res.status).toBe(403);
    expect(res.error).toMatch(/own repository.*gadgets/);
  });
});
