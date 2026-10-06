import { SELF } from 'cloudflare:test';
import { keyFromBase64, seal, unseal } from '../src/crypto.js';
import { decodeSegment, encodeSegment } from '../src/ops.js';
import { ORIGIN, TEST_API_TOKEN, TEST_CLIENT_ID, TEST_SYNC_KEY } from './constants.js';

export const HS = 'application/vnd.taskchampion.history-segment';
export const SNAP = 'application/vnd.taskchampion.snapshot';
export const NIL = '00000000-0000-0000-0000-000000000000';
export const KEY = keyFromBase64(TEST_SYNC_KEY);
const ts = () => new Date().toISOString();

/** What a Taskwarrior replica sends to the sync server. */
export function sync(path, { method = 'GET', body, contentType = HS, clientId = TEST_CLIENT_ID } = {}) {
  const headers = {};
  if (clientId) headers['X-Client-Id'] = clientId;
  if (body) headers['Content-Type'] = contentType;
  return SELF.fetch(`${ORIGIN}/v1/client/${path}`, { method, headers, body });
}

/** Seals ops the way a Taskwarrior replica does and adds them as a child of `parent`. */
export function pushOps(parent, ops, key = KEY) {
  return sync(`add-version/${parent}`, { method: 'POST', body: seal(key, parent, encodeSegment(ops)) });
}

export async function readChild(parent) {
  const res = await sync(`get-child-version/${parent}`);
  if (res.status !== 200) return { res };
  const bytes = new Uint8Array(await res.arrayBuffer());
  return {
    res,
    ops: decodeSegment(unseal(KEY, res.headers.get('X-Parent-Version-Id'), bytes)),
    versionId: res.headers.get('X-Version-Id'),
  };
}

/** Walks the whole history from the start, like a fresh replica with no snapshot. */
export async function latestVersion() {
  let parent = NIL;
  for (;;) {
    const { res, versionId } = await readChild(parent);
    if (res.status !== 200) return parent;
    parent = versionId;
  }
}

/** A task as `task add` creates it. */
export function twCreate(uuid, props) {
  const timestamp = ts();
  return [
    { type: 'create', uuid },
    ...Object.entries({ status: 'pending', entry: '1790630931', modified: '1790630931', ...props }).map(
      ([property, value]) => ({ type: 'update', uuid, property, value, timestamp }),
    ),
  ];
}

export function api(path, { method = 'GET', body, token = TEST_API_TOKEN, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  return SELF.fetch(`${ORIGIN}/api/${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** The signed-in web board's call: the cookie from /login, from the board's own origin unless told otherwise. */
export async function boardApi(path, { method = 'GET', body, origin = ORIGIN } = {}) {
  const login = await SELF.fetch(`${ORIGIN}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: TEST_API_TOKEN }),
  });
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  return SELF.fetch(`${ORIGIN}/api/${path}`, {
    method,
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Gives the install's default repository (widgets) a deploy pipeline, as its owner would with `repos modify`: the seeded row has none. */
export async function setPipeline(slug = 'widgets') {
  const res = await api(`repos/${slug}`, {
    method: 'PATCH',
    body: {
      pipeline: {
        workers: { staging: 'widgets-staging', production: 'widgets' },
        workflows: { deploy: 'deploy.yml', promote: 'promote.yml', rollback: 'rollback.yml' },
        deployPaths: '.github/deploy-paths.json',
      },
    },
  });
  if (res.status !== 200) throw new Error(`couldn't set the pipeline: ${res.status} ${await res.text()}`);
}

/** The deploy paths file a pipeline's repository keeps on its default branch, as the Deploy workflow reads it. */
export const DEPLOY_PATHS = {
  widgets: String.raw`^(src/|public/|migrations/|index\.html$|vite\.config\.js$|wrangler\.jsonc$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|\.github/workflows/deploy\.yml$|\.github/deploy-paths\.json$)`,
};

/**
 * Lets every routine the board holds after Claude refused a start (BRK-144) go, as if its wait ran out or it was
 * connected again, so a test that makes Claude refuse once can start agents after it.
 */
export async function releaseRoutineHolds(name = 'widgets') {
  const { env, runInDurableObject } = await import('cloudflare:test');
  await runInDurableObject(env.STORE.get(env.STORE.idFromName(name)), (instance) => {
    instance.sql.exec("DELETE FROM meta WHERE key LIKE 'routine_hold:%'");
  });
}
