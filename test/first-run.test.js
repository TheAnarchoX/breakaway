import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { TaskStore } from '../src/store.js';
import { api } from './helpers.js';

/**
 * A fresh install (CLD-131): no samewave built in. Each test runs a store on an empty database of its own,
 * with the env a new install has: no TASKS_GITHUB_REPO and no routine yet.
 */
const FRESH = {
  ...env,
  TASKS_GITHUB_REPO: undefined,
  TASKS_ROUTINE_URL: undefined,
  TASKS_ROUTINE_TOKEN: undefined,
  TASKS_ROUTINES: undefined,
};

/** Runs `fn` with a store built on an empty database; `before` may fill the database first, as an older install would have it. */
async function fresh(name, fn, { before = () => {}, vars = FRESH } = {}) {
  await runInDurableObject(env.STORE.get(env.STORE.idFromName(name)), async (_instance, state) => {
    await state.storage.deleteAll();
    // The test Worker's own constructor already ran on this database; start again from nothing.
    for (const { name: table } of state.storage.sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
      )
      .toArray()) {
      state.storage.sql.exec(`DROP TABLE IF EXISTS "${table}"`);
    }
    before(state.storage.sql);
    await fn(new TaskStore(state, vars));
  });
}

const byId = (report, id, repo) =>
  report.connections.find((c) => c.id === id && (repo === undefined || c.repo === repo));

describe('a fresh install', () => {
  it('starts with no repository, and refuses tasks until one is registered', async () => {
    await fresh('fresh-empty', async (s) => {
      const listed = await s.reposApi();
      expect(listed.body).toMatchObject({ repos: [], default: null, firstRun: true });
      const made = await s.create([{ description: 'Too early', project: 'product' }]);
      expect(made.status).toBe(400);
      expect(made.body.error).toMatch(/no repository yet/);
      expect((await s.create([{ description: 'An idea', project: 'ideas' }])).status).toBe(400);
    });
  });

  it('shows registering a repository as the first setup step in Connections', async () => {
    await fresh('fresh-connections', async (s) => {
      const report = await s.connectionsReport();
      expect(byId(report, 'repos.registered')).toMatchObject({ group: 'repos', state: 'attention' });
      expect(byId(report, 'repos.registered').fix).toMatch(/repos add/);
      expect(report.setup.done).toBe(false);
      expect(report.setup.steps.map((step) => [step.id, step.done])).toEqual([
        ['repo', false],
        ['app', false],
        ['install', false],
        ['init', false],
        ['routine', false],
        ['cli', false],
      ]);
    });
  });

  it('ends setup with connecting a machine’s CLI and Taskwarrior, done once a replica syncs (CLD-139)', async () => {
    await fresh('fresh-cli', async (s) => {
      let report = await s.connectionsReport();
      expect(byId(report, 'taskwarrior')).toMatchObject({ state: 'off', detail: 'no replica has synced yet' });
      expect(byId(report, 'taskwarrior').fix).toMatch(/npx breakaway setup/);
      expect(report.setup.steps.at(-1)).toMatchObject({ id: 'cli', connection: 'taskwarrior', done: false });
      s.setMeta('conn_replica_seen', Date.now());
      report = await s.connectionsReport();
      expect(byId(report, 'taskwarrior').state).toBe('working');
      expect(report.setup.steps.at(-1).done).toBe(true);
    });
  });

  it('goes by the address it was opened at when its install has no URL (workers.dev)', async () => {
    const vars = {
      ...FRESH,
      TASKS_INSTALL: {
        name: 'breakaway',
        worker: 'breakaway',
        url: null,
        secretsPrefix: 'BREAKAWAY_',
        store: 'breakaway',
        docs: null,
      },
    };
    await fresh(
      'fresh-workers-dev',
      async (s) => {
        expect(s.homeUrl()).toBeNull();
        expect((await s.connectionsReport()).cannotCheck[0].why).toMatch(/the board’s host/);
        await s.connectionsApi('https://breakaway.someone.workers.dev');
        expect(s.homeUrl()).toBe('https://breakaway.someone.workers.dev');
        expect((await s.connectionsReport()).cannotCheck[0].why).toMatch(/breakaway\.someone\.workers\.dev/);
      },
      { vars },
    );
  });

  it('makes the first registered repository the default, so tasks without a repo are its', async () => {
    await fresh('fresh-first', async (s) => {
      const first = await s.reposAddApi({
        slug: 'breakaway',
        github: 'someone/breakaway',
        areas: ['product:BRK', 'cloud:BCLD'],
        by: 'owner',
      });
      expect(first.status).toBe(201);
      expect(first.body.repo).toMatchObject({ slug: 'breakaway', isDefault: true });
      const second = await s.reposAddApi({ slug: 'notes', github: 'someone/notes', areas: ['docs:NOTE'] });
      expect(second.body.repo.isDefault).toBe(false);
      expect((await s.reposApi()).body).toMatchObject({ default: 'breakaway', firstRun: true });

      const made = await s.create([
        { description: 'Landing page', project: 'product' },
        { description: 'An idea', project: 'ideas' },
      ]);
      expect(made.status).toBe(201);
      expect(made.body.tasks.map((t) => [t.wid, t.repo])).toEqual([
        ['BRK-1', 'breakaway'],
        ['IDEA-1', 'breakaway'],
      ]);
      // Stored without `repo`, like samewave's on samewave's board: the default needs none.
      expect(s.tasks.get(made.body.tasks[0].uuid).repo).toBeUndefined();
      expect((await s.create([{ description: 'Not here', project: 'product', repo: 'notes' }])).body.error).toMatch(
        /project is one of docs/,
      );
    });
  });

  it('shows each setup step for the first repository: the App on it, and its routine', async () => {
    await fresh('fresh-steps', async (s) => {
      await s.reposAddApi({ slug: 'breakaway', github: 'someone/breakaway', areas: ['product:BRK'] });
      const report = await s.connectionsReport();
      expect(byId(report, 'repos.registered')).toMatchObject({ state: 'working' });
      expect(byId(report, 'repos.registered').detail).toMatch(/breakaway/);
      // Its routine isn't connected yet: on a new install that's a step to do, not a feature left off.
      const routine = byId(report, 'claude.routine', 'breakaway');
      expect(routine).toMatchObject({ name: 'Agent routine', state: 'attention' });
      expect(routine.fix).toMatch(/npx breakaway agents-connect(?! --repo)/);
      expect(report.setup.steps.find((step) => step.id === 'repo').done).toBe(true);
      expect(report.setup.steps.find((step) => step.id === 'install').name).toMatch(/someone\/breakaway/);
      expect(report.setup.steps.find((step) => step.id === 'routine').done).toBe(false);
    });
  });

  it('marks the routine step done once the first repository’s routine is connected', async () => {
    const vars = { ...FRESH, TASKS_ROUTINE_URL: env.TASKS_ROUTINE_URL, TASKS_ROUTINE_TOKEN: env.TASKS_ROUTINE_TOKEN };
    await fresh(
      'fresh-routine',
      async (s) => {
        await s.reposAddApi({ slug: 'breakaway', github: 'someone/breakaway', areas: ['product:BRK'] });
        const report = await s.connectionsReport();
        expect(byId(report, 'claude.routine', 'breakaway').state).toBe('working');
        expect(report.setup.steps.find((step) => step.id === 'routine').done).toBe(true);
      },
      { vars },
    );
  });
});

describe('an install that already holds tasks', () => {
  it('registers samewave by itself, as before, even without TASKS_GITHUB_REPO', async () => {
    const before = (sql) => {
      sql.exec('CREATE TABLE tasks (uuid TEXT PRIMARY KEY, data TEXT NOT NULL)');
      sql.exec(
        'INSERT INTO tasks (uuid, data) VALUES (?, ?)',
        crypto.randomUUID(),
        JSON.stringify({ description: 'Older work', status: 'pending', project: 'debt', wid: 'DEBT-1' }),
      );
    };
    await fresh(
      'populated',
      async (s) => {
        const listed = (await s.reposApi()).body;
        expect(listed.default).toBe('samewave');
        expect(listed.firstRun).toBe(false);
        expect(listed.repos.map((r) => [r.slug, r.github, r.isDefault])).toEqual([
          ['samewave', 'TheAnarchoX/samewave', true],
        ]);
        const report = await s.connectionsReport();
        expect(report.setup).toBeNull();
        expect(byId(report, 'repos.registered')).toBeUndefined();
      },
      { before },
    );
  });

  it('leaves samewave’s board as it is: samewave the default, no setup steps', async () => {
    const repos = await (await api('repos')).json();
    expect(repos).toMatchObject({ default: 'samewave', firstRun: false });
    const report = await (await api('connections')).json();
    expect(report.setup).toBeNull();
    expect(report.connections.some((c) => c.group === 'repos')).toBe(false);
    expect(report.connections.find((c) => c.id === 'claude.routine')).toMatchObject({
      name: 'Agent routine',
      repo: 'samewave',
    });
  });
});
