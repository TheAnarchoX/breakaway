/**
 * The version numbers of a repository's npm releases (docs/specs/IDEA-27-move-ci-cd-to-the-deploy-flow.md, section
 * 2b), worked out the way breakaway's own Release workflow does (scripts/release/lib.js uses these): every merge
 * stages `X.Y.Z-main.N` on next, and the owner promotes one to a stable `X.Y.Z` on latest. The tags remember the
 * numbers: `<prefix>X.Y.Z-main.N` for each pre-release and `<prefix>X.Y.Z` for each stable, where the prefix is `v`,
 * or `<package>@` in a repository whose production deploys already tag `v…`. Pure, so it's tested without git.
 * Copied into a repository by `repos init`, with scripts/package-release.mjs.
 */

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/u;
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const prereleasePattern = (prefix) => new RegExp(`^${escapeRegex(prefix)}(\\d+\\.\\d+\\.\\d+)-main\\.(\\d+)$`, 'u');
const stablePattern = (prefix) => new RegExp(`^${escapeRegex(prefix)}(\\d+\\.\\d+\\.\\d+)$`, 'u');

/** @param {string} v @returns {[number, number, number]} */
function parts(v) {
  const m = SEMVER.exec(v);
  if (!m) throw new Error(`"${v}" isn't a version like 1.4.0.`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Negative, zero, or positive, like a sort comparator, for two X.Y.Z versions. */
export function compareVersions(a, b) {
  const [x, y] = [parts(a), parts(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** The tags' prefix: `v`, or `<package>@` when the repository's production deploys already tag `v…`. */
export const tagPrefix = (name, { workers = false } = {}) => (workers ? `${name}@` : 'v');

/**
 * The next pre-release. `current` is package.json's version, the release being worked toward; once its stable tag
 * exists the work is toward the next patch, so a pre-release never sorts below a stable.
 * @param {string} current
 * @param {string[]} tags every tag in the repository
 * @param {string} [prefix]
 * @returns {{ version: string, base: string, tag: string }}
 */
export function nextPrerelease(current, tags, prefix = 'v') {
  parts(current);
  const stable = stablePattern(prefix);
  const prerelease = prereleasePattern(prefix);
  const stables = tags.map((t) => stable.exec(t)?.[1]).filter(Boolean);
  let base = current;
  for (const s of stables) {
    if (compareVersions(s, base) >= 0) {
      const [maj, min, pat] = parts(s);
      base = `${maj}.${min}.${pat + 1}`;
    }
  }
  const last = tags
    .map((t) => prerelease.exec(t))
    .filter((m) => m?.[1] === base)
    .reduce((n, m) => Math.max(n, Number(m[2])), 0);
  const version = `${base}-main.${last + 1}`;
  return { version, base, tag: `${prefix}${version}` };
}

/**
 * The version a stable release's pull request sets package.json to (BRK-118, WEB-39): the next minor or major after
 * the stable, or null when there is nothing to set. A patch is null, since the pre-releases count patches by
 * themselves, and so is a package.json already at or past the choice (main moved on before an older pre-release was
 * released).
 * @param {string} stable the version just released, like 1.3.0
 * @param {string} next patch, minor, or major
 * @param {string} current package.json's version on the default branch
 * @returns {string | null}
 */
export function nextVersion(stable, next, current) {
  const [maj, min] = parts(stable);
  parts(current);
  if (next === 'patch') return null;
  if (next !== 'minor' && next !== 'major') throw new Error(`next is patch, minor, or major, not "${next}".`);
  const version = next === 'major' ? `${maj + 1}.0.0` : `${maj}.${min + 1}.0`;
  return compareVersions(current, version) >= 0 ? null : version;
}

/** The pre-release among `tags` (the tags on one commit), if one was already staged from it. */
export function prereleaseAmong(tags, prefix = 'v') {
  const prerelease = prereleasePattern(prefix);
  const tag = tags.find((t) => prerelease.test(t));
  return tag ? { tag, version: tag.slice(prefix.length) } : null;
}

/** The stable version a pre-release tag (`v1.4.0-main.37`) is promoted to. */
export function stableOf(prereleaseTag, prefix = 'v') {
  const m = prereleasePattern(prefix).exec(prereleaseTag);
  if (!m) throw new Error(`"${prereleaseTag}" isn't a pre-release tag like ${prefix}1.4.0-main.37.`);
  return m[1];
}
