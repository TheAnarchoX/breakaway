import { describe, expect, it } from 'vitest';
import { api, latestVersion, pushOps, sync, twCreate } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const WRONG_KEY = new Uint8Array(32).fill(7);

describe("a version the server can't read", () => {
  it('is still stored and served to replicas, but the API stops writing and says why', async () => {
    const parent = await latestVersion();
    const res = await pushOps(
      parent,
      twCreate(crypto.randomUUID(), { description: 'sealed with another secret' }),
      WRONG_KEY,
    );
    expect(res.status).toBe(200);
    const child = await sync(`get-child-version/${parent}`);
    expect(child.status).toBe(200);
    expect(child.headers.get('X-Version-Id')).toBe(res.headers.get('X-Version-Id'));

    const health = await body(await api('health'));
    expect(health.ok).toBe(false);
    expect(health.replicaError).toMatch(/can't read version/);

    const add = await body(await api('tasks', { method: 'POST', body: { description: 'x' } }));
    expect(add.status).toBe(409);
    expect(add.error).toMatch(/can't read its history/);
  });

  it('rebuild says where it stopped while the key is still wrong', async () => {
    const res = await body(await api('admin/rebuild', { method: 'POST' }));
    expect(res.status).toBe(500);
    expect(res.error).toMatch(/rebuild stopped after 0 versions/);
  });
});
