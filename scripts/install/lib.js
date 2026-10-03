// What an install repository's workflows decide (BRK-9), as plain functions so they are tested: which release to
// deploy, whether it may be deployed without hands, which release is newer, and what a health check accepts.
// The workflows in template/.github/workflows run these as `breakaway install <step>`, with the CLI from a release's
// own source on GitHub (BRK-61).

// The versions live in src, because the Worker compares them too and a release bundle carries only src (BRK-60).
import { MAIN, STABLE, compareVersions, isVersion } from '../../src/versions.js';

export { compareVersions, isVersion };

/**
 * breakaway.json, checked: the release the install runs (`stable` pins it; `main` follows the latest pre-release, and the
 * version is the one last written). Throws an Error that says what is wrong.
 * @returns {{ version: string, channel: 'stable' | 'main' }}
 */
export function parseState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('breakaway.json is a JSON object like {"version":"0.2.0","channel":"stable"}.');
  const { version, channel } = raw;
  if (channel !== 'stable' && channel !== 'main') throw new Error('breakaway.json: channel is "stable" or "main".');
  if (!isVersion(version))
    throw new Error(`breakaway.json: version is a release like 0.2.0${channel === 'main' ? ' or 0.2.1-main.4' : ''}.`);
  if (channel === 'stable' && !STABLE.test(version))
    throw new Error('breakaway.json: the stable channel pins a stable version like 0.2.0, not a pre-release.');
  return { version, channel };
}

/** A release's tag, `v` and its version. */
export const tagOf = (version) => `v${version}`;

/** Where a release's files are, on GitHub (the same for the feed's entries). */
export function releaseUrls(repository, version) {
  const base = `https://github.com/${repository}/releases/download/${tagOf(version)}`;
  return {
    bundle: `${base}/breakaway-bundle.tar.gz`,
    manifest: `${base}/manifest.json`,
    checksums: `${base}/SHA256SUMS`,
    notes: `https://github.com/${repository}/releases/tag/${tagOf(version)}`,
  };
}

/**
 * The latest release of each channel, from the update feed (`{ channels: { stable, main } }`) or from GitHub's list of
 * releases (what the feed is built from, for a repository the feed can't read yet). Ordered by version, never by date.
 * @returns {{ stable: { version: string } | null, main: { version: string } | null }}
 */
export function latestReleases(raw) {
  const out = { stable: null, main: null };
  if (raw && !Array.isArray(raw) && typeof raw === 'object' && raw.channels) {
    for (const channel of ['stable', 'main']) {
      const version = raw.channels[channel]?.version;
      if (isVersion(version)) out[channel] = { version };
    }
    return out;
  }
  if (!Array.isArray(raw)) throw new Error('the releases are neither the feed nor a list of GitHub releases.');
  for (const release of raw) {
    if (release?.draft) continue;
    const version = String(release?.tag_name ?? '').replace(/^v/u, '');
    const channel = STABLE.test(version) ? 'stable' : MAIN.test(version) ? 'main' : null;
    if (!channel || (channel === 'stable') === Boolean(release.prerelease)) continue;
    if (!out[channel] || compareVersions(version, out[channel].version) > 0) out[channel] = { version };
  }
  return out;
}

/**
 * The release the deploy workflow puts on the Worker: the pinned one on stable, the channel's latest on main.
 * @returns {{ version: string, tag: string, channel: 'stable' | 'main' }}
 */
export function deployTarget(state, releases) {
  if (state.channel === 'stable') return { version: state.version, tag: tagOf(state.version), channel: 'stable' };
  const latest = releases.main;
  if (!latest)
    throw new Error(
      'the main channel has no pre-release yet, so there is nothing to deploy. Set the channel to "stable" in breakaway.json, or try again after a merge to breakaway.',
    );
  return { version: latest.version, tag: tagOf(latest.version), channel: 'main' };
}

/**
 * Whether a downloaded release may be deployed by the workflow. A release that needs hands, or one the running version
 * can't update from, stops with the message the workflow prints.
 * @param {{ version?: string, manual?: boolean, manualSteps?: string[], updatesFrom?: string }} manifest
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function checkManifest(manifest, { version, running = null }) {
  if (!manifest || typeof manifest !== 'object')
    return { ok: false, message: 'the release’s manifest.json isn’t readable, so nothing was deployed.' };
  if (manifest.version !== version)
    return {
      ok: false,
      message: `the manifest is for ${manifest.version}, not ${version}, so nothing was deployed. Try again; if it persists, the release was published wrongly.`,
    };
  if (manifest.manual === true) {
    const steps = (manifest.manualSteps ?? []).map((s) => `\n  - ${s}`).join('');
    return {
      ok: false,
      message: `breakaway ${version} needs steps by hand, so the workflow didn't deploy it. Do these, then deploy it yourself with wrangler:${steps}`,
    };
  }
  if (
    running &&
    manifest.updatesFrom &&
    isVersion(running) &&
    isVersion(manifest.updatesFrom) &&
    compareVersions(running, manifest.updatesFrom) < 0
  )
    return {
      ok: false,
      message: `breakaway ${version} updates from ${manifest.updatesFrom} or newer, and this install runs ${running}. Update to ${manifest.updatesFrom} first (set it in breakaway.json), then to ${version}.`,
    };
  return { ok: true };
}

/** What a deploy by the workflow can't change: routes, crons, the Durable Object classes, and their migrations. */
export function shapeOf(wrangler) {
  return {
    routes: wrangler.routes ?? [],
    workers_dev: Boolean(wrangler.workers_dev),
    crons: wrangler.triggers?.crons ?? [],
    durable_objects: wrangler.durable_objects?.bindings ?? [],
    migrations: wrangler.migrations ?? [],
    jurisdiction: wrangler.vars?.TASKS_JURISDICTION ?? null,
  };
}

/** What differs between two installs' shapes, as phrases for the message; empty when a deploy may go ahead. */
export function shapeChanges(before, after) {
  const names = {
    routes: 'its address (routes)',
    workers_dev: 'its workers.dev address',
    crons: 'its cron triggers',
    durable_objects: 'its Durable Object classes',
    migrations: 'its Durable Object migrations',
    jurisdiction: 'its jurisdiction',
  };
  return Object.keys(names)
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => names[key]);
}

/** The message that stops a deploy when the install's config changed what the workflow can't deploy, or null. */
export function configStop(changes) {
  if (!changes.length) return null;
  return `breakaway.config.json changed ${changes.join(', ')}, which the workflow doesn't deploy. Apply it yourself with wrangler (npx wrangler deploy, with the config npx breakaway install config makes), then run the workflow again.`;
}

/**
 * The version to roll back to: the one the Worker ran before this deploy, from `wrangler deployments list --json`
 * (the newest deployment's version with the largest share). Null when the Worker has never been deployed.
 */
export function previousVersionId(deployments) {
  const list = Array.isArray(deployments) ? deployments : [];
  const newest = [...list].sort((a, b) => String(b.created_on ?? '').localeCompare(String(a.created_on ?? '')))[0];
  const versions = newest?.versions ?? [];
  const best = [...versions].sort((a, b) => (b.percentage ?? 0) - (a.percentage ?? 0))[0];
  return best?.version_id ?? null;
}

/** Whether wrangler's output from a failed `deployments list` says the Worker doesn't exist yet (Cloudflare error 10007). */
export function workerMissing(output) {
  return /\[code: 10007\]|worker does not exist on your account/iu.test(String(output ?? ''));
}

/** Whether `/api/ping`'s answer says the new release is running. */
export function isHealthy(ping, version) {
  return Boolean(ping) && ping.ok === true && ping.release === version;
}

/**
 * What the update workflow does with the feed. On stable it bumps breakaway.json to a newer stable release (the
 * workflow puts that in a pull request); on main it deploys again when a newer pre-release than the running one exists.
 * @returns {{ action: 'none', reason: string } | { action: 'bump' | 'deploy', version: string, tag: string }}
 */
export function updatePlan(state, releases, running = null) {
  if (state.channel === 'stable') {
    const latest = releases.stable;
    if (!latest) return { action: 'none', reason: 'the feed has no stable release yet.' };
    if (compareVersions(latest.version, state.version) <= 0)
      return { action: 'none', reason: `breakaway.json is on ${state.version}, the latest stable release.` };
    return { action: 'bump', version: latest.version, tag: tagOf(latest.version) };
  }
  const latest = releases.main;
  if (!latest) return { action: 'none', reason: 'the feed has no pre-release yet.' };
  if (!running || !isVersion(running))
    return {
      action: 'none',
      reason:
        'the running release is unknown (set BREAKAWAY_URL so the update can ask the board), so it did not deploy.',
    };
  if (compareVersions(latest.version, running) <= 0)
    return { action: 'none', reason: `the board runs ${running}, the latest pre-release.` };
  return { action: 'deploy', version: latest.version, tag: tagOf(latest.version) };
}

/** The update pull request's description. `notes` is the release's own notes; `manual` its manifest. */
export function bumpBody({ from, to, repository, notes, manifest }) {
  const manual = manifest?.manual === true;
  const steps = manual
    ? `\n\n**This release needs steps by hand**, so merging it won't deploy it:\n${(manifest.manualSteps ?? []).map((s) => `- ${s}`).join('\n')}`
    : '';
  return `Updates breakaway from ${from} to ${to}. Merging this deploys it${manual ? ', except that this release needs hands (below)' : ''}.${steps}\n\n[Release notes](https://github.com/${repository}/releases/tag/${tagOf(to)})\n\n${String(notes ?? '').trim()}\n`.replace(
    /\n{3,}/gu,
    '\n\n',
  );
}
