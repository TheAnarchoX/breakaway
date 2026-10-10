import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const enc = encodeURIComponent;
const feature = async (slug) => body(await api(`features/${slug}`));
const claim = (wid, agent) => api(`tasks/${wid}/claim`, { method: 'POST', body: { agent } });
const post = async (peloton, input) => body(await api(`peloton/${enc(peloton)}`, { method: 'POST', body: input }));

describe('a feature page’s overview (WEB-118)', () => {
  let repo;
  let spy;
  beforeAll(async () => {
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 404 }));
    const created = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'Lay the track', project: 'ops', who: 'agent', tags: ['relay'], horizon: 'now' },
          { description: 'Paint the lines', project: 'ops', who: 'agent', tags: ['relay'], horizon: 'now' },
          { description: 'Open the gates', project: 'ops', who: 'agent', tags: ['relay'], horizon: 'now' },
          { description: 'Elsewhere', project: 'ops', who: 'agent', horizon: 'now' },
        ],
      }),
    );
    expect(created.tasks.map((t) => t.wid)).toEqual(['OPS-1', 'OPS-2', 'OPS-3', 'OPS-4']);
    repo = created.tasks[0].repo;
    expect((await api('features', { method: 'POST', body: { slug: 'relay' } })).status).toBe(201);
  });
  afterAll(() => spy.mockRestore());

  it('has no riders while nobody holds its tasks', async () => {
    const res = await feature('relay');
    expect(res.status).toBe(200);
    expect(res.feature.riders).toEqual([]);
  });

  it('lists the agents holding its open tasks, each with its last post on any peloton', async () => {
    expect((await claim('OPS-1', 'claude-ops-1')).status).toBe(200);
    expect((await claim('OPS-2', 'claude-ops-2')).status).toBe(200);
    expect((await claim('OPS-4', 'claude-ops-4')).status).toBe(200);
    expect((await post(repo, { agent: 'claude-ops-1', kind: 'checkin', text: 'On src/track.js' })).status).toBe(201);
    expect((await post(repo, { agent: 'claude-ops-1', kind: 'step', text: 'Track laid' })).status).toBe(201);
    expect((await post(repo, { agent: 'claude-ops-4', kind: 'checkin', text: 'Not in the feature' })).status).toBe(201);
    const res = await feature('relay');
    expect(res.feature.riders).toEqual([
      {
        uuid: expect.any(String),
        wid: 'OPS-1',
        agent: 'claude-ops-1',
        last: expect.objectContaining({ kind: 'step', text: 'Track laid', task: 'OPS-1', at: expect.any(String) }),
      },
      { uuid: expect.any(String), wid: 'OPS-2', agent: 'claude-ops-2', last: null },
    ]);
  });

  it('drops a rider once its task is done', async () => {
    expect(
      (await api('tasks/OPS-2', { method: 'PATCH', body: { status: 'completed', by: 'claude-ops-2' } })).status,
    ).toBe(200);
    const res = await feature('relay');
    expect(res.feature.riders.map((r) => r.wid)).toEqual(['OPS-1']);
  });
});
