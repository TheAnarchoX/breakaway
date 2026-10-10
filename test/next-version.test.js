import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generalAgentRequest, generalAgentSummary } from '../scripts/tasks/cli.js';
import { nextChoices, nextVersionPrompt, versionBase } from '../src/next-version.js';
import { api } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const fires = [];

/** What the last GitHub sync kept for widgets: its releases and tags. */
const seed = (releases, tags = []) =>
  runInDurableObject(env.STORE.get(env.STORE.idFromName('widgets')), (instance) => {
    instance.setGhMeta('gh_releases', 'widgets', JSON.stringify(releases.map((tag) => ({ tag, draft: false }))));
    instance.setGhMeta('gh_tags', 'widgets', JSON.stringify(tags.map((name) => ({ name }))));
  });
const prepare = (extra) => api('agents/general', { method: 'POST', body: { force: true, ...extra } });
const finish = async (t) => api(`tasks/${t.uuid}/release`, { method: 'POST', body: { agent: t.claim } });

describe('the next version (BRK-100)', () => {
  it('reads the version the pre-releases work toward from the tags', () => {
    expect(versionBase(['v1.1.2-main.3', 'v1.1.2-main.12', 'v1.1.1', 'v1.1.2-main.9'])).toEqual({
      base: '1.1.2',
      latest: 'v1.1.2-main.12',
    });
    // Once its stable is out, the work is toward the next patch, as nextPrerelease counts it.
    expect(versionBase(['v1.3.0-main.7', 'v1.3.0'])).toEqual({ base: '1.3.1', latest: 'v1.3.0-main.7' });
    expect(versionBase(['v1.10.0-main.1', 'v1.9.4-main.30'])).toEqual({ base: '1.10.0', latest: 'v1.10.0-main.1' });
    // No pre-release counted from package.json: nothing to offer.
    expect(versionBase(['v1.2.0', 'release-3', 'v2.0.0-beta.1'])).toBeNull();
    expect(versionBase([])).toBeNull();
  });

  it('offers the next minor and the next major', () => {
    expect(nextChoices('1.1.2')).toEqual([
      { next: 'minor', version: '1.2.0' },
      { next: 'major', version: '2.0.0' },
    ]);
    expect(nextChoices('1.3.6').map((c) => c.version)).toEqual(['1.4.0', '2.0.0']);
  });

  it('writes a prompt that sets package.json, with the owner’s note under it', () => {
    const offer = { name: 'widgets', base: '1.3.6', latest: 'v1.3.6-main.4', next: 'minor', version: '1.4.0' };
    const { title, brief } = nextVersionPrompt(offer);
    expect(title).toBe('Set widgets’s version to 1.4.0 for the next minor release');
    expect(brief).toContain('The latest is v1.3.6-main.4, so the work is toward 1.3.6');
    expect(brief).toContain('- Set "version" in package.json to 1.4.0.');
    expect(brief).toContain('the next pre-release is v1.4.0-main.1');
    expect(brief).not.toContain('Note from the owner');
    expect(nextVersionPrompt(offer, '  Wait for the docs. ').brief).toMatch(
      /\n\nNote from the owner:\nWait for the docs\.$/,
    );
  });
});

describe('Prepare the next version from the board (BRK-100)', () => {
  let spy;
  beforeEach(() => {
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url !== FIRE) return new Response('{"message":"Not Found"}', { status: 404 });
      fires.push(JSON.parse(init.body).text);
      return Response.json({
        claude_code_session_id: `session_${fires.length}`,
        claude_code_session_url: `https://claude.ai/code/session_${fires.length}`,
      });
    });
  });
  afterEach(() => spy.mockRestore());

  it('shows nothing, and refuses, for a repository with no pre-release counted from package.json', async () => {
    await seed(['v1.0.0'], ['v1.0.0']);
    expect((await body(await api('github'))).nextVersion).toBeNull();
    const before = (await body(await api('tasks?status=all'))).tasks.length;
    const res = await body(await prepare({ next: 'minor' }));
    expect(res.status).toBe(409);
    expect(res.error).toMatch(/no pre-release like v1\.2\.3-main\.4/);
    expect((await body(await api('tasks?status=all'))).tasks.length).toBe(before);
  });

  it('offers the next minor and major on the GitHub view', async () => {
    await seed(['v1.1.2-main.4', 'v1.1.2-main.3', 'v1.1.1'], ['v1.1.2-main.4']);
    const view = await body(await api('github'));
    expect(view.nextVersion).toEqual({
      base: '1.1.2',
      latest: 'v1.1.2-main.4',
      choices: [
        { next: 'minor', version: '1.2.0' },
        { next: 'major', version: '2.0.0' },
      ],
      preparing: null,
    });
  });

  it('shows the prompt with dryRun and makes nothing', async () => {
    await seed(['v1.1.2-main.4']);
    const before = (await body(await api('tasks?status=all'))).tasks.length;
    const fired = fires.length;
    const preview = await body(await prepare({ next: 'major', dryRun: true }));
    expect(preview).toMatchObject({
      status: 200,
      dryRun: true,
      task: null,
      already: null,
      refusal: null,
      base: '1.1.2',
      version: '2.0.0',
      title: 'Set widgets’s version to 2.0.0 for the next major release',
    });
    expect(preview.prompt).toContain('package.json to 2.0.0');
    expect((await body(await api('tasks?status=all'))).tasks.length).toBe(before);
    expect(fires.length).toBe(fired);
  });

  it('starts a general agent with the board’s prompt, and links to it instead of starting another', async () => {
    await seed(['v1.3.6-main.2']);
    const res = await body(await prepare({ next: 'minor', version: '1.4.0', note: 'Ship BRK-1 first.' }));
    expect(res.status).toBe(201);
    const t = res.task;
    expect(t).toMatchObject({ wid: null, project: null, horizon: 'now', autostart: true });
    expect(t.tags).toEqual(['general', 'version']);
    expect(t.who).toBe('agent');
    expect(t.description).toBe('Set widgets’s version to 1.4.0 for the next minor release');
    expect(t.brief).toContain('- Set "version" in package.json to 1.4.0.');
    expect(t.brief).toMatch(/\n\nNote from the owner:\nShip BRK-1 first\.$/);
    expect(res.run).toMatchObject({ trigger: 'general', kind: 'general', agent: `claude-${t.short}` });
    expect(fires.at(-1)).toContain('Mode: general');
    expect(fires.at(-1)).toContain(`Task: ${t.uuid}`);

    // The view says it's being prepared, and a second press links to it, whichever step it asks for.
    expect((await body(await api('github'))).nextVersion.preparing).toMatchObject({ uuid: t.uuid, claim: t.claim });
    const fired = fires.length;
    const again = await body(await prepare({ next: 'major' }));
    expect(again).toMatchObject({ status: 200, run: null, already: `${t.claim} is on it` });
    expect(again.task.uuid).toBe(t.uuid);
    expect(fires.length).toBe(fired);
    const preview = await body(await prepare({ next: 'minor', dryRun: true }));
    expect(preview.task.uuid).toBe(t.uuid);

    // Once its agent lets go, the next press starts a new one.
    await finish(t);
    const next = await body(await prepare({ next: 'minor' }));
    expect(next.status).toBe(201);
    expect(next.task.uuid).not.toBe(t.uuid);
    await finish(next.task);
  });

  it('refuses a version that moved, a bad step, a prompt of its own, a decision too, and an agent', async () => {
    await seed(['v1.4.0-main.1', 'v1.3.6-main.9']);
    const before = (await body(await api('tasks?status=all'))).tasks.length;
    const moved = await body(await prepare({ next: 'minor', version: '1.4.0' }));
    expect(moved.status).toBe(409);
    expect(moved.error).toBe('widgets’s next minor is 1.5.0 now, not 1.4.0: look again');
    expect((await prepare({ next: 'patch' })).status).toBe(400);
    expect((await prepare({ next: 'minor', prompt: 'Mine' })).status).toBe(400);
    expect((await prepare({ next: 'minor', decision: 'OPS-1' })).status).toBe(400);
    const agent = await body(await prepare({ next: 'minor', by: 'claude-x' }));
    expect(agent.status).toBe(403);
    expect((await body(await api('tasks?status=all'))).tasks.length).toBe(before);
  });

  it('needs the repository when the board runs more than one', async () => {
    await api('repos', { method: 'POST', body: { slug: 'gadgets', github: 'acme/gadgets', areas: ['product:GDG'] } });
    await seed(['v1.3.6-main.2']);
    const res = await body(await prepare({ next: 'minor' }));
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/which repository/);
    // gadgets has no pre-releases on the board.
    expect((await prepare({ next: 'minor', repo: 'gadgets' })).status).toBe(409);
    const ok = await body(await prepare({ next: 'minor', repo: 'widgets', dryRun: true }));
    expect(ok.version).toBe('1.4.0');
  });
});

describe('agents new --next (BRK-100)', () => {
  it('sends the step and the text as the owner’s note, in the checkout’s repository', () => {
    expect(generalAgentRequest(' Ship BRK-1 first ', { next: 'minor', repo: 'widgets', by: 'owner' })).toEqual({
      request: ['POST', 'agents/general', { next: 'minor', note: 'Ship BRK-1 first', repo: 'widgets', by: 'owner' }],
    });
    expect(generalAgentRequest('', { next: 'major', repo: 'widgets', force: true })).toEqual({
      request: ['POST', 'agents/general', { next: 'major', repo: 'widgets', force: true }],
    });
    expect(generalAgentRequest('', { next: 'patch' })).toEqual({
      error: 'patches count by themselves: --next minor or --next major',
    });
    expect(generalAgentRequest('', { next: 'minor', decision: 'BRK-1' })).toHaveProperty('error');
  });

  it('says when one is preparing the next version already', () => {
    expect(
      generalAgentSummary(
        { task: { short: 'a1b2c3d4' }, run: null, already: 'claude-a1b2c3d4 is on it' },
        { next: 'minor' },
      ),
    ).toBe('a1b2c3d4 already prepares the next version: claude-a1b2c3d4 is on it.');
  });
});
