import { describe, expect, it } from 'vitest';
import { api } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });

// The roadmap names each feature's, loose release task's, and suggested tag's repositories, so the web app
// can follow the repository switcher (WEB-78).
describe('the roadmap’s repositories', () => {
  it('sets up a second repository, with features in the default (widgets), the other, and both', async () => {
    const repo = { slug: 'gadgets', github: 'acme/gadgets', areas: ['product:GAD'] };
    expect((await api('repos', { method: 'POST', body: repo })).status).toBe(201);
    const res = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'Widget part', project: 'ops', tags: ['agent', 'only-widgets'] },
          { description: 'Gadget part', project: 'product', repo: 'gadgets', tags: ['agent', 'both'] },
          { description: 'Widget half', project: 'ops', tags: ['agent', 'both'] },
          { description: 'Loose gadget fix', project: 'product', repo: 'gadgets', tags: ['agent', 'v1_2-0'] },
          { description: 'A gadget tag', project: 'product', repo: 'gadgets', tags: ['agent', 'gadget-idea'] },
        ],
      }),
    );
    expect(res.tasks.map((t) => t.wid)).toEqual(['OPS-1', 'GAD-1', 'OPS-2', 'GAD-2', 'GAD-3']);
    for (const slug of ['only-widgets', 'both', 'empty'])
      expect((await api('features', { method: 'POST', body: { slug } })).status).toBe(201);
  });

  it('names each feature’s repositories, none for a feature with no tasks', async () => {
    const { features } = await body(await api('features'));
    expect(Object.fromEntries(features.map((f) => [f.slug, f.repos]))).toEqual({
      'only-widgets': ['widgets'],
      both: ['gadgets', 'widgets'],
      empty: [],
    });
  });

  it('names the repository of each loose release task and each suggestion', async () => {
    const roadmap = await body(await api('features'));
    expect(roadmap.releaseTasks).toEqual([
      {
        release: '1.2.0',
        tasks: [expect.objectContaining({ wid: 'GAD-2', repo: 'gadgets' })],
      },
    ]);
    expect(roadmap.suggestions).toEqual([
      { slug: 'gadget-idea', tasks: 1, open: 1, release: null, repos: ['gadgets'] },
    ]);
  });
});
