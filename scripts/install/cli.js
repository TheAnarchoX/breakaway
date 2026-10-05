// `npx breakaway install <step>` (BRK-9): `init` makes an install repository, and the other steps are what its
// Deploy and Update workflows run (template/.github/workflows). Each step reads files and prints `key=value` lines
// for $GITHUB_OUTPUT; a step that stops the workflow prints a plain message and exits 2.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, parseInstall, wranglerConfig } from '../../src/install.js';
import { ask } from '../tasks/ask.js';
import { QUESTIONS, configFrom, stateFrom, writeInstall } from './init.js';
import {
  bumpBody,
  deployPlan,
  deployTarget,
  latestReleases,
  newWorkerStop,
  parseState,
  pingHealth,
  previousVersionId,
  shapeOf,
  updatePlan,
  workerMissing,
} from './lib.js';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The repository the releases come from, unless a fork says otherwise (the workflows pass --repo). */
const DEFAULT_REPO = 'TheAnarchoX/breakaway';

export const STEPS = ['init', 'resolve', 'check', 'config', 'previous', 'missing', 'healthy', 'update'];

/** A step's own mistake: the message is printed, and the step exits with `code`. */
class Stop extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

const readJson = (path, what) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Stop(`${path}: couldn't read ${what} (${error.code ?? error.message}).`);
  }
};

/** The releases in a file, or none when it's missing or isn't the feed or GitHub's list: the workflow then tries the other source. */
function releasesIn(path) {
  if (!path) return { stable: null, main: null };
  try {
    return latestReleases(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return { stable: null, main: null };
  }
}

const stateIn = (dir) => {
  try {
    return parseState(readJson(join(dir, 'breakaway.json'), 'breakaway.json'));
  } catch (error) {
    throw error instanceof Stop ? error : new Stop(error.message);
  }
};

const configIn = (path) => {
  try {
    return parseInstall(readJson(path, 'the install’s config'));
  } catch (error) {
    throw error instanceof ConfigError ? new Stop(`${path}: ${error.message}`) : error;
  }
};

/** A file's JSON, or null when it's missing or isn't JSON. */
const jsonIn = (path) => {
  try {
    return path ? JSON.parse(readFileSync(path, 'utf8')) : null;
  } catch {
    return null;
  }
};

/** The running Worker's shape for `check`, or null when nothing says what it is. */
function runningShape(opts) {
  const running = jsonIn(opts['running-config']);
  if (running && typeof running === 'object') return shapeOf(running);
  const before = jsonIn(opts.before);
  if (!before) return null; // no earlier config (the first deploy, or a dispatch): nothing to compare with
  try {
    return shapeOf(wranglerConfig(parseInstall(before)));
  } catch {
    return null;
  }
}

/** The Worker's wrangler config for a downloaded release: the install's config, with the code and web app where the bundle put them. */
export function bundleConfig(config, bundle) {
  const out = wranglerConfig(config);
  out.main = `./${bundle}/worker/src/worker.js`;
  out.assets = { ...out.assets, directory: `./${bundle}/dist` };
  return out;
}

/**
 * Runs one step. `io` is { out(line), cwd, input() } so tests need no process.
 * @returns {Promise<number>} the exit code
 */
export async function runStep(step, opts, io) {
  const dir = io.cwd;
  const repo = opts.repo ?? DEFAULT_REPO;
  if (step === 'resolve') {
    const target = deployTarget(stateIn(dir), releasesIn(opts.releases));
    io.out(`version=${target.version}`);
    io.out(`tag=${target.tag}`);
    io.out(`channel=${target.channel}`);
    io.out(`repository=${repo}`);
    return 0;
  }
  if (step === 'check') {
    const version = opts.version;
    if (!version) throw new Stop('check needs --version, the release being deployed.');
    const manifest = readJson(opts.manifest ?? 'release/manifest.json', 'the release’s manifest');
    // The Worker as it runs: the config the running release's own CLI made (--running-config), else this release's code
    // with the config from before this push (--before). Neither (a first deploy, or a dispatch): nothing to compare.
    const before = runningShape(opts);
    const after = before && shapeOf(wranglerConfig(configIn(join(dir, 'breakaway.config.json'))));
    const apply = opts['deploy-changes'] === true || opts['deploy-changes'] === 'true';
    const plan = deployPlan(manifest, { version, running: opts.running || null, before, after, apply });
    if (plan.ok === false) throw new Stop(plan.message, 2);
    io.out('ok=true');
    io.out(`deploy=${plan.deploy}`);
    io.out(`changes=${plan.changes.join(', ')}`);
    io.out(`address_changed=${plan.addressChanged}`);
    return 0;
  }
  if (step === 'config') {
    const out = resolve(dir, opts.out ?? 'wrangler.generated.json');
    mkdirSync(dirname(out), { recursive: true });
    const config = configIn(join(dir, 'breakaway.config.json'));
    writeFileSync(out, `${JSON.stringify(bundleConfig(config, opts.bundle ?? 'bundle'), null, 2)}\n`);
    io.out(`address=${config.url ?? ''}`);
    return 0;
  }
  if (step === 'previous') {
    io.out(`previous=${previousVersionId(JSON.parse(io.input() || '[]')) ?? ''}`);
    return 0;
  }
  if (step === 'missing') {
    // stdin is wrangler's output from a failed `deployments list`: only a Worker that doesn't exist is a first deploy.
    const output = io.input() || '';
    if (!workerMissing(output)) {
      throw new Stop(
        `Couldn't list the Worker's deployments, so the deploy stopped before changing anything. Check that CLOUDFLARE_ACCOUNT_ID is your account's ID and that CLOUDFLARE_API_TOKEN can read Workers on it. Wrangler said:\n${output.trim()}`,
      );
    }
    // A Worker that doesn't exist on an install that already has a board is a changed or mistyped name, not a first
    // deploy (BRK-141): a dispatch has no earlier config for `check` to compare with.
    const stop = newWorkerStop({
      worker: configIn(join(dir, 'breakaway.config.json')).worker,
      variable: opts.variable || null,
      running: opts.running || null,
      at: opts.at || null,
    });
    if (stop) throw new Stop(stop, 2);
    io.out('first=true');
    return 0;
  }
  if (step === 'healthy') {
    if (!opts.version) throw new Stop('healthy needs --version, the release that should answer.');
    let ping = null;
    try {
      ping = JSON.parse(io.input());
    } catch {
      ping = null;
    }
    // A first deploy answers before its secrets are on (the install puts them on the Worker it made), so there it
    // passes and says so; any later deploy needs them (BRK-141).
    const health = pingHealth(ping, opts.version);
    const first = opts.first === true || opts.first === 'true';
    io.out(`health=${health}`);
    return health === 'healthy' || (first && health === 'secrets') ? 0 : 1;
  }
  if (step === 'update') {
    const state = stateIn(dir);
    const plan = updatePlan(state, releasesIn(opts.releases), opts.running || null);
    io.out(`action=${plan.action}`);
    if (plan.action === 'none') {
      io.out(`reason=${plan.reason}`);
      return 0;
    }
    io.out(`version=${plan.version}`);
    io.out(`tag=${plan.tag}`);
    if (plan.action === 'bump') {
      writeFileSync(join(dir, 'breakaway.json'), `${JSON.stringify({ ...state, version: plan.version }, null, 2)}\n`);
      let manifest = null;
      let notes = '';
      try {
        manifest = opts.manifest ? JSON.parse(readFileSync(opts.manifest, 'utf8')) : null;
        notes = opts.notes ? readFileSync(opts.notes, 'utf8') : '';
      } catch {
        manifest = null;
      }
      const body = bumpBody({ from: state.version, to: plan.version, repository: repo, notes, manifest });
      if (opts.body) writeFileSync(opts.body, body);
      io.out(`title=Update breakaway to ${plan.version}`);
    }
    return 0;
  }
  throw new Stop(`install has no "${step}"; it has ${STEPS.join(', ')}.`);
}

/** Asks what the flags didn't answer, in a terminal; everywhere else the defaults stand. */
async function answersFor(opts, { input, output }) {
  const answers = {};
  for (const q of QUESTIONS) {
    if (opts[q.flag] !== undefined) answers[q.flag] = opts[q.flag];
    else if (input?.isTTY) {
      const shown = q.fallback ? ` [${q.fallback}]` : '';
      answers[q.flag] = (await ask(`${q.ask}${shown} `, { input, output, createInterface })) || q.fallback;
    }
  }
  return answers;
}

/** The owner/name of the GitHub repository `dir`'s origin names, or '' when it has none (or isn't GitHub's). */
export function originRepository(dir) {
  try {
    const url = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/iu.exec(url)?.[1] ?? '';
  } catch {
    return '';
  }
}

/** `npx breakaway install init [dir]`. */
export async function runInit(args, opts, { cwd, out, input = process.stdin, output = process.stderr, own }) {
  const dir = resolve(cwd, args[0] ?? '.');
  mkdirSync(dir, { recursive: true });
  let config;
  let state;
  try {
    const answers = await answersFor(opts, { input, output });
    // The board looks for updates in the repository it deploys from: the flag, else what the terminal says, else origin.
    let installRepository = opts['install-repository'];
    if (installRepository === undefined) {
      const origin = originRepository(dir);
      installRepository = input?.isTTY
        ? (await ask(`Install repository (owner/name)${origin ? ` [${origin}]` : ', or blank to skip'}? `, {
            input,
            output,
            createInterface,
          })) || origin
        : origin;
    }
    config = configFrom(answers, { ...opts, 'install-repository': installRepository });
    state = stateFrom({ version: opts.version, channel: opts.channel }, own);
  } catch (error) {
    if (error instanceof ConfigError || /^breakaway\.json/u.test(error.message))
      throw new Stop(`install init: ${error.message}`);
    throw error;
  }
  const { written, skipped } = writeInstall({ dir, templateDir: join(PKG, 'template'), config, state });
  for (const file of written) out(`added   ${file}`);
  for (const file of skipped) out(`kept    ${file} (already there)`);
  out('');
  out(
    `Next: commit these to a private repository, then follow its README: a GitHub environment named production with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, and the board's secrets (see .dev.vars.example).`,
  );
  if (state.channel === 'main' && !opts.channel)
    out(
      'No stable release exists yet, so this install follows the main channel. Set "channel": "stable" in breakaway.json to pin a release once there is one.',
    );
  return 0;
}

/** Entry from scripts/tasks.mjs: `args` is what follows `install`, `opts` the parsed `--flags`. */
export async function run(args, opts) {
  const [step, ...rest] = args;
  const own = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version;
  let lines = 0;
  const io = {
    cwd: process.cwd(),
    out: (line) => {
      lines += 1;
      console.log(line);
    },
    input: () => readFileSync(0, 'utf8'),
  };
  try {
    if (!step) throw new Stop(`install needs a step: ${STEPS.join(', ')}. npx breakaway help says what each does.`);
    const code =
      step === 'init' ? await runInit(rest, opts, { cwd: io.cwd, out: io.out, own }) : await runStep(step, opts, io);
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof Stop) && !(error instanceof Error)) throw error;
    const message = error.message;
    if (process.env.GITHUB_ACTIONS === 'true')
      console.log(`::error title=breakaway install ${step ?? ''}::${message.replace(/\n/gu, '%0A')}`);
    console.error(`install ${step ?? ''}: ${message}`);
    process.exitCode = error instanceof Stop ? error.code : 1;
  }
  return lines;
}
