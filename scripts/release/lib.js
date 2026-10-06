// The release workflow's decisions, as plain functions so they are tested (.github/workflows/release.yml).

import {
  compareVersions,
  nextPrerelease as prereleaseWith,
  nextVersion,
  stableOf as stableWith,
} from '../lib/package-release.js';

// The version a stable's pull request sets package.json to (BRK-118) is a repository's release flow's too (WEB-39).
export { compareVersions, nextVersion };

/**
 * The next pre-release on the main channel. `current` is package.json's version, the release being worked
 * toward; once its stable tag exists the work is toward the next patch, so a pre-release never sorts below a stable.
 * The same numbers a repository's own release flow uses (scripts/lib/package-release.js), with breakaway's `v` tags.
 * @param {string} current
 * @param {string[]} tags every tag in the repository
 * @returns {{ version: string, base: string, tag: string }}
 */
export const nextPrerelease = (current, tags) => prereleaseWith(current, tags, 'v');

/** The stable version a pre-release tag (`v1.4.0-main.37`) is promoted to. */
export const stableOf = (prereleaseTag) => stableWith(prereleaseTag, 'v');

/**
 * manifest.json: what an install reads before it deploys.
 * `wranglerDeploy` says a manual release's only step is wrangler deploy (a new Durable Object class, a cron, a route), so
 * an install whose Deploy may run it does it itself (BRK-62).
 * @param {{ version: string, channel: 'main' | 'stable', commit: string, config: { manual?: boolean, manualSteps?: string[], wranglerDeploy?: boolean, updatesFrom?: string }, builtAs?: string, bundleSha256?: string, shape?: ReturnType<typeof shapeOf>, created: string }} o
 */
export function manifestOf({ version, channel, commit, config, builtAs, bundleSha256, shape, created }) {
  const manual = config.manual === true;
  if (manual && !config.manualSteps?.length)
    throw new Error('release.json says manual, so it needs manualSteps: what an install does by hand.');
  if (config.wranglerDeploy === true && !manual)
    throw new Error('release.json says wranglerDeploy, which is for a manual release: set manual and manualSteps too.');
  return {
    version,
    channel,
    commit,
    manual,
    ...(manual ? { manualSteps: config.manualSteps } : {}),
    ...(manual && config.wranglerDeploy === true ? { wranglerDeploy: true } : {}),
    // The first release there was: a stable floor like 0.1.0 would sit above its own pre-releases, which a main-channel
    // install runs, so it could never update (BRK-67).
    updatesFrom: config.updatesFrom ?? '0.1.0-main.1',
    ...(builtAs ? { builtAs } : {}),
    // The bundle's checksum, so the manifest's signature covers the bundle (BRK-52): SHA256SUMS isn't signed.
    ...(bundleSha256 ? { bundleSha256 } : {}),
    // What the release expects of the Worker, so an install stops a change the board can't make (BRK-54).
    ...(shape ? { shape } : {}),
    created,
  };
}

/**
 * The shape a release expects of the Worker, from its wrangler config (BRK-54): what an install's self-update
 * compares with what Cloudflare reports, to stop a release that changes what the board can't change itself.
 * @param {any} wrangler the parsed wrangler.jsonc
 */
export function shapeOf(wrangler) {
  const objects = wrangler.durable_objects?.bindings ?? [];
  const types = [
    ...objects.map((b) => `durable_object_namespace:${b.name}`),
    ...(wrangler.version_metadata ? [`version_metadata:${wrangler.version_metadata.binding}`] : []),
    ...(wrangler.assets?.binding ? [`assets:${wrangler.assets.binding}`] : []),
  ];
  const sorted = (list) => [...new Set(list)].sort();
  return {
    bindings: sorted(types),
    durableObjects: sorted(objects.map((b) => b.class_name)),
    migrations: (wrangler.migrations ?? []).map((m) => m.tag),
    crons: sorted(wrangler.triggers?.crons ?? []),
    routes: sorted((wrangler.routes ?? []).map((r) => (typeof r === 'string' ? r : (r.pattern ?? r.custom_domain)))),
  };
}

/** The notes' Manual steps section, or nothing when no install has to do anything by hand. */
export function manualSection(config) {
  if (config.manual !== true) return '';
  const byWrangler =
    config.wranglerDeploy === true
      ? "\nThese steps are what wrangler deploy does: an install whose Deploy may run wrangler deploy does them itself (its repository's README says how).\n"
      : '';
  return `\n### Manual steps\n\n${config.manualSteps.map((s) => `- ${s}`).join('\n')}\n${byWrangler}`;
}

/**
 * The npm packages a set of source files import, by name and sorted: `@noble/ciphers/chacha.js` is `@noble/ciphers`.
 * Relative paths and runtime-provided specifiers (`cloudflare:workers`, `node:fs`) are not packages.
 * @param {string[]} texts
 * @returns {string[]}
 */
export function importedPackages(texts) {
  const names = new Set();
  for (const text of texts) {
    for (const m of text.matchAll(
      /^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gmu,
    )) {
      const spec = m[1] ?? m[2];
      if (/^[./]|^[a-z]+:/u.test(spec)) continue;
      names.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
    }
  }
  return [...names].sort();
}

/**
 * The pull requests a range of squash-merged commits carries, from their subjects (`git log --format=%s`): a squash
 * merge's subject is the pull request's title and ` (#31)`. The notes since the last stable read them so, without a
 * request per pull request, which would spend the workflow token's rate limit on every merge. Other commits are left out.
 * @param {string} text one subject per line
 * @returns {{ number: number, title: string }[]}
 */
export function prsFromSubjects(text) {
  const prs = [];
  for (const subject of String(text ?? '').split('\n')) {
    const m = /^(.+?)\s*\(#(\d+)\)\s*$/u.exec(subject);
    if (m) prs.push({ number: Number(m[2]), title: m[1].trim() });
  }
  return prs;
}

/** Release notes without their `## breakaway v1.4.0` heading, and how many changes they list. */
function notesBody(text) {
  const body = String(text ?? '')
    .replace(/\r\n?/gu, '\n')
    .replace(/^\s*## [^\n]*\n?/u, '')
    .trim();
  return { notes: body, changes: body.split('\n').filter((line) => /^- /u.test(line)).length };
}

/**
 * whats-new.json (WEB-80): what the board shows after it updates, written into the web app's files when a
 * pre-release is built, so an install reads it from its own bundle and makes no call to learn it. A stable is the
 * pre-release's bundle unchanged, so the file carries both: `main`, this pre-release's notes, and `stable`, the notes
 * since the last stable, which is what the stable this pre-release becomes lists.
 * @param {{ version: string, notes: string, sinceStable: string, from?: string | null, repository?: string | null }} o
 */
export function whatsNewOf({ version, notes, sinceStable, from = null, repository = null }) {
  return {
    version,
    ...(repository && /^[\w.-]+\/[\w.-]+$/u.test(repository) ? { repository } : {}),
    main: notesBody(notes),
    stable: {
      version: stableOf(`v${version}`),
      from: from ? from.replace(/^v/u, '') : null,
      ...notesBody(sinceStable),
    },
  };
}
