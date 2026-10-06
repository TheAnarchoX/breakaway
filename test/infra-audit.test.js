import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api } from './helpers.js';
import { AUDIT_KEPT_DAYS, infraAuditMethods } from '../src/store-infra-audit.js';

const DAY = 86_400_000;
const stub = () => env.STORE.get(env.STORE.idFromName('widgets'));
const inStore = (fn) => runInDurableObject(stub(), (instance) => fn(instance));
const append = (entry) => inStore((store) => store.appendInfraAudit(entry));
const read = async (query = '') => {
  const res = await api(`infra/audit${query}`);
  expect(res.status).toBe(200);
  return res.json();
};

describe('the infrastructure audit trail', () => {
  it('appends entries and reads them back newest first, by environment and repository', async () => {
    const plan = await append({
      kind: 'plan',
      repo: 'widgets',
      environment: 'audit-staging',
      plan: 'plan-1',
      by: 'agent',
      agent: 'claude-brk-1',
      outcome: 'waiting',
      summary: 'Add a queue for the importer.',
    });
    expect(plan).toMatchObject({
      kind: 'plan',
      repo: 'widgets',
      environment: 'audit-staging',
      plan: 'plan-1',
      by: 'agent',
      agent: 'claude-brk-1',
      envelope: null,
      outcome: 'waiting',
      summary: 'Add a queue for the importer.',
    });
    expect(plan.id).toBeGreaterThan(0);
    expect(plan.at).toBeLessThanOrEqual(Date.now());
    await append({ kind: 'approve', repo: 'widgets', environment: 'audit-staging', plan: 'plan-1', by: 'owner' });
    await append({ kind: 'apply', repo: 'widgets', environment: 'audit-prod', plan: 'plan-2', by: 'executor' });
    await append({ kind: 'apply', repo: 'gadgets', environment: 'audit-staging', plan: 'plan-3', by: 'executor' });

    const staging = await read('?environment=audit-staging&repo=widgets');
    expect(staging.entries.map((e) => e.kind)).toEqual(['approve', 'plan']);
    expect(staging.more).toBe(false);
    expect((await read('?environment=audit-prod')).entries.map((e) => e.plan)).toEqual(['plan-2']);
    expect((await read('?environment=audit-staging')).entries.map((e) => e.plan)).toEqual([
      'plan-3',
      'plan-1',
      'plan-1',
    ]);
    expect((await read('?environment=audit-staging&kind=apply')).entries.map((e) => e.repo)).toEqual(['gadgets']);
  });

  it('pages with before and limit', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++)
      ids.push((await append({ kind: 'envelope', repo: 'widgets', environment: 'audit-pages', by: 'envelope' })).id);
    const first = await read('?environment=audit-pages&limit=2');
    expect(first.entries.map((e) => e.id)).toEqual([ids[4], ids[3]]);
    expect(first.more).toBe(true);
    const rest = await read(`?environment=audit-pages&limit=10&before=${ids[3]}`);
    expect(rest.entries.map((e) => e.id)).toEqual([ids[2], ids[1], ids[0]]);
    expect(rest.more).toBe(false);
    expect((await api('infra/audit?limit=0')).status).toBe(400);
    expect((await api('infra/audit?before=x')).status).toBe(400);
    expect((await api('infra/audit?kind=deploy')).status).toBe(400);
  });

  it('redacts a token-looking value and anything personal before it stores it', async () => {
    const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
    const entry = await append({
      kind: 'break-glass',
      repo: 'widgets',
      environment: 'audit-redact',
      by: 'owner',
      outcome: `failed: Bearer ${'x9Y8z7W6v5'.repeat(3)}`,
      summary: `Changed by hand with ${token}, CLOUDFLARE_API_TOKEN=abc123 and sam@example.com`,
    });
    const stored = (await read('?environment=audit-redact')).entries[0];
    for (const shown of [entry, stored]) {
      expect(JSON.stringify(shown)).not.toContain(token);
      expect(JSON.stringify(shown)).not.toContain('abc123');
      expect(JSON.stringify(shown)).not.toContain('x9Y8z7W6v5');
      expect(JSON.stringify(shown)).not.toContain('sam@example.com');
      expect(shown.summary).toContain('[redacted]');
      expect(shown.outcome).toBe('failed: Bearer [redacted]');
    }
    // Nothing unredacted reached the table either.
    const raw = await inStore((store) =>
      store.sql.exec("SELECT * FROM infra_audit WHERE environment = 'audit-redact'").toArray(),
    );
    expect(JSON.stringify(raw)).not.toContain(token);
  });

  it('refuses an entry that says nothing about what or who', async () => {
    const base = { kind: 'apply', repo: 'widgets', environment: 'audit-bad', by: 'executor' };
    for (const bad of [
      { ...base, kind: 'deploy' },
      { ...base, by: 'someone' },
      { ...base, repo: '' },
      { ...base, environment: 'has spaces' },
      { ...base, by: 'agent' },
      { ...base, agent: 'not a name!' },
    ])
      await expect(append(bad)).rejects.toThrow();
    // The time is the board's, never the caller's.
    const entry = await append({ ...base, at: 1 });
    expect(entry.at).toBeGreaterThan(1);
  });

  it('has no path that changes or removes an entry', async () => {
    const entry = await append({ kind: 'lock-release', repo: 'widgets', environment: 'audit-fixed', by: 'executor' });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await api('infra/audit', { method, body: { id: entry.id, outcome: 'changed' } });
      expect(res.status).toBe(405);
      const resOne = await api(`infra/audit/${entry.id}`, { method, body: { outcome: 'changed' } });
      expect(resOne.status).toBeGreaterThanOrEqual(400);
    }
    // The store has no method to edit or delete one: retention's prune is the only thing that removes entries.
    expect(Object.keys(infraAuditMethods).filter((name) => /update|edit|delete|remove|drop/iu.test(name))).toEqual([]);
    // And the table itself refuses it.
    await expect(
      inStore((store) => store.sql.exec("UPDATE infra_audit SET outcome = 'changed' WHERE id = ?", entry.id)),
    ).rejects.toThrow(/append-only/u);
    await expect(inStore((store) => store.sql.exec('DELETE FROM infra_audit WHERE id = ?', entry.id))).rejects.toThrow(
      /a year/u,
    );
    expect((await read('?environment=audit-fixed')).entries).toEqual([entry]);
  });

  it('keeps every entry younger than a year, and drops only those past retention', async () => {
    expect(AUDIT_KEPT_DAYS).toBeGreaterThanOrEqual(365);
    const now = Date.now();
    const ages = { young: 364, year: 366, kept: AUDIT_KEPT_DAYS - 1, old: AUDIT_KEPT_DAYS + 1 };
    await inStore((store) => {
      for (const [plan, days] of Object.entries(ages))
        store.sql.exec(
          "INSERT INTO infra_audit (at, kind, repo, environment, plan, by, outcome, summary) VALUES (?, 'apply', 'widgets', 'audit-keep', ?, 'executor', '', '')",
          now - days * DAY,
          plan,
        );
      store.pruneInfraAudit(now);
    });
    expect((await read('?environment=audit-keep')).entries.map((e) => e.plan).sort()).toEqual(
      ['kept', 'year', 'young'].sort(),
    );
  });
});
