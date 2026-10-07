// Runs the launch board (board/worker.js) with `wrangler dev` on 127.0.0.1:8787: breakaway's Worker with a made-up
// platform and GitHub, for the launch media. Its secrets are throwaway values made here, in board/.dev.vars (never
// committed), and its state starts empty each run. Run: node board.mjs, then seed.sh and screens.mjs in another shell.
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const vars = here('./board/.dev.vars');
if (!existsSync(vars)) {
  // A throwaway GitHub App key: the made-up GitHub never checks it, but the board signs its requests with one.
  const github = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  });
  writeFileSync(
    vars,
    [
      `TASKS_API_TOKEN=launch-${randomBytes(16).toString('hex')}`,
      `TASKS_CLIENT_ID=${randomUUID()}`,
      `TASKS_SYNC_KEY=${randomBytes(32).toString('base64')}`,
      'TASKS_GITHUB_APP_ID=424242',
      `TASKS_GITHUB_KEY="${String(github).trim().replace(/\n/gu, '\\n')}"`,
      `TASKS_GITHUB_WEBHOOK_SECRET=${randomBytes(16).toString('hex')}`,
      '',
    ].join('\n'),
  );
}
// A fresh board every run, so seed.sh's work IDs come out the same.
rmSync(here('./board/.wrangler'), { recursive: true, force: true });
const token = /TASKS_API_TOKEN=(.+)/u.exec(String(readFileSync(vars)))?.[1];
console.log(`The launch board's token: ${token}\nBREAKAWAY_URL=http://127.0.0.1:8787 BREAKAWAY_TOKEN=${token}`);
spawn(
  'pnpm',
  [
    'exec',
    'wrangler',
    'dev',
    '-c',
    here('./board/wrangler.jsonc'),
    '--ip',
    '127.0.0.1',
    '--port',
    '8787',
    '--persist-to',
    here('./board/.wrangler/state'),
  ],
  { stdio: 'inherit', cwd: here('../..') },
).on('exit', (code) => process.exit(code ?? 0));
