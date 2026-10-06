/**
 * `npx breakaway infra init` and the apply runner's steps (CLI-12, docs/specs/IDEA-19-architect.md, "Executor").
 *
 * `infra init [--update] [--dry-run] [--branch <name>]` renders `.github/workflows/breakaway-infra.yml` from
 * template/infra/apply.yml, like `pipeline init`: one workflow for every environment with a desired-state file in
 * `.github/breakaway-infra/`, which the board starts for exactly one approved plan (BRK-171, BRK-183).
 *
 * `infra runner check|apply|end` are the steps that workflow runs, and run only there: `check` asks the board for the
 * plan with the run's GitHub OIDC token and stops unless it's approved for this environment and run; `apply` hands
 * it to the provider with the environment's write token and reports each step; `end` reports a run that stopped
 * before it finished. The contract is src/infra-runner.js.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESIRED_DIR, environmentOfFile } from '../../src/infra-desired.js';
import { checkApplyResult, providers as registry } from '../../src/infra-provider.js';
import {
  RUNNER_HEADER,
  RUNNER_WORKFLOW,
  RunnerError,
  checkRunInputs,
  checkRunPlan,
  planDigest,
  runPath,
  runReport,
} from '../../src/infra-runner.js';
import { fill, lintWorkflow } from './pipeline.js';

/** The first line of the rendered workflow: how `--update` knows the file is its own to replace. */
export const HEADER = `Rendered by npx breakaway infra init from the environments in ${DESIRED_DIR}/: add one there and run npx breakaway infra init --update, not this file.`;
/** Where the runner keeps the checked plan between its steps, in the job's temporary folder. */
export const STATE_FILE = 'breakaway-infra-run.json';
const BRANCH = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/u;
const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(HERE, '..', '..', 'template', 'infra', 'apply.yml');
const USER_AGENT = 'breakaway-infra-runner';

/** A mistake `infra init` can name. */
export class InfraError extends Error {}
const bad = (message) => {
  throw new InfraError(message);
};

// ---- infra init ----------------------------------------------------------------------------

/**
 * The environments the runner offers, from the file names in the desired-state folder: each `<environment>.json`,
 * sorted, skipping policy.json, scaling.json, and anything that isn't JSON.
 * @param {string[]} names
 */
export function environmentsIn(names) {
  const environments = [];
  for (const name of names) {
    const found = environmentOfFile(name);
    if (!found) continue;
    if ('problem' in found) throw new InfraError(`${DESIRED_DIR}/${found.problem}.`);
    environments.push(found.environment);
  }
  if (!environments.length)
    bad(
      `${DESIRED_DIR}/ has no environment's file, so there's nothing to apply to: write <environment>.json for each (like staging.json), then run this again.`,
    );
  return environments.sort();
}

/**
 * The runner's workflow for these environments, applied from `branch`, running breakaway `version`.
 * @param {{ environments: string[], branch: string, version: string }} input
 * @param {string} template template/infra/apply.yml
 * @returns {{ path: string, text: string }}
 */
export function renderRunner({ environments, branch, version }, template) {
  if (!BRANCH.test(branch)) bad(`${branch.slice(0, 80)} isn't a branch's name.`);
  if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/u.test(version)) bad(`${version} isn't a breakaway release.`);
  const text = fill(template, {
    header: HEADER,
    branchName: branch,
    version,
    environments: environments.map((name) => `- ${JSON.stringify(name)}`),
  });
  const problems = lintWorkflow(text);
  if (problems.length) throw new Error(`${RUNNER_WORKFLOW} renders with problems: ${problems.join('; ')}`);
  return { path: RUNNER_WORKFLOW, text };
}

/**
 * What `infra init` does with the rendered file, given what's there (null when nothing): write it, leave it (the
 * same), or refuse it (the repository's own, or rendered before when `update` isn't set).
 * @param {{ path: string, text: string }} file
 * @param {string | null} there
 * @param {{ update?: boolean }} [options]
 * @returns {{ write: boolean, same?: boolean, refused?: string }}
 */
export function initStep(file, there, { update = false } = {}) {
  if (there === null) return { write: true };
  if (there === file.text) return { write: false, same: true };
  if (!there.startsWith(`# ${HEADER}`))
    return { write: false, refused: "it's the repository's own, not rendered: rename it, then run infra init again" };
  if (!update) return { write: false, refused: 'it differs from what infra init renders: run infra init --update' };
  return { write: true };
}

/** The checkout's top folder, or the folder the command runs in. */
function topOf(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return cwd;
  }
}

/** The default branch, as origin names it, else main. */
function defaultBranch(root) {
  try {
    const ref = execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return ref.replace(/^origin\//u, '') || 'main';
  } catch {
    return 'main';
  }
}

/** The release this CLI is, which the rendered workflow pins. */
export const VERSION = JSON.parse(readFileSync(join(HERE, '..', '..', 'package.json'), 'utf8')).version;

/**
 * `infra init` in the checkout at `cwd`.
 * @param {Record<string, any>} opts
 * @param {{ cwd: string, log: (line: string) => void, error: (line: string) => void, version?: string }} io
 */
function init(opts, { cwd, log, error, version = VERSION }) {
  const root = topOf(cwd);
  const folder = join(root, DESIRED_DIR);
  if (!existsSync(folder))
    bad(
      `${DESIRED_DIR}/ isn't here: write the desired state of each environment there first (<environment>.json), then run this again.`,
    );
  const environments = environmentsIn(readdirSync(folder));
  const branch = opts.branch ? String(opts.branch) : defaultBranch(root);
  const file = renderRunner({ environments, branch, version }, readFileSync(TEMPLATE, 'utf8'));
  const at = join(root, file.path);
  const step = initStep(file, existsSync(at) ? readFileSync(at, 'utf8') : null, { update: Boolean(opts.update) });
  if (step.refused) {
    error(`Left ${file.path}: ${step.refused}.`);
    return 1;
  }
  if (step.same) {
    log(`${file.path} is already current.`);
    return 0;
  }
  if (!opts['dry-run']) {
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, file.text);
  }
  log(`${opts['dry-run'] ? 'Would write' : 'Wrote'} ${file.path}, for ${environments.join(', ')}, from ${branch}.`);
  log(
    `Before the board can apply a plan, the owner makes, for each environment, a GitHub environment of the same name that only ${branch} may use, with that environment's write token as the secret CLOUDFLARE_API_TOKEN; sets the repository variable BREAKAWAY_URL to the board's address; and gives the board's GitHub App Actions: read and write here. Agents never do these, and never run the workflow.`,
  );
  return 0;
}

// ---- infra runner --------------------------------------------------------------------------

/**
 * What the runner's steps read and call, passed in so the tests run without Actions, a board, or a platform.
 * @typedef {object} RunnerIO
 * @property {Record<string, string | undefined>} env
 * @property {typeof fetch} fetch
 * @property {{ get: (id: string) => import('../../src/infra-provider.js').Provider }} providers
 * @property {(line: string) => void} log
 * @property {(line: string) => void} error
 */

/** A fresh GitHub OIDC token for the board, from the job's own token endpoint. */
async function oidcToken(env, origin, fetcher) {
  const { ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: bearer } = env;
  if (!url || !bearer)
    throw new RunnerError(
      `This runs only inside the ${RUNNER_WORKFLOW} workflow, whose job has id-token: write, so the board knows where it runs.`,
    );
  const at = new URL(url);
  at.searchParams.set('audience', origin);
  const res = await fetcher(at, { headers: { Authorization: `Bearer ${bearer}`, 'User-Agent': USER_AGENT } });
  const body = res.ok ? await res.json().catch(() => null) : null;
  if (typeof body?.value !== 'string') throw new RunnerError(`GitHub gave no OIDC token (${res.status}).`);
  return body.value;
}

/** Calls the board's run route with a fresh OIDC token; the answer's JSON, or stops with what the board said. */
async function board(io, inputs, init = {}) {
  const token = await oidcToken(io.env, inputs.origin, io.fetch);
  const res = await io.fetch(`${inputs.origin}${runPath(inputs.plan)}`, {
    ...init,
    headers: {
      [RUNNER_HEADER]: token,
      'User-Agent': USER_AGENT,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const said = typeof body?.error === 'string' ? `: ${body.error.slice(0, 300)}` : '';
    throw new RunnerError(`The board refused ${init.method ?? 'GET'} for plan ${inputs.plan} (${res.status})${said}`);
  }
  return body;
}

const statePath = (env) => {
  if (!env.RUNNER_TEMP) throw new RunnerError("There is no RUNNER_TEMP: this runs only inside GitHub's Actions.");
  return join(env.RUNNER_TEMP, STATE_FILE);
};
const readState = (env) => (existsSync(statePath(env)) ? JSON.parse(readFileSync(statePath(env), 'utf8')) : null);
const writeState = (env, state) => writeFileSync(statePath(env), JSON.stringify(state));

/** Sends one report and records that it went. */
async function report(io, state, fields) {
  const body = runReport({ run: state.inputs.run, digest: state.digest, ...fields });
  await board(io, state.inputs, { method: 'POST', body: JSON.stringify(body) });
  writeState(io.env, { ...state, reported: body.step });
}

const inputsOf = (env) =>
  checkRunInputs({ plan: env.PLAN, environment: env.ENVIRONMENT, board: env.BREAKAWAY_URL, run: env.RUN_ID });

/** `check`: the board's plan for this run, approved and for this environment, or the run stops here. */
async function check(io) {
  const inputs = inputsOf(io.env);
  const plan = checkRunPlan(await board(io, inputs), inputs);
  const digest = await planDigest(plan.diff);
  writeState(io.env, { inputs, plan, digest, reported: null });
  io.log(
    `Plan ${plan.id} is approved for ${plan.environment}: ${plan.diff.changes.length} change${plan.diff.changes.length === 1 ? '' : 's'}, digest ${digest.slice(0, 12)}.`,
  );
  return 0;
}

/** `apply`: the checked plan, through its provider, with the environment's write token; every step reported. */
async function apply(io) {
  const state = readState(io.env);
  if (!state) throw new RunnerError('The plan was never checked, so nothing is applied.');
  if (state.reported) throw new RunnerError(`This run already reported ${state.reported}: a plan applies once.`);
  const inputs = inputsOf(io.env);
  if (inputs.plan !== state.inputs.plan || inputs.environment !== state.inputs.environment)
    throw new RunnerError('The checked plan is for another run.');
  const { plan } = state;
  const token = io.env.BREAKAWAY_WRITE_TOKEN;
  if (!token)
    throw new RunnerError(
      `${plan.environment}'s GitHub environment has no write token: the owner adds it as the secret CLOUDFLARE_API_TOKEN.`,
    );
  await report(io, state, { step: 'applying' });
  let result;
  try {
    const provider = io.providers.get(plan.diff.provider);
    const ctx = { environment: plan.environment, scope: plan.scope ?? {}, token, fetch: io.fetch };
    result = checkApplyResult(provider, plan.diff, await provider.apply(ctx, plan.diff));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await report(io, { ...state, reported: 'applying' }, { step: 'failed', error: message });
    throw new RunnerError(`Plan ${plan.id} failed: ${message}`);
  }
  await report(io, { ...state, reported: 'applying' }, { step: result.ok ? 'applied' : 'failed', steps: result.steps });
  for (const s of result.steps)
    io.log(`${s.ok ? 'Applied' : 'Failed'}: ${s.op} ${s.resource}${s.error ? `: ${s.error}` : ''}`);
  if (!result.ok) throw new RunnerError(`Plan ${plan.id} stopped at a failed step: the board rolls back.`);
  io.log(`Plan ${plan.id} is applied to ${plan.environment}: the board checks its health now.`);
  return 0;
}

/** `end`: a run that started applying but never said how it ended is reported failed; anything else is left. */
async function end(io) {
  const state = readState(io.env);
  if (!state) {
    io.log('The plan was never checked, so there is nothing to report.');
    return 0;
  }
  if (state.reported === 'applied' || state.reported === 'failed') return 0;
  const why = io.env.OUTCOME === 'cancelled' ? 'was cancelled' : 'stopped';
  await report(io, state, { step: 'failed', error: `The run ${why} before the apply finished.` });
  io.log(`Reported plan ${state.plan.id} failed: the run ${why}.`);
  return 0;
}

/**
 * One step of the runner, `check`, `apply`, or `end`: its exit code. A RunnerError goes to the run's log as an
 * error annotation.
 * @param {string} step
 * @param {RunnerIO} io
 */
export async function runner(step, io) {
  const steps = { check, apply, end };
  try {
    if (!Object.hasOwn(steps, step)) throw new RunnerError('infra runner has check, apply, and end.');
    return await steps[step](io);
  } catch (e) {
    if (!(e instanceof RunnerError)) throw e;
    io.error(`::error title=Apply infrastructure::${e.message.replace(/[\r\n]+/gu, ' ')}`);
    return 1;
  }
}

/**
 * `npx breakaway infra init` and `infra runner <step>`.
 * @param {string[]} args
 * @param {Record<string, any>} opts
 * @param {Partial<RunnerIO> & { cwd?: string, version?: string }} [io]
 * @returns {Promise<number>} the exit code
 */
export async function run(args, opts, io = {}) {
  const { cwd = process.cwd(), log = console.log, error = console.error } = io;
  const [command, step] = args;
  if (command === 'runner')
    return runner(step, {
      env: io.env ?? process.env,
      fetch: io.fetch ?? fetch,
      providers: io.providers ?? registry,
      log,
      error,
    });
  try {
    if (command !== 'init') bad('infra has init. npx breakaway help says what it does.');
    return init(opts, { cwd, log, error, version: io.version });
  } catch (e) {
    if (!(e instanceof InfraError)) throw e;
    error(`infra: ${e.message}`);
    return 1;
  }
}
