// The update feed (BRK-8): what an install reads to learn about new releases, built from GitHub's releases.
import { compareVersions } from '../../scripts/release/lib.js';

const STABLE = /^v(\d+\.\d+\.\d+)$/u;
const PRERELEASE = /^v(\d+\.\d+\.\d+)-main\.(\d+)$/u;
const ASSETS = { bundle: 'breakaway-bundle.tar.gz', manifest: 'manifest.json', checksums: 'SHA256SUMS' };
// Releases from before signing (BRK-51) have none: their entry says so, and an install updates by hand once.
const SIGNATURE = 'manifest.json.sig';
const TRIES = 3;

/**
 * Orders releases of one channel, newest first: by version, then by pre-release number. Never by date,
 * so promoting or republishing an old release can't make it look newest.
 * @param {{ tag_name: string }[]} releases
 * @param {'stable' | 'main'} channel
 */
export function newestFirst(releases, channel) {
  const rows = [];
  for (const release of releases) {
    if (release.draft) continue;
    if (channel === 'stable' && !release.prerelease) {
      const m = STABLE.exec(release.tag_name);
      if (m) rows.push({ release, version: m[1], n: 0 });
    } else if (channel === 'main' && release.prerelease) {
      const m = PRERELEASE.exec(release.tag_name);
      if (m) rows.push({ release, version: m[1], n: Number(m[2]) });
    }
  }
  return rows.sort((a, b) => compareVersions(b.version, a.version) || b.n - a.n).map((r) => r.release);
}

/** One channel's entry from a release and its manifest, or null when the release is missing an asset or the manifest is wrong. */
export function entryOf(release, manifest) {
  const urls = {};
  for (const [key, name] of Object.entries(ASSETS)) {
    const asset = release.assets?.find((a) => a.name === name);
    if (!asset?.browser_download_url) return null;
    urls[key] = asset.browser_download_url;
  }
  urls.signature = release.assets?.find((a) => a.name === SIGNATURE)?.browser_download_url ?? null;
  const version = release.tag_name.replace(/^v/u, '');
  if (
    !manifest ||
    manifest.version !== version ||
    typeof manifest.manual !== 'boolean' ||
    typeof manifest.updatesFrom !== 'string'
  )
    return null;
  return {
    version,
    tag: release.tag_name,
    ...urls,
    notes: release.html_url,
    manual: manifest.manual,
    ...(manifest.manual ? { manualSteps: manifest.manualSteps ?? [] } : {}),
    updatesFrom: manifest.updatesFrom,
    published: release.published_at ?? null,
  };
}

/**
 * Builds the feed. `fetchJson` reads a URL as JSON and throws when it can't.
 * A channel with no usable release is null.
 * @param {{ tag_name: string }[]} releases
 * @param {(url: string) => Promise<any>} fetchJson
 */
export async function buildFeed(releases, fetchJson) {
  const channels = {};
  for (const channel of ['stable', 'main']) {
    channels[channel] = null;
    for (const release of newestFirst(releases, channel).slice(0, TRIES)) {
      const url = release.assets?.find((a) => a.name === ASSETS.manifest)?.browser_download_url;
      if (!url) continue;
      let manifest;
      try {
        manifest = await fetchJson(url);
      } catch {
        continue;
      }
      const entry = entryOf(release, manifest);
      if (entry) {
        channels[channel] = entry;
        break;
      }
    }
  }
  return { channels };
}
