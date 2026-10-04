import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROMPT_PATH, checkRepo, defaultRepo, prefixFor, promptPathOf, stubFor } from '../src/repos.js';
import { pipelineOf } from '../src/release.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';
import { api, latestVersion, pushOps, readChild, twCreate } from './helpers.js';

const json = async (res) => ({ status: res.status, ...(await res.json()) });
const add = (body) => api('repos', { method: 'POST', body });
const modify = (slug, body) => api(`repos/${slug}`, { method: 'PATCH', body });
const create = async (body) => json(await api('tasks', { method: 'POST', body }));

describe('the registry, without the store', () => {
  const widgets = { ...defaultRepo({ TASKS_GITHUB_REPO: 'acme/widgets' }), isDefault: true };

  it('registers widgets with today’s areas, and ideas and routines stay install-wide', () => {
    expect(widgets.areas.map((a) => `${a.project}:${a.prefix}`)).toEqual([
      'product:PRD',
      'brand:BRD',
      'moderation:MOD',
      'ops:OPS',
      'cloud:CLD',
      'debt:DEBT',
      'compliance:CMP',
    ]);
    expect(prefixFor(widgets, 'ops')).toBe('OPS');
    expect(prefixFor(widgets, 'ideas')).toBe('IDEA');
    expect(prefixFor(widgets, 'routines')).toBe('RUN');
    expect(prefixFor(widgets, 'nope')).toBeNull();
    expect(widgets.pipeline).toBeNull(); // its owner sets one, as for any repository (BRK-44)
  });

  it('refuses a prefix or an area that is taken, shared, or malformed', () => {
    const others = [widgets];
    const base = { slug: 'other', github: 'someone/other' };
    expect(() => checkRepo({ ...base, areas: ['product:PRD'] }, { others })).toThrow(/PRD already belongs to widgets/);
    expect(() => checkRepo({ ...base, areas: ['ideas:OIDEA'] }, { others })).toThrow(/shared by the whole install/);
    expect(() => checkRepo({ ...base, areas: ['inbox:IDEA'] }, { others })).toThrow(/shared by the whole install/);
    expect(() => checkRepo({ ...base, areas: ['product:prd1'] }, { others })).toThrow(/capital letters/);
    expect(() => checkRepo({ ...base, areas: ['a:AA', 'b:AA'] }, { others })).toThrow(/given twice/);
    expect(() => checkRepo({ ...base, areas: [] }, { others })).toThrow(/at least one area/);
    expect(() =>
      checkRepo({ ...base, areas: ['x:XX'] }, { others, usedPrefixes: new Map([['XX', 'widgets']]) }),
    ).toThrow(/in use by tasks in widgets/);
    expect(() => checkRepo({ ...base, github: 'acme/WIDGETS', areas: ['x:XX'] }, { others })).toThrow(
      /already registered as widgets/,
    );
    expect(() => checkRepo({ ...base, slug: 'widgets', areas: ['x:XX'] }, { others })).toThrow(/already registered/);
    expect(
      checkRepo(
        { ...base, github: 'https://github.com/someone/other.git', areas: ['product:OPRD:Product'] },
        { others },
      ),
    ).toMatchObject({
      slug: 'other',
      github: 'someone/other',
      name: 'other',
      defaultBranch: 'main',
      areas: [{ project: 'product', prefix: 'OPRD', name: 'Product' }],
    });
  });

  it('keeps a prefix once given, and an area while it has tasks', () => {
    const current = checkRepo({ slug: 'other', github: 'someone/other', areas: ['product:OPRD'] });
    expect(() => checkRepo({ addAreas: ['product:OPR'] }, { current })).toThrow(/a prefix never changes/);
    expect(() =>
      checkRepo({ removeAreas: ['product'], addAreas: ['ops:OOPS'] }, { current, inUse: () => true }),
    ).toThrow(/has tasks/);
    expect(
      checkRepo({ removeAreas: ['product'], addAreas: ['ops:OOPS'] }, { current }).areas.map((a) => a.prefix),
    ).toEqual(['OOPS']);
    expect(() => checkRepo({ slug: 'renamed' }, { current })).toThrow(/keeps its slug/);
  });

  it('keeps where a repository’s agent prompt lives, and fills it into the routine’s stub (CLD-127)', () => {
    expect(promptPathOf(widgets)).toBe(DEFAULT_PROMPT_PATH);
    const current = checkRepo({ slug: 'other', github: 'someone/other', areas: ['product:OPRD'] });
    const set = checkRepo({ routine: { prompt: './agents/prompt.md', max: 1 } }, { current });
    expect(set.routine).toEqual({ prompt: 'agents/prompt.md', max: 1 });
    expect(promptPathOf(set)).toBe('agents/prompt.md');
    expect(checkRepo({ routine: { prompt: null, max: 1 } }, { current }).routine).toEqual({ max: 1 });
    for (const bad of ['/etc/passwd.md', '../other/prompt.md', 'prompt.txt', 'a b.md']) {
      expect(() => checkRepo({ routine: { prompt: bad } }, { current })).toThrow(/routine.prompt/);
    }
    expect(stubFor('Read `<prompt path>` and follow it.', set)).toBe('Read `agents/prompt.md` and follow it.');
    expect(stubFor('Read `<prompt path>`.', widgets)).toBe('Read `tools/tasks/routine-prompt.md`.');
  });
});

describe('repositories on the board', () => {
  it('lists widgets as the default repository', async () => {
    const res = await json(await api('repos'));
    expect(res.status).toBe(200);
    expect(res.default).toBe('widgets');
    expect(res.repos[0]).toMatchObject({
      slug: 'widgets',
      github: 'acme/widgets',
      isDefault: true,
      defaultBranch: 'main',
    });
  });

  it('lets only the owner add or change a repository, and refuses a duplicate prefix', async () => {
    expect(
      (await json(await add({ slug: 'breakaway', github: 'acme/breakaway', areas: ['product:BRK'], by: 'claude-x-1' })))
        .status,
    ).toBe(403);
    const dup = await json(await add({ slug: 'breakaway', github: 'acme/breakaway', areas: ['product:PRD'] }));
    expect(dup.status).toBe(400);
    expect(dup.error).toMatch(/PRD already belongs to widgets/);
    const made = await json(
      await add({
        slug: 'breakaway',
        github: 'acme/breakaway',
        name: 'breakaway',
        areas: ['product:BRK:Product', 'cloud:BCLD:Cloud'],
        by: 'owner',
      }),
    );
    expect(made.status).toBe(201);
    expect(made.repo).toMatchObject({
      slug: 'breakaway',
      isDefault: false,
      pipeline: null,
      areas: [
        { project: 'product', prefix: 'BRK' },
        { project: 'cloud', prefix: 'BCLD' },
      ],
    });
    expect((await json(await add({ slug: 'another', github: 'x/y', areas: ['product:BRK'] }))).error).toMatch(
      /BRK already belongs to breakaway/,
    );
    expect((await json(await modify('breakaway', { addAreas: ['ops:BOPS'], by: 'codex-y' }))).status).toBe(403);
    expect((await json(await modify('nowhere', { addAreas: ['ops:NOPS'] }))).status).toBe(404);
    const changed = await json(
      await modify('breakaway', { addAreas: ['ops:BOPS'], settings: { mergeWhenGreen: false } }),
    );
    expect(changed.repo.areas.map((a) => a.prefix)).toEqual(['BRK', 'BCLD', 'BOPS']);
    expect(changed.repo.settings).toEqual({ mergeWhenGreen: false });
    expect((await json(await api('repos'))).repos.map((r) => r.slug)).toEqual(['widgets', 'breakaway']);
  });

  it('sets a repository’s deploy pipeline for the owner, refuses one pipelineOf would ignore, and clears it (BRK-44)', async () => {
    await add({ slug: 'acme', github: 'acme/gadgets', areas: ['product:ACM'] });
    const pipeline = {
      workers: { staging: 'widgets-staging', production: 'widgets' },
      workflows: { promote: 'promote.yml' },
      deployPaths: './.github/deploy-paths.json',
    };
    expect((await json(await modify('acme', { pipeline, by: 'claude-x-1' }))).status).toBe(403);
    const saved = await json(await modify('acme', { pipeline }));
    expect(saved.status).toBe(200);
    expect(pipelineOf(saved.repo)).toMatchObject({
      staging: 'widgets-staging',
      production: 'widgets',
      promote: 'promote.yml',
      rollback: 'rollback.yml',
      deployPaths: '.github/deploy-paths.json',
      branch: 'main',
    });
    const refused = [
      [{ workers: { staging: 'widgets-staging' } }, /workers.production is required/],
      [{ workflows: {} }, /workers needs staging and production/],
      [{ workers: { staging: 'a b', production: 'widgets' } }, /workers.staging is a Worker name/],
      [
        { workers: { staging: 'a', production: 'b' }, workflows: { promote: '../x' } },
        /workflows.promote is a workflow file name/,
      ],
      [
        { workers: { staging: 'a', production: 'b' }, deployPaths: '/etc/x.json' },
        /deployPaths is the path of a JSON file/,
      ],
      [{ workers: { staging: 'a', production: 'b' }, extra: 1 }, /no "extra"/],
    ];
    for (const [bad, reason] of refused) {
      const res = await json(await modify('acme', { pipeline: bad }));
      expect(res.status).toBe(400);
      expect(res.error).toMatch(reason);
    }
    expect(pipelineOf((await json(await api('repos'))).repos.find((r) => r.slug === 'acme'))).toMatchObject({
      production: 'widgets',
    });
    const cleared = await json(await modify('acme', { pipeline: null }));
    expect(cleared.repo.pipeline).toBeNull();
    expect(pipelineOf(cleared.repo)).toBeNull();
  });

  it('gives a repository’s tasks its own work IDs, and keeps ideas install-wide', async () => {
    const first = await create({ description: 'Breakaway landing page', project: 'product', repo: 'breakaway' });
    expect(first.status).toBe(201);
    expect(first.tasks[0]).toMatchObject({ wid: 'BRK-1', repo: 'breakaway', project: 'product' });
    const second = await create({
      description: 'Breakaway docs',
      project: 'product',
      repo: 'breakaway',
      depends: ['BRK-1'],
    });
    expect(second.tasks[0].wid).toBe('BRK-2');
    // widgets's areas aren't breakaway's, and the other way round.
    const wrong = await create({ description: 'Nope', project: 'brand', repo: 'breakaway' });
    expect(wrong.status).toBe(400);
    expect(wrong.error).toMatch(/project is one of product, cloud, ops, ideas, routines in breakaway/);
    expect((await create({ description: 'Nope', project: 'product', repo: 'nowhere' })).error).toMatch(
      /no repository "nowhere"/,
    );
    expect(
      (await create({ description: 'Nope', project: 'product', repo: 'breakaway', wid: 'PRD-999' })).error,
    ).toMatch(/PRD belongs to widgets/);
    // One IDEA sequence for the whole install, whichever repository an idea is in.
    const before = (await json(await api('tasks?status=all'))).tasks.filter((t) => /^IDEA-/.test(t.wid ?? '')).length;
    const idea = await create({ description: 'An idea for breakaway', project: 'ideas', repo: 'breakaway' });
    expect(idea.tasks[0].wid).toMatch(/^IDEA-\d+$/);
    expect(idea.tasks[0].repo).toBe('breakaway');
    expect(Number(idea.tasks[0].wid.slice(5))).toBeGreaterThan(before);
  });

  it('leaves widgets’s tasks as they are: no repo property, the same IDs', async () => {
    const res = await create({ description: 'A widgets task', project: 'debt' });
    expect(res.tasks[0]).toMatchObject({ repo: 'widgets' });
    expect(res.tasks[0].wid).toMatch(/^DEBT-\d+$/);
    // Taskwarrior never sees a `repo` on it.
    const { ops } = await readChild(await parentOfLatest());
    expect(ops.some((op) => op.property === 'repo')).toBe(false);
    const explicit = await create({ description: 'Also widgets', project: 'debt', repo: 'widgets' });
    expect(explicit.tasks[0].repo).toBe('widgets');
  });

  it('gives a task made in Taskwarrior with a repo its repository’s work ID', async () => {
    const tw = crypto.randomUUID();
    const plain = crypto.randomUUID();
    await pushOps(await latestVersion(), [
      ...twCreate(tw, { description: 'From Taskwarrior in breakaway', project: 'ops', repo: 'breakaway' }),
      ...twCreate(plain, { description: 'From Taskwarrior in widgets', project: 'ops' }),
    ]);
    const a = (await json(await api(`tasks/${tw}`))).task;
    expect(a).toMatchObject({ wid: 'BOPS-1', repo: 'breakaway' });
    const b = (await json(await api(`tasks/${plain}`))).task;
    expect(b.repo).toBe('widgets');
    expect(b.wid).toMatch(/^OPS-\d+$/);
  });

  it('lets dependencies cross repositories, but a task stays in its repository', async () => {
    const sw = await create({ description: 'Needs breakaway first', project: 'cloud', depends: ['BRK-1'] });
    expect(sw.tasks[0].blockedBy.length).toBe(1);
    const wid = sw.tasks[0].wid;
    const moved = await json(await api(`tasks/${wid}`, { method: 'PATCH', body: { repo: 'breakaway' } }));
    expect(moved.status).toBe(400);
    expect(moved.error).toMatch(/stays in its repository/);
    expect(
      (await json(await api(`tasks/${wid}`, { method: 'PATCH', body: { repo: 'widgets', priority: 'L' } }))).task
        .priority,
    ).toBe('L');
    expect((await json(await api('tasks/BRK-2', { method: 'PATCH', body: { project: 'brand' } }))).error).toMatch(
      /project is one of/,
    );
    expect((await json(await api('tasks/BRK-2', { method: 'PATCH', body: { project: 'cloud' } }))).task.project).toBe(
      'cloud',
    );
  });

  it('adds a ping’s proposed task to the pinged task’s repository', async () => {
    const agent = 'claude-brk-1';
    expect((await api('tasks/BRK-1/claim', { method: 'POST', body: { agent } })).status).toBe(200);
    const change = {
      type: 'add',
      ref: 'n1',
      title: 'Follow-up in breakaway',
      horizon: 'next',
      tags: ['agent'],
      brief: 'Why.',
      done_when: 'Done.',
    };
    const wrong = await json(
      await api('tasks/BRK-1/pings', {
        method: 'POST',
        body: { by: agent, kind: 'fyi', message: 'Found more.', proposal: [{ ...change, project: 'brand' }] },
      }),
    );
    expect(wrong.status).toBe(400);
    expect(wrong.error).toMatch(/project is one of product, cloud, ops, ideas, routines/);
    const ping = await json(
      await api('tasks/BRK-1/pings', {
        method: 'POST',
        body: { by: agent, kind: 'fyi', message: 'Found more.', proposal: [{ ...change, project: 'product' }] },
      }),
    );
    expect(ping.status).toBe(201);
    const login = await SELF.fetch(`${ORIGIN}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_API_TOKEN }),
    });
    const cookie = login.headers.get('Set-Cookie').split(';')[0];
    const applied = await SELF.fetch(`${ORIGIN}/api/pings/${ping.ping.id}/apply`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(applied.status).toBe(200);
    const made = (await json(await api('tasks?status=all'))).tasks.find(
      (t) => t.description === 'Follow-up in breakaway',
    );
    expect(made).toMatchObject({ repo: 'breakaway', wid: 'BRK-3' });
  });

  it('says each ping’s and activity line’s repository, so the board can follow its switcher (CLD-128)', async () => {
    const made = await json(
      await api('tasks/BRK-1/pings', {
        method: 'POST',
        body: { by: 'claude-brk-1', kind: 'question', message: 'Which copy goes on the landing page?' },
      }),
    );
    expect(made.status).toBe(201);
    const open = await json(await api('pings'));
    expect(open.pings.find((p) => p.id === made.ping.id)).toMatchObject({ task: 'BRK-1', repo: 'breakaway' });
    const { events } = await json(await api('activity?limit=200'));
    const brk = events.find((e) => e.task?.wid === 'BRK-2');
    expect(brk.task.repo).toBe('breakaway');
    const sw = events.find((e) => e.task?.wid && /^DEBT-/.test(e.task.wid));
    expect(sw.task.repo).toBe('widgets');
  });

  it('keeps claim and next to the checkout’s repository when the CLI names it (CLD-123)', async () => {
    const brk = (
      await create({
        description: 'Breakaway agent work',
        project: 'product',
        repo: 'breakaway',
        tags: ['agent'],
        priority: 'H',
      })
    ).tasks[0];
    const claim = async (body) => json(await api(`tasks/${brk.wid}/claim`, { method: 'POST', body }));
    const refused = await claim({ agent: 'claude-sw', repo: 'widgets', force: true });
    expect(refused.status).toBe(409);
    expect(refused.error).toMatch(
      new RegExp(
        `${brk.wid} belongs to breakaway \\(acme/breakaway\\), and this checkout is widgets.*--repo breakaway`,
      ),
    );
    expect((await claim({ agent: 'claude-brk', repo: 'Breakaway' })).task.claim).toBe('claude-brk');
    await api(`tasks/${brk.wid}/release`, { method: 'POST', body: { agent: 'claude-brk' } });
    // No repo (an old CLI, or --all): as before.
    expect((await claim({ agent: 'claude-any' })).status).toBe(200);
    await api(`tasks/${brk.wid}/release`, { method: 'POST', body: { agent: 'claude-any' } });

    const next = async (repo) =>
      (await json(await api('next', { method: 'POST', body: { agent: 'claude-n', repo } }))).task;
    expect((await next('breakaway')).repo).toBe('breakaway');
    const sw = await next('widgets');
    expect(sw === null || sw.repo === 'widgets').toBe(true);
    expect(await next('nowhere')).toBeNull();
    const claimed = (
      await json(await api('next', { method: 'POST', body: { agent: 'claude-n', repo: 'breakaway', claim: true } }))
    ).task;
    expect(claimed).toMatchObject({ repo: 'breakaway', claim: 'claude-n' });
    await api(`tasks/${claimed.uuid}/release`, { method: 'POST', body: { agent: 'claude-n' } });
  });

  it('refuses removing an area that still has tasks', async () => {
    expect((await json(await modify('breakaway', { removeAreas: ['product'] }))).error).toMatch(
      /has tasks in breakaway/,
    );
    expect((await json(await modify('breakaway', { addAreas: ['brand:BBRD'] }))).status).toBe(200);
    expect(
      (await json(await modify('breakaway', { removeAreas: ['brand'] }))).repo.areas.map((a) => a.project),
    ).toEqual(['product', 'cloud', 'ops']);
  });
});

describe('taking a repository off the board (CLD-191)', () => {
  const remove = (slug, body = {}) => api(`repos/${slug}`, { method: 'DELETE', body });

  it('refuses the default repository, an agent, and an unknown one', async () => {
    expect((await json(await remove('widgets'))).status).toBe(409);
    expect((await json(await remove('widgets'))).error).toMatch(/default repository/);
    expect((await json(await remove('nowhere'))).status).toBe(404);
    expect(
      await json(await add({ slug: 'leftover', github: 'someone/leftover', areas: ['product:LFTP'] })),
    ).toMatchObject({ status: 201 });
    expect((await json(await remove('leftover', { by: 'claude-x' }))).status).toBe(403);
  });

  it('waits for open tasks unless forced, then keeps its finished tasks, slug, and prefixes', async () => {
    const made = (await create({ description: 'Leftover work', project: 'product', repo: 'leftover' })).tasks[0];
    expect(made.wid).toBe('LFTP-1');
    const routine = await json(
      await api('routines', {
        method: 'POST',
        body: { slug: 'leftover-weekly', name: 'Weekly', prompt: 'Look around.', repo: 'leftover' },
      }),
    );
    expect(routine.status).toBe(201);
    const refused = await json(await remove('leftover'));
    expect(refused).toMatchObject({ status: 409 });
    expect(refused.error).toMatch(/1 open task/);
    expect(
      (await json(await api(`tasks/${made.uuid}/done`, { method: 'POST', body: { note: 'Done before removing.' } })))
        .status,
    ).toBe(200);

    const removed = await json(await remove('leftover'));
    expect(removed).toMatchObject({ status: 200, open: 0, running: 0, routines: ['leftover-weekly'], routine: false });
    expect(removed.removed).toMatchObject({
      slug: 'leftover',
      github: 'someone/leftover',
      areas: [{ project: 'product', prefix: 'LFTP' }],
    });

    const registry = await json(await api('repos'));
    expect(registry.repos.map((r) => r.slug)).not.toContain('leftover');
    expect(registry.removed.map((r) => r.slug)).toContain('leftover');
    // Its finished task stays readable, still its own.
    expect((await json(await api('tasks/LFTP-1'))).task).toMatchObject({
      wid: 'LFTP-1',
      repo: 'leftover',
      status: 'completed',
    });
    // Its routine is off; new tasks can't go in it; its slug and prefix are never given again.
    expect((await json(await api('routines'))).routines.find((r) => r.slug === 'leftover-weekly')).toMatchObject({
      enabled: false,
    });
    expect((await create({ description: 'Late', project: 'product', repo: 'leftover' })).error).toMatch(
      /no repository "leftover"; registered: .*repos add/,
    );
    expect(
      (await json(await add({ slug: 'leftover', github: 'someone/other-leftover', areas: ['product:LFTQ'] }))).error,
    ).toMatch(/taken off the board/);
    expect(
      (await json(await add({ slug: 'newcomer', github: 'someone/newcomer', areas: ['product:LFTP'] }))).error,
    ).toMatch(/LFTP was leftover’s/);
    // Its GitHub repository may come back under a new slug.
    expect(
      (await json(await add({ slug: 'leftover-again', github: 'someone/leftover', areas: ['product:LFTR'] }))).status,
    ).toBe(201);
  });

  it('removes one with open tasks when forced, leaving them as they are', async () => {
    const made = (await create({ description: 'Still open', project: 'product', repo: 'leftover-again' })).tasks[0];
    const removed = await json(await remove('leftover-again', { force: true }));
    expect(removed).toMatchObject({ status: 200, open: 1 });
    expect((await json(await api(`tasks/${made.uuid}`))).task).toMatchObject({
      repo: 'leftover-again',
      status: 'pending',
    });
  });
});

describe('releasing a removed repository’s slug and prefixes (CLD-205)', () => {
  const remove = (slug) => api(`repos/${slug}`, { method: 'DELETE', body: {} });
  const release = (slug, body = {}) => api(`repos/${slug}/release`, { method: 'POST', body });

  it('refuses an agent, an unknown repository, and one still on the board', async () => {
    expect(
      await json(await add({ slug: 'mistake', github: 'someone/mistake', areas: ['product:MSTP', 'cloud:MSTC'] })),
    ).toMatchObject({ status: 201 });
    expect((await json(await release('nowhere'))).status).toBe(404);
    const active = await json(await release('mistake'));
    expect(active.status).toBe(409);
    expect(active.error).toMatch(/still on the board.*repos remove mistake/);
    expect((await json(await remove('mistake'))).status).toBe(200);
    expect((await json(await release('mistake', { by: 'claude-x' }))).status).toBe(403);
  });

  it('says which clashing removed repositories could be released, for the wizard’s button', async () => {
    const bySlug = await json(
      await add({ slug: 'mistake', github: 'someone/mistake', areas: ['product:MSTX'], dryRun: true }),
    );
    expect(bySlug).toMatchObject({ status: 400, releasable: ['mistake'] });
    expect(bySlug.error).toMatch(/taken off the board/);
    expect(
      (
        await json(
          await add({ slug: 'fresh', github: 'someone/fresh', areas: ['product:FRSH', 'cloud:MSTC'], dryRun: true }),
        )
      ).releasable,
    ).toEqual(['mistake']);
    // leftover has a task, so it's never offered.
    const kept = await json(
      await add({ slug: 'leftover', github: 'someone/fresh', areas: ['product:FRSH'], dryRun: true }),
    );
    expect(kept.status).toBe(400);
    expect(kept.releasable).toBeUndefined();
  });

  it('frees a removed repository no task ever used, so its slug and prefixes can be registered again', async () => {
    const released = await json(await release('mistake'));
    expect(released).toMatchObject({ status: 200, released: { slug: 'mistake', github: 'someone/mistake' } });
    expect(released.released.areas.map((a) => a.prefix)).toEqual(['MSTP', 'MSTC']);
    expect((await json(await api('repos'))).removed.map((r) => r.slug)).not.toContain('mistake');
    // Released once: there's nothing left to release.
    expect((await json(await release('mistake'))).status).toBe(404);
    const again = await json(
      await add({
        slug: 'mistake',
        github: 'someone/mistake',
        areas: ['product:MSTP', 'cloud:MSTC'],
        routine: { prompt: 'AGENTS.md' },
      }),
    );
    expect(again).toMatchObject({ status: 201, repo: { slug: 'mistake', routine: { prompt: 'AGENTS.md' } } });
    expect((await create({ description: 'First real task', project: 'product', repo: 'mistake' })).tasks[0].wid).toBe(
      'MSTP-1',
    );
  });

  it('keeps a removed repository that has tasks of any status, or a saved routine', async () => {
    // leftover (above) still has its finished LFTP-1, and its switched-off routine.
    const withTasks = await json(await release('leftover'));
    expect(withTasks.status).toBe(409);
    expect(withTasks.error).toMatch(/1 task.*a work ID means one task forever/);

    expect(
      await json(await add({ slug: 'routined', github: 'someone/routined', areas: ['product:RTDP'] })),
    ).toMatchObject({ status: 201 });
    expect(
      (
        await json(
          await api('routines', {
            method: 'POST',
            body: { slug: 'routined-weekly', name: 'Weekly', prompt: 'Look around.', repo: 'routined' },
          }),
        )
      ).status,
    ).toBe(201);
    expect((await json(await remove('routined'))).status).toBe(200);
    const withRoutine = await json(await release('routined'));
    expect(withRoutine.status).toBe(409);
    expect(withRoutine.error).toMatch(/saved routine routined-weekly/);
    expect((await json(await api('repos'))).removed.map((r) => r.slug)).toEqual(
      expect.arrayContaining(['leftover', 'routined']),
    );
  });
});

/** The parent of the newest version, so readChild returns the newest version's operations. */
async function parentOfLatest() {
  const latest = (await json(await api('health'))).latestVersion;
  let parent = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const { res, versionId } = await readChild(parent);
    if (res.status !== 200 || versionId === latest) return parent;
    parent = versionId;
  }
}

describe('the default branch of a new repository', () => {
  it('takes GitHub’s when none is given, and keeps one that is', async () => {
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const reply = (data, status = 200) =>
        new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.pathname === '/repos/acme/branchy/installation') return reply({ id: 7, permissions: {} });
      if (url.pathname === '/app/installations/7/access_tokens')
        return reply({ token: 'ghs_fake', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      if (url.pathname === '/repos/acme/branchy') return reply({ full_name: 'acme/branchy', default_branch: 'dev' });
      return reply({ message: 'Not Found' }, 404);
    });
    try {
      const taken = await json(await add({ slug: 'branchy', github: 'acme/branchy', areas: ['product:BRH'] }));
      expect(taken).toMatchObject({ status: 201, repo: { defaultBranch: 'dev' } });
      const given = await json(
        await add({ slug: 'branchy2', github: 'acme/unknown', areas: ['product:BRI'], defaultBranch: 'trunk' }),
      );
      expect(given).toMatchObject({ status: 201, repo: { defaultBranch: 'trunk' } });
      // GitHub can't say (not installed): the old default, main.
      const unknown = await json(await add({ slug: 'branchy3', github: 'acme/unknown2', areas: ['product:BRJ'] }));
      expect(unknown).toMatchObject({ status: 201, repo: { defaultBranch: 'main' } });
    } finally {
      mock.mockRestore();
    }
  });
});

describe('one repository’s settings (BRK-129)', () => {
  const read = async (slug) => json(await api(`repos/${slug}`));
  const inStore = (fn) => runInDurableObject(env.STORE.get(env.STORE.idFromName('widgets')), (s) => fn(s));
  const githubSays = (branch) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const reply = (data, status = 200) =>
        new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.pathname === '/repos/acme/gizmos/installation') return reply({ id: 9, permissions: {} });
      if (url.pathname === '/app/installations/9/access_tokens')
        return reply({ token: 'ghs_fake', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      if (url.pathname === '/repos/acme/gizmos') return reply({ full_name: 'acme/gizmos', default_branch: branch });
      return reply({ message: 'Not Found' }, 404);
    });

  it('reads a repository with its areas’ counts, its routine, its saved routines, and its agents', async () => {
    expect(
      await json(
        await add({
          slug: 'gizmos',
          github: 'acme/gizmos',
          areas: ['product:GZP:Product', 'ops:GZO', 'cloud:GZC'],
          defaultBranch: 'main',
        }),
      ),
    ).toMatchObject({ status: 201 });
    const open = (await create({ description: 'Gizmo work', project: 'product', repo: 'gizmos' })).tasks[0];
    for (const project of ['product', 'ops']) {
      const made = (await create({ description: `Finished ${project}`, project, repo: 'gizmos' })).tasks[0];
      await api(`tasks/${made.uuid}/done`, { method: 'POST', body: { note: 'Done.' } });
    }
    expect((await api(`tasks/${open.uuid}/claim`, { method: 'POST', body: { agent: 'claude-gz' } })).ok).toBe(true);
    await inStore((s) =>
      s.sql.exec(
        "INSERT INTO agent_runs (task, agent, trigger, status, started, repo) VALUES (?, 'claude-gz', 'manual', 'started', ?, 'gizmos')",
        open.uuid,
        Date.now() - 60_000,
      ),
    );
    expect(
      (
        await api('routines', {
          method: 'POST',
          body: { slug: 'gizmos-weekly', name: 'Weekly', prompt: 'Look around.', repo: 'gizmos' },
        })
      ).status,
    ).toBe(201);

    const mock = githubSays('trunk');
    let res;
    try {
      res = await read('Gizmos');
    } finally {
      mock.mockRestore();
    }
    expect(res).toMatchObject({
      status: 200,
      repo: { slug: 'gizmos', github: 'acme/gizmos', defaultBranch: 'main', isDefault: false },
      removed: null,
      routineConnected: false,
      routines: 1,
      open: 1,
      running: 1,
      githubDefaultBranch: 'trunk',
    });
    expect(res.areas).toEqual([
      { project: 'product', prefix: 'GZP', name: 'Product', open: 1, total: 2 },
      { project: 'ops', prefix: 'GZO', name: 'ops', open: 0, total: 1 },
      { project: 'cloud', prefix: 'GZC', name: 'cloud', open: 0, total: 0 },
    ]);
    expect(Date.parse(res.repo.edited)).toBeGreaterThan(0);

    // The default repository’s routine is connected: a yes, never its URL or token.
    const widgets = await read('widgets');
    expect(widgets).toMatchObject({ status: 200, routineConnected: true, repo: { isDefault: true } });
    expect(JSON.stringify(widgets)).not.toMatch(/routines\/trig_|sk-ant-/);
  });

  it('reads it without GitHub’s default branch while the App isn’t connected', async () => {
    const res = await inStore(async (s) => {
      const saved = s.env.TASKS_GITHUB_APP_ID;
      s.env.TASKS_GITHUB_APP_ID = 'unset';
      try {
        return await s.repoApi('gizmos');
      } finally {
        s.env.TASKS_GITHUB_APP_ID = saved;
      }
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ githubDefaultBranch: null, open: 1, routines: 1 });
    expect(res.body.areas.map((a) => a.total)).toEqual([2, 1, 0]);
  });

  it('says which repository it doesn’t know, and reads one taken off the board', async () => {
    const unknown = await read('nowhere');
    expect(unknown).toMatchObject({ status: 404 });
    expect(unknown.error).toMatch(/no repository "nowhere"/);

    await add({ slug: 'retired', github: 'acme/retired', areas: ['product:RTP'] });
    expect((await api('repos/retired', { method: 'DELETE', body: {} })).status).toBe(200);
    const gone = await read('retired');
    expect(gone).toMatchObject({
      status: 200,
      repo: { slug: 'retired', github: 'acme/retired' },
      open: 0,
      running: 0,
      routines: 0,
      githubDefaultBranch: null,
      releaseBlocker: null,
    });
    expect(Date.parse(gone.removed)).toBeGreaterThan(0);
    expect(gone.areas).toEqual([{ project: 'product', prefix: 'RTP', name: 'product', open: 0, total: 0 }]);
  });

  it('checks a change with dryRun and saves nothing, whether it passes or not', async () => {
    const before = (await read('gizmos')).repo;
    const passes = await json(await modify('gizmos', { addAreas: ['brand:GZB'], dryRun: true }));
    expect(passes).toMatchObject({ status: 200, dryRun: true });
    expect(passes.repo.areas.map((a) => a.prefix)).toEqual(['GZP', 'GZO', 'GZC', 'GZB']);
    const refused = await json(await modify('gizmos', { addAreas: ['brand:PRD'], dryRun: true }));
    expect(refused.status).toBe(400);
    expect(refused.error).toMatch(/PRD already belongs to widgets/);
    expect((await json(await modify('gizmos', { removeAreas: ['product'], dryRun: true }))).error).toMatch(/has tasks/);
    expect((await read('gizmos')).repo).toEqual(before);
    // An agent can't check one either.
    expect((await json(await modify('gizmos', { name: 'X', dryRun: true, by: 'claude-gz' }))).status).toBe(403);
  });

  it('refuses a change made over a newer one, with the row as it is now', async () => {
    const loaded = (await read('gizmos')).repo;
    const first = await json(await modify('gizmos', { name: 'Gizmos', edited: loaded.edited }));
    expect(first).toMatchObject({ status: 200, repo: { name: 'Gizmos' } });
    expect(first.repo.edited).not.toBe(loaded.edited);

    const stale = await json(await modify('gizmos', { name: 'Other', edited: loaded.edited }));
    expect(stale.status).toBe(409);
    expect(stale.error).toMatch(/changed somewhere else/i);
    expect(stale.repo).toEqual(first.repo);
    expect((await json(await modify('gizmos', { name: 'Other', edited: loaded.edited, dryRun: true }))).status).toBe(
      409,
    );
    expect((await read('gizmos')).repo.name).toBe('Gizmos');
    expect((await json(await modify('gizmos', { name: 'Other', edited: 'yesterday' }))).status).toBe(400);

    // The CLI sends no edited time and saves as before, even twice in a row.
    expect((await json(await modify('gizmos', { name: 'Gizmos one' }))).status).toBe(200);
    const again = await json(await modify('gizmos', { name: 'Gizmos two' }));
    expect(again).toMatchObject({ status: 200, repo: { name: 'Gizmos two' } });
    expect((await json(await modify('gizmos', { name: 'Gizmos three', edited: first.repo.edited }))).status).toBe(409);
    expect((await json(await modify('gizmos', { name: 'Gizmos', edited: again.repo.edited }))).status).toBe(200);
  });
});
