/**
 * The install: what makes one board itself rather than another (docs/specs/IDEA-13-breakaway.md, section 2).
 * An install's breakaway.config.json names its Worker, its URL, the prefix of its Secrets Store secrets,
 * its Durable Object, and its default repository; `node tools/tasks/install.mjs` turns it into the
 * Worker's wrangler config, and the Worker reads it back from the `TASKS_INSTALL` var.
 *
 * Pure, so it's tested without the Worker. Bindings in the code (`TASKS_*`, `STORE`) never change;
 * the names an install picks are the ones outside it: Cloudflare's, the Secrets Store's, and people's.
 */

/** A config's defaults: a new install is breakaway's, under its own prefix. */
export const DEFAULTS = Object.freeze({
  name: 'breakaway',
  worker: 'breakaway',
  url: null,
  secretsPrefix: 'BREAKAWAY_',
  secretsStore: null,
  store: 'breakaway',
  jurisdiction: null,
  repository: null,
  docs: null,
  vapidPublic: null,
  installRepository: null,
  channel: 'stable',
});

/**
 * What a Worker deployed without `TASKS_INSTALL` is: samewave's board as it ran before installs were
 * configurable, so its Durable Object, secrets, and links stay where they were. The compatibility fallback.
 */
export const LEGACY = Object.freeze({
  name: 'samewave tasks',
  worker: 'samewave-tasks',
  url: 'https://tasks.samewave.dev',
  secretsPrefix: 'SAMEWAVE_TASKS_',
  store: 'samewave',
  docs: 'https://github.com/TheAnarchoX/samewave/blob/main/docs/tasks.md',
});

/** The Secrets Store secrets the Worker binds, by the part of the name after the prefix; the binding is `TASKS_<key>`. */
export const SECRET_KEYS = [
  'CLIENT_ID',
  'SYNC_KEY',
  'API_TOKEN',
  'GITHUB_APP_ID',
  'GITHUB_KEY',
  'GITHUB_WEBHOOK_SECRET',
  'ROUTINE_URL',
  'ROUTINE_TOKEN',
  'ROUTINES',
  'VAPID_KEY',
];

/** The Worker's compatibility date, the same for every install so they all run the same code the same way. */
export const COMPATIBILITY_DATE = '2026-09-26';

const NAME = /^[\w .-]{1,40}$/u;
const WORKER = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const PREFIX = /^[A-Z][A-Z0-9_]{0,30}_$/u;
const STORE_ID = /^[0-9a-f]{32}$/u;
const GITHUB = /^[\w.-]{1,39}\/[\w.-]{1,100}$/u;

export class ConfigError extends Error {}

/** `url` as an https origin (no path), or null when it isn't one. */
function origin(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.pathname === '/' && !u.search && !u.hash ? u.origin : null;
  } catch {
    return null;
  }
}

/** A breakaway.config.json's contents, checked and with its defaults filled in. Throws ConfigError naming what's wrong. */
export function parseInstall(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('the config is a JSON object');
  const unknown = Object.keys(raw).filter((k) => !(k in DEFAULTS) && k !== '$schema');
  if (unknown.length) throw new ConfigError(`unknown setting${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  const c = {
    ...DEFAULTS,
    ...Object.fromEntries(Object.entries(raw).filter(([k, v]) => k !== '$schema' && v !== undefined)),
  };
  if (!NAME.test(c.name)) throw new ConfigError('name is a short name people see, like breakaway');
  if (!WORKER.test(c.worker)) throw new ConfigError('worker is a Worker name: lowercase letters, digits, and dashes');
  if (c.url !== null && !origin(c.url))
    throw new ConfigError(
      'url is where the board answers, an https origin like https://tasks.example.com, or null for workers.dev',
    );
  c.url = c.url === null ? null : origin(c.url);
  if (!PREFIX.test(c.secretsPrefix))
    throw new ConfigError('secretsPrefix is uppercase and ends with _, like BREAKAWAY_');
  if (c.secretsStore !== null && !STORE_ID.test(c.secretsStore))
    throw new ConfigError('secretsStore is a Secrets Store ID (32 hex characters), or null');
  if (!WORKER.test(c.store))
    throw new ConfigError('store is the Durable Object’s name: lowercase letters, digits, and dashes');
  if (c.jurisdiction !== null && !['eu', 'fedramp'].includes(c.jurisdiction))
    throw new ConfigError('jurisdiction is eu, fedramp, or null');
  if (c.repository !== null && !GITHUB.test(c.repository))
    throw new ConfigError('repository is owner/name, or null for a fresh install');
  if (c.docs !== null && !/^https:\/\/\S+$/u.test(String(c.docs)))
    throw new ConfigError('docs is an https link, or null');
  if (c.installRepository !== null && !GITHUB.test(c.installRepository))
    throw new ConfigError('installRepository is the owner/name of the repository this install deploys from, or null');
  if (!['stable', 'main'].includes(c.channel)) throw new ConfigError('channel is stable or main');
  if (c.vapidPublic !== null && !/^[\w-]{80,100}$/u.test(String(c.vapidPublic)))
    throw new ConfigError('vapidPublic is the VAPID public key (base64url), or null');
  return c;
}

/**
 * The install a Worker runs as: its `TASKS_INSTALL` var, or samewave's names when it has none. An install
 * without a `url` (a new install's, on workers.dev) has a null `url`: the board
 * then goes by the address it was last opened at (the Durable Object's homeUrl()).
 *
 * @param {any} [env]
 * @returns {{ name: string, worker: string, url: string | null, secretsPrefix: string, store: string, docs: string | null, installRepository?: string | null, channel?: string }}
 */
export function install(env) {
  const set = env?.TASKS_INSTALL;
  const raw = typeof set === 'string' ? safeParse(set) : set;
  if (!raw || typeof raw !== 'object') return LEGACY;
  return {
    name: String(raw.name || LEGACY.name),
    worker: String(raw.worker || LEGACY.worker),
    url: raw.url ? String(raw.url) : null,
    secretsPrefix: String(raw.secretsPrefix || DEFAULTS.secretsPrefix),
    store: String(raw.store || LEGACY.store),
    docs: raw.docs ? String(raw.docs) : null,
    installRepository: raw.installRepository ? String(raw.installRepository) : null,
    channel: raw.channel === 'main' ? 'main' : 'stable',
  };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A Secrets Store secret's name on this install: `CLIENT_ID` → `SAMEWAVE_TASKS_CLIENT_ID` on samewave's. */
export const secretName = (inst, key) => `${inst.secretsPrefix}${key}`;

/** A link into the install's docs, or null when it has none. */
export const docsLink = (inst, anchor) => (inst.docs ? `${inst.docs}${anchor ? `#${anchor}` : ''}` : null);

/** The routes `run_worker_first` sends to the Worker; everything else is the web app. */
const WORKER_FIRST = ['/api/*', '/v1/*', '/github/*', '/login', '/logout'];

/**
 * The Worker's wrangler config for an install. `local` is for `wrangler dev` (interop): no custom
 * domain, no Secrets Store (secrets come from `--var`), and `root`, the absolute path to tools/tasks,
 * so the file can live anywhere. An install without a `url` answers on workers.dev instead of a custom
 * domain: the root config a new install starts from (BRK-5).
 */
export function wranglerConfig(config, { local = false, root = '.' } = {}) {
  const c = parseInstall(config);
  const at = (path) => (root === '.' ? `./${path}` : `${root.replace(/\/$/u, '')}/${path}`);
  /** @type {Record<string, unknown>} */
  const vars = {
    TASKS_INSTALL: {
      name: c.name,
      worker: c.worker,
      url: c.url,
      secretsPrefix: c.secretsPrefix,
      store: c.store,
      docs: c.docs,
    },
  };
  // Only an install with a repository of its own follows a channel (BRK-10); the others carry neither.
  if (c.installRepository)
    Object.assign(vars.TASKS_INSTALL, { installRepository: c.installRepository, channel: c.channel });
  if (c.jurisdiction && !local) vars.TASKS_JURISDICTION = c.jurisdiction;
  if (c.repository) vars.TASKS_GITHUB_REPO = c.repository;
  if (c.vapidPublic && !local) vars.TASKS_VAPID_PUBLIC = c.vapidPublic;
  return {
    name: c.worker,
    main: at('src/worker.js'),
    compatibility_date: COMPATIBILITY_DATE,
    ...(local || !c.url ? {} : { routes: [{ pattern: new URL(c.url).host, custom_domain: true }] }),
    workers_dev: !local && !c.url,
    preview_urls: false,
    ...(local
      ? {}
      : {
          observability: { enabled: true, redact_query_string: true, logs: { enabled: true, invocation_logs: false } },
        }),
    version_metadata: { binding: 'VERSION' },
    vars,
    assets: { directory: at(local ? 'web/public' : 'dist'), binding: 'ASSETS', run_worker_first: WORKER_FIRST },
    ...(c.secretsStore && !local
      ? {
          secrets_store_secrets: SECRET_KEYS.map((key) => ({
            binding: `TASKS_${key}`,
            store_id: c.secretsStore,
            secret_name: secretName(c, key),
          })),
        }
      : {}),
    triggers: { crons: ['*/5 * * * *'] },
    durable_objects: { bindings: [{ name: 'STORE', class_name: 'TaskStore' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['TaskStore'] }],
  };
}

/** JSONC as wrangler reads it: `//` and block comments and trailing commas, outside strings. */
export function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/gu, '$1'));
}
