/**
 * Prepare the next version (BRK-100, docs/specs/BRK-100-next-version.md): pre-releases count patches by themselves
 * from package.json's version (scripts/release/lib.js nextPrerelease), and moving to the next minor or major takes a
 * pull request that sets it. Pure: the version the work is toward, read from a repository's release tags, the choices
 * it offers, and the prompt the board writes for the general agent that sets it.
 */

const PRERELEASE = /^v(\d+\.\d+\.\d+)-main\.(\d+)$/u;
const STABLE = /^v(\d+\.\d+\.\d+)$/u;

/** The next steps the board offers. Patches stay automatic. */
export const NEXT_STEPS = ['minor', 'major'];

/** @param {string} v @returns {[number, number, number]} */
const parts = (v) => /** @type {[number, number, number]} */ (v.split('.').map(Number));

/** Negative, zero, or positive, like a sort comparator, for two X.Y.Z versions. */
const compare = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/**
 * The version a repository's pre-releases work toward, from its tag names: the newest `vX.Y.Z-main.N`'s X.Y.Z, or
 * the next patch once a stable at or above it is out (as nextPrerelease counts). Null for a repository with no such
 * pre-release, whose versions don't come from package.json this way.
 * @param {string[]} tags
 * @returns {{ base: string, latest: string } | null}
 */
export function versionBase(tags) {
  const pre = tags
    .map((t) => PRERELEASE.exec(t))
    .filter((m) => m !== null)
    .sort((a, b) => compare(b[1], a[1]) || Number(b[2]) - Number(a[2]));
  if (!pre.length) return null;
  let base = pre[0][1];
  const stables = tags
    .map((t) => STABLE.exec(t)?.[1])
    .filter((s) => typeof s === 'string')
    .sort(compare);
  for (const s of stables) {
    if (compare(s, base) >= 0) {
      const [maj, min, pat] = parts(s);
      base = `${maj}.${min}.${pat + 1}`;
    }
  }
  return { base, latest: pre[0][0] };
}

/**
 * The next minor and major after `base`: from 1.1.2, 1.2.0 and 2.0.0.
 * @param {string} base
 * @returns {{ next: 'minor' | 'major', version: string }[]}
 */
export function nextChoices(base) {
  const [maj, min] = parts(base);
  return [
    { next: 'minor', version: `${maj}.${min + 1}.0` },
    { next: 'major', version: `${maj + 1}.0.0` },
  ];
}

/**
 * The prompt the board writes for the general agent that prepares the next version of repository `name`, with the
 * owner's `note` under it. Returns the task's title and description.
 * @param {{ name: string, base: string, latest: string, next: 'minor' | 'major', version: string }} offer
 * @param {string | null} [note]
 */
export function nextVersionPrompt({ name, base, latest, next, version }, note = null) {
  const title = `Set ${name}’s version to ${version} for the next ${next} release`;
  const lines = [
    `The owner wants ${name}’s next ${next} release: set its version to ${version}.`,
    '',
    `Pre-releases count patches by themselves from package.json’s version. The latest is ${latest}, so the work is toward ${base}; moving to ${version} takes a pull request that sets it.`,
    '',
    'What to do',
    `- Set "version" in package.json to ${version}. Change it anywhere else the repository keeps the same version in step (its AGENTS.md and release docs say where), and nothing else.`,
    `- Open one pull request that closes your own task, titled with its work ID and "Set the version to ${version}". Say in it that once it merges, the next pre-release is v${version}-main.1.`,
    `- If package.json already says ${version} or later, change nothing: comment what you found on your task and release it.`,
    ...(note && String(note).trim() ? ['', 'Note from the owner:', String(note).trim().slice(0, 4000)] : []),
  ];
  return { title, brief: lines.join('\n') };
}
