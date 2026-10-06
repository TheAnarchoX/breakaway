import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api, boardApi } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const store = () => env.STORE.get(env.STORE.idFromName('widgets'));

describe('environments (BRK-174)', () => {
  const board = boardApi;
  const add = (fields) =>
    board('infra/environments', { method: 'POST', body: { repo: 'widgets', provider: 'fake', ...fields } });
  const list = async (query = '') => body(await api(`infra/environments${query}`));

  it('a fresh install has none', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.environments).toEqual([]);
  });

  it('the owner adds one on the board, and production gates apply to production by default', async () => {
    const staging = await body(await add({ name: 'staging', kind: 'staging', target: 'widgets-staging' }));
    expect(staging.status).toBe(201);
    expect(staging.environment).toMatchObject({
      repo: 'widgets',
      name: 'staging',
      kind: 'staging',
      provider: 'fake',
      target: 'widgets-staging',
      task: null,
      frozen: false,
      frozenAt: null,
      gates: false,
      observeOnly: false,
      runsTheBoard: false,
    });
    expect(staging.environment.id).toEqual(expect.any(Number));
    const production = await body(
      await add({ name: 'production', kind: 'production', target: 'widgets', by: 'owner' }),
    );
    expect(production.status).toBe(201);
    expect(production.environment.gates).toBe(true);

    const all = await list();
    expect(all.environments.map((e) => e.name)).toEqual(['production', 'staging']);
    expect((await list('?repo=widgets')).environments).toHaveLength(2);
    const one = await body(await api(`infra/environments/${staging.environment.id}`));
    expect(one.environment.name).toBe('staging');
    expect((await body(await api('infra/environments/staging?repo=widgets'))).environment.id).toBe(
      staging.environment.id,
    );
  });

  it('refuses what isn’t an environment, saying what to send', async () => {
    const kind = await body(await add({ name: 'qa', kind: 'test' }));
    expect(kind.status).toBe(400);
    expect(kind.error).toMatch(/production, staging, or short-lived/);
    const name = await body(await add({ name: 'Not A Name!', kind: 'staging' }));
    expect(name.status).toBe(400);
    expect(name.error).toMatch(/lowercase letters, digits, and -/);
    const provider = await body(await add({ name: 'qa', kind: 'staging', provider: '' }));
    expect(provider.status).toBe(400);
    expect(provider.error).toMatch(/provider/);
    const repo = await body(await add({ name: 'qa', kind: 'staging', repo: 'nowhere' }));
    expect(repo.status).toBe(400);
    expect(repo.error).toMatch(/no repository "nowhere"/);
    const twice = await body(await add({ name: 'staging', kind: 'staging' }));
    expect(twice.status).toBe(409);
    expect(twice.error).toMatch(/widgets already has an environment called staging/);
    const unknown = await api('infra/environments/9999');
    expect(unknown.status).toBe(404);
  });

  it('agents read, but never add, change, or remove one', async () => {
    const as = { by: 'claude-brk-9' };
    expect((await api('infra/environments')).status).toBe(200);
    // Even through the signed-in board, an agent's `by` is refused: the store's own check stays.
    const created = await body(await add({ name: 'agents', kind: 'staging', ...as }));
    expect(created.status).toBe(403);
    expect(created.error).toMatch(/only the owner/);
    const id = (await list()).environments.find((e) => e.name === 'staging').id;
    const renamed = await board(`infra/environments/${id}`, { method: 'PATCH', body: { name: 'stage', ...as } });
    expect(renamed.status).toBe(403);
    const removed = await board(`infra/environments/${id}`, { method: 'DELETE', body: as });
    expect(removed.status).toBe(403);
    expect((await list()).environments.find((e) => e.id === id).name).toBe('staging');
  });

  it('the API token reads them but never adds, changes, or removes one, with or without a `by`', async () => {
    const id = (await list()).environments.find((e) => e.name === 'staging').id;
    expect((await api(`infra/environments/${id}`)).status).toBe(200);
    expect((await api('infra/environments?repo=widgets')).status).toBe(200);
    for (const by of [undefined, 'owner', 'claude-brk-9']) {
      const calls = [
        api('infra/environments', {
          method: 'POST',
          body: { repo: 'widgets', provider: 'fake', name: 'tokened', kind: 'staging', by },
        }),
        api(`infra/environments/${id}`, { method: 'PATCH', body: { name: 'retargeted', target: 'elsewhere', by } }),
        api(`infra/environments/${id}`, { method: 'DELETE', body: by === undefined ? undefined : { by } }),
      ];
      for (const res of await Promise.all(calls)) {
        const refused = await body(res);
        expect(refused.status).toBe(403);
        expect(refused.error).toBe('only the signed-in web board can add, change, or remove an environment');
      }
    }
    const after = await list();
    expect(after.environments.map((e) => e.name)).toEqual(['production', 'staging']);
    expect(after.environments.find((e) => e.id === id).target).toBe('widgets-staging');
  });

  it('the owner renames one on the board', async () => {
    const id = (await list()).environments.find((e) => e.name === 'staging').id;
    const renamed = await body(await board(`infra/environments/${id}`, { method: 'PATCH', body: { name: 'stage' } }));
    expect(renamed.status).toBe(200);
    expect(renamed.environment.name).toBe('stage');
    const back = await body(await board(`infra/environments/${id}`, { method: 'PATCH', body: { name: 'staging' } }));
    expect(back.environment.name).toBe('staging');
    const clash = await board(`infra/environments/${id}`, { method: 'PATCH', body: { name: 'production' } });
    expect(clash.status).toBe(409);
  });

  it('freezing is the owner’s, from the signed-in board only', async () => {
    const id = (await list()).environments.find((e) => e.name === 'staging').id;
    const token = await body(await api(`infra/environments/${id}`, { method: 'PATCH', body: { frozen: true } }));
    expect(token.status).toBe(403);
    expect(token.error).toMatch(/only the signed-in web board/);
    const elsewhere = await board(`infra/environments/${id}`, {
      method: 'PATCH',
      body: { frozen: true },
      origin: 'https://evil.example',
    });
    expect(elsewhere.status).toBe(403);

    const frozen = await body(await board(`infra/environments/${id}`, { method: 'PATCH', body: { frozen: true } }));
    expect(frozen.status).toBe(200);
    expect(frozen.environment.frozen).toBe(true);
    expect(Date.parse(frozen.environment.frozenAt)).toBeGreaterThan(Date.now() - 60_000);

    // A frozen environment stays: removing it is refused until the owner unfreezes it.
    const remove = await body(await board(`infra/environments/${id}`, { method: 'DELETE' }));
    expect(remove.status).toBe(409);
    expect(remove.error).toMatch(/unfreeze it first/);
    // And unfreezing is the signed-in board's too.
    expect((await api(`infra/environments/${id}`, { method: 'PATCH', body: { frozen: false } })).status).toBe(403);

    const thawed = await body(await board(`infra/environments/${id}`, { method: 'PATCH', body: { frozen: false } }));
    expect(thawed.environment).toMatchObject({ frozen: false, frozenAt: null });

    // Each freeze and thaw is in the audit trail once, by the owner (BRK-175); the refused ones aren't.
    const audit = await body(await api(`infra/audit?environment=staging&repo=widgets&kind=freeze`));
    expect(audit.entries.map(({ by, outcome, repo, environmentId }) => ({ by, outcome, repo, environmentId }))).toEqual(
      [
        { by: 'owner', outcome: 'off', repo: 'widgets', environmentId: id },
        { by: 'owner', outcome: 'on', repo: 'widgets', environmentId: id },
      ],
    );
  });

  it('adding, changing, and removing one is in the audit trail, by the owner (BRK-229)', async () => {
    const made = await body(await add({ name: 'audited', kind: 'staging', target: 'widgets-audited' }));
    const id = made.environment.id;
    // A change that moves nothing appends nothing.
    await board(`infra/environments/${id}`, { method: 'PATCH', body: { target: 'widgets-audited' } });
    await board(`infra/environments/${id}`, {
      method: 'PATCH',
      body: { target: 'widgets-elsewhere', observeOnly: true },
    });
    expect((await board(`infra/environments/${id}`, { method: 'DELETE' })).status).toBe(200);
    const audit = await body(await api(`infra/audit?environmentId=${id}&kind=environment`));
    expect(audit.entries.map(({ by, outcome, summary }) => ({ by, outcome, summary })).reverse()).toEqual([
      { by: 'owner', outcome: 'added', summary: 'added by the owner: staging, fake widgets-audited' },
      {
        by: 'owner',
        outcome: 'changed',
        summary: 'changed by the owner: target widgets-audited → widgets-elsewhere; observe only off → on',
      },
      { by: 'owner', outcome: 'removed', summary: 'removed by the owner' },
    ]);
  });

  it('production gates and observe only are the signed-in board’s to change', async () => {
    const id = (await list()).environments.find((e) => e.name === 'production').id;
    for (const change of [{ gates: false }, { observeOnly: true }]) {
      const res = await body(await api(`infra/environments/${id}`, { method: 'PATCH', body: change }));
      expect(res.status).toBe(403);
    }
    const created = await body(
      await api('infra/environments', {
        method: 'POST',
        body: { repo: 'widgets', provider: 'fake', name: 'quiet', kind: 'staging', observeOnly: true },
      }),
    );
    expect(created.status).toBe(403);
    const changed = await body(
      await board(`infra/environments/${id}`, { method: 'PATCH', body: { gates: false, observeOnly: true } }),
    );
    expect(changed.environment).toMatchObject({ gates: false, observeOnly: true });
    const back = await body(
      await board(`infra/environments/${id}`, { method: 'PATCH', body: { gates: true, observeOnly: false } }),
    );
    expect(back.environment).toMatchObject({ gates: true, observeOnly: false });
  });

  it('the board’s own install is always observe only, and nothing turns that off', async () => {
    // The test install's Worker is widgets-tasks (wrangler.test.jsonc).
    const own = await body(
      await board('infra/environments', {
        method: 'POST',
        body: {
          repo: 'widgets',
          name: 'board',
          kind: 'production',
          provider: 'fake',
          target: 'widgets-tasks',
          observeOnly: false,
        },
      }),
    );
    expect(own.status).toBe(201);
    expect(own.environment).toMatchObject({ observeOnly: true, runsTheBoard: true });
    const id = own.environment.id;

    const off = await body(await board(`infra/environments/${id}`, { method: 'PATCH', body: { observeOnly: false } }));
    expect(off.status).toBe(409);
    expect(off.error).toMatch(/runs this board/);
    const moved = await body(
      await board(`infra/environments/${id}`, { method: 'PATCH', body: { target: 'elsewhere' } }),
    );
    expect(moved.status).toBe(409);
    expect((await body(await api(`infra/environments/${id}`))).environment).toMatchObject({
      observeOnly: true,
      target: 'widgets-tasks',
    });

    // Pointing another environment at the board's Worker makes it observe only too.
    const staging = (await list()).environments.find((e) => e.name === 'staging');
    const pointed = await body(
      await board(`infra/environments/${staging.id}`, { method: 'PATCH', body: { target: 'widgets-tasks' } }),
    );
    expect(pointed.environment).toMatchObject({ observeOnly: true, runsTheBoard: true });
    const restored = await body(
      await board(`infra/environments/${staging.id}`, { method: 'PATCH', body: { target: 'widgets-staging' } }),
    );
    expect(restored.status).toBe(409);

    // Removing it is still the owner's choice; it stays observe only while it exists.
    expect((await board(`infra/environments/${id}`, { method: 'DELETE' })).status).toBe(200);
  });

  it('a short-lived environment may name the task that owns it; the others may not', async () => {
    const task = await body(
      await api('tasks', { method: 'POST', body: [{ description: 'Try a preview', project: 'ops', horizon: 'now' }] }),
    );
    const { wid, uuid } = task.tasks[0];
    const preview = await body(await add({ name: 'preview-1', kind: 'short-lived', task: wid }));
    expect(preview.status).toBe(201);
    expect(preview.environment.task).toMatchObject({ wid, uuid });
    const wrongKind = await body(await add({ name: 'preview-2', kind: 'staging', task: wid }));
    expect(wrongKind.status).toBe(400);
    expect(wrongKind.error).toMatch(/only a short-lived environment/);
    const missing = await body(await add({ name: 'preview-3', kind: 'short-lived', task: 'OPS-9999' }));
    expect(missing.status).toBe(400);
    expect(missing.error).toMatch(/no task OPS-9999/);
    const cleared = await body(
      await board(`infra/environments/${preview.environment.id}`, { method: 'PATCH', body: { task: null } }),
    );
    expect(cleared.environment.task).toBeNull();
  });

  it('the owner removes one', async () => {
    const id = (await list()).environments.find((e) => e.name === 'preview-1').id;
    const removed = await body(await board(`infra/environments/${id}`, { method: 'DELETE' }));
    expect(removed.status).toBe(200);
    expect((await api(`infra/environments/${id}`)).status).toBe(404);
  });

  it('only GET, POST, PATCH, and DELETE answer', async () => {
    expect((await api('infra/environments', { method: 'PUT', body: {} })).status).toBe(404);
  });

  it('migrates a store from before a column existed, keeping its rows, and runs again harmlessly', async () => {
    await runInDurableObject(store(), async (instance) => {
      instance.sql.exec('DROP TABLE infra_environments');
      instance.sql.exec(
        'CREATE TABLE infra_environments (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, created INTEGER NOT NULL, edited INTEGER NOT NULL)',
      );
      instance.sql.exec(
        "INSERT INTO infra_environments (repo, name, kind, created, edited) VALUES ('widgets', 'old', 'production', 1, 1)",
      );
      instance.initInfraEnvironments();
      instance.initInfraEnvironments();
    });
    const old = (await list()).environments.find((e) => e.name === 'old');
    expect(old).toMatchObject({ kind: 'production', frozen: false, gates: true, observeOnly: false, provider: null });
    // The unique name per repository holds after the migration too.
    expect((await add({ name: 'old', kind: 'staging' })).status).toBe(409);
  });
});
