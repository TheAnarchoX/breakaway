#!/usr/bin/env node
/**
 * Builds the landing page and the docs: site/content (Markdown and one HTML page) into site/public, and copies the
 * install prompt (prompts/install.md) to /install.md, where Claude Code reads it from the site (DOC-8), and writes
 * /llms.txt, /llms-full.txt, and each docs page as Markdown (LCH-10).
 *   node site/build.mjs           write the pages
 *   node site/build.mjs --check   exit 1 when a written page differs from what the content builds
 * The pages are committed, so deploying the site needs no build step; test/site-pages.test.js runs the check.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLlms, buildPages } from './lib/site.js';

const here = dirname(fileURLToPath(import.meta.url));

export function readContent(root = here) {
  const docsDir = join(root, 'content/docs');
  const docs = {};
  for (const file of readdirSync(docsDir))
    if (file.endsWith('.md')) docs[file.slice(0, -3)] = readFileSync(join(docsDir, file), 'utf8');
  return { landing: readFileSync(join(root, 'content/index.html'), 'utf8'), docs };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const content = readContent();
  const files = buildPages(content);
  // llms.txt, llms-full.txt, and each docs page as Markdown, for agents and language models (LCH-10).
  for (const [path, text] of buildLlms(content)) files.set(path, text);
  // The prompt a person pastes into Claude Code points here, so it follows the site's release like the docs do.
  files.set('install.md', readFileSync(join(here, '../prompts/install.md'), 'utf8'));
  const stale = [];
  for (const [path, html] of files) {
    const target = join(here, 'public', path);
    if (check) {
      if (!existsSync(target) || readFileSync(target, 'utf8') !== html) stale.push(path);
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, html);
    }
  }
  if (check && stale.length) {
    console.error(`These pages are out of date: ${stale.join(', ')}. Run node site/build.mjs and commit the result.`);
    process.exit(1);
  }
  console.log(check ? `Site pages are up to date (${files.size}).` : `Wrote ${files.size} pages to site/public.`);
}
