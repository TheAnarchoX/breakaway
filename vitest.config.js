import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  TEST_API_TOKEN,
  TEST_CLIENT_ID,
  TEST_GITHUB_APP_ID,
  TEST_GITHUB_WEBHOOK_SECRET,
  TEST_SYNC_KEY,
} from './test/constants.js';

// A throwaway key for the GitHub App's JWT in tests; the public half checks the signature.
const github = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

// A throwaway VAPID key pair for Web Push in tests (the public half is the uncompressed point).
const vapid = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
const vapidPublic = b64u(
  Buffer.concat([Buffer.from([4]), Buffer.from(vapid.x, 'base64url'), Buffer.from(vapid.y, 'base64url')]),
);

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // The package's own folder, so the tests run the same from anywhere.
  root: here('.'),
  plugins: [
    cloudflareTest({
      wrangler: { configPath: here('./wrangler.test.jsonc') },
      miniflare: {
        bindings: {
          TASKS_CLIENT_ID: TEST_CLIENT_ID,
          TASKS_SYNC_KEY: TEST_SYNC_KEY,
          TASKS_API_TOKEN: TEST_API_TOKEN,
          TASKS_GITHUB_APP_ID: TEST_GITHUB_APP_ID,
          TASKS_GITHUB_KEY: github.privateKey,
          TASKS_GITHUB_WEBHOOK_SECRET: TEST_GITHUB_WEBHOOK_SECRET,
          TEST_GITHUB_PUBLIC_KEY: github.publicKey,
          TASKS_ROUTINE_URL: 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire',
          TASKS_ROUTINE_TOKEN: 'sk-ant-oat01-test-routine-token',
          // Other repositories' routines, keyed by slug (agents.test.js registers breakaway).
          TASKS_ROUTINES: JSON.stringify({
            breakaway: {
              url: 'https://api.anthropic.com/v1/claude_code/routines/trig_breakaway/fire',
              token: 'sk-ant-oat01-breakaway-routine-token',
            },
          }),
          TASKS_VAPID_KEY: vapid.d,
          TASKS_VAPID_PUBLIC: vapidPublic,
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.js'],
    // Vitest swaps stylesheets for empty strings unless they're included, ?raw imports too; brand.test.js reads them.
    css: { include: [/\.css(\?|$)/u] },
  },
});
