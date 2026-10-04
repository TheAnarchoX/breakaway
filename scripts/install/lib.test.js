import { describe, expect, it } from 'vitest';
import { wranglerConfig } from '../../src/install.js';
import {
  bumpBody,
  checkManifest,
  compareVersions,
  configStop,
  deployPlan,
  deployTarget,
  isHealthy,
  latestReleases,
  parseState,
  previousVersionId,
  workerMissing,
  shapeChanges,
  shapeOf,
  updatePlan,
} from './lib.js';

const feed = (stable, main) => ({
  channels: { stable: stable && { version: stable }, main: main && { version: main } },
});

describe('versions', () => {
  it('orders releases, with a pre-release below its stable and main.10 above main.9', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0-main.3', '0.2.0')).toBeLessThan(0);
    expect(compareVersions('0.2.0-main.10', '0.2.0-main.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(() => compareVersions('latest', '1.0.0')).toThrow(/isn't a version/u);
  });
});

describe('breakaway.json', () => {
  it('takes a pinned stable release or a main channel', () => {
    expect(parseState({ version: '0.2.0', channel: 'stable' })).toEqual({ version: '0.2.0', channel: 'stable' });
    expect(parseState({ version: '0.2.1-main.4', channel: 'main' }).channel).toBe('main');
  });

  it('says what is wrong', () => {
    expect(() => parseState([])).toThrow(/JSON object/u);
    expect(() => parseState({ version: '0.2.0', channel: 'beta' })).toThrow(/"stable" or "main"/u);
    expect(() => parseState({ version: 'latest', channel: 'stable' })).toThrow(/version is a release/u);
    expect(() => parseState({ version: '0.2.1-main.4', channel: 'stable' })).toThrow(/pins a stable version/u);
  });
});

describe('finding releases', () => {
  it('reads the feed', () => {
    expect(latestReleases(feed('0.2.0', '0.2.1-main.4'))).toEqual({
      stable: { version: '0.2.0' },
      main: { version: '0.2.1-main.4' },
    });
    expect(latestReleases(feed(null, null))).toEqual({ stable: null, main: null });
  });

  it('reads GitHub’s releases when the feed has none, by version and never by date, skipping drafts', () => {
    const list = [
      { tag_name: 'v0.2.1-main.2', prerelease: true },
      { tag_name: 'v0.2.1-main.10', prerelease: true },
      { tag_name: 'v0.2.1-main.9', prerelease: true },
      { tag_name: 'v0.2.0', prerelease: false },
      { tag_name: 'v0.1.0', prerelease: false },
      { tag_name: 'v0.3.0', prerelease: false, draft: true },
      { tag_name: 'v0.2.5', prerelease: true },
    ];
    expect(latestReleases(list)).toEqual({ stable: { version: '0.2.0' }, main: { version: '0.2.1-main.10' } });
  });

  it('refuses something else', () => {
    expect(() => latestReleases('nope')).toThrow(/neither the feed/u);
  });
});

describe('what deploy puts on the Worker', () => {
  it('is the pinned release on stable and the latest pre-release on main', () => {
    expect(deployTarget({ channel: 'stable', version: '0.2.0' }, latestReleases(feed('0.3.0', null)))).toEqual({
      version: '0.2.0',
      tag: 'v0.2.0',
      channel: 'stable',
    });
    expect(deployTarget({ channel: 'main', version: '0.2.0' }, latestReleases(feed('0.3.0', '0.3.1-main.2'))).tag).toBe(
      'v0.3.1-main.2',
    );
  });

  it('says so when main has nothing yet', () => {
    expect(() => deployTarget({ channel: 'main', version: '0.2.0' }, latestReleases(feed('0.3.0', null)))).toThrow(
      /no pre-release yet/u,
    );
  });
});

describe('a release that may deploy by itself', () => {
  const manifest = { version: '0.2.0', manual: false, updatesFrom: '0.1.0' };

  it('passes', () => {
    expect(checkManifest(manifest, { version: '0.2.0', running: '0.1.5' })).toEqual({ ok: true });
    expect(checkManifest(manifest, { version: '0.2.0' })).toEqual({ ok: true });
  });

  it('stops for a manual release, with its steps', () => {
    const verdict = checkManifest(
      { ...manifest, manual: true, manualSteps: ['Add the new binding.', 'Run the migration.'] },
      { version: '0.2.0' },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('needs steps by hand');
    expect(verdict.message).toContain('- Add the new binding.');
    expect(verdict.message).toContain('- Run the migration.');
  });

  it('stops for a manifest of another release, and for a running release that is too old', () => {
    expect(checkManifest({ ...manifest, version: '0.1.0' }, { version: '0.2.0' }).message).toContain(
      'manifest is for 0.1.0',
    );
    expect(
      checkManifest({ ...manifest, updatesFrom: '0.1.5' }, { version: '0.2.0', running: '0.1.0' }).message,
    ).toContain('updates from 0.1.5');
    expect(checkManifest(null, { version: '0.2.0' }).ok).toBe(false);
  });
});

describe('a manual release whose only step is wrangler deploy (BRK-62)', () => {
  const manifest = {
    version: '0.2.0',
    manual: true,
    manualSteps: ['Deploy with wrangler deploy: it adds the Durable Object class Archive.'],
    wranglerDeploy: true,
    updatesFrom: '0.1.0',
  };

  it('passes when the install lets Deploy run wrangler deploy', () => {
    expect(checkManifest(manifest, { version: '0.2.0', apply: true })).toEqual({ ok: true, wrangler: true });
  });

  it('stops without it, saying how to let Deploy do it', () => {
    const verdict = checkManifest(manifest, { version: '0.2.0' });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('- Deploy with wrangler deploy');
    expect(verdict.message).toContain('BREAKAWAY_DEPLOY_CHANGES');
  });

  it('stops any other manual release, whatever the install allows', () => {
    const other = { ...manifest, wranglerDeploy: undefined, manualSteps: ['Set the new secret.'] };
    expect(checkManifest(other, { version: '0.2.0', apply: true }).ok).toBe(false);
  });

  it('still needs the running release to be one it updates from', () => {
    const verdict = checkManifest(
      { ...manifest, updatesFrom: '0.1.5' },
      { version: '0.2.0', running: '0.1.0', apply: true },
    );
    expect(verdict.message).toContain('updates from 0.1.5');
  });
});

describe('what a deploy changes that a version can’t carry', () => {
  const base = { name: 'board', worker: 'board' };
  const shape = (config, edit = (w) => w) => shapeOf(edit(wranglerConfig(config)));
  const changes = (before, after) => shapeChanges(before, after).map((c) => [c.change, c.apply]);
  const withClass = (w, migration, binding = { name: 'ARCHIVE', class_name: 'Archive' }) => ({
    ...w,
    durable_objects: { bindings: [...w.durable_objects.bindings, ...(binding ? [binding] : [])] },
    migrations: [...w.migrations, migration],
  });

  it('is none for a rename, a secrets prefix, or the same config', () => {
    expect(shapeChanges(shape(base), shape({ ...base, name: 'Other', secretsPrefix: 'OTHER_' }))).toEqual([]);
    expect(configStop([])).toBeNull();
  });

  it('applies an address, cron triggers, and a new Durable Object class', () => {
    expect(changes(shape(base), shape({ ...base, url: 'https://tasks.example.com' }))).toEqual([
      ['its address (routes)', true],
      ['its workers.dev address', true],
    ]);
    expect(
      changes(
        shape(base),
        shape(base, (w) => ({ ...w, triggers: { crons: ['*/10 * * * *'] } })),
      ),
    ).toEqual([['its cron triggers', true]]);
    const added = shape(base, (w) => withClass(w, { tag: 'v2', new_sqlite_classes: ['Archive'] }));
    expect(changes(shape(base), added)).toEqual([['its Durable Object classes: it adds Archive', true]]);
    // A new alias is an address change too (BRK-78): wrangler deploy adds its custom domain.
    const moving = { ...base, url: 'https://new.example.com' };
    expect(changes(shape(moving), shape({ ...moving, aliases: ['https://old.example.com'] }))).toEqual([
      ['its address (routes)', true],
    ]);
  });

  it('never applies another Worker, another Durable Object, or a class deleted, renamed, or moved', () => {
    expect(changes(shape(base), shape({ ...base, worker: 'board-2' }))).toEqual([
      ['its Worker’s name (worker)', false],
    ]);
    expect(changes(shape(base), shape({ ...base, store: 'other' }))).toEqual([['its Durable Object (store)', false]]);
    expect(changes(shape(base), shape({ ...base, jurisdiction: 'eu' }))).toEqual([['its jurisdiction', false]]);
    const moved = 'its Durable Object classes: it deletes, renames, or moves one';
    const deleted = shape(base, (w) => withClass(w, { tag: 'v2', deleted_classes: ['TaskStore'] }, null));
    expect(changes(shape(base), deleted)).toEqual([[moved, false]]);
    const renamed = shape(base, (w) => ({
      ...w,
      durable_objects: { bindings: [{ name: 'STORE', class_name: 'Store' }] },
      migrations: [...w.migrations, { tag: 'v2', renamed_classes: [{ from: 'TaskStore', to: 'Store' }] }],
    }));
    expect(changes(shape(base), renamed)).toEqual([[moved, false]]);
    // A migration history rewritten, rather than added to, is never applied either.
    const rewritten = shape(base, (w) => ({ ...w, migrations: [{ tag: 'v1', new_sqlite_classes: ['Other'] }] }));
    expect(changes(shape(base), rewritten)).toEqual([[moved, false]]);
  });
});

describe('the deploy plan', () => {
  const base = { name: 'board', worker: 'board' };
  const shape = (config) => shapeOf(wranglerConfig(config));
  const manifest = { version: '0.2.0', manual: false, updatesFrom: '0.1.0' };
  const plan = (after, opts = {}) => deployPlan(manifest, { version: '0.2.0', before: shape(base), after, ...opts });

  it('uploads a version when nothing a version can’t carry changes, or there is nothing to compare', () => {
    expect(plan(shape({ ...base, name: 'Other' }))).toEqual({
      ok: true,
      deploy: 'versions',
      changes: [],
      addressChanged: false,
    });
    expect(deployPlan(manifest, { version: '0.2.0' })).toMatchObject({ ok: true, deploy: 'versions' });
  });

  it('stops an address change without the install’s say-so, naming what to set', () => {
    const verdict = plan(shape({ ...base, url: 'https://tasks.example.com' }));
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('its address (routes)');
    expect(verdict.message).toContain('BREAKAWAY_DEPLOY_CHANGES');
    expect(verdict.message).toContain('npx breakaway install config');
    expect(configStop(['its address (routes)', 'its workers.dev address'])).toBe(verdict.message);
  });

  it('runs wrangler deploy for it with the install’s say-so', () => {
    expect(plan(shape({ ...base, url: 'https://tasks.example.com' }), { apply: true })).toEqual({
      ok: true,
      deploy: 'wrangler',
      changes: ['its address (routes)', 'its workers.dev address'],
      addressChanged: true,
    });
  });

  it('runs wrangler deploy for a manual release that says it is all wrangler deploy does', () => {
    const release = { ...manifest, manual: true, manualSteps: ['Deploy with wrangler deploy.'], wranglerDeploy: true };
    expect(deployPlan(release, { version: '0.2.0', apply: true })).toEqual({
      ok: true,
      deploy: 'wrangler',
      changes: [],
      addressChanged: false,
    });
  });

  it('never deploys a change that opens an empty board, whatever the install allows', () => {
    const verdict = plan(shape({ ...base, store: 'other' }), { apply: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('its Durable Object (store)');
    expect(verdict.message).toContain('empty board');
    expect(verdict.message).toContain('nothing was deployed');
  });
});

describe('rollback', () => {
  it('goes to the version the newest deployment ran before', () => {
    const deployments = [
      { created_on: '2026-10-01T10:00:00Z', versions: [{ version_id: 'old', percentage: 100 }] },
      { created_on: '2026-10-02T10:00:00Z', versions: [{ version_id: 'new', percentage: 100 }] },
    ];
    expect(previousVersionId(deployments)).toBe('new');
    expect(previousVersionId([])).toBeNull();
    expect(previousVersionId({})).toBeNull();
  });

  it('takes a failed list for a first deploy only when the Worker does not exist', () => {
    expect(workerMissing('✘ [ERROR] This Worker does not exist on your account. [code: 10007]')).toBe(true);
    expect(
      workerMissing('✘ [ERROR] A request to the Cloudflare API failed. Invalid account identifier [code: 7003]'),
    ).toBe(false);
    expect(workerMissing('')).toBe(false);
  });

  it('accepts only the release it expects from /api/ping', () => {
    expect(isHealthy({ ok: true, release: '0.2.0' }, '0.2.0')).toBe(true);
    expect(isHealthy({ ok: true, release: '0.1.0' }, '0.2.0')).toBe(false);
    expect(isHealthy(null, '0.2.0')).toBe(false);
  });
});

describe('updating', () => {
  const stable = { channel: 'stable', version: '0.2.0' };

  it('bumps stable to a newer stable release, and never to an older one or a pre-release', () => {
    expect(updatePlan(stable, latestReleases(feed('0.3.0', '0.3.1-main.1')))).toEqual({
      action: 'bump',
      version: '0.3.0',
      tag: 'v0.3.0',
    });
    expect(updatePlan(stable, latestReleases(feed('0.2.0', '0.2.1-main.1'))).action).toBe('none');
    expect(updatePlan(stable, latestReleases(feed('0.1.0', null))).action).toBe('none');
    expect(updatePlan(stable, latestReleases(feed(null, null))).reason).toContain('no stable release');
  });

  it('deploys main when a newer pre-release than the running one exists', () => {
    const main = { channel: 'main', version: '0.2.1-main.1' };
    expect(updatePlan(main, latestReleases(feed(null, '0.2.1-main.3')), '0.2.1-main.1')).toEqual({
      action: 'deploy',
      version: '0.2.1-main.3',
      tag: 'v0.2.1-main.3',
    });
    expect(updatePlan(main, latestReleases(feed(null, '0.2.1-main.3')), '0.2.1-main.3').action).toBe('none');
    expect(updatePlan(main, latestReleases(feed(null, '0.2.1-main.3')), null).reason).toContain(
      'running release is unknown',
    );
  });

  it('writes the pull request’s description, with a manual release’s steps', () => {
    const plain = bumpBody({
      from: '0.2.0',
      to: '0.3.0',
      repository: 'acme/breakaway',
      notes: '### Board\n- a change',
      manifest: { manual: false },
    });
    expect(plain).toContain('Updates breakaway from 0.2.0 to 0.3.0. Merging this deploys it.');
    expect(plain).toContain('https://github.com/acme/breakaway/releases/tag/v0.3.0');
    expect(plain).toContain('- a change');
    const manual = bumpBody({
      from: '0.2.0',
      to: '0.3.0',
      repository: 'acme/breakaway',
      notes: '',
      manifest: { manual: true, manualSteps: ['Do this.'] },
    });
    expect(manual).toContain("won't deploy it");
    expect(manual).toContain('- Do this.');
  });
});
