import pkg from '../package.json' with { type: 'json' };

/**
 * The release this build is: package.json's version, which the release workflow sets to the pre-release's
 * (`1.4.0-main.37`) before it builds. An install that deploys a stable release's bundle, which is the
 * pre-release's bundle unchanged, passes the stable version as the BREAKAWAY_VERSION variable.
 * @param {{ BREAKAWAY_VERSION?: string }} [env]
 * @returns {string}
 */
export function releaseOf(env) {
  return env?.BREAKAWAY_VERSION || pkg.version;
}
