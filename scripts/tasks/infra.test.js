import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUNNER_HEADER, RUNNER_WORKFLOW, planDigest } from '../../src/infra-runner.js';
import { fakeProvider } from '../../test/fake-infra-provider.js';
import { HEADER, STATE_FILE, environmentsIn, initStep, renderRunner, run, runner } from './infra.js';
import { lintWorkflow, parseYaml, runScripts } from './pipeline.js';

const TEMPLATE = readFileSync(new URL('../../template/infra/apply.yml', import.meta.url), 'utf8');
const SAMPLE = { environments: ['production', 'staging'], branch: 'main', version: '2.0.0' };
const scratch = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'infra-'));
  scratch.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// CLI-12: the apply runner is a workflow rendered into the repository, like pipeline init's.
describe('infra init renders the runner (CLI-12)', () => {
  it('as the snapshot says', async () => {
    const file = renderRunner(SAMPLE, TEMPLATE);
    expect(file.path).toBe(RUNNER_WORKFLOW);
    await expect(file.text).toMatchFileSnapshot('./__snapshots__/breakaway-infra.yml');
  });

  it('sound: the workflow linter and bash both pass it', () => {
    const { text } = renderRunner(SAMPLE, TEMPLATE);
    expect(lintWorkflow(text)).toEqual([]);
    for (const { where, script } of runScripts(text)) {
      const bash = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
      expect(bash.status, `${where}: ${bash.stderr}`).toBe(0);
    }
  });

  it('runs one approved plan, from the default branch, in the environment’s GitHub environment, with no code checked out', () => {
    const doc = parseYaml(renderRunner({ ...SAMPLE, branch: 'trunk' }, TEMPLATE).text);
    expect(Object.keys(doc.on)).toEqual(['workflow_dispatch']);
    expect(doc.on.workflow_dispatch.inputs.plan).toMatchObject({ required: true, type: 'string' });
    expect(doc.on.workflow_dispatch.inputs.environment).toMatchObject({
      type: 'choice',
      options: ['production', 'staging'],
    });
    const job = doc.jobs.apply;
    expect(job.if).toBe("github.ref == 'refs/heads/trunk'");
    expect(job.environment).toBe(`\${{ inputs.environment }}`);
    expect(job.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(job.steps.some((s) => String(s.uses ?? '').startsWith('actions/checkout'))).toBe(false);
    expect(job.steps.filter((s) => s.run).map((s) => s.run)).toEqual([
      'npx --yes breakaway@2.0.0 infra runner check',
      'npx --yes breakaway@2.0.0 infra runner apply',
      'npx --yes breakaway@2.0.0 infra runner end',
    ]);
    // The write token reaches only the apply step, which runs after the plan is checked.
    const withSecret = job.steps.filter((s) => JSON.stringify(s).includes('secrets.'));
    expect(withSecret.map((s) => s.name)).toEqual(['Apply the plan']);
  });

  it('offers every environment with a file, and no reserved one', () => {
    expect(environmentsIn(['staging.json', 'policy.json', 'scaling.json', 'README.md', 'production.json'])).toEqual([
      'production',
      'staging',
    ]);
    expect(() => environmentsIn(['policy.json'])).toThrow(/no environment's file/u);
    expect(() => environmentsIn(['Prod.json'])).toThrow(/isn’t an environment’s name/u);
  });

  it('refuses a branch or a release it can’t pin', () => {
    expect(() => renderRunner({ ...SAMPLE, branch: 'a..b' }, TEMPLATE)).toThrow(/branch/u);
    expect(() => renderRunner({ ...SAMPLE, version: 'latest' }, TEMPLATE)).toThrow(/release/u);
  });

  it('writes a new file, leaves a current one, and replaces only its own with --update', () => {
    const file = { path: RUNNER_WORKFLOW, text: `# ${HEADER}\nnew\n` };
    expect(initStep(file, null)).toEqual({ write: true });
    expect(initStep(file, file.text)).toEqual({ write: false, same: true });
    expect(initStep(file, `# ${HEADER}\nold\n`).refused).toMatch(/--update/u);
    expect(initStep(file, `# ${HEADER}\nold\n`, { update: true })).toEqual({ write: true });
    expect(initStep(file, 'name: Ours\n', { update: true }).refused).toMatch(/repository's own/u);
  });
});

describe('npx breakaway infra init in a scratch repository (CLI-12)', () => {
  let root;
  let out;
  const io = () => ({ cwd: root, version: '2.0.0', log: (l) => out.push(l), error: (l) => out.push(`! ${l}`) });
  beforeEach(() => {
    root = tmp();
    out = [];
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  });

  it('says what to write when there is no desired state', async () => {
    expect(await run(['init'], {}, io())).toBe(1);
    expect(out.join('\n')).toMatch(/\.github\/breakaway-infra\/ isn't here/u);
    expect(existsSync(join(root, RUNNER_WORKFLOW))).toBe(false);
  });

  it('renders the runner for the environments there, and leaves it once it’s current', async () => {
    mkdirSync(join(root, '.github/breakaway-infra'), { recursive: true });
    for (const name of ['staging', 'production', 'policy'])
      writeFileSync(join(root, `.github/breakaway-infra/${name}.json`), '{}\n');

    expect(await run(['init'], { 'dry-run': true }, io())).toBe(0);
    expect(existsSync(join(root, RUNNER_WORKFLOW))).toBe(false);

    expect(await run(['init'], {}, io())).toBe(0);
    const text = readFileSync(join(root, RUNNER_WORKFLOW), 'utf8');
    expect(text).toBe(renderRunner(SAMPLE, TEMPLATE).text);
    expect(out.join('\n')).toMatch(/Wrote .*breakaway-infra\.yml, for production, staging, from main/u);
    expect(out.join('\n')).toMatch(/CLOUDFLARE_API_TOKEN/u);

    expect(await run(['init'], {}, io())).toBe(0);
    expect(out.at(-1)).toMatch(/already current/u);

    writeFileSync(join(root, '.github/breakaway-infra/preview.json'), '{}\n');
    expect(await run(['init'], {}, io())).toBe(1);
    expect(out.at(-1)).toMatch(/--update/u);
    expect(await run(['init'], { update: true }, io())).toBe(0);
    expect(readFileSync(join(root, RUNNER_WORKFLOW), 'utf8')).toContain('- "preview"');

    writeFileSync(join(root, RUNNER_WORKFLOW), 'name: Ours\n');
    expect(await run(['init'], { update: true }, io())).toBe(1);
    expect(readFileSync(join(root, RUNNER_WORKFLOW), 'utf8')).toBe('name: Ours\n');
  });

  it('takes --branch', async () => {
    mkdirSync(join(root, '.github/breakaway-infra'), { recursive: true });
    writeFileSync(join(root, '.github/breakaway-infra/staging.json'), '{}\n');
    expect(await run(['init'], { branch: 'trunk' }, io())).toBe(0);
    expect(readFileSync(join(root, RUNNER_WORKFLOW), 'utf8')).toContain("refs/heads/trunk'");
  });
});

// The runner's steps, against a mocked board, GitHub's OIDC endpoint, and the fake provider.
describe('infra runner (CLI-12)', () => {
  const BOARD = 'https://board.example.com';
  const OIDC = 'https://token.actions.example.com/token?api-version=2.0';
  let env;
  let calls;
  let lines;
  let answer;
  let fake;

  const plan = (over = {}) => ({
    id: 'p-1',
    environment: 'staging',
    state: 'approved',
    diff: {
      provider: 'fake',
      environment: 'staging',
      changes: [
        {
          op: 'update',
          resource: 'svc-api',
          kind: 'service',
          name: 'api',
          before: { instances: 2, version: '1.0.0' },
          after: { instances: 3, version: '1.0.0' },
          reversible: true,
        },
      ],
      reversible: true,
    },
    ...over,
  });

  /** @type {typeof fetch} */
  const mockFetch = async (url, init = {}) => {
    const href = String(url);
    calls.push({
      href,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : null,
    });
    if (href.startsWith('https://token.actions.example.com/')) {
      expect(init.headers.Authorization).toBe('Bearer fake-request-token');
      return Response.json({ value: `oidc-for-${new URL(href).searchParams.get('audience')}` });
    }
    if (href === `${BOARD}/api/infra/runs/p-1`) {
      expect(init.headers[RUNNER_HEADER]).toBe(`oidc-for-${BOARD}`);
      if ((init.method ?? 'GET') === 'GET') return answer();
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected fetch ${href}`);
  };

  const providers = { get: (id) => (id === fake.id ? fake : fail(id)) };
  const fail = (id) => {
    throw new Error(`no provider ${id}`);
  };
  const step = (name) =>
    runner(name, { env, fetch: mockFetch, providers, log: (l) => lines.push(l), error: (l) => lines.push(`! ${l}`) });
  const posts = () => calls.filter((c) => c.method === 'POST').map((c) => c.body);
  const platformState = () => fake.state.resources.find((r) => r.id === 'svc-api').attrs;

  beforeEach(() => {
    env = {
      PLAN: 'p-1',
      ENVIRONMENT: 'staging',
      BREAKAWAY_URL: `${BOARD}/`,
      RUN_ID: '42',
      RUNNER_TEMP: tmp(),
      ACTIONS_ID_TOKEN_REQUEST_URL: OIDC,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fake-request-token',
      BREAKAWAY_WRITE_TOKEN: 'fake-write-token',
    };
    calls = [];
    lines = [];
    answer = () => Response.json({ plan: plan() });
    fake = fakeProvider();
  });

  it('refuses to start without a plan ID, and asks nobody', async () => {
    env.PLAN = '';
    expect(await step('check')).toBe(1);
    expect(lines.join('\n')).toMatch(/::error title=Apply infrastructure::There is no plan/u);
    expect(calls).toEqual([]);
    expect(await step('apply')).toBe(1);
    expect(lines.at(-1)).toMatch(/never checked/u);
    expect(await step('end')).toBe(0);
    expect(calls).toEqual([]);
  });

  it('refuses a plan the board didn’t approve, and never applies it', async () => {
    answer = () => Response.json({ plan: plan({ state: 'waiting' }) });
    expect(await step('check')).toBe(1);
    expect(lines.at(-1)).toMatch(/is waiting, not approved/u);
    expect(await step('apply')).toBe(1);
    expect(platformState()).toEqual({ instances: 2, version: '1.0.0' });
    expect(posts()).toEqual([]);
  });

  it('stops when the board refuses the run, with what it said', async () => {
    answer = () => Response.json({ error: 'this plan already ran' }, { status: 409 });
    expect(await step('check')).toBe(1);
    expect(lines.at(-1)).toMatch(/refused GET for plan p-1 \(409\): this plan already ran/u);
  });

  it('runs only inside Actions, with an OIDC token', async () => {
    delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
    expect(await step('check')).toBe(1);
    expect(lines.at(-1)).toMatch(/id-token: write/u);
  });

  it('applies an approved plan and reports each step with its digest', async () => {
    expect(await step('check')).toBe(0);
    expect(calls[0].href).toContain('audience=https%3A%2F%2Fboard.example.com');
    expect(await step('apply')).toBe(0);
    expect(await step('end')).toBe(0);
    expect(platformState()).toEqual({ instances: 3, version: '1.0.0' });
    const digest = await planDigest(plan().diff);
    expect(posts()).toEqual([
      { run: '42', step: 'applying', digest },
      { run: '42', step: 'applied', digest, steps: [{ resource: 'svc-api', op: 'update', ok: true }] },
    ]);
    // A plan applies once, whatever runs the step again.
    expect(await step('apply')).toBe(1);
    expect(lines.at(-1)).toMatch(/already reported applied/u);
    expect(posts()).toHaveLength(2);
  });

  it('reports a failed apply, with the provider’s error, and exits 1', async () => {
    answer = () => Response.json({ plan: plan({ diff: { ...plan().diff, provider: 'elsewhere' } }) });
    expect(await step('check')).toBe(0);
    expect(await step('apply')).toBe(1);
    expect(posts().map((p) => p.step)).toEqual(['applying', 'failed']);
    expect(posts()[1].error).toMatch(/no provider elsewhere/u);
    expect(await step('end')).toBe(0);
    expect(posts()).toHaveLength(2);
  });

  it('never reads the plan as applyable without the environment’s write token', async () => {
    delete env.BREAKAWAY_WRITE_TOKEN;
    expect(await step('check')).toBe(0);
    expect(await step('apply')).toBe(1);
    expect(lines.at(-1)).toMatch(/no write token/u);
    expect(posts()).toEqual([]);
  });

  it('reports a run cancelled mid-apply as failed', async () => {
    expect(await step('check')).toBe(0);
    const state = JSON.parse(readFileSync(join(env.RUNNER_TEMP, STATE_FILE), 'utf8'));
    writeFileSync(join(env.RUNNER_TEMP, STATE_FILE), JSON.stringify({ ...state, reported: 'applying' }));
    env.OUTCOME = 'cancelled';
    expect(await step('end')).toBe(0);
    expect(posts()).toEqual([
      { run: '42', step: 'failed', digest: state.digest, error: 'The run was cancelled before the apply finished.' },
    ]);
  });

  it('finds the registered providers when none are passed (CLI-22)', async () => {
    answer = () => Response.json({ plan: plan({ diff: { ...plan().diff, provider: 'cloudflare' } }) });
    const io = { env, fetch: mockFetch, log: (l) => lines.push(l), error: (l) => lines.push(`! ${l}`) };
    expect(await run(['runner', 'check'], {}, io)).toBe(0);
    expect(await run(['runner', 'apply'], {}, io)).toBe(1);
    expect(posts()[1].error).not.toMatch(/no provider/u);
    expect(posts()[1].error).toMatch(/^cloudflare /u);
  });

  it('has check, apply, and end', async () => {
    expect(await step('deploy')).toBe(1);
    expect(lines.at(-1)).toMatch(/check, apply, and end/u);
  });
});
