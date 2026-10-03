/**
 * Builds the task board's web app (tools/tasks/web) into tools/tasks/dist, which the
 * board's Worker serves as static assets. `pnpm build` and `pnpm tasks:deploy` run it.
 * The app wears breakaway's identity (BRD-28): the tokens and logo in brand/, its base styles
 * (web/src/styles), its fonts (the package's dependencies), and its icons (web/public/icons, built by
 * brand/tools/icons.mjs), all inside the package, so it builds on its own (CLD-135).
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: here('./web'),
  plugins: [preact()],
  build: {
    outDir: here('./dist'),
    emptyOutDir: true,
    // The CSP allows only same-origin files, so nothing is inlined as a data: URL.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
  server: {
    // `wrangler dev -c tools/tasks/wrangler.test.jsonc` on 8787 serves the API.
    proxy: { '/api': 'http://127.0.0.1:8787', '/login': 'http://127.0.0.1:8787', '/logout': 'http://127.0.0.1:8787' },
  },
});
