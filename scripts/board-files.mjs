#!/usr/bin/env node
/**
 * Writes src/board-files.json (BRK-132): the board's files repos init reads (boardSources in src/init.js), by path,
 * so the Worker renders an empty repository's first commit from the same files as the CLI. It's generated, never
 * committed (BRK-148): `pnpm install`, `build`, `typecheck`, `test`, and `deploy` run this first, and the release
 * workflow's build puts it in the bundle.
 *
 * It writes src/infra-shipped-templates.json too (BRK-259), generated and never committed the same way: the golden
 * paths breakaway ships, template/infra/templates/<name>/, each file by name, so the board's console can add from
 * them when a repository has no template of that name.
 *
 * And src/infra-runner-template.json (BRK-307), the same way: the apply workflow's template, so the board renders
 * .github/workflows/breakaway-infra.yml from the very text npx breakaway infra init does.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { boardSources } from '../src/init.js';
import { RUNNER_TEMPLATE } from '../src/infra-runner-render.js';

const ROOT = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8');

export const boardFiles = () => Object.fromEntries(boardSources(read).map((path) => [path, read(path)]));

const TEMPLATES = 'template/infra/templates/';
export const shippedTemplates = () =>
  Object.fromEntries(
    readdirSync(new URL(TEMPLATES, ROOT), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .map((name) => [
        name,
        Object.fromEntries(
          readdirSync(new URL(`${TEMPLATES}${name}/`, ROOT))
            .sort()
            .map((file) => [file, read(`${TEMPLATES}${name}/${file}`)]),
        ),
      ]),
  );

export const runnerTemplate = () => ({ path: RUNNER_TEMPLATE, text: read(RUNNER_TEMPLATE) });

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(new URL('src/board-files.json', ROOT), `${JSON.stringify(boardFiles(), null, 2)}\n`);
  writeFileSync(new URL('src/infra-shipped-templates.json', ROOT), `${JSON.stringify(shippedTemplates(), null, 2)}\n`);
  writeFileSync(new URL('src/infra-runner-template.json', ROOT), `${JSON.stringify(runnerTemplate(), null, 2)}\n`);
  // On stderr: npm pack and npm publish run it (prepare), and their --json goes to stdout.
  console.error('Wrote src/board-files.json, src/infra-shipped-templates.json, and src/infra-runner-template.json.');
}
