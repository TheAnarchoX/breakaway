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

/** How Deploy is allowed to run wrangler deploy, for the messages that stop it. */
const LET_DEPLOY =
  "give CLOUDFLARE_API_TOKEN the scopes this repository's README lists for it and set the repository variable BREAKAWAY_DEPLOY_CHANGES to true";

/**
 * Whether a downloaded release may be deployed by the workflow. A release that needs hands, or one the running version
 * can't update from, stops with the message the workflow prints. A manual release whose only step is wrangler deploy
 * (`wranglerDeploy`, BRK-62) passes when the install lets Deploy run it (`apply`), and says it needs wrangler deploy.
 * @param {{ version?: string, manual?: boolean, manualSteps?: string[], wranglerDeploy?: boolean, updatesFrom?: string }} manifest
 * @param {{ version: string, running?: string | null, apply?: boolean }} options
 * @returns {{ ok: true, wrangler?: true } | { ok: false, message: string }}
 */
export function checkManifest(manifest, { version, running = null, apply = false }) {
  if (!manifest || typeof manifest !== 'object')
    return { ok: false, message: 'the release’s manifest.json isn’t readable, so nothing was deployed.' };
  if (manifest.version !== version)
    return {
      ok: false,
      message: `the manifest is for ${manifest.version}, not ${version}, so nothing was deployed. Try again; if it persists, the release was published wrongly.`,
    };
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
  if (manifest.manual === true) {
    const byWrangler = manifest.wranglerDeploy === true;
    if (byWrangler && apply) return { ok: true, wrangler: true };
    const steps = (manifest.manualSteps ?? []).map((s) => `\n  - ${s}`).join('');
    const hint = byWrangler
      ? `\nThese steps are what wrangler deploy does, so Deploy can do them itself: ${LET_DEPLOY}, then run Deploy again.`
      : '';
    return {
      ok: false,
      message: `breakaway ${version} needs steps by hand, so the workflow didn't deploy it. Do these, then deploy it yourself with wrangler:${steps}${hint}`,
    };
  }
  return { ok: true };
}

/**
 * What a version upload can't change (BRK-62): the Worker and its Durable Object, its routes and crons, and the Durable
 * Object classes and their migrations. Made from the Worker's wrangler config.
 */
export function shapeOf(wrangler) {
  const inst = wrangler.vars?.TASKS_INSTALL;
  return {
    worker: wrangler.name ?? null,
    store: (inst && typeof inst === 'object' ? inst.store : null) ?? null,
    jurisdiction: wrangler.vars?.TASKS_JURISDICTION ?? null,
    routes: wrangler.routes ?? [],
    workers_dev: Boolean(wrangler.workers_dev),
    crons: wrangler.triggers?.crons ?? [],
    durable_objects: wrangler.durable_objects?.bindings ?? [],
    migrations: wrangler.migrations ?? [],
  };
}

const json = (value) => JSON.stringify(value);
/** A migration that only makes classes, which wrangler deploy applies; any other kind deletes, renames, or moves one. */
const CREATES = new Set(['tag', 'new_sqlite_classes', 'new_classes']);

/**
 * The classes `after` adds, when adding is all its Durable Object change does: its migrations are `before`'s with only
 * new classes after them, and it keeps every binding `before` has. Null for anything else.
 */
function addedClasses(before, after) {
  const kept = before.migrations.every((m, i) => json(m) === json(after.migrations[i]));
  const added = after.migrations.slice(before.migrations.length);
  if (!kept || !added.every((m) => Object.keys(m).every((key) => CREATES.has(key)))) return null;
  if (!before.durable_objects.every((b) => after.durable_objects.some((a) => json(a) === json(b)))) return null;
  return added.flatMap((m) => [...(m.new_sqlite_classes ?? []), ...(m.new_classes ?? [])]);
}

/**
 * What differs between the Worker's shape as it runs and as this deploy makes it, each with whether wrangler deploy may
 * apply it (BRK-62): an address, cron triggers, and new Durable Object classes, yes. Another Worker, another Durable
 * Object, or a class deleted, renamed, or moved, never: the first two open an empty board, and the last is a release's
 * manual step. Empty when a version upload carries the whole deploy.
 * @returns {{ change: string, apply: boolean, why?: string, address?: true }[]}
 */
export function shapeChanges(before, after) {
  const differs = (key) => json(before[key]) !== json(after[key]);
  const out = [];
  const empty = 'another Durable Object is an empty board';
  if (differs('worker'))
    out.push({
      change: 'its Worker’s name (worker)',
      apply: false,
      why: 'a new name makes a new Worker, with an empty board',
    });
  if (differs('store')) out.push({ change: 'its Durable Object (store)', apply: false, why: empty });
  if (differs('jurisdiction')) out.push({ change: 'its jurisdiction', apply: false, why: empty });
  if (differs('routes')) out.push({ change: 'its address (routes)', apply: true, address: true });
  if (differs('workers_dev')) out.push({ change: 'its workers.dev address', apply: true, address: true });
  if (differs('crons')) out.push({ change: 'its cron triggers', apply: true });
  if (differs('durable_objects') || differs('migrations')) {
    const added = addedClasses(before, after);
    if (added === null)
      out.push({
        change: 'its Durable Object classes: it deletes, renames, or moves one',
        apply: false,
        why: 'that is a release’s manual step, and it can lose a board',
      });
    else
      out.push({
        change: added.length
          ? `its Durable Object classes: it adds ${added.join(', ')}`
          : 'its Durable Object bindings',
        apply: true,
      });
  }
  return out;
}

/** The message that stops a deploy whose changes need wrangler deploy when the install hasn't allowed it, or null. */
export function configStop(changes) {
  if (!changes.length) return null;
  return `This deploy changes ${changes.join(', ')}, which a version upload can't carry, so nothing was deployed. To let Deploy run wrangler deploy for it, ${LET_DEPLOY}, then run Deploy again. Or apply it yourself with wrangler (npx wrangler deploy, with the config npx breakaway install config makes), then run Deploy again.`;
}

/** The message that stops a deploy with a change Deploy never makes. */
function neverStop(changes) {
  const why = [...new Set(changes.map((c) => c.why))].join('; ');
  return `This deploy changes ${changes.map((c) => c.change).join(', ')}, which Deploy never does, so nothing was deployed: ${why}. If breakaway.config.json changed it, put it back as it was. If the release did, its notes say what to do by hand.`;
}

/**
 * What Deploy does with a release (BRK-62): stop with a message, upload a version (`versions`), or run wrangler deploy
 * (`wrangler`) for what a version can't carry. `before` and `after` are the Worker's shapes as it runs and as this deploy
 * makes it; `before` is null when there is nothing to compare with (a first deploy, or a dispatch with no running release
 * to ask). `apply` is whether the install lets Deploy run wrangler deploy: BREAKAWAY_DEPLOY_CHANGES, set for a token that
 * can. `addressChanged` tells the health check to wait for a new custom domain.
 * @returns {{ ok: false, message: string } | { ok: true, deploy: 'versions' | 'wrangler', changes: string[], addressChanged: boolean }}
 */
export function deployPlan(manifest, { version, running = null, before = null, after = null, apply = false }) {
  const verdict = checkManifest(manifest, { version, running, apply });
  if (verdict.ok === false) return verdict;
  const found = before && after ? shapeChanges(before, after) : [];
  const never = found.filter((c) => !c.apply);
  if (never.length) return { ok: false, message: neverStop(never) };
  const changes = found.map((c) => c.change);
  const byWrangler = changes.length > 0 || verdict.wrangler === true;
  if (byWrangler && !apply) return { ok: false, message: configStop(changes) };
  return {
    ok: true,
    deploy: byWrangler ? 'wrangler' : 'versions',
    changes,
    addressChanged: found.some((c) => c.address === true),
  };
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

/**
 * The message that stops a deploy about to make a new Worker on an install that already has a board (BRK-141), or null
 * when making one is a first deploy. A board is there when the repository variable BREAKAWAY_URL is set (`variable`: the
 * install sets it once the board answers) or the address the deploy checked (`at`) answered /api/ping with a release
 * (`running`). A new Worker then means the name changed or is mistyped, and deploying it would open a second, empty board.
 * @param {{ worker: string, variable?: string | null, running?: string | null, at?: string | null }} options
 */
export function newWorkerStop({ worker, variable = null, running = null, at = null }) {
  if (!variable && !running) return null;
  const seen = running
    ? `${at || variable || 'its address'} answers as breakaway ${running}`
    : `the repository variable BREAKAWAY_URL is set (${variable})`;
  return `There is no Worker named ${worker} on this Cloudflare account, but this install already has a board: ${seen}. Deploying would make a new Worker with an empty board, so nothing was deployed. Put "worker" in breakaway.config.json back to the name the board runs as (Workers & Pages on Cloudflare lists it), then run Deploy again. If that board is gone and you mean to start an empty one, delete the repository variable BREAKAWAY_URL, then run Deploy again.`;
}

/**
 * What `/api/ping`'s answer says about the new release: `healthy` when it runs and its secrets load (BRK-96), `secrets`
 * when it runs but a bound secret can't be read yet, and `down` for anything else.
 * @returns {'healthy' | 'secrets' | 'down'}
 */
export function pingHealth(ping, version) {
  if (ping?.ok !== true || ping.release !== version) return 'down';
  return ping.secrets?.ok === true ? 'healthy' : 'secrets';
}

/** Whether `/api/ping`'s answer says the new release is running and its secrets load (BRK-96). */
export function isHealthy(ping, version) {
  return pingHealth(ping, version) === 'healthy';
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
