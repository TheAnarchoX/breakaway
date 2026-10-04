import { env, runInDurableObject } from 'cloudflare:test';
import { gzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assetHash } from '../src/cloudflare-deploy.js';
import { assetFiles, untar, workerModules } from '../src/self-update-bundle.js';
import { FEED_URL } from '../src/updates.js';
import { api } from './helpers.js';

// BRK-53: an install with no repository updates its own Worker from the board: verify, upload a version, deploy it,
// check it answers, and go back if it doesn't. Cloudflare, the feed, and the downloads are mocked.
const enc = (text) => new TextEncoder().encode(text);
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const hex = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );

/** A gzipped tarball of `files` (path → text), as the Release workflow's `tar -czf` makes one. */
function tarball(files) {
  const blocks = [];
  for (const [path, text] of Object.entries(files)) {
    const body = enc(text);
    const header = new Uint8Array(512);
    header.set(enc(`./${path}`));
    header.set(enc(`${body.length.toString(8).padStart(11, '0')}\0`), 124);
    header[156] = 48;
    blocks.push(header, body, new Uint8Array((512 - (body.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const tar = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of blocks) {
    tar.set(b, at);
    at += b.length;
  }
  return gzipSync(tar);
}

const FILES = {
  'worker/package.json': '{"name":"breakaway","version":"0.2.0-main.5"}',
  'worker/src/worker.js':
    "import { gcm } from '@noble/ciphers/aes.js';\nimport { zlibSync } from 'fflate';\nexport default {};\n",
  'worker/src/build.js': "import pkg from '../package.json' with { type: 'json' };\nexport const v = pkg.version;\n",
  'dist/index.html': '<!doctype html>',
  'dist/assets/app.js': 'console.log(1)',
  'node_modules/fflate/package.json': JSON.stringify({
    name: 'fflate',
    exports: { '.': { node: { import: './esm/index.mjs' }, import: './esm/browser.js' } },
  }),
  'node_modules/fflate/esm/browser.js': 'export const zlibSync = () => 1;',
  'node_modules/@noble/ciphers/package.json': JSON.stringify({
    name: '@noble/ciphers',
    exports: { './aes.js': './aes.js' },
  }),
  'node_modules/@noble/ciphers/aes.js': "import { x } from './_arx.js';\nexport const gcm = x;\n",
  'node_modules/@noble/ciphers/_arx.js': 'export const x = 1;',
};

describe('reading a release bundle', () => {
  it('names the modules as their imports spell them, and gives bare imports a module', () => {
    const files = untar(tarball(FILES));
    const { main, modules } = workerModules(files);
    const names = modules.map((m) => m.name).sort();
    expect(main).toBe('src/worker.js');
    expect(names).toEqual(
      expect.arrayContaining([
        'package.json',
        'src/worker.js',
        'src/build.js',
        'fflate',
        '@noble/ciphers/aes.js',
        'node_modules/fflate/esm/browser.js',
        'node_modules/@noble/ciphers/aes.js',
        'node_modules/@noble/ciphers/_arx.js',
      ]),
    );
    const shim = modules.find((m) => m.name === '@noble/ciphers/aes.js');
    expect(shim.content).toContain("from '../../node_modules/@noble/ciphers/aes.js'");
    expect(modules.find((m) => m.name === 'fflate').content).toContain("'./node_modules/fflate/esm/browser.js'");
    expect([...assetFiles(files).keys()].sort()).toEqual(['/assets/app.js', '/index.html']);
  });

  it('refuses a bundle without a package it imports, and an unsafe path', () => {
    const { 'node_modules/fflate/package.json': _, ...rest } = FILES;
    expect(() => workerModules(untar(tarball(rest)))).toThrow(/missing the package fflate/u);
    expect(() => untar(tarball({ '../evil': 'x' }))).toThrow(/unsafe/u);
  });

  it('hashes an asset the way Cloudflare’s upload does', async () => {
    expect(await assetHash(enc('hi'), '/a.html')).toMatch(/^[0-9a-f]{32}$/u);
    expect(await assetHash(enc('hi'), '/a.html')).not.toBe(await assetHash(enc('hi'), '/a.css'));
  });
});

const ACCOUNT = 'a'.repeat(32);
const TOKEN = 'cf-token-for-tests-1234567890';
const NOW_RUNNING = '0.2.0-main.3';
const TARGET = '0.2.0-main.5';
const world = {};

const SHAPE = {
  bindings: ['durable_object_namespace:STORE', 'version_metadata:VERSION'],
  durableObjects: ['TaskStore'],
  migrations: ['v1'],
  crons: ['*/5 * * * *'],
  routes: [],
};

/** Serves a signed manifest for the release with `extra` on top, in place of the one setup made. */
async function serve(extra) {
  const bundle = world.served.get('https://dl.test/v/breakaway-bundle.tar.gz');
  const manifest = JSON.stringify({
    version: TARGET,
    manual: false,
    updatesFrom: '0.1.0',
    bundleSha256: await hex(bundle),
    shape: SHAPE,
    ...extra,
  });
  const sig = b64(await crypto.subtle.sign({ name: 'Ed25519' }, world.privateKey, enc(manifest)));
  world.served.set('https://dl.test/v/manifest.json', manifest);
  world.served.set('https://dl.test/v/manifest.json.sig', sig);
  world.served.set(
    'https://dl.test/v/SHA256SUMS',
    `${await hex(bundle)}  breakaway-bundle.tar.gz\n${await hex(enc(manifest))}  manifest.json\n`,
  );
}

async function setup() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const bundle = tarball(FILES);
  const manifest = JSON.stringify({
    version: TARGET,
    manual: false,
    updatesFrom: '0.1.0',
    bundleSha256: await hex(bundle),
    shape: SHAPE,
  });
  const sig = b64(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, enc(manifest)));
  const sums = `${await hex(bundle)}  breakaway-bundle.tar.gz\n${await hex(enc(manifest))}  manifest.json\n`;
  const dl = 'https://dl.test/v';
  Object.assign(world, {
    privateKey: pair.privateKey,
    crons: ['*/5 * * * *'],
    publicKey: b64(await crypto.subtle.exportKey('raw', pair.publicKey)),
    served: new Map([
      [`${dl}/breakaway-bundle.tar.gz`, bundle],
      [`${dl}/manifest.json`, manifest],
      [`${dl}/SHA256SUMS`, sums],
      [`${dl}/manifest.json.sig`, sig],
    ]),
    feed: {
      channels: {
        main: {
          version: TARGET,
          manual: false,
          updatesFrom: '0.1.0',
          bundle: `${dl}/breakaway-bundle.tar.gz`,
          manifest: `${dl}/manifest.json`,
          checksums: `${dl}/SHA256SUMS`,
          signature: `${dl}/manifest.json.sig`,
        },
      },
    },
    calls: [],
    uploads: [],
    failUpload: false,
    refuse: false,
    deployed: undefined,
    secret: undefined,
  });
}

function mock() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = init.method ?? 'GET';
    const reply = (result, status = 200) =>
      new Response(
        JSON.stringify({ success: status < 400, errors: status < 400 ? [] : [{ message: 'nope' }], result }),
        {
          status,
        },
      );
    if (url.href === FEED_URL) return new Response(JSON.stringify(world.feed));
    if (world.served.has(url.href)) return new Response(world.served.get(url.href));
    if (url.host !== 'api.cloudflare.com') throw new Error(`unexpected fetch to ${url}`);
    world.calls.push(`${method} ${url.pathname.replace(/^\/client\/v4\/accounts\/[0-9a-f]+/u, '')}`);
    if (world.refuse) return reply(null, 403);
    const path = url.pathname;
    if (path.endsWith('/settings'))
      return reply({
        compatibility_date: '2026-09-26',
        bindings: [
          { type: 'durable_object_namespace', name: 'STORE', class_name: 'TaskStore' },
          { type: 'json', name: 'TASKS_INSTALL', json: { name: 'acme' } },
          { type: 'plain_text', name: 'BREAKAWAY_VERSION', text: NOW_RUNNING },
          { type: 'secret_text', name: 'TASKS_API_TOKEN' },
          { type: 'version_metadata', name: 'VERSION' },
        ],
      });
    if (path.endsWith('/schedules')) return reply({ schedules: world.crons.map((cron) => ({ cron })) });
    if (path.endsWith('/deployments') && method === 'GET')
      return reply({ deployments: [{ versions: [{ version_id: 'old-version', percentage: 100 }] }] });
    if (path.endsWith('/deployments') && method === 'POST') {
      world.deployed = JSON.parse(init.body);
      return reply({ id: 'dep' });
    }
    if (path.endsWith('/secrets') && method === 'PUT') {
      world.secret = JSON.parse(init.body);
      return reply({ name: world.secret.name });
    }
    if (path.endsWith('/assets-upload-session'))
      return reply({ jwt: 'session-jwt', buckets: [Object.values(JSON.parse(init.body).manifest).map((f) => f.hash)] });
    if (path.endsWith('/workers/assets/upload')) return reply({ jwt: 'completion-jwt' });
    if (path.endsWith('/versions') && method === 'POST') {
      if (world.failUpload) return reply(null, 400);
      const form = init.body;
      world.uploads.push({ metadata: JSON.parse(await form.get('metadata').text()), names: [...form.keys()] });
      return reply({ id: 'new-version' });
    }
    return reply(null, 404);
  });
}

const stub = () => env.STORE.get(env.STORE.idFromName('acme'));
/** Runs `fn` as a board with no install repository, running `running`, holding the token. */
const asBoard = (fn, { token = TOKEN, running = NOW_RUNNING, install = {} } = {}) =>
  runInDurableObject(stub(), async (instance) => {
    const own = instance.env;
    try {
      instance.env = {
        ...own,
        TASKS_INSTALL: { ...own.TASKS_INSTALL, installRepository: null, worker: 'acme-board', ...install },
        BREAKAWAY_VERSION: running,
        ...(token ? { TASKS_UPDATE_TOKEN: token } : {}),
      };
      instance.releasePublicKey = world.publicKey;
      instance.setMeta('selfupd', null);
      instance.setMeta('selfupd_cfg', token ? JSON.stringify({ accountId: ACCOUNT }) : null);
      return await fn(instance);
    } finally {
      instance.env = own;
      instance.releasePublicKey = undefined;
    }
  });

beforeEach(async () => {
  await setup();
  mock();
});
afterEach(() => vi.restoreAllMocks());

describe('updating the Worker from the board', () => {
  it('uploads the release as a version with the running Worker’s bindings, deploys it, and passes its check', async () => {
    await asBoard(async (s) => {
      const res = await s.selfUpdateStart({ wait: true });
      expect(res.status).toBe(202);
      expect(s.selfUpdateState()).toMatchObject({ status: 'checking', target: TARGET, previousId: 'old-version' });
      const { metadata, names } = world.uploads[0];
      expect(metadata.main_module).toBe('src/worker.js');
      expect(metadata.keep_bindings).toContain('secret_text');
      expect(metadata.assets.jwt).toBe('completion-jwt');
      const bindings = Object.fromEntries(metadata.bindings.map((b) => [b.name, b]));
      expect(bindings.STORE.type).toBe('durable_object_namespace');
      expect(bindings.BREAKAWAY_VERSION.text).toBe(TARGET);
      expect(bindings.TASKS_API_TOKEN).toBeUndefined();
      expect(bindings.ASSETS.type).toBe('assets');
      expect(names).toEqual(expect.arrayContaining(['src/worker.js', 'package.json', 'fflate']));
      expect(world.deployed.versions).toEqual([{ percentage: 100, version_id: 'new-version' }]);
      // Before the new code runs, the check waits; once it reports the release, the update is done.
      await s.selfUpdateTick();
      expect(s.selfUpdateState().status).toBe('checking');
      s.env.BREAKAWAY_VERSION = TARGET;
      await s.selfUpdateTick();
      expect(s.selfUpdateState()).toMatchObject({ status: 'done', message: `Updated to ${TARGET}.` });
      expect(world.calls.filter((c) => c === 'POST /workers/scripts/acme-board/deployments')).toHaveLength(1);
    });
  });

  it('leaves the running version untouched when the upload fails, and says which step', async () => {
    world.failUpload = true;
    await asBoard(async (s) => {
      await s.selfUpdateStart({ wait: true });
      expect(s.selfUpdateState()).toMatchObject({ status: 'failed', step: 'upload' });
      expect(s.selfUpdateState().message).toContain(`still on ${NOW_RUNNING}`);
      expect(world.deployed).toBeUndefined();
    });
  });

  it('rolls back to the previous version when the new code doesn’t answer in a minute', async () => {
    await asBoard(async (s) => {
      await s.selfUpdateStart({ wait: true });
      const state = s.selfUpdateState();
      s.saveSelfUpdate({ ...state, deadline: Date.now() - 1 });
      await s.selfUpdateTick();
      expect(world.deployed.versions).toEqual([{ percentage: 100, version_id: 'old-version' }]);
      expect(s.selfUpdateState()).toMatchObject({ status: 'rolledback' });
      expect(s.selfUpdateState().message).toBe(`The update failed its check and was rolled back to ${NOW_RUNNING}.`);
    });
  });

  it('rolls back when the new code answers but its secrets can’t be read', async () => {
    await asBoard(async (s) => {
      await s.selfUpdateStart({ wait: true });
      s.env.BREAKAWAY_VERSION = TARGET;
      s.env.TASKS_SYNC_KEY = { get: async () => Promise.reject(new Error('Failed to fetch secret')) };
      await s.selfUpdateTick();
      expect(s.selfUpdateState().status).toBe('checking');
      s.saveSelfUpdate({ ...s.selfUpdateState(), deadline: Date.now() - 1 });
      await s.selfUpdateTick();
      expect(world.deployed.versions).toEqual([{ percentage: 100, version_id: 'old-version' }]);
      expect(s.selfUpdateState().status).toBe('rolledback');
    });
  });

  it('refuses a second update while one is running', async () => {
    await asBoard(async (s) => {
      await s.selfUpdateStart({ wait: true });
      const calls = world.calls.length;
      const second = await s.selfUpdateStart({ wait: true });
      expect(second.status).toBe(409);
      expect(second.body.error).toContain('already running');
      expect(world.calls).toHaveLength(calls);
    });
  });

  it('installs nothing from a release that fails its signature, and from a manual one', async () => {
    await asBoard(async (s) => {
      world.served.set('https://dl.test/v/manifest.json.sig', b64(new Uint8Array(64)));
      await s.selfUpdateStart({ wait: true });
      expect(s.selfUpdateState()).toMatchObject({ status: 'failed', step: 'verify' });
      expect(world.calls).toEqual([]);
    });
  });

  it('stops a manual release, and a release whose shape the install doesn’t have, with the steps and nothing changed', async () => {
    const run = async (extra, setupWorld) => {
      await setup();
      setupWorld?.();
      await serve(extra);
      return asBoard(async (s) => {
        await s.selfUpdateStart({ wait: true });
        const state = s.selfUpdateState();
        expect(state).toMatchObject({ status: 'failed' });
        expect(world.uploads).toEqual([]);
        expect(world.deployed).toBeUndefined();
        return state;
      });
    };
    const manual = await run({ manual: true, manualSteps: ['Add the new cron trigger.'] });
    expect(manual.message).toContain('Add the new cron trigger.');
    const cron = await run({
      shape: { ...SHAPE, crons: ['*/5 * * * *', '0 * * * *'] },
      manualSteps: ['Add the cron.'],
    });
    expect(cron).toMatchObject({ step: 'release' });
    expect(cron.message).toContain('cron triggers are */5 * * * *, 0 * * * *');
    expect(cron.message).toContain('Add the cron.');
    expect(cron.message).toContain('Nothing changed.');
    const klass = await run({ shape: { ...SHAPE, durableObjects: ['TaskStore', 'Queue'] } });
    expect(klass.message).toContain('Durable Object classes this Worker doesn’t have (Queue)');
    const binding = await run({ shape: { ...SHAPE, bindings: [...SHAPE.bindings, 'durable_object_namespace:QUEUE'] } });
    expect(binding.message).toContain('durable_object_namespace:QUEUE');
    const unlisted = await run({ shape: undefined });
    expect(unlisted.message).toContain('doesn’t list the shape');
  });

  it('installs a release whose shape the install matches, even with extra bindings the owner added', async () => {
    await asBoard(async (s) => {
      await s.selfUpdateStart({ wait: true });
      expect(s.selfUpdateState().status).toBe('checking');
    });
  });

  it('says there is nothing to do when the board is up to date', async () => {
    await asBoard(
      async (s) => {
        await s.selfUpdateStart({ wait: true });
        expect(s.selfUpdateState()).toMatchObject({ status: 'idle', message: 'Up to date.' });
      },
      { running: TARGET },
    );
  });

  it('goes back to the previous version on Roll back, once', async () => {
    await asBoard(async (s) => {
      expect((await s.selfUpdateRollback()).status).toBe(409);
      await s.selfUpdateStart({ wait: true });
      s.env.BREAKAWAY_VERSION = TARGET;
      await s.selfUpdateTick();
      expect((await s.selfUpdateRollback()).status).toBe(200);
      expect(world.deployed.versions[0].version_id).toBe('old-version');
      expect((await s.selfUpdateRollback()).status).toBe(409);
    });
  });

  it('is off without a token, and for an install that has a repository', async () => {
    await asBoard(async (s) => expect((await s.selfUpdateStart({ wait: true })).status).toBe(409), { token: null });
    await asBoard(async (s) => expect((await s.selfUpdateStart({ wait: true })).status).toBe(409), {
      install: { installRepository: 'acme/board' },
    });
    expect(world.calls).toEqual([]);
  });
});

describe('turning self-update on', () => {
  it('checks the token reaches the Worker, then keeps it as a Worker secret and the account beside it', async () => {
    await asBoard(
      async (s) => {
        const bad = await s.selfUpdateEnable({ token: 'short', accountId: ACCOUNT });
        expect(bad.status).toBe(400);
        const res = await s.selfUpdateEnable({ token: TOKEN, accountId: ACCOUNT });
        expect(res.status).toBe(200);
        expect(world.secret).toEqual({ name: 'TASKS_UPDATE_TOKEN', text: TOKEN, type: 'secret_text' });
        expect(JSON.stringify(res.body)).not.toContain(TOKEN);
        expect(s.selfUpdateConfig()).toMatchObject({ accountId: ACCOUNT });
      },
      { token: null },
    );
  });

  it('says what to do when Cloudflare refuses the token, and stores nothing', async () => {
    world.refuse = true;
    await asBoard(
      async (s) => {
        const res = await s.selfUpdateEnable({ token: TOKEN, accountId: ACCOUNT });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe(
          'Cloudflare refused the token. Make a new one with Workers Scripts: edit and paste it here.',
        );
        expect(s.selfUpdateConfig()).toBeNull();
      },
      { token: null },
    );
  });

  it('checks for updates only once it is on, and Connections reads what the check kept', async () => {
    await asBoard(
      async (s) => {
        expect((await s.selfUpdateCheck()).status).toBe(409);
        const api = (await s.selfUpdateApi()).body.selfUpdate;
        expect(api).toMatchObject({ allowed: true, enabled: false });
        expect(typeof api.running).toBe('string');
      },
      { token: null },
    );
    await asBoard(async (s) => expect((await s.selfUpdateCheck()).status).toBe(409), {
      install: { installRepository: 'acme/board' },
    });
  });

  it('is the signed-in browser’s alone: the bearer token is refused', async () => {
    for (const action of ['enable', 'disable', 'start', 'rollback', 'check']) {
      const res = await api(`self-update/${action}`, { method: 'POST', body: {} });
      expect(res.status).toBe(403);
    }
  });
});
