/**
 * The Packages feed's pure half (BRK-101, docs/specs/IDEA-27-move-ci-cd-to-the-deploy-flow.md, section 2b): what a
 * workflow run's annotations say it staged on npm, and what npm's public registry answers about it. Read-only: the
 * board never publishes or approves a package; approving a staged version needs the owner's 2FA on npm.
 */

/** npm's public registry. The npmjs.com pages answer 403 to anything but a browser, so the board reads this. */
export const REGISTRY = 'https://registry.npmjs.org';

/** How staging works and how a person approves a staged version (with 2FA): npm's own docs. */
export const STAGING_DOCS = 'https://docs.npmjs.com/staged-publishing';

/** The package's page on npm; its Staged Packages tab is where the owner approves a staged version. */
export const packageUrl = (name, version = null) =>
  `https://www.npmjs.com/package/${name}${version ? `/v/${version}` : ''}`;

const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/**
 * The line the release flow prints when it stages a version (`::notice title=Staged on npm::…`), word for word:
 * `<package>@<version> goes live on <dist-tag> once the owner approves it with 2FA: …`. The package may be scoped.
 */
const STAGED = /(?<=^|\s)((?:@[^\s@/]+\/)?[^\s@/]+)@(\S+) goes live on (\S+) once the owner approves it\b/gu;

/**
 * The versions an annotation's message says were staged: `{ name, version, tag }` each, only names, versions, and
 * dist-tags npm would accept, so nothing else from a run reaches a URL or the board.
 */
export function stagedIn(message) {
  const out = [];
  for (const m of String(message ?? '').matchAll(STAGED)) {
    const [, name, version, tag] = m;
    if (name.length <= 214 && NAME.test(name) && VERSION.test(version) && TAG.test(tag))
      out.push({ name, version, tag });
  }
  return out;
}

/** A package name as the registry's path has it: a scoped one's slash is escaped. */
export const registryName = (name) => name.replace('/', '%2f');

/** The registry's URL for a package's metadata, or for one version of it. */
export const registryUrl = (name, version = null, base = REGISTRY) =>
  `${base.replace(/\/$/u, '')}/${registryName(name)}${version ? `/${encodeURIComponent(version)}` : ''}`;

/** A package's dist-tags from its metadata, only the ones that name a version. */
export function distTags(metadata) {
  const tags = metadata?.['dist-tags'];
  if (!tags || typeof tags !== 'object') return {};
  return Object.fromEntries(
    Object.entries(tags).filter(([tag, version]) => TAG.test(tag) && VERSION.test(String(version))),
  );
}
