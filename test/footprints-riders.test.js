import { env, runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { besideLines } from '../src/footprint-text.js';
import { firePayload } from '../src/store-agents.js';
import { api } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));
const inStore = (fn) => runInDurableObject(store(), fn);
const enc = encodeURIComponent;

const ADA = 'claude-rd-ada';
const BEA = 'claude-rd-bea';
const CY = 'claude-rd-cy';

const paths = async (wid, payload) => body(await api(`tasks/${wid}/paths`, { method: 'POST', body: payload }));
const post = async (peloton, input) => body(await api(`peloton/${enc(peloton)}`, { method: 'POST', body: input }));
const mine = async (agent) => body(await api(`peloton?agent=${enc(agent)}`));
const hook = async (wid, agent, extra = {}) =>
  body(
    await api(`tasks/${wid}/session`, {
      method: 'POST',
      body: { agent, entries: [{ kind: 'tool', tool: 'Edit', title: 'Edit a file' }], ...extra },
    }),
  );
/** The board's own posts on `peloton`. */
const boardNotes = (peloton) =>
  inStore((s) =>
    s.sql.exec("SELECT * FROM peloton_posts WHERE peloton = ? AND agent = 'board' ORDER BY id", peloton).toArray(),
  );

describe('telling the riders who touches what (IDEA-55 section 4)', () => {
  let a;
  let b;
  let c;
  let repo;
  let spy;
  beforeAll(async () => {
    // Nothing reaches the network.
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 404 }));
    const created = await body(
      await api('tasks', {
        method: 'POST',
        body: [
          { description: 'Rework the widget API', project: 'ops', tags: ['agent'], horizon: 'now', force: true },
          { description: 'Restyle the widget list', project: 'ops', tags: ['agent'], horizon: 'now', force: true },
          { description: 'Document the widgets', project: 'ops', tags: ['agent'], horizon: 'now', force: true },
        ],
      }),
    );
    [a, b, c] = created.tasks.map((t) => t.wid);
    for (const [wid, agent] of [
      [a, ADA],
      [b, BEA],
      [c, CY],
    ])
      expect((await api(`tasks/${wid}/claim`, { method: 'POST', body: { agent } })).status).toBe(200);
    repo = await inStore((s) => s.defaultRepoSlug());
  });
  afterAll(() => spy.mockRestore());

  it('a check-in lists what each rider is changing, and where the new agent’s paths overlap it', async () => {
    expect((await paths(a, { agent: ADA, claim: ['apps/widgets/api/**', 'test/api.test.js'] })).status).toBe(200);
    expect((await post(repo, { agent: ADA, kind: 'checkin', text: 'The widget API' })).status).toBe(201);
    const res = await post(repo, {
      agent: BEA,
      kind: 'checkin',
      text: 'The list view',
      files: ['web/widgets/', 'apps/widgets/api/list.js'],
    });
    expect(res.status).toBe(201);
    // The overlapping path is refused, so the check-in says where it meets Ada's footprint.
    expect(res.paths.refused.map((r) => r.pattern)).toEqual(['apps/widgets/api/list.js']);
    const roster = res.peloton.roster;
    const ada = roster.find((r) => r.agent === ADA);
    expect(ada.changing).toEqual(['apps/widgets/api/**', 'test/api.test.js']);
    expect(ada).not.toHaveProperty('uuid');
    // Claims never overlap (the board refuses the second), so nothing of Bea's meets Ada's yet.
    expect(ada).not.toHaveProperty('overlaps');
    const bea = roster.find((r) => r.agent === BEA);
    expect(bea.changing).toEqual(['web/widgets/']);
    expect(bea).not.toHaveProperty('overlaps');

    // Ada reads the room: Cy hasn't checked in yet.
    const view = (await mine(ADA)).pelotons.find((p) => p.peloton === repo);
    expect(view.roster.map((r) => r.agent)).toEqual([ADA, BEA]);

    await paths(c, { agent: CY, claim: ['docs/widgets.md'] });
    const cy = await post(repo, { agent: CY, kind: 'checkin', text: 'Docs', files: ['docs/'] });
    const seen = Object.fromEntries(cy.peloton.roster.map((r) => [r.agent, r]));
    expect(seen[ADA].overlaps).toBeUndefined();
    expect(seen[CY].changing).toEqual(['docs/widgets.md', 'docs/']);
  });

  it('posts one note on the peloton when an agent changes another’s claimed file, mentioning both, once per pair and path', async () => {
    const before = (await boardNotes(repo)).length;
    const res = await hook(b, BEA, { dirty: ['apps/widgets/api/routes.js', 'web/widgets/list.jsx'] });
    expect(res.status).toBe(201);
    expect(res.footprint.conflicts).toEqual([
      expect.objectContaining({ path: 'apps/widgets/api/routes.js', agent: ADA, task: a, new: true }),
    ]);
    let notes = (await boardNotes(repo)).slice(before);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'note', agent: 'board' });
    expect(notes[0].text).toBe(
      `@${BEA} @${ADA}: both of you are changing \`apps/widgets/api/routes.js\` (${b} and ${a}, which claims \`apps/widgets/api/**\`); agree who goes first.`,
    );
    expect(JSON.parse(notes[0].mentions)).toEqual([BEA, ADA]);

    // The same pair and path again: no second note. Another path: a note of its own.
    await hook(b, BEA, { dirty: ['apps/widgets/api/routes.js'] });
    await paths(b, { agent: BEA, dirty: ['apps/widgets/api/routes.js', 'test/api.test.js'] });
    notes = (await boardNotes(repo)).slice(before);
    expect(notes.map((n) => n.text.match(/`([^`]+)`/u)[1])).toEqual(['apps/widgets/api/routes.js', 'test/api.test.js']);

    // Both agents hear it as a mention.
    const ada = (await mine(ADA)).pelotons.find((p) => p.peloton === repo);
    expect(ada.posts.filter((p) => p.agent === 'board').map((p) => p.mentions)).toEqual([
      [BEA, ADA],
      [BEA, ADA],
    ]);
    // Bea's footprint now holds the file it changed, so reading the room, Bea sees where it meets Ada's.
    const bea = (await mine(BEA)).pelotons.find((p) => p.peloton === repo);
    expect(bea.roster.find((r) => r.agent === ADA).overlaps).toEqual([
      'apps/widgets/api/routes.js',
      'test/api.test.js',
    ]);
    expect(bea.roster.find((r) => r.agent === CY)).not.toHaveProperty('overlaps');
    const marked = await inStore((s) =>
      s.sql.exec('SELECT COUNT(*) AS n FROM path_conflicts WHERE noted IS NULL').one(),
    );
    expect(marked.n).toBe(0);
  });

  it('the other way round is the same pair and path: no second note', async () => {
    const before = (await boardNotes(repo)).length;
    await inStore((s) => {
      // As if Ada had changed web/widgets/list.jsx while Bea held it: flagged, with Bea's own already posted.
      s.sql.exec(
        'INSERT INTO path_conflicts (uuid, path, other, agent, other_agent, pattern, at, noted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        s.resolve(b),
        'web/widgets/x.jsx',
        s.resolve(a),
        BEA,
        ADA,
        'web/widgets/x.jsx',
        Date.now(),
        Date.now(),
      );
      s.sql.exec(
        'INSERT INTO path_conflicts (uuid, path, other, agent, other_agent, pattern, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        s.resolve(a),
        'web/widgets/x.jsx',
        s.resolve(b),
        ADA,
        BEA,
        'web/widgets/',
        Date.now(),
      );
      s.notePathConflicts(s.resolve(a));
    });
    expect((await boardNotes(repo)).length).toBe(before);
  });

  it('names the agents running beside a new one in its start payload, with what each is changing', async () => {
    const riders = await inStore((s) => {
      // Ada and Cy run as agents the board started; Bea's claim is no run.
      for (const [wid, agent] of [
        [a, ADA],
        [c, CY],
      ])
        s.sql.exec(
          "INSERT INTO agent_runs (task, agent, trigger, status, started, kind) VALUES (?, ?, 'manual', 'started', ?, 'build')",
          s.resolve(wid),
          agent,
          Date.now(),
        );
      return {
        forBea: s.ridingBesideFor(s.resolve(b), 'build'),
        forReview: s.ridingBesideFor(s.resolve(b), 'pr-review'),
        forAda: s.ridingBeside(s.resolve(a)),
      };
    });
    // Newest run first, as the board lists its running agents.
    expect(riders.forBea).toEqual([
      { task: c, agent: CY, patterns: ['docs/widgets.md', 'docs/'] },
      { task: a, agent: ADA, patterns: expect.arrayContaining(['apps/widgets/api/**', 'test/api.test.js']) },
    ]);
    expect(riders.forReview).toEqual([]);
    expect(riders.forAda.map((r) => r.task)).toEqual([c]);

    const task = { wid: b, uuid: 'u', description: 'Restyle the widget list' };
    const text = firePayload(task, BEA, 'manual', null, 'build', null, null, 0, null, null, null, null, null, null, [
      { task: 'OPS-12', agent: 'claude-ops-12', patterns: ['src/store-chase.js', 'test/chase.test.js'] },
    ]);
    expect(text).toContain(
      'Riding beside you: OPS-12 (claude-ops-12) is changing src/store-chase.js, test/chase.test.js',
    );
    expect(firePayload(task, BEA, 'manual')).not.toContain('Riding beside you');
  });
});

describe('the start payload’s riders, in words', () => {
  it('one line per rider, up to 8, each with up to 6 patterns', () => {
    expect(besideLines(null)).toEqual([]);
    const many = Array.from({ length: 10 }, (_, i) => ({
      task: `OPS-${i}`,
      agent: `claude-ops-${i}`,
      patterns: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    }));
    const lines = besideLines(many);
    expect(lines).toHaveLength(9);
    expect(lines[0]).toBe('Riding beside you: OPS-0 (claude-ops-0) is changing a, b, c, d, e, f and 1 more');
    expect(lines[8]).toBe('Riding beside you: 2 more agents');
  });
});
