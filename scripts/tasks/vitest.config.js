import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The board's CLI (scripts/tasks.mjs and scripts/tasks/): plain Node, no Worker. `pnpm test` runs it.
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    include: [
      'scripts/tasks/**/*.test.js',
      'scripts/lib/**/*.test.js',
      'scripts/release/**/*.test.js',
      'scripts/install/**/*.test.js',
    ],
  },
});
