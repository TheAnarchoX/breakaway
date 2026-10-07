#!/usr/bin/env node
/**
 * Takes a snapshot of breakaway's roadmap for the site's road ahead (LCH-39): the board's features for breakaway's own
 * repository, by release, into site/content/roadmap.json, then rebuilds the site. Run it only when the owner asks; the
 * page marks releases that are out from the feed by itself, so a release going out needs no new snapshot.
 *   node scripts/site-roadmap.mjs                     read the board with the CLI (it needs the board's token)
 *   node scripts/site-roadmap.mjs --from <file.json>  read a saved `npx breakaway features --json` instead
 * The titles and lines in the file's `edits` are kept: write one there for each feature the script names.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { roadmapFrom } from '../site/lib/roadmap.js';

const ROOT = new URL('../', import.meta.url);
const FILE = new URL('site/content/roadmap.json', ROOT);

const at = process.argv.indexOf('--from');
const raw =
  at === -1
    ? execFileSync(process.execPath, [fileURLToPath(new URL('scripts/tasks.mjs', ROOT)), 'features', '--json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      })
    : readFileSync(process.argv[at + 1], 'utf8');
const listed = JSON.parse(raw);
const features = Array.isArray(listed) ? listed : listed.features;
if (!Array.isArray(features)) throw new Error('No features in what the board returned: expected { features: [...] }.');

const kept = JSON.parse(readFileSync(FILE, 'utf8'));
const { roadmap, unwritten } = roadmapFrom(features, { note: kept.note, edits: kept.edits ?? {} });
writeFileSync(FILE, `${JSON.stringify(roadmap, null, 2)}\n`);
execFileSync(process.execPath, [fileURLToPath(new URL('site/build.mjs', ROOT))], { stdio: 'inherit' });

const count = roadmap.releases.reduce((n, r) => n + r.features.length, 0);
console.log(`Wrote ${roadmap.releases.length} releases and ${count} features to site/content/roadmap.json.`);
if (unwritten.length)
  console.log(
    `These use their brief's first sentence; write a line for each in the file's edits, then run node site/build.mjs: ${unwritten.join(', ')}.`,
  );
