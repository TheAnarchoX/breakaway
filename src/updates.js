/**
 * Updates (BRK-10): what an install that has its own repository learns about breakaway's releases. Pure: where the
 * feed is, which release is the latest in a channel, and whether it is newer than what the board runs. The store's
 * side (reading, the bump pull request, the deploy dispatch) is in store-updates.js.
 */
import { compareVersions, isVersion } from './versions.js';

/** The update feed (site/README.md), and breakaway's own repository, which the board reads instead while the feed has nothing. */
export const FEED_URL = 'https://leavethepack.dev/releases.json';
export const BREAKAWAY_REPO = 'TheAnarchoX/breakaway';
/** The install repository's workflows (template/.github/workflows) and the branch its update pull request is on. */
export const DEPLOY_WORKFLOW = 'deploy.yml';
export const UPDATE_BRANCH = 'breakaway/update';

/**
 * The latest release in `channel` from the feed (`{ channels }`) or from GitHub's list of breakaway's releases,
 * ordered by version and never by date; null when there is none.
 * @returns {{ version: string, notes: string | null, body: string | null, manual: boolean, manualSteps: string[], updatesFrom: string | null } | null}
 */
export function latestIn(raw, channel) {
  if (raw && !Array.isArray(raw) && typeof raw === 'object' && raw.channels) {
    const e = raw.channels[channel];
    if (!e || !isVersion(e.version)) return null;
    return {
      version: e.version,
      notes: typeof e.notes === 'string' ? e.notes : null,
      body: null,
      manual: e.manual === true,
      manualSteps: Array.isArray(e.manualSteps) ? e.manualSteps.map(String) : [],
      updatesFrom: isVersion(e.updatesFrom) ? e.updatesFrom : null,
    };
  }
  if (!Array.isArray(raw)) return null;
  let best = null;
  for (const release of raw) {
    if (release?.draft) continue;
    const version = String(release?.tag_name ?? '').replace(/^v/u, '');
    const main = /^\d+\.\d+\.\d+-main\.\d+$/u.test(version);
    const stable = /^\d+\.\d+\.\d+$/u.test(version);
    if (channel === 'main' ? !main || !release.prerelease : !stable || release.prerelease) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { version, release };
  }
  if (!best) return null;
  return {
    version: best.version,
    notes: best.release.html_url ?? null,
    body: String(best.release.body ?? '').slice(0, 2000) || null,
    manual: false,
    manualSteps: [],
    updatesFrom: null,
  };
}

/** Whether `latest` is newer than `running`; false when either isn't a version (a build of someone's own). */
export function isNewer(latest, running) {
  return Boolean(latest) && isVersion(latest) && isVersion(running) && compareVersions(latest, running) > 0;
}

/** Whether `running` is too old for the release to update from, so a deploy would stop (the release's `updatesFrom`). */
export function tooOld(running, updatesFrom) {
  return Boolean(updatesFrom) && isVersion(running) && compareVersions(running, updatesFrom) < 0;
}
