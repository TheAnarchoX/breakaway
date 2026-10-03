#!/usr/bin/env node
/**
 * Release notes for a deploy, as Markdown on stdout.
 *   node scripts/release-notes.mjs --title <name> --from <sha> --to <sha> [--version <id>] [--areas BRK:Board,WEB:Web]
 *     [--migrations <names>] [--repo owner/name]
 * The areas group the pull requests by the work-ID prefix in their titles. Without --areas they come from the
 * board's registry for the repository (BREAKAWAY_URL and BREAKAWAY_TOKEN), and without either everything is
 * listed under Other. Reads GITHUB_TOKEN, and without --repo GITHUB_REPOSITORY. Copied by `repos init`.
 */
import { parseArgs } from 'node:util';
import { USER_AGENT } from './lib/deployments.js';
import { parseAreas, prNumberOf, releaseNotes } from './lib/release-notes.js';

const { values: o } = parseArgs({
  options: {
    repo: { type: 'string' },
    title: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    version: { type: 'string' },
    areas: { type: 'string' },
    migrations: { type: 'string' },
  },
});

async function get(url, token) {
  const res = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': USER_AGENT },
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}.`);
  return res.json();
}

/** The repository's areas from the board's registry, or none when it can't be asked. */
async function registryAreas(repo) {
  const { BREAKAWAY_URL: url, BREAKAWAY_TOKEN: token } = process.env;
  if (!url || !token) return [];
  try {
    const res = await fetch(`${url.replace(/\/$/u, '')}/api/repos`, { headers: { authorization: `Bearer ${token}` } });
    const found = /** @type {any} */ (await res.json()).repos?.find(
      (r) => r.github?.toLowerCase() === repo.toLowerCase(),
    );
    return (found?.areas ?? []).map((a) => ({ prefix: a.prefix, name: a.name }));
  } catch {
    return [];
  }
}

try {
  if (!o.title || !o.from || !o.to) throw new Error('Give --title <name>, --from <sha> and --to <sha>.');
  const token = process.env.GITHUB_TOKEN;
  const repo = o.repo ?? process.env.GITHUB_REPOSITORY;
  /** @type {any} */
  const compare = await get(`https://api.github.com/repos/${repo}/compare/${o.from}...${o.to}`, token);
  const numbers = [...new Set(compare.commits.map((c) => prNumberOf(c.commit.message)).filter(Boolean))];
  const prs = await Promise.all(
    numbers.map(async (number) => ({
      number,
      title: /** @type {any} */ (await get(`https://api.github.com/repos/${repo}/pulls/${number}`, token)).title,
    })),
  );
  const areas = o.areas ? parseAreas(o.areas) : await registryAreas(repo);
  process.stdout.write(
    releaseNotes({
      title: o.title,
      version: o.version,
      prs,
      areas,
      migrations: o.migrations
        ? o.migrations
            .split(',')
            .map((m) => m.trim())
            .filter(Boolean)
        : [],
    }),
  );
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
