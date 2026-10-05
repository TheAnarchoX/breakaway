import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import template from '../breakaway.config.json';
import templateJsonc from '../wrangler.jsonc?raw';
import devVarsExample from '../.dev.vars.example?raw';
import { summarizeDeliveries } from '../src/connections.js';
import { appManifest, repoRef } from '../src/github.js';
import {
  DEFAULTS,
  SECRET_KEYS,
  ConfigError,
  docsLink,
  install,
  parseInstall,
  parseJsonc,
  secretName,
  wranglerConfig,
} from '../src/install.js';
import { pingMessage } from '../src/push.js';

/** Another board: different names everywhere, and breakaway's default prefix. */
const ACME = {
  name: 'acme board',
  worker: 'acme-board',
  url: 'https://board.acme.test',
  store: 'acme',
  secretsStore: 'f'.repeat(32),
};

describe('an install’s config', () => {
  it('fills in breakaway’s defaults, so a new install needs only its URL', () => {
    const c = parseInstall({ url: 'https://board.example.com/' });
    expect(c).toEqual({ ...DEFAULTS, url: 'https://board.example.com' });
    expect(secretName(c, 'API_TOKEN')).toBe('BREAKAWAY_API_TOKEN');
  });

  it('refuses what wrangler or Cloudflare would, naming the setting', () => {
    expect(() => parseInstall(null)).toThrow(ConfigError);
    expect(() => parseInstall({ url: '' })).toThrow(/url/u);
    expect(() => parseInstall({ url: 'http://board.example.com' })).toThrow(/https origin/u);
    expect(() => parseInstall({ url: 'https://board.example.com/app' })).toThrow(/https origin/u);
    expect(() => parseInstall({ url: 'https://b.example.com', secretsPrefix: 'acme' })).toThrow(/secretsPrefix/u);
    expect(() => parseInstall({ url: 'https://b.example.com', secretsPrefix: 'ACME' })).toThrow(/ends with _/u);
    expect(() => parseInstall({ url: 'https://b.example.com', worker: 'Acme Board' })).toThrow(/worker/u);
    expect(() => parseInstall({ url: 'https://b.example.com', store: '' })).toThrow(/store/u);
    expect(() => parseInstall({ url: 'https://b.example.com', secretsStore: 'nope' })).toThrow(/Secrets Store/u);
    expect(() => parseInstall({ url: 'https://b.example.com', repository: 'nope' })).toThrow(/owner\/name/u);
    expect(() => parseInstall({ url: 'https://b.example.com', jurisdiction: 'mars' })).toThrow(/jurisdiction/u);
    expect(() => parseInstall({ url: 'https://b.example.com', prefix: 'X_' })).toThrow(/unknown setting: prefix/u);
  });

  it('gives another install its own names throughout', () => {
    const c = wranglerConfig({ ...ACME, repository: 'acme/widgets', jurisdiction: 'eu' });
    expect(c.name).toBe('acme-board');
    expect(c.routes).toEqual([{ pattern: 'board.acme.test', custom_domain: true }]);
    expect(c.secrets_store_secrets).toContainEqual({
      binding: 'TASKS_API_TOKEN',
      store_id: 'f'.repeat(32),
      secret_name: 'BREAKAWAY_API_TOKEN',
    });
    expect(
      c.secrets_store_secrets.every((s) => s.secret_name.startsWith('BREAKAWAY_') && s.binding.startsWith('TASKS_')),
    ).toBe(true);
    expect(c.vars).toMatchObject({
      TASKS_GITHUB_REPO: 'acme/widgets',
      TASKS_JURISDICTION: 'eu',
      TASKS_INSTALL: { name: 'acme board', store: 'acme' },
    });
    expect(JSON.stringify(c)).not.toMatch(/samewave/iu);
  });

  it('leaves out what a fresh install doesn’t have yet', () => {
    const c = wranglerConfig({ url: 'https://board.example.com' });
    expect(c.secrets_store_secrets).toBeUndefined(); // secrets set with wrangler, not the Secrets Store
    expect(c.vars).toEqual({
      TASKS_INSTALL: expect.objectContaining({ name: 'breakaway', store: 'breakaway', docs: null }),
    });
  });

  it('answers on workers.dev when it has no URL of its own', () => {
    expect(parseInstall({}).url).toBeNull();
    const c = wranglerConfig({});
    expect(c.workers_dev).toBe(true);
    expect(c.routes).toBeUndefined();
    expect(c.vars.TASKS_INSTALL.url).toBeNull();
    expect(install(c.vars).url).toBeNull(); // never samewave's URL
    expect(wranglerConfig(ACME).workers_dev).toBe(false);
  });

  it('answers on other addresses beside its URL while it moves (BRK-78)', () => {
    const moving = { ...ACME, aliases: ['https://old.acme.test/'] };
    expect(parseInstall(moving).aliases).toEqual(['https://old.acme.test']);
    expect(wranglerConfig(moving).routes).toEqual([
      { pattern: 'board.acme.test', custom_domain: true },
      { pattern: 'old.acme.test', custom_domain: true },
    ]);
    // The board's own address is still its url: pushes, Connections, and self-update use that one.
    expect(install(wranglerConfig(moving).vars).url).toBe('https://board.acme.test');
    expect(parseInstall(ACME).aliases).toEqual([]);
    expect(wranglerConfig(ACME).routes).toHaveLength(1);
    expect(wranglerConfig(moving, { local: true }).routes).toBeUndefined();
  });

  it('refuses an alias that isn’t another https address beside a url', () => {
    expect(() => parseInstall({ aliases: ['https://old.acme.test'] })).toThrow(/aliases need a url/u);
    expect(() => parseInstall({ ...ACME, aliases: 'https://old.acme.test' })).toThrow(/aliases is a list/u);
    expect(() => parseInstall({ ...ACME, aliases: ['http://old.acme.test'] })).toThrow(/https origin/u);
    expect(() => parseInstall({ ...ACME, aliases: ['https://board.acme.test'] })).toThrow(/already the url/u);
    expect(() => parseInstall({ ...ACME, aliases: ['https://a.acme.test', 'https://a.acme.test/'] })).toThrow(/twice/u);
  });

  it('makes a local config for wrangler dev that lives anywhere', () => {
    const c = wranglerConfig({ ...ACME, jurisdiction: 'eu' }, { local: true, root: '/work/tools/tasks' });
    expect(c.main).toBe('/work/tools/tasks/src/worker.js');
    expect(c.assets.directory).toBe('/work/tools/tasks/web/public');
    expect(c.routes).toBeUndefined();
    expect(c.secrets_store_secrets).toBeUndefined();
    expect(c.vars.TASKS_JURISDICTION).toBeUndefined();
  });

  it('reads JSONC as wrangler does, leaving // inside strings alone', () => {
    expect(parseJsonc('{\n  // a comment\n  "url": "https://x.test", /* block */ "list": [1, 2,],\n}')).toEqual({
      url: 'https://x.test',
      list: [1, 2],
    });
  });
});

describe('the Worker’s install', () => {
  it('is a new install’s defaults when the Worker has no TASKS_INSTALL', () => {
    for (const env of [{}, { TASKS_INSTALL: 'not json' }])
      expect(install(env)).toMatchObject({
        name: 'breakaway',
        worker: 'breakaway',
        url: null,
        secretsPrefix: 'BREAKAWAY_',
        store: 'breakaway',
        docs: null,
      });
  });

  it('says which Secrets Store it uses, so the owner’s commands can check they write to it (BRK-95)', () => {
    const vars = wranglerConfig(ACME).vars;
    expect(vars.TASKS_INSTALL.secretsStore).toBe(ACME.secretsStore);
    expect(install(vars).secretsStore).toBe(ACME.secretsStore);
    expect(install(wranglerConfig({}).vars).secretsStore).toBeNull(); // Worker secrets
    expect(wranglerConfig(ACME, { local: true }).vars.TASKS_INSTALL.secretsStore).toBeNull();
    // A Worker deployed before BRK-95 doesn't say: unknown, not "none".
    expect(install({ TASKS_INSTALL: { name: 'acme' } })).not.toHaveProperty('secretsStore');
  });

  it('reads TASKS_INSTALL as an object or as JSON text', () => {
    const vars = wranglerConfig(ACME).vars;
    expect(install(vars)).toMatchObject({ name: 'acme board', store: 'acme', secretsPrefix: 'BREAKAWAY_', docs: null });
    expect(install({ TASKS_INSTALL: JSON.stringify(vars.TASKS_INSTALL) }).worker).toBe('acme-board');
    expect(docsLink(install(vars), 'secrets')).toBeNull();
    expect(docsLink({ docs: 'https://docs.acme.test/tasks' }, 'secrets')).toBe('https://docs.acme.test/tasks#secrets');
  });

  it('names the install in pushes, the GitHub App, and webhook fixes', () => {
    const acme = install(wranglerConfig(ACME).vars);
    expect(pingMessage({ id: 1, task: 'CLD-1', kind: 'blocked', message: 'x' }, acme.name).title).toBe('acme board');
    expect(appManifest(acme.url, repoRef('acme/widgets'), acme.name)).toMatchObject({
      name: 'acme board',
      url: 'https://board.acme.test',
    });
    const fix = summarizeDeliveries(
      [{ event: 'push', status_code: 401 }],
      acme.url,
      secretName(acme, 'GITHUB_WEBHOOK_SECRET'),
    ).fix;
    expect(fix).toContain('BREAKAWAY_GITHUB_WEBHOOK_SECRET');
    expect(fix).not.toMatch(/samewave/iu);
  });

  it('names the install’s Worker and secrets in Connections', async () => {
    const stub = env.STORE.get(env.STORE.idFromName('widgets'));
    await runInDurableObject(stub, async (instance) => {
      const own = instance.env;
      try {
        instance.env = { ...own, TASKS_INSTALL: wranglerConfig(ACME).vars.TASKS_INSTALL };
        const [, secrets, cron] = await instance.cloudflareConnections();
        expect(cron.fix).toContain('Workers → acme-board → Settings');
        expect(secrets.link).toBeNull();
      } finally {
        instance.env = own;
      }
      const [, secrets, cron] = await instance.cloudflareConnections();
      expect(cron.fix).toContain('Workers → widgets-tasks → Settings');
      expect(secrets.link).toBe('https://github.com/acme/widgets/blob/main/docs/tasks.md#secrets');
    });
  });
});

/** The `KEY=value` lines of a .dev.vars file, as dotenv reads them: a `#` after spaces starts a comment. */
function devVars(text) {
  return Object.fromEntries(
    text
      .split('\n')
      .filter((line) => /^[A-Z]/u.test(line))
      .map((line) => {
        const [key, ...rest] = line.split('=');
        return [
          key,
          rest
            .join('=')
            .replace(/\s+#.*$/u, '')
            .trim(),
        ];
      }),
  );
}

describe('the root config, a new install’s template (BRK-5)', () => {
  it('is wrangler.jsonc for breakaway.config.json, so the two never drift', () => {
    const { $schema, ...checkedIn } = parseJsonc(templateJsonc);
    expect($schema).toBeTruthy();
    expect(wranglerConfig(template)).toEqual(checkedIn);
  });

  it('deploys a fresh board on workers.dev: no custom domain, Secrets Store, repository, or samewave', () => {
    const c = parseJsonc(templateJsonc);
    expect(c).toMatchObject({
      name: 'breakaway',
      workers_dev: true,
      main: './src/worker.js',
      assets: { directory: './dist' },
    });
    expect(c.routes).toBeUndefined();
    expect(c.secrets_store_secrets).toBeUndefined();
    expect(c.vars.TASKS_GITHUB_REPO).toBeUndefined(); // so the board starts with Connections' setup (CLD-131)
    expect(c.durable_objects.bindings).toEqual([{ name: 'STORE', class_name: 'TaskStore' }]);
    expect(c.migrations).toEqual([{ tag: 'v1', new_sqlite_classes: ['TaskStore'] }]);
    expect(`${JSON.stringify(c)}${JSON.stringify(template)}`).not.toMatch(/samewave/iu);
    expect(parseInstall(template)).toEqual({ ...DEFAULTS });
  });

  it('asks for every secret the Worker binds, with the three it needs left blank', () => {
    const vars = devVars(devVarsExample);
    expect(Object.keys(vars).sort()).toEqual(SECRET_KEYS.map((k) => `TASKS_${k}`).sort());
    for (const required of ['TASKS_API_TOKEN', 'TASKS_CLIENT_ID', 'TASKS_SYNC_KEY']) expect(vars[required]).toBe('');
    for (const [key, value] of Object.entries(vars))
      if (!['TASKS_API_TOKEN', 'TASKS_CLIENT_ID', 'TASKS_SYNC_KEY'].includes(key)) expect(value).toBe('unset');
  });
});
