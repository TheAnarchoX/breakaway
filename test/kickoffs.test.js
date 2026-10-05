import { SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import {
  checkName,
  checkPitch,
  createUrl,
  firstFree,
  freeSlug,
  githubOf,
  kickoffIdea,
  prefixCandidates,
  suggestName,
} from '../src/kickoff.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const PITCH = 'A diary for my plants\nI keep forgetting when I watered the fern. Photos of each plant, and a reminder.';
// The smallest PNG there is: its signature and an empty IHDR are enough for the board's check.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

describe('kickoffs, the pure parts', () => {
  it('suggests a name from the pitch’s first line, without the filler words', () => {
    expect(suggestName(PITCH)).toBe('diary-plants');
    expect(suggestName('\n\n  I want to build a QR code for room links')).toBe('qr-code-room');
    expect(suggestName('A thing')).toBe('a-thing');
    expect(suggestName('!!! ???')).toBeNull();
  });

  it('checks a pitch and a name', () => {
    expect(checkPitch('  Plants  ')).toBe('Plants');
    expect(() => checkPitch('   ')).toThrow(/say what you want to make/);
    expect(() => checkPitch('x'.repeat(4001))).toThrow(/up to 4000/);
    expect(checkName(' plant diary ')).toBe('plant-diary');
    expect(() => checkName('plant/diary')).toThrow(/letters, digits/);
    expect(() => checkName('123')).toThrow(/needs a letter/);
  });

  it('suggests prefixes from the name, never the shared ones, and the next free one on a clash', () => {
    expect(prefixCandidates('plant-diary').slice(0, 3)).toEqual(['PLN', 'PLA', 'PLT']);
    expect(prefixCandidates('qr-code-room')[0]).toBe('QCR');
    expect(prefixCandidates('run')).not.toContain('RUN');
    expect(prefixCandidates('idea-board').every((p) => p !== 'IDEA')).toBe(true);
    expect(prefixCandidates('x')).toEqual(['XXX']);
    expect(prefixCandidates('ab').length).toBeGreaterThan(0);
    expect(firstFree(['PLN', 'PLA'], (p) => p === 'PLN')).toBe('PLA');
    expect(freeSlug('plants', (s) => ['plants', 'plants-2'].includes(s))).toBe('plants-3');
  });

  it('gives github.com’s own form, private, filled in', () => {
    const url = new URL(createUrl({ name: 'plant-diary', pitch: PITCH }));
    expect(url.origin + url.pathname).toBe('https://github.com/new');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      name: 'plant-diary',
      visibility: 'private',
      description: 'A diary for my plants',
    });
    expect(new URL(createUrl({ name: 'x', github: 'acme/plant-diary' })).searchParams.get('owner')).toBe('acme');
    expect(githubOf('https://github.com/acme/plant-diary.git')).toBe('acme/plant-diary');
    expect(githubOf('acme')).toBeNull();
  });

  it('makes the IDEA from the pitch, word for word', () => {
    expect(kickoffIdea({ pitch: PITCH, slug: 'plant-diary' })).toEqual({
      description: 'A diary for my plants',
      brief: PITCH,
      project: 'ideas',
      repo: 'plant-diary',
      horizon: 'next',
      tags: ['agent', 'idea', 'kickoff-project'],
    });
  });
});

/** A pretend GitHub that knows acme/plant-diary and acme/herb-log, installed, and records any write. */
const gh = { writes: [] };
function mockGitHub() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const reply = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const path = url.pathname;
    const method = init.method ?? 'GET';
    if (url.host !== 'api.github.com') throw new Error(`unexpected fetch to ${url}`);
    if (method !== 'GET' && !path.endsWith('/access_tokens')) {
      gh.writes.push([method, path]);
      return reply({ message: 'no writes here' }, 500);
    }
    const repo = /^\/repos\/acme\/(plant-diary|herb-log)(\/.*)?$/u.exec(path);
    if (path === '/app')
      return reply({ id: 424242, slug: 'widgets-tasks', name: 'widgets tasks', html_url: 'https://github.com/apps/x' });
    if (path === '/app/installations/91/access_tokens')
      return reply({ token: 'ghs_kickoff', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (path === '/rate_limit')
      return reply({ resources: { core: { limit: 5000, remaining: 4999, reset: 1_790_000_000 } } });
    if (repo && repo[2] === '/installation')
      return reply({
        id: 91,
        permissions: {
          metadata: 'read',
          contents: 'write',
          pull_requests: 'write',
          checks: 'read',
          statuses: 'read',
          actions: 'write',
          deployments: 'read',
          vulnerability_alerts: 'read',
        },
        suspended_at: null,
        html_url: 'https://github.com/settings/installations/91',
      });
    if (repo && !repo[2])
      return reply({ full_name: `acme/${repo[1]}`, default_branch: 'main', allow_auto_merge: true });
    return reply({ message: 'Not Found' }, 404);
  });
}

describe('kickoffs on the board (IDEA-26)', () => {
  let spy;
  let cookie;
  beforeAll(async () => {
    spy = mockGitHub();
    const res = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    cookie = res.headers.get('Set-Cookie').split(';')[0];
  });
  afterAll(() => spy.mockRestore());

  /** The owner on the signed-in web board. */
  const owner = (path, { method = 'GET', body: sent } = {}) =>
    SELF.fetch(`${ORIGIN}/api/${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: sent === undefined ? undefined : JSON.stringify(sent),
    });
  const upload = (id, bytes, headers = { Cookie: cookie, Origin: ORIGIN }) =>
    SELF.fetch(`${ORIGIN}/api/kickoffs/${id}/images`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'image/png', 'X-Attachment-Name': 'fern.png' },
      body: bytes,
    });
  const allTasks = async () => (await body(await api('tasks?status=all'))).tasks;
  let plant;

  it('refuses an agent’s request to write, and the bearer token only reads', async () => {
    const viaToken = await body(await api('kickoffs', { method: 'POST', body: { pitch: PITCH } }));
    expect(viaToken.status).toBe(403);
    expect(viaToken.error).toMatch(/only the signed-in web board/);
    const agent = await body(await owner('kickoffs', { method: 'POST', body: { pitch: PITCH, by: 'claude-brk-1' } }));
    expect(agent.status).toBe(403);
    expect(agent.error).toMatch(/only the owner/);
    expect(await body(await api('kickoffs'))).toEqual({ status: 200, kickoffs: [], app: true });
  });

  it('checks the form as it’s typed and saves nothing', async () => {
    const dry = await body(await owner('kickoffs', { method: 'POST', body: { pitch: PITCH, dryRun: true } }));
    expect(dry).toMatchObject({
      status: 200,
      dryRun: true,
      kickoff: { name: 'diary-plants', slug: 'diary-plants', areas: [{ project: 'app', prefix: 'DRY' }] },
    });
    // A prefix another repository has is the clash registering would give.
    const clash = await body(
      await owner('kickoffs', { method: 'POST', body: { pitch: PITCH, areas: ['app:PRD'], dryRun: true } }),
    );
    expect(clash.status).toBe(400);
    expect(clash.error).toMatch(/PRD already belongs to widgets/);
    expect((await body(await owner('kickoffs', { method: 'POST', body: { pitch: '  ' } }))).status).toBe(400);
    expect((await body(await api('kickoffs'))).kickoffs).toEqual([]);
  });

  it('saves a kickoff with the name, slug, and prefix suggested, and the next free ones for another', async () => {
    const made = await body(await owner('kickoffs', { method: 'POST', body: { pitch: PITCH, name: 'plant diary' } }));
    expect(made.status).toBe(201);
    plant = made.kickoff;
    expect(plant).toMatchObject({
      pitch: PITCH,
      name: 'plant-diary',
      slug: 'plant-diary',
      areas: [{ project: 'app', prefix: 'PLN', name: 'app' }],
      github: null,
      registered: false,
      idea: null,
      step: 'create',
      images: [],
    });
    expect(plant.links.create).toBe(
      'https://github.com/new?name=plant-diary&visibility=private&description=A%20diary%20for%20my%20plants',
    );
    // Another kickoff with the same name doesn't take what this one will register.
    const again = await body(
      await owner('kickoffs', { method: 'POST', body: { pitch: PITCH, name: 'plant-diary', dryRun: true } }),
    );
    expect(again.kickoff).toMatchObject({ slug: 'plant-diary-2', areas: [{ prefix: 'PLA' }] });
    const taken = await body(
      await owner('kickoffs', { method: 'POST', body: { pitch: PITCH, slug: 'plant-diary', dryRun: true } }),
    );
    expect(taken.error).toMatch(/another kickoff, plant-diary, will register the slug plant-diary/);
  });

  it('keeps up to 4 images, the owner’s to add and delete', async () => {
    expect((await upload(plant.id, PNG, { Authorization: `Bearer ${TEST_API_TOKEN}` })).status).toBe(403);
    expect((await body(await upload(plant.id, new TextEncoder().encode('<svg/>')))).error).toMatch(/isn't a PNG/);
    const first = await body(await upload(plant.id, PNG));
    expect(first).toMatchObject({ status: 201, attachment: { name: 'fern.png', type: 'image/png' } });
    for (let i = 0; i < 3; i++) expect((await upload(plant.id, PNG)).status).toBe(201);
    expect((await body(await upload(plant.id, PNG))).error).toMatch(/a kickoff can hold 4 images/);
    // The bearer token's image route can't delete a kickoff's; the owner's can.
    expect((await api(`attachments/${first.attachment.id}`, { method: 'DELETE' })).status).toBe(404);
    const images = (await body(await api(`kickoffs/${plant.id}`))).kickoff.images;
    expect(images).toHaveLength(4);
    expect((await owner(`kickoffs/${plant.id}/images/${images[3].id}`, { method: 'DELETE' })).status).toBe(200);
    // It's read like any image.
    const served = await api(`attachments/${first.attachment.id}`);
    expect(served.headers.get('Content-Type')).toBe('image/png');
  });

  it('lists and resumes it, with the wizard’s own steps for the same repository', async () => {
    const listed = await body(await api('kickoffs'));
    expect(listed.kickoffs.map((k) => k.id)).toEqual([plant.id]);
    expect(listed.app).toBe(true);
    // Before it has a GitHub name, nothing is done yet.
    const fresh = await body(await api(`kickoffs/${plant.id}`));
    expect(fresh).toMatchObject({ now: 'create', done: false, routine: { connected: false, source: null } });
    expect(fresh.promptPath).toMatch(/\.md$/u);
    expect(fresh.steps.map((s) => s.id)).toEqual([
      'create',
      'install',
      'register',
      'init',
      'deploys',
      'prompt',
      'routine',
      'connect',
      'task',
      'agent',
    ]);

    // Changing the name moves the suggestions with it; changing the GitHub name keeps them.
    const renamed = await body(await owner(`kickoffs/${plant.id}`, { method: 'PATCH', body: { name: 'fern-log' } }));
    expect(renamed.kickoff).toMatchObject({ name: 'fern-log', slug: 'fern-log', areas: [{ prefix: 'FRN' }] });
    expect((await api(`kickoffs/${plant.id}`, { method: 'PATCH', body: { name: 'x' } })).status).toBe(403);
    expect(
      (await body(await owner(`kickoffs/${plant.id}`, { method: 'PATCH', body: { github: 'nope' } }))).status,
    ).toBe(400);
    const named = await body(
      await owner(`kickoffs/${plant.id}`, {
        method: 'PATCH',
        body: { name: 'plant-diary', github: 'acme/plant-diary' },
      }),
    );
    expect(named.kickoff).toMatchObject({
      github: 'acme/plant-diary',
      slug: 'plant-diary',
      areas: [{ prefix: 'PLN' }],
    });
    expect(new URL(named.kickoff.links.create).searchParams.get('owner')).toBe('acme');

    const kickoff = await body(await api(`kickoffs/${plant.id}?check=1`));
    const wizard = await body(await api('repos/setup?github=acme/plant-diary&check=1'));
    expect(kickoff.steps).toEqual(wizard.steps);
    expect(kickoff.now).toBe(wizard.now);
    // What the Kickoff view needs for its links and its routine guide: the wizard's own facts.
    expect(kickoff.app).toEqual(wizard.app);
    expect(kickoff.app).toMatchObject({ slug: 'widgets-tasks' });
    expect(kickoff.routine).toEqual(wizard.routine);
    expect(kickoff.routine).toEqual({ connected: false, source: null });
    expect(kickoff.promptPath).toBe(wizard.promptPath);
    expect(kickoff.now).toBe('register');
    expect(kickoff.kickoff.step).toBe('register');
  });

  it('makes its IDEA in the new repository when it’s registered, and writes nothing anywhere else', async () => {
    const before = await allTasks();
    expect((await api(`kickoffs/${plant.id}/register`, { method: 'POST', body: {} })).status).toBe(403);
    const registered = await body(await owner(`kickoffs/${plant.id}/register`, { method: 'POST', body: {} }));
    expect(registered.status).toBe(201);
    expect(registered.repo).toMatchObject({ slug: 'plant-diary', github: 'acme/plant-diary', name: 'plant-diary' });
    expect(registered.repo.areas).toEqual([{ project: 'app', prefix: 'PLN', name: 'app' }]);
    expect(registered.kickoff).toMatchObject({ registered: true, idea: { wid: 'IDEA-1' } });

    const after = await allTasks();
    expect(after).toHaveLength(before.length + 1);
    const idea = (await body(await api('tasks/IDEA-1'))).task;
    expect(idea).toMatchObject({
      description: 'A diary for my plants',
      brief: PITCH,
      project: 'ideas',
      repo: 'plant-diary',
      horizon: 'next',
      tags: ['agent', 'idea', 'kickoff-project'],
      autostart: false,
      claim: null,
    });
    // Its images went with it.
    const images = (await body(await api('tasks/IDEA-1/attachments'))).attachments;
    expect(images).toHaveLength(3);
    expect((await body(await api(`kickoffs/${plant.id}`))).kickoff.images.map((i) => i.id)).toEqual(
      images.map((i) => i.id),
    );
    // Only GitHub reads: nothing was written to any repository.
    expect(gh.writes).toEqual([]);

    // Its settings are the repository's now.
    const locked = await body(await owner(`kickoffs/${plant.id}`, { method: 'PATCH', body: { name: 'other' } }));
    expect(locked.status).toBe(409);
    expect(locked.error).toMatch(/on the board as plant-diary.*IDEA-1/);
    expect((await body(await api(`kickoffs/${plant.id}`))).kickoff.links.settings).toBe('#/settings/plant-diary');
  });

  it('makes the IDEA however the repository is registered', async () => {
    const herb = (
      await body(
        await owner('kickoffs', {
          method: 'POST',
          body: { pitch: 'Herb log\nWhat I planted and when.', github: 'acme/herb-log' },
        }),
      )
    ).kickoff;
    expect(herb).toMatchObject({ name: 'herb-log', areas: [{ prefix: 'HRB' }] });
    // The owner's CLI registers it with a slug and area of its own: the kickoff takes them.
    const added = await body(
      await api('repos', { method: 'POST', body: { slug: 'herbs', github: 'acme/herb-log', areas: ['garden:HRB'] } }),
    );
    expect(added).toMatchObject({ status: 201, kickoff: herb.id });
    const seen = (await body(await api(`kickoffs/${herb.id}`))).kickoff;
    expect(seen).toMatchObject({
      slug: 'herbs',
      areas: [{ project: 'garden', prefix: 'HRB' }],
      idea: { wid: 'IDEA-2' },
    });
    expect((await body(await api('tasks/IDEA-2'))).task).toMatchObject({
      repo: 'herbs',
      brief: 'Herb log\nWhat I planted and when.',
    });
    // A repository no kickoff named gets no IDEA.
    expect((await allTasks()).filter((t) => t.project === 'ideas')).toHaveLength(2);
  });

  it('stops a kickoff, its waiting images with it, and a finished one leaves the list', async () => {
    const extra = (await body(await owner('kickoffs', { method: 'POST', body: { pitch: 'Bird feeder camera' } })))
      .kickoff;
    const image = (await body(await upload(extra.id, PNG))).attachment;
    expect((await api(`kickoffs/${extra.id}`, { method: 'DELETE' })).status).toBe(403);
    const stopped = await body(await owner(`kickoffs/${extra.id}`, { method: 'DELETE' }));
    expect(stopped).toEqual({ status: 200, stopped: extra.id, registered: null });
    expect((await api(`attachments/${image.id}`)).status).toBe(404);
    expect((await api(`kickoffs/${extra.id}`)).status).toBe(404);

    // A registered one stops too, and says which repository stays on the board.
    expect((await body(await api('kickoffs'))).kickoffs.map((k) => k.name)).toEqual(['plant-diary', 'herb-log']);
    // Its plan merged: the IDEA is done, and the kickoff with it.
    expect((await api('tasks/IDEA-2', { method: 'PATCH', body: { status: 'completed' } })).status).toBe(200);
    expect((await body(await api('kickoffs'))).kickoffs.map((k) => k.name)).toEqual(['plant-diary']);
    // Asked for by its IDEA, a finished one still answers, so its plan's pull request page can lead back (WEB-48).
    const herbIdea = (await body(await api('tasks/IDEA-2'))).task.uuid;
    const byIdea = await body(await api(`kickoffs?idea=${herbIdea}`));
    expect(byIdea.kickoffs).toHaveLength(1);
    expect(byIdea.kickoffs[0]).toMatchObject({ name: 'herb-log', finished: true, idea: { wid: 'IDEA-2' } });
    expect((await body(await api('kickoffs?idea=00000000-0000-4000-8000-000000000000'))).kickoffs).toEqual([]);
    const gone = await body(await owner(`kickoffs/${plant.id}`, { method: 'DELETE' }));
    expect(gone).toMatchObject({ stopped: plant.id, registered: 'plant-diary' });
    expect((await body(await api('tasks/IDEA-1'))).task.status).toBe('pending');
    expect((await body(await api('tasks/IDEA-1/attachments'))).attachments).toHaveLength(3);
  });
});
