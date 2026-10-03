import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { seal, unseal } from '../src/crypto.js';
import { decodeSegment, decodeSnapshot, encodeSegment } from '../src/ops.js';
import { ORIGIN } from './constants.js';
import { HS, KEY, NIL, api, pushOps, readChild, sync, twCreate } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const NEW_CLIENT = '7c1f3a52-9d4e-4b8a-9f0c-2e6d5b4a3c21';
const NEW_KEY = new Uint8Array(32).map((_, i) => (i * 7 + 3) % 256);
const NEW_KEY_B64 = btoa(String.fromCharCode(...NEW_KEY));

function syncAs(clientId, path, init = {}) {
  return sync(path, { ...init, clientId });
}

describe('rotating the sync credentials', () => {
  const U = crypto.randomUUID();
  let first;
  let second;

  it('starts with a history under the old key', async () => {
    first = (await pushOps(NIL, twCreate(U, { description: 'Before the rotation', project: 'ops' }))).headers.get(
      'X-Version-Id',
    );
    const res = await body(
      await api('tasks', { method: 'POST', body: { description: 'Also before', project: 'ops' } }),
    );
    expect(res.status).toBe(201);
    second = (await readChild(first)).versionId; // the auto work ID or the API version
    expect(second).toBeTruthy();
  });

  it('only runs with the bearer token, never the web cookie, and checks its input', async () => {
    const cookieOnly = await SELF.fetch(`${ORIGIN}/api/admin/rekey`, {
      method: 'POST',
      headers: { Cookie: '__Host-sw_tasks=1.x', Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: NEW_CLIENT, key: NEW_KEY_B64 }),
    });
    expect(cookieOnly.status).toBe(401);
    expect((await api('admin/rekey', { method: 'POST', body: { clientId: 'nope', key: NEW_KEY_B64 } })).status).toBe(
      400,
    );
    expect((await api('admin/rekey', { method: 'POST', body: { clientId: NEW_CLIENT, key: 'c2hvcnQ=' } })).status).toBe(
      400,
    );
  });

  it('re-encrypts every version and the snapshot under the new key, keeping version IDs', async () => {
    const res = await body(
      await api('admin/rekey', { method: 'POST', body: { clientId: NEW_CLIENT, key: NEW_KEY_B64 } }),
    );
    expect(res.status).toBe(200);
    expect(res.versions).toBeGreaterThanOrEqual(2);

    // The old client ID is refused from now on.
    expect((await sync(`get-child-version/${NIL}`)).status).toBe(403);

    // The same chain, readable only with the new key.
    const child = await syncAs(NEW_CLIENT, `get-child-version/${NIL}`);
    expect(child.headers.get('X-Version-Id')).toBe(first);
    const bytes = new Uint8Array(await child.arrayBuffer());
    expect(() => unseal(KEY, NIL, bytes)).toThrow();
    expect(decodeSegment(unseal(NEW_KEY, NIL, bytes))[0]).toEqual({ type: 'create', uuid: U });

    const snap = await syncAs(NEW_CLIENT, 'snapshot');
    const tasks = decodeSnapshot(
      unseal(NEW_KEY, snap.headers.get('X-Version-Id'), new Uint8Array(await snap.arrayBuffer())),
    );
    expect(tasks.get(U).description).toBe('Before the rotation');
  });

  it('lets a replica carry on from where it was, with the new credentials', async () => {
    let latest = second;
    for (;;) {
      const res = await syncAs(NEW_CLIENT, `get-child-version/${latest}`);
      if (res.status !== 200) break;
      latest = res.headers.get('X-Version-Id');
    }
    const V = crypto.randomUUID();
    const add = await syncAs(NEW_CLIENT, `add-version/${latest}`, {
      method: 'POST',
      body: seal(NEW_KEY, latest, encodeSegment(twCreate(V, { description: 'After the rotation' }))),
      contentType: HS,
    });
    expect(add.status).toBe(200);
    const task = await body(await api(`tasks/${V}`));
    expect(task.task.description).toBe('After the rotation');
  });

  it('keeps the API working and says the Secrets Store still has the old values', async () => {
    const health = await body(await api('health'));
    expect(health).toMatchObject({ ok: true, secretsStoreInSync: false });
    expect(health.rekeyedAt).toMatch(/^\d{4}-/u);
    expect((await api('tasks', { method: 'POST', body: { description: 'Still writable' } })).status).toBe(201);
    expect((await body(await api('admin/rebuild', { method: 'POST' }))).status).toBe(200);
  });

  it('refuses to rotate to the client ID already in use', async () => {
    expect(
      (await api('admin/rekey', { method: 'POST', body: { clientId: NEW_CLIENT, key: NEW_KEY_B64 } })).status,
    ).toBe(400);
  });
});
