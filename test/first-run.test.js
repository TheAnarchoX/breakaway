import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskStore } from '../src/store.js';
import { api } from './helpers.js';

/**
 * A fresh install (CLD-131): no widgets built in. Each test runs a store on an empty database of its own,
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

/**
 * Nothing here reaches the network (BRK-344). Registering a repository asks GitHub for its default branch through
 * the App, and a real call to api.github.com made these tests slow and, on a slow runner, time out. On a fresh
 * install the App isn't on the repository yet, so GitHub answers 404 and the board keeps its own default; anything
 * else these tests would call fails loudly instead of going out.
 */
let calls;
beforeEach(() => {
  calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.startsWith('https://api.github.com/'))
      return Response.json({ message: 'Not Found' }, { status: 404, statusText: 'Not Found' });
    throw new Error(`first-run tests don’t reach the network: ${url}`);
  });
});
afterEach(() => vi.restoreAllMocks());

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
        ['passkey', false],
        ['taskwarrior', false],
        ['first', false],
      ]);
      expect(report.setup.steps.find((step) => step.id === 'taskwarrior').optional).toBe(true);
    });
  });

  it('counts any call with the API token for the CLI step, and keeps Taskwarrior optional (BRK-143)', async () => {
    await fresh('fresh-cli', async (s) => {
      let report = await s.connectionsReport();
      expect(byId(report, 'cli')).toMatchObject({ state: 'off', detail: 'no call with the API token yet' });
      expect(byId(report, 'cli').fix).toMatch(/npx breakaway health/);
      expect(byId(report, 'taskwarrior')).toMatchObject({ state: 'off', detail: 'no replica has synced yet' });
      expect(byId(report, 'taskwarrior').fix).toMatch(/^Optional: .*npx breakaway setup/);
      const step = (id) => report.setup.steps.find((st) => st.id === id);
      expect(step('cli')).toMatchObject({ name: 'Connect the CLI', connection: 'cli', done: false });
      expect(step('taskwarrior')).toMatchObject({ connection: 'taskwarrior', optional: true, done: false });

      s.connectionsCliSeen();
      report = await s.connectionsReport();
      expect(byId(report, 'cli').state).toBe('working');
      expect(step('cli').done).toBe(true);
      // No replica has synced: still not connected, and still not needing attention.
      expect(byId(report, 'taskwarrior').state).toBe('off');
      expect(step('taskwarrior').done).toBe(false);

      s.setMeta('conn_replica_seen', Date.now());
      report = await s.connectionsReport();
      expect(byId(report, 'taskwarrior').state).toBe('working');
      expect(step('taskwarrior').done).toBe(true);
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
      // Stored without `repo`, like widgets's on widgets's board: the default needs none.
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
    // Only GitHub was asked, and only the stand-in above answered.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((url) => url.startsWith('https://api.github.com/'))).toBe(true);
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

describe('the owner’s passkey step (BRK-328)', () => {
  it('is optional, after Connect the CLI, and done once the owner has a passkey; a person’s doesn’t count', async () => {
    await fresh('fresh-passkey', async (s) => {
      const step = () => s.setupSteps([]).steps.find((st) => st.id === 'passkey');
      const ids = s.setupSteps([]).steps.map((st) => st.id);
      expect(ids.indexOf('passkey')).toBe(ids.indexOf('cli') + 1);
      expect(step()).toMatchObject({ name: 'Add a passkey for yourself (optional)', optional: true, done: false });
      const passkey = (id, handle) =>
        s.sql.exec(
          'INSERT INTO passkeys (id, handle, name, alg, jwk, sign_count, created) VALUES (?, ?, ?, ?, ?, ?, ?)',
          id,
          handle,
          'Laptop',
          -7,
          '{}',
          0,
          Date.now(),
        );
      passkey('made-up-person-key', 'ana');
      expect(step().done).toBe(false);
      passkey('made-up-owner-key', 'owner');
      expect(step().done).toBe(true);
    });
  });
});

describe('the last setup step: a first closed task (BRK-143)', () => {
  /** Every step but the last done, as Connections would show it: the GitHub ones from a live check. */
  const readyBut = ({ routine }) => {
    const working = (id, repo) => ({ id, repo, state: 'working' });
    return [
      working('github.app', null),
      working('github.install', 'breakaway'),
      working('github.sync', 'breakaway'),
      ...(routine ? [working('claude.routine', 'breakaway')] : []),
      working('cli', null),
    ];
  };
  const last = (setup) => setup.steps.at(-1);

  it('without a routine, ends with a first task closed by its merged pull request, and never needs Taskwarrior', async () => {
    await fresh('fresh-first-closed', async (s) => {
      await s.reposAddApi({ slug: 'breakaway', github: 'someone/breakaway', areas: ['product:BRK'] });
      const connections = readyBut({ routine: false });
      let setup = s.setupSteps(connections);
      expect(last(setup)).toMatchObject({ id: 'first', name: 'A first task closed', done: false });
      // Until then, connecting the routine is still a step to do.
      expect(setup.steps.find((step) => step.id === 'routine').optional).toBeUndefined();
      expect(setup.done).toBe(false);

      // Claimed and finished from a local session, with its pull request in the task's pr field.
      const task = (await s.create([{ description: 'Add a README', project: 'product' }])).body.tasks[0];
      expect((await s.update(task.wid, { pr: '3' })).status).toBe(200);
      expect(last(s.setupSteps(connections)).done).toBe(false);
      expect((await s.update(task.wid, { status: 'completed' })).status).toBe(200);
      setup = s.setupSteps(connections);
      expect(last(setup)).toMatchObject({ done: true, wid: 'BRK-1', number: 3 });
      // Every step done but Taskwarrior, which is optional, and the routine, which a closed task leaves optional.
      expect(setup.steps.find((step) => step.id === 'taskwarrior').done).toBe(false);
      expect(setup.steps.find((step) => step.id === 'routine')).toMatchObject({ done: false, optional: true });
      expect(setup.done).toBe(true);
    });
  });

  it('a task closed without a pull request doesn’t count', async () => {
    await fresh('fresh-first-no-pr', async (s) => {
      await s.reposAddApi({ slug: 'breakaway', github: 'someone/breakaway', areas: ['product:BRK'] });
      const task = (await s.create([{ description: 'Add a README', project: 'product' }])).body.tasks[0];
      expect((await s.update(task.wid, { status: 'completed' })).status).toBe(200);
      const setup = s.setupSteps(readyBut({ routine: false }));
      expect(last(setup).done).toBe(false);
      expect(setup.done).toBe(false);
    });
  });

  it('with a routine, ends with a first agent’s pull request merged, as the wizard’s agent step says', async () => {
    await fresh('fresh-first-agent', async (s) => {
      await s.reposAddApi({ slug: 'breakaway', github: 'someone/breakaway', areas: ['product:BRK'] });
      const connections = readyBut({ routine: true });
      expect(last(s.setupSteps(connections))).toMatchObject({ name: 'A first agent’s pull request merged' });
      // It names the repository, so its last step opens that repository's wizard at the agent step (WEB-40).
      expect(s.setupSteps(connections).repo).toBe('breakaway');

      // A pull request merged by hand, with no agent run, isn't an agent's.
      const task = (await s.create([{ description: 'Add a README', project: 'product' }])).body.tasks[0];
      expect((await s.update(task.wid, { pr: '2', status: 'completed' })).status).toBe(200);
      expect(last(s.setupSteps(connections)).done).toBe(false);
      expect(s.wizardWork('breakaway').merged).toMatchObject({ wid: 'BRK-1' });

      // Once an agent started on it and its live output reached the task, the wizard's checks all tick.
      s.sql.exec(
        "INSERT INTO agent_runs (task, agent, trigger, status, started, repo) VALUES (?, 'claude-brk-1', 'manual', 'started', ?, 'breakaway')",
        task.uuid,
        Date.now(),
      );
      s.sql.exec("INSERT INTO agent_logs (task, at, data) VALUES (?, ?, '{}')", task.uuid, Date.now());
      const setup = s.setupSteps(connections);
      expect(last(setup)).toMatchObject({ done: true, wid: 'BRK-1', number: 2 });
      expect(setup.done).toBe(true);
    });
  });
});

describe('an install that already holds tasks', () => {
  const holdsTasks = (sql) => {
    sql.exec('CREATE TABLE tasks (uuid TEXT PRIMARY KEY, data TEXT NOT NULL)');
    sql.exec(
      'INSERT INTO tasks (uuid, data) VALUES (?, ?)',
      crypto.randomUUID(),
      JSON.stringify({ description: 'Older work', status: 'pending', project: 'debt', wid: 'DEBT-1' }),
    );
  };

  it('registers the repository TASKS_GITHUB_REPO names by itself, as before', async () => {
    await fresh(
      'populated',
      async (s) => {
        const listed = (await s.reposApi()).body;
        expect(listed.default).toBe('widgets');
        expect(listed.firstRun).toBe(false);
        expect(listed.repos.map((r) => [r.slug, r.github, r.isDefault])).toEqual([['widgets', 'acme/widgets', true]]);
        const report = await s.connectionsReport();
        expect(report.setup).toBeNull();
        expect(byId(report, 'repos.registered')).toBeUndefined();
      },
      { before: holdsTasks, vars: { ...FRESH, TASKS_GITHUB_REPO: 'acme/widgets' } },
    );
  });

  it('invents no repository when TASKS_GITHUB_REPO names none: its owner registers one', async () => {
    await fresh(
      'populated-unnamed',
      async (s) => {
        expect((await s.reposApi()).body).toMatchObject({ repos: [], default: null, firstRun: true });
      },
      { before: holdsTasks },
    );
  });

  it('leaves widgets’s board as it is: widgets the default, no setup steps', async () => {
    const repos = await (await api('repos')).json();
    expect(repos).toMatchObject({ default: 'widgets', firstRun: false });
    const report = await (await api('connections')).json();
    expect(report.setup).toBeNull();
    expect(report.connections.some((c) => c.group === 'repos')).toBe(false);
    expect(report.connections.find((c) => c.id === 'claude.routine')).toMatchObject({
      name: 'Agent routine',
      repo: 'widgets',
    });
  });
});
