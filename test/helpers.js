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
