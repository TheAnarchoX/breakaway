// `npx breakaway install init [dir]` (BRK-9): writes an install repository's files. It never overwrites a file, like
// repos init: one that is there is skipped and said, and .gitignore only gets the lines it lacks.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ConfigError, parseInstall } from '../../src/install.js';
import { parseState } from './lib.js';

/** The template's own files, relative to its folder and to the install repository. */
export const TEMPLATE_FILES = ['.dev.vars.example', '.github/workflows/deploy.yml', '.github/workflows/update.yml'];
/** What the install repository keeps out of git: the secrets copy, and what the workflows make. */
export const GITIGNORE = [
  '.dev.vars*',
  '!.dev.vars.example',
  '.wrangler/',
  'node_modules/',
  'bundle/',
  'release/',
  'wrangler.generated.json',
];

/** The install's questions: flag, config key, what's asked, and the default shown. */
export const QUESTIONS = [
  { flag: 'name', key: 'name', ask: 'What is this board called?', fallback: 'breakaway' },
  { flag: 'worker', key: 'worker', ask: 'Worker name on Cloudflare?', fallback: 'breakaway' },
  {
    flag: 'url',
    key: 'url',
    ask: 'Address on your own domain (https://tasks.example.com), or blank for workers.dev?',
    fallback: '',
  },
  {
    flag: 'secrets-store',
    key: 'secretsStore',
    ask: 'Secrets Store ID (32 hex characters), or blank to set secrets on the Worker itself?',
    fallback: '',
  },
];

/** The config's other settings come only from flags: flag → config key. */
const OTHER_FLAGS = {
  'secrets-prefix': 'secretsPrefix',
  store: 'store',
  jurisdiction: 'jurisdiction',
  repository: 'repository',
  docs: 'docs',
  'install-repository': 'installRepository',
};

/** The install's config from what was answered (blank is null) and the other flags; throws ConfigError for a bad value. */
export function configFrom(answers, opts = {}) {
  const raw = {};
  for (const q of QUESTIONS) {
    const value = String(answers[q.flag] ?? q.fallback).trim();
    if (value) raw[q.key] = value;
  }
  for (const [flag, key] of Object.entries(OTHER_FLAGS)) if (opts[flag]) raw[key] = String(opts[flag]);
  return parseInstall(raw);
}

/**
 * The install's breakaway.json: `channel` and `version` from the flags, else the stable release this CLI is when it is one,
 * else the main channel (a stable release may not exist yet) at the pre-release this CLI is.
 */
export function stateFrom({ version, channel }, own) {
  const cliIsStable = /^\d+\.\d+\.\d+$/u.test(own);
  const chosen = channel ?? (cliIsStable ? 'stable' : 'main');
  return parseState({ channel: chosen, version: version ?? own });
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** The README, from the template's, with this install's names. */
export function readmeFor(template, config) {
  const address = config.url ?? 'the workers.dev address Cloudflare gives it';
  return template
    .replaceAll('{{name}}', config.name)
    .replaceAll('{{worker}}', config.worker)
    .replaceAll('{{address}}', address);
}

/**
 * Writes the install repository into `dir`. `templateDir` is the package's template folder.
 * @returns {{ written: string[], skipped: string[] }}
 */
export function writeInstall({ dir, templateDir, config, state }) {
  const written = [];
  const skipped = [];
  const put = (path, text) => {
    const target = join(dir, path);
    if (existsSync(target)) return skipped.push(path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    written.push(path);
  };
  // The Worker reads the channel from its config (BRK-10), so it starts the same as breakaway.json's.
  put('breakaway.config.json', json({ ...config, channel: state.channel }));
  put('breakaway.json', json(state));
  for (const file of TEMPLATE_FILES) put(file, readFileSync(join(templateDir, file), 'utf8'));
  put('README.md', readmeFor(readFileSync(join(templateDir, 'README.md'), 'utf8'), config));
  const ignore = join(dir, '.gitignore');
  const have = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
  const missing = GITIGNORE.filter((line) => !have.split('\n').includes(line));
  if (missing.length) {
    writeFileSync(ignore, `${have}${have && !have.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
    written.push('.gitignore');
  }
  return { written, skipped };
}

export { ConfigError };
