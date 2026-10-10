import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { featureIdea, featurePrompt } from '../src/feature-prompt.js';
import { api } from './helpers.js';

// Shape a new feature as an idea (WEB-42) and refine a feature's tasks with an agent (BRK-150).
const body = async (res) => ({ ...(await res.json()), code: res.status });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const fires = [];

function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const reply = (data, status = 200) => Response.json(data, { status });
    if (url.href === FIRE) {
      fires.push(JSON.parse(init.body).text);
      return reply({
        claude_code_session_id: `session_${fires.length}`,
        claude_code_session_url: `https://claude.ai/code/session_${fires.length}`,
      });
    }
    if (url.host !== 'api.github.com') throw new Error(`unexpected fetch to ${url}`);
    return reply({ message: 'Not Found' }, 404);
  });
}

const addFeature = (extra) => api('features', { method: 'POST', body: extra });
const refine = (extra) => api('agents/general', { method: 'POST', body: { force: true, ...extra } });
const add = async (tasks) => (await body(await api('tasks', { method: 'POST', body: tasks }))).tasks;
const count = async () => (await body(await api('tasks?status=all'))).tasks.length;
const features = async () => (await body(await api('features'))).features.map((f) => f.slug);

describe('shape a new feature as an idea (WEB-42)', () => {
  let spy;
  beforeEach(() => {
    spy = mockFetch();
  });
  afterEach(() => spy.mockRestore());

  it('adds the feature and an idea that carries its tag, its brief, and its release, and starts by itself', async () => {
    const res = await body(
      await addFeature({
        slug: 'dark-mode',
        title: 'Dark mode',
        release: '1.4.0',
        brief: 'Let people pick a **dark** theme.',
        shape: { horizon: 'next' },
      }),
    );
    expect(res.code).toBe(201);
    expect(res.feature).toMatchObject({ slug: 'dark-mode', title: 'Dark mode', release: '1.4.0' });
    const idea = res.idea;
    expect(idea).toMatchObject({ project: 'ideas', description: 'Dark mode', autostart: true });
    expect(idea.wid).toMatch(/^IDEA-\d+$/u);
    expect(idea.tags).toEqual(expect.arrayContaining(['idea', 'horizon-next', 'dark-mode']));
    expect(idea.who).toBe('agent');
    expect(idea.brief).toMatch(/^Let people pick a \*\*dark\*\* theme\.\n\n## The feature\n/u);
    expect(idea.brief).toContain('Dark mode (+dark-mode), aimed at release 1.4.0');
    expect(idea.brief).toContain('give each one --tag dark-mode');
    expect(idea.brief).toContain('its tasks go out in 1.4.0');
    // The idea is in the feature, so its page shows the shaping.
    const detail = await body(await api('features/dark-mode'));
    expect(detail.feature.tasks.map((t) => t.uuid)).toEqual([idea.uuid]);
  });

  it('lets the agent pick the horizon by default', async () => {
    const res = await body(await addFeature({ slug: 'search', brief: 'Find tasks by text.', shape: true }));
    expect(res.code).toBe(201);
    expect(res.feature.release).toBeNull();
    expect(res.idea.tags).toContain('horizon-auto');
    expect(res.idea.description).toBe('Search');
    expect(res.idea.brief).toContain('Search (+search), with no release yet');
  });

  it('refuses without a brief, with picked tasks, a horizon it doesn’t know, or anyone else, and makes nothing', async () => {
    const before = await count();
    const [t] = await add([{ description: 'Loose', project: 'ops' }]);
    const empty = await body(await addFeature({ slug: 'no-brief', shape: true }));
    expect(empty).toMatchObject({ code: 400, error: expect.stringMatching(/write the brief first/u) });
    const picked = await body(await addFeature({ slug: 'picked', brief: 'x', tasks: [t.uuid], shape: true }));
    expect(picked).toMatchObject({ code: 400, error: expect.stringMatching(/has its tasks already/u) });
    const horizon = await body(await addFeature({ slug: 'soon', brief: 'x', shape: { horizon: 'soon' } }));
    expect(horizon).toMatchObject({ code: 400, error: expect.stringMatching(/the horizon is/u) });
    const agent = await body(await addFeature({ slug: 'mine', brief: 'x', shape: true, by: 'claude-ops-1' }));
    expect(agent.code).toBe(403);
    expect(await count()).toBe(before + 1);
    expect(await features()).not.toEqual(expect.arrayContaining(['no-brief', 'picked', 'soon', 'mine']));
  });
});

describe('refine a feature with an agent (BRK-150)', () => {
  let spy;
  beforeEach(() => {
    spy = mockFetch();
  });
  afterEach(() => spy.mockRestore());

  it('writes the prompt from the feature and its tasks, tags it with the feature, and starts a general agent', async () => {
    await addFeature({ slug: 'inbox', title: 'A calmer inbox', brief: 'Fewer, better pings.' });
    const [open, done, claimed] = await add([
      { description: 'Sort by age', project: 'ops', who: 'agent', tags: ['inbox'] },
      { description: 'Show the age', project: 'ops', tags: ['inbox'] },
      { description: 'Mute a task', project: 'ops', who: 'agent', tags: ['inbox'] },
      { description: 'Unrelated', project: 'ops', who: 'agent' },
    ]);
    await api(`tasks/${done.wid}/done`, { method: 'POST' });
    await api(`tasks/${claimed.wid}/claim`, { method: 'POST', body: { agent: 'claude-other' } });
    const res = await body(await refine({ feature: 'inbox', note: 'Split the big ones.' }));
    expect(res.code).toBe(201);
    const t = res.task;
    expect(t).toMatchObject({ wid: null, project: null, horizon: 'now', autostart: true });
    expect(t.description).toBe('Refine the feature: A calmer inbox');
    expect(t.tags).toEqual(['general', 'inbox']);
    expect(t.who).toBe('agent');
    expect(t.brief).toMatch(
      /^The owner wants the tasks of the feature A calmer inbox \(\+inbox\), with no release yet refined\./u,
    );
    expect(t.brief).toContain('The owner’s request\nSplit the big ones.\n\nThe feature’s brief\nFewer, better pings.');
    expect(t.brief).toContain(`- ${open.wid}: Sort by age (open)`);
    expect(t.brief).toContain(`- ${done.wid}: Show the age (done)`);
    expect(t.brief).toContain(`- ${claimed.wid}: Mute a task (open, claimed)`);
    expect(t.brief).not.toContain('Unrelated');
    expect(t.brief).toContain('each with --tag inbox');
    expect(t.brief).toContain('Never set --autostart');
    expect(res.run).toMatchObject({ trigger: 'general', kind: 'general', forced: true });
    expect(fires.at(-1)).toContain('Mode: general');
  });

  it('links to the open one instead of starting a second, and leaves it out of the next prompt', async () => {
    await addFeature({ slug: 'badges', brief: 'Badges on cards.' });
    await add([{ description: 'Draw the badge', project: 'ops', who: 'agent', tags: ['badges'] }]);
    const first = await body(await refine({ feature: 'badges', note: 'Smaller.' }));
    expect(first.code).toBe(201);
    const fired = fires.length;
    const before = await count();
    const again = await body(await refine({ feature: 'badges', note: 'And again' }));
    expect(again).toMatchObject({ code: 200, run: null, already: `${first.task.claim} is on it` });
    expect(again.task.uuid).toBe(first.task.uuid);
    expect(fires.length).toBe(fired);
    expect(await count()).toBe(before);
    await api(`tasks/${first.task.uuid}/release`, { method: 'POST', body: { agent: first.task.claim } });
    const next = await body(await refine({ feature: 'badges', note: 'Once more.' }));
    expect(next.code).toBe(201);
    expect(next.task.uuid).not.toBe(first.task.uuid);
    expect(next.task.brief).not.toContain('Refine the feature');
  });

  it('shows the prompt it would write with dryRun, without a request, and makes nothing', async () => {
    await addFeature({ slug: 'empty-one', title: 'Empty one', release: '2.0.0' });
    const before = await count();
    const fired = fires.length;
    const preview = await body(await refine({ feature: 'empty-one', dryRun: true }));
    expect(preview).toMatchObject({ code: 200, dryRun: true, task: null, already: null, refusal: null });
    expect(preview.title).toBe('Refine the feature: Empty one');
    expect(preview.prompt).toContain('aimed at release 2.0.0');
    expect(preview.prompt).not.toContain('The owner’s request');
    expect(preview.prompt).toContain('- None yet: add the tasks the feature needs.');
    expect(await count()).toBe(before);
    expect(fires.length).toBe(fired);
  });

  it('refuses no request, a prompt of its own, a feature that isn’t there, two sources, and anyone else', async () => {
    await addFeature({ slug: 'refused', brief: 'x' });
    const before = await count();
    const empty = await body(await refine({ feature: 'refused', note: '  ' }));
    expect(empty).toMatchObject({ code: 400, error: expect.stringMatching(/say what to refine/u) });
    const own = await body(await refine({ feature: 'refused', prompt: 'Mine', note: 'x' }));
    expect(own.code).toBe(400);
    const missing = await body(await refine({ feature: 'nope', note: 'x' }));
    expect(missing.code).toBe(404);
    const both = await body(await refine({ feature: 'refused', spec: 'docs/specs/X.md', note: 'x' }));
    expect(both).toMatchObject({ code: 400, error: expect.stringMatching(/only one of them/u) });
    const agent = await refine({ feature: 'refused', note: 'x', by: 'claude-ops-1' });
    expect(agent.status).toBe(403);
    expect(await count()).toBe(before);
  });
});

describe('the words for features', () => {
  it('keeps the refine prompt within a description, and the task list gives way first', () => {
    const tasks = Array.from({ length: 400 }, (_, i) => ({
      ref: `OPS-${i + 1}`,
      description: 'A task with a long enough title to fill the list quickly'.repeat(2),
      status: 'pending',
    }));
    const { brief } = featurePrompt({ slug: 'big', title: 'Big' }, tasks, 'widgets', 'Trim it.');
    expect(brief.length).toBeLessThanOrEqual(10000);
    expect(brief).toContain('npx breakaway features show big lists them all');
    expect(brief).toMatch(/What to do\n/u);
  });

  it('names another repository’s task as such', () => {
    const { brief } = featurePrompt(
      { slug: 'x', title: 'X' },
      [{ ref: 'WEB-1', description: 'Web side', status: 'pending', repo: 'site' }],
      'widgets',
    );
    expect(brief).toContain('- WEB-1: Web side (open, in site)');
  });

  it('puts the owner’s brief first in the idea', () => {
    const { title, brief } = featureIdea({ slug: 'x', title: 'X', brief: 'Mine.', release: null });
    expect(title).toBe('X');
    expect(brief.startsWith('Mine.\n\n## The feature')).toBe(true);
  });
});
