/**
 * breakaway's release versions: a stable `1.4.0`, or a pre-release on the main channel, `1.4.0-main.7`. Here in src
 * because the Worker compares them (updates.js) and a release bundle carries only src (BRK-60); an install's workflows
 * use them through scripts/install/lib.js.
 */

export const STABLE = /^(\d+)\.(\d+)\.(\d+)$/u;
export const MAIN = /^(\d+)\.(\d+)\.(\d+)-main\.(\d+)$/u;

/** @param {string} v @returns {[number, number, number, number] | null} major, minor, patch, and the pre-release number (Infinity for a stable) */
function parts(v) {
  const s = STABLE.exec(String(v));
  if (s) return [Number(s[1]), Number(s[2]), Number(s[3]), Number.POSITIVE_INFINITY];
  const m = MAIN.exec(String(v));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null;
}

export const isVersion = (v) => parts(v) !== null;

/** Negative, zero, or positive for two versions (`1.4.0` or `1.4.0-main.7`); a pre-release sorts below its stable. */
export function compareVersions(a, b) {
  const [x, y] = [parts(a), parts(b)];
  if (!x || !y) throw new Error(`"${!x ? a : b}" isn't a version like 1.4.0 or 1.4.0-main.7.`);
  for (let i = 0; i < 4; i += 1) {
    if (x[i] === y[i]) continue;
    return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}
