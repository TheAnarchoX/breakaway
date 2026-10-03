import { describe, expect, it } from 'vitest';
import { unseal } from '../src/crypto.js';
import { decodeSnapshot } from '../src/ops.js';
import { HS, KEY, NIL, SNAP, pushOps, readChild, sync, twCreate } from './helpers.js';

// Tests in a file share Durable Object storage, so this file walks one history from empty.
describe('TaskChampion sync protocol', () => {
  const U = crypto.randomUUID();
  let first;

  it("needs the install's client ID", async () => {
    expect((await sync(`get-child-version/${NIL}`, { clientId: null })).status).toBe(400);
    expect((await sync(`get-child-version/${NIL}`, { clientId: 'not-a-uuid' })).status).toBe(400);
    expect((await sync(`get-child-version/${NIL}`, { clientId: crypto.randomUUID() })).status).toBe(403);
  });

  it('starts empty', async () => {
    expect((await sync(`get-child-version/${NIL}`)).status).toBe(404);
    expect((await sync('snapshot')).status).toBe(404);
  });

  it('rejects a bad content type, an empty body, and a bad version ID', async () => {
    expect((await sync(`add-version/${NIL}`, { method: 'POST', body: 'x', contentType: 'text/plain' })).status).toBe(
      400,
    );
    expect((await sync(`add-version/${NIL}`, { method: 'POST' })).status).toBe(400);
    expect((await sync('add-version/nope', { method: 'POST', body: 'x' })).status).toBe(400);
  });

  it('adds the first version and hands it back to other replicas', async () => {
    const res = await pushOps(NIL, twCreate(U, { description: 'From a replica' }));
    expect(res.status).toBe(200);
    first = res.headers.get('X-Version-Id');
    expect(first).toMatch(/^[0-9a-f-]{36}$/u);
    expect(res.headers.get('Cache-Control')).toBe('no-store, max-age=0');

    const { res: child, ops } = await readChild(NIL);
    expect(child.headers.get('Content-Type')).toBe(HS);
    expect(child.headers.get('X-Version-Id')).toBe(first);
    expect(child.headers.get('X-Parent-Version-Id')).toBe(NIL);
    expect(ops[0]).toEqual({ type: 'create', uuid: U });
  });

  it('asks a replica that is behind to catch up first', async () => {
    const res = await pushOps(NIL, twCreate(crypto.randomUUID(), { description: 'late' }));
    expect(res.status).toBe(409);
    expect(res.headers.get('X-Parent-Version-Id')).toBe(first);
  });

  it('says 404 at the latest version and 410 for a version it never had', async () => {
    expect((await sync(`get-child-version/${first}`)).status).toBe(404);
    expect((await sync(`get-child-version/${crypto.randomUUID()}`)).status).toBe(410);
  });

  it('keeps its own snapshot, sealed for the version it describes', async () => {
    const res = await sync('snapshot');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe(SNAP);
    const version = res.headers.get('X-Version-Id');
    const tasks = decodeSnapshot(unseal(KEY, version, new Uint8Array(await res.arrayBuffer())));
    expect(tasks.get(U)).toMatchObject({ description: 'From a replica', status: 'pending' });
  });

  it("accepts a replica's snapshot of the latest version", async () => {
    const res = await sync(`add-snapshot/${first}`, {
      method: 'POST',
      body: new Uint8Array([1, 2, 3]),
      contentType: SNAP,
    });
    expect(res.status).toBe(200);
  });
});
