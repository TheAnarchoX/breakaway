import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseInstall } from '../../src/install.js';
import { bundleConfig, originRepository, runInit, runStep } from './cli.js';
import { TEMPLATE_FILES } from './init.js';

const ROOT = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8');

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'install-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lines = [];
const io = () => {
  lines.length = 0;
  return { cwd: dir, out: (l) => lines.push(l), input: () => '' };
};
const init = (args = [], opts = {}, own = '0.2.0') =>
  runInit(
    args,
    { name: 'Acme board', worker: 'acme-board', ...opts },
    { cwd: dir, out: (l) => lines.push(l), input: { isTTY: false }, own },
  );
const put = (path, value) => writeFileSync(join(dir, path), typeof value === 'string' ? value : JSON.stringify(value));

describe('install init', () => {
  it('writes the template, with this install’s names, and pins the release the CLI is', async () => {
    await init([], { url: 'https://board.example.com' });
    for (const file of ['breakaway.config.json', 'breakaway.json', 'README.md', ...TEMPLATE_FILES])
      expect(existsSync(join(dir, file)), file).toBe(true);
    const written = JSON.parse(readFileSync(join(dir, 'breakaway.config.json'), 'utf8'));
    const config = parseInstall(written);
    expect(config).toMatchObject({ name: 'Acme board', worker: 'acme-board', url: 'https://board.example.com' });
    // No aliases key in a new install's file, so a release from before aliases (BRK-78) reads it.
    expect(written).not.toHaveProperty('aliases');
    expect(JSON.parse(readFileSync(join(dir, 'breakaway.json'), 'utf8'))).toEqual({
      version: '0.2.0',
      channel: 'stable',
    });
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toContain('# Acme board');
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('wrangler.generated.json');
  });

  it('writes installRepository from the flag, else from origin, else leaves it out', async () => {
    await init([], { 'install-repository': 'acme/my-board' });
    expect(JSON.parse(readFileSync(join(dir, 'breakaway.config.json'), 'utf8'))).toMatchObject({
      installRepository: 'acme/my-board',
      channel: 'stable',
    });
    const other = join(dir, 'viaorigin');
    mkdirSync(other);
    execFileSync('git', ['init', '-q', other]);
    execFileSync('git', ['-C', other, 'remote', 'add', 'origin', 'git@github.com:acme/origin-board.git']);
    await runInit(
      [other],
      { name: 'A', worker: 'a' },
      { cwd: dir, out: () => {}, input: { isTTY: false }, own: '0.2.0' },
    );
    expect(JSON.parse(readFileSync(join(other, 'breakaway.config.json'), 'utf8')).installRepository).toBe(
      'acme/origin-board',
    );
    expect(originRepository(join(dir, 'nowhere'))).toBe('');
    await expect(init([], { 'install-repository': 'nope' })).rejects.toThrow(/installRepository/u);
  });

  it('follows main when the CLI is a pre-release, unless told otherwise', async () => {
    await init([], {}, '0.2.1-main.4');
    expect(JSON.parse(readFileSync(join(dir, 'breakaway.json'), 'utf8'))).toEqual({
      version: '0.2.1-main.4',
      channel: 'main',
    });
    expect(lines.join('\n')).toContain('No stable release exists yet');
  });

  it('never overwrites a file, and only adds the .gitignore lines it lacks', async () => {
    put('breakaway.json', '{"mine":true}');
    put('.gitignore', 'node_modules/\ndist/\n');
    await init();
    expect(readFileSync(join(dir, 'breakaway.json'), 'utf8')).toBe('{"mine":true}');
    expect(lines).toContain('kept    breakaway.json (already there)');
    const ignore = readFileSync(join(dir, '.gitignore'), 'utf8').split('\n');
    expect(ignore.filter((l) => l === 'node_modules/')).toHaveLength(1);
    expect(ignore).toContain('dist/');
    expect(ignore).toContain('bundle/');
  });

  it('refuses a bad value, saying what is wrong', async () => {
    await expect(init([], { url: 'http://insecure.example.com' })).rejects.toThrow(/https origin/u);
    await expect(init([], { worker: 'Not A Worker' })).rejects.toThrow(/Worker name/u);
  });

  it('keeps its copies of the root files the same', () => {
    expect(read('template/.dev.vars.example')).toBe(read('.dev.vars.example'));
  });
});

describe('the deploy workflow’s steps', () => {
  const feed = { channels: { stable: { version: '0.3.0' }, main: { version: '0.3.1-main.2' } } };

  it('resolves the pinned release on stable, and the latest pre-release on main', async () => {
    put('breakaway.json', { version: '0.2.0', channel: 'stable' });
    put('releases.json', feed);
    expect(await runStep('resolve', { releases: join(dir, 'releases.json'), repo: 'acme/breakaway' }, io())).toBe(0);
    expect(lines).toEqual(['version=0.2.0', 'tag=v0.2.0', 'channel=stable', 'repository=acme/breakaway']);
    put('breakaway.json', { version: '0.2.0', channel: 'main' });
    await runStep('resolve', { releases: join(dir, 'releases.json') }, io());
    expect(lines[0]).toBe('version=0.3.1-main.2');
  });

  it('stops a manual release, exiting 2 with its steps', async () => {
    put('manifest.json', {
      version: '0.2.0',
      manual: true,
      manualSteps: ['Run the migration by hand.'],
      updatesFrom: '0.1.0',
    });
    await expect(
      runStep('check', { version: '0.2.0', manifest: join(dir, 'manifest.json') }, io()),
    ).rejects.toMatchObject({ code: 2, message: expect.stringContaining('Run the migration by hand.') });
  });

  it('lets a release through, then stops a config that changed the address', async () => {
    put('manifest.json', { version: '0.2.0', manual: false, updatesFrom: '0.1.0' });
    put('before.json', { name: 'board', worker: 'board' });
    put('breakaway.config.json', { name: 'board', worker: 'board' });
    const opts = { version: '0.2.0', manifest: join(dir, 'manifest.json'), before: join(dir, 'before.json') };
    expect(await runStep('check', opts, io())).toBe(0);
    put('breakaway.config.json', { name: 'board', worker: 'board', url: 'https://board.example.com' });
    await expect(runStep('check', opts, io())).rejects.toMatchObject({
      code: 2,
      message: expect.stringContaining('its address (routes)'),
    });
    // No earlier config (the first deploy): nothing to compare.
    expect(await runStep('check', { ...opts, before: join(dir, 'missing.json') }, io())).toBe(0);
  });

  it('says how it deploys: a version upload, or wrangler deploy for what a version can’t carry (BRK-62)', async () => {
    put('manifest.json', { version: '0.2.0', manual: false, updatesFrom: '0.1.0' });
    put('before.json', { name: 'board', worker: 'board' });
    put('breakaway.config.json', { name: 'board', worker: 'board' });
    const opts = { version: '0.2.0', manifest: join(dir, 'manifest.json'), before: join(dir, 'before.json') };
    await runStep('check', opts, io());
    expect(lines).toEqual(['ok=true', 'deploy=versions', 'changes=', 'address_changed=false']);
    put('breakaway.config.json', { name: 'board', worker: 'board', url: 'https://board.example.com' });
    await runStep('check', { ...opts, 'deploy-changes': 'true' }, io());
    expect(lines).toEqual([
      'ok=true',
      'deploy=wrangler',
      'changes=its address (routes), its workers.dev address',
      'address_changed=true',
    ]);
    // Anything but true is no: the variable unset, or set to something else.
    await expect(runStep('check', { ...opts, 'deploy-changes': '' }, io())).rejects.toMatchObject({ code: 2 });
  });

  it('compares with the config the running release made, so a release’s own cron change shows', async () => {
    put('manifest.json', { version: '0.2.0', manual: false, updatesFrom: '0.1.0' });
    put('breakaway.config.json', { name: 'board', worker: 'board' });
    const running = bundleConfig(parseInstall({ name: 'board', worker: 'board' }), 'bundle');
    put('running.json', { ...running, triggers: { crons: ['*/10 * * * *'] } });
    const opts = {
      version: '0.2.0',
      manifest: join(dir, 'manifest.json'),
      'running-config': join(dir, 'running.json'),
    };
    await expect(runStep('check', opts, io())).rejects.toMatchObject({
      code: 2,
      message: expect.stringContaining('its cron triggers'),
    });
    await runStep('check', { ...opts, 'deploy-changes': 'true' }, io());
    expect(lines).toContain('deploy=wrangler');
    // A running config that can't be read falls back to the config before the push.
    put('running.json', 'not json');
    put('before.json', { name: 'board', worker: 'board' });
    await runStep('check', { ...opts, before: join(dir, 'before.json') }, io());
    expect(lines).toContain('deploy=versions');
  });

  it('never deploys another Durable Object, whatever the install allows', async () => {
    put('manifest.json', { version: '0.2.0', manual: false, updatesFrom: '0.1.0' });
    put('before.json', { name: 'board', worker: 'board' });
    put('breakaway.config.json', { name: 'board', worker: 'board', store: 'another' });
    const opts = { version: '0.2.0', manifest: join(dir, 'manifest.json'), before: join(dir, 'before.json') };
    await expect(runStep('check', { ...opts, 'deploy-changes': 'true' }, io())).rejects.toMatchObject({
      code: 2,
      message: expect.stringContaining('its Durable Object (store)'),
    });
  });

  it('makes a Worker config that points at the downloaded bundle', async () => {
    put('breakaway.config.json', { name: 'board', worker: 'board' });
    await runStep('config', { bundle: 'bundle', out: 'wrangler.generated.json' }, io());
    const out = JSON.parse(readFileSync(join(dir, 'wrangler.generated.json'), 'utf8'));
    expect(out).toMatchObject({
      name: 'board',
      main: './bundle/worker/src/worker.js',
      assets: { directory: './bundle/dist', binding: 'ASSETS' },
    });
    expect(bundleConfig(parseInstall({}), 'x').main).toBe('./x/worker/src/worker.js');
  });

  it('stops on a failed list unless the Worker does not exist', async () => {
    put('breakaway.config.json', { name: 'board', worker: 'board' });
    await runStep('missing', {}, { ...io(), input: () => 'This Worker does not exist on your account. [code: 10007]' });
    expect(lines).toEqual(['first=true']);
    await expect(
      runStep('missing', {}, { ...io(), input: () => 'Invalid account identifier [code: 7003]' }),
    ).rejects.toThrow(/CLOUDFLARE_ACCOUNT_ID[\s\S]*7003/);
  });

  it('stops a new Worker on an install that already has a board, and makes nothing (BRK-141)', async () => {
    put('breakaway.config.json', { name: 'board', worker: 'bord', url: 'https://board.example.com' });
    const missing = { ...io(), input: () => 'This Worker does not exist on your account. [code: 10007]' };
    // A dispatch on an install whose BREAKAWAY_URL is set: the name is mistyped, not new.
    await expect(
      runStep(
        'missing',
        { variable: 'https://board.example.com', running: '', at: 'https://board.example.com' },
        missing,
      ),
    ).rejects.toMatchObject({ code: 2, message: expect.stringMatching(/no Worker named bord[\s\S]*empty board/u) });
    // The address answered as a release, with no variable set: a board runs there.
    await expect(
      runStep('missing', { variable: '', running: '0.2.0', at: 'https://board.example.com' }, missing),
    ).rejects.toMatchObject({ code: 2, message: expect.stringContaining('answers as breakaway 0.2.0') });
    expect(lines).toEqual([]);
    // Nothing set and nothing answering: the first deploy.
    await runStep('missing', { variable: '', running: '', at: 'https://board.example.com' }, missing);
    expect(lines).toEqual(['first=true']);
  });

  it('passes a first deploy that answers before its secrets are on, and no later one (BRK-141)', async () => {
    const waiting = '{"ok":true,"release":"0.2.0","secrets":{"ok":false,"unreadable":["TASKS_SYNC_KEY"]}}';
    const ping = { ...io(), input: () => waiting };
    expect(await runStep('healthy', { version: '0.2.0', first: 'true' }, ping)).toBe(0);
    expect(lines).toEqual(['health=secrets']);
    expect(await runStep('healthy', { version: '0.2.0', first: 'false' }, ping)).toBe(1);
    expect(await runStep('healthy', { version: '0.2.0' }, ping)).toBe(1);
    // Down is down, first deploy or not.
    expect(await runStep('healthy', { version: '0.2.0', first: 'true' }, { ...io(), input: () => '' })).toBe(1);
    expect(lines).toEqual(['health=down']);
  });

  it('reads the previous version and the health of a ping from stdin', async () => {
    const deployments = JSON.stringify([
      { created_on: '2026-10-02T00:00:00Z', versions: [{ version_id: 'abc', percentage: 100 }] },
    ]);
    await runStep('previous', {}, { ...io(), input: () => deployments });
    expect(lines).toEqual(['previous=abc']);
    expect(
      await runStep(
        'healthy',
        { version: '0.2.0' },
        { ...io(), input: () => '{"ok":true,"release":"0.2.0","secrets":{"ok":true}}' },
      ),
    ).toBe(0);
    expect(await runStep('healthy', { version: '0.2.0' }, { ...io(), input: () => 'not json' })).toBe(1);
  });
});

describe('the update workflow’s step', () => {
  it('bumps breakaway.json from a fixture feed, and writes the pull request’s description', async () => {
    put('breakaway.json', { version: '0.2.0', channel: 'stable' });
    put('releases.json', { channels: { stable: { version: '0.3.0' }, main: null } });
    put('manifest.json', { version: '0.3.0', manual: true, manualSteps: ['Do this first.'] });
    put('notes.md', '### Board\n- a thing');
    await runStep(
      'update',
      {
        releases: join(dir, 'releases.json'),
        repo: 'acme/breakaway',
        manifest: join(dir, 'manifest.json'),
        notes: join(dir, 'notes.md'),
        body: join(dir, 'body.md'),
      },
      io(),
    );
    expect(lines).toEqual(['action=bump', 'version=0.3.0', 'tag=v0.3.0', 'title=Update breakaway to 0.3.0']);
    expect(JSON.parse(readFileSync(join(dir, 'breakaway.json'), 'utf8'))).toEqual({
      version: '0.3.0',
      channel: 'stable',
    });
    const body = readFileSync(join(dir, 'body.md'), 'utf8');
    expect(body).toContain('0.2.0 to 0.3.0');
    expect(body).toContain('- Do this first.');
    expect(body).toContain('- a thing');
  });

  it('changes nothing when there is nothing newer', async () => {
    put('breakaway.json', { version: '0.3.0', channel: 'stable' });
    put('releases.json', { channels: { stable: { version: '0.3.0' }, main: null } });
    await runStep('update', { releases: join(dir, 'releases.json') }, io());
    expect(lines[0]).toBe('action=none');
    expect(JSON.parse(readFileSync(join(dir, 'breakaway.json'), 'utf8')).version).toBe('0.3.0');
  });

  it('starts a deploy on main for a newer pre-release', async () => {
    put('breakaway.json', { version: '0.3.1-main.1', channel: 'main' });
    put('releases.json', [{ tag_name: 'v0.3.1-main.2', prerelease: true }]);
    await runStep('update', { releases: join(dir, 'releases.json'), running: '0.3.1-main.1' }, io());
    expect(lines).toEqual(['action=deploy', 'version=0.3.1-main.2', 'tag=v0.3.1-main.2']);
  });

  it('says what step it lacks', async () => {
    await expect(runStep('nope', {}, io())).rejects.toThrow(/install has no "nope"/u);
    mkdirSync(join(dir, 'x'));
  });
});
