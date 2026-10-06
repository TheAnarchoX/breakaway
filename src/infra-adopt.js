/**
 * A draft of an environment's desired state (docs/specs/IDEA-19-architect.md, "Desired state"; BRK-240): the owner
 * shouldn't hand-write `.github/breakaway-infra/<environment>.json`, and the board already knows what runs there, so
 * this writes the file from the environment's slice of the inventory (BRK-177), in BRK-180's format, checked with
 * checkDesiredFile so it's valid as written. Planning it against the same platform changes nothing (desiredFrom).
 *
 * Only names, kinds, and settings go in it: what the platform reports by itself (an attr that isn't one of the kind's
 * `settings`, like a version or a size) is left out so the file says what should be, not what was seen; so is a
 * setting that looks like a secret's value (or was redacted when the inventory stored it), and a kind the provider
 * doesn't manage. The notes say what was left out and why. Pure: no store, no network, so the CLI's `infra adopt` (CLI-23) can import it.
 */
import { desiredFrom } from './infra-provider.js';
import { checkDesiredFile, DESIRED_MAX_RESOURCES, DESIRED_VERSION, desiredPath } from './infra-desired.js';
import { redact } from './redact.js';

/** @typedef {import('./infra-provider.js').Provider} Provider */
/** @typedef {{ id: string, kind: string, name: string, attrs?: Record<string, unknown> | null }} InventoryResource */

/**
 * The draft as the board returns it: where the file goes, its text, how many resources it declares, whether the
 * environment is observe only, and what was left out.
 * @typedef {{ path: string, json: string, resources: number, observeOnly: boolean, notes: string[] }} Draft
 */

/** Whether a value holds something that looks like a secret, or that the inventory redacted when it stored it. */
function secretLike(value) {
  if (typeof value === 'string') return value.includes('[redacted') || redact(value) !== value;
  if (Array.isArray(value)) return value.some(secretLike);
  if (value && typeof value === 'object') return Object.values(value).some(secretLike);
  return false;
}

/** `a`, `a and b`, `a, b, and c`. */
function list(items) {
  if (items.length <= 2) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

/**
 * Drafts one environment's desired-state file from what its inventory holds.
 * @param {{ environment: { name: string, provider: string, observeOnly?: boolean }, resources: InventoryResource[], provider?: Provider | null }} input
 *   `provider` is the environment's adapter when it's connected: then a kind it doesn't manage is left out.
 * @returns {Draft}
 */
export function draftDesired({ environment, resources, provider = null }) {
  /** @type {string[]} */
  const notes = [];
  const observeOnly = Boolean(environment.observeOnly);
  if (observeOnly)
    notes.push(
      `${environment.name} is observe only: this describes it, and Architect never applies a change to it. Keep it out of the repository: an observe-only environment takes no desired state.`,
    );
  if (!provider) notes.push(`${environment.provider} isn’t connected, so the kinds weren’t checked against it.`);

  const sorted = [...resources].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  /** @type {Map<string, string[]>} names left out, by kind */
  const unmanaged = new Map();
  /** @type {InventoryResource[]} */
  const kept = [];
  let reported = false;
  for (const r of sorted) {
    const spec = provider ? provider.kinds[r.kind] : null;
    if (provider && !spec) {
      unmanaged.set(r.kind, [...(unmanaged.get(r.kind) ?? []), r.name]);
      continue;
    }
    /** @type {Record<string, unknown>} */
    const attrs = {};
    const secret = [];
    for (const [key, value] of Object.entries(r.attrs ?? {})) {
      // What the platform reports by itself (a version, a size, a deploy) isn't what should be: keeping it would
      // make the file drift by itself.
      if (spec?.settings && !spec.settings.includes(key)) reported = true;
      else if (secretLike(key) || secretLike(value)) secret.push(key);
      else attrs[key] = value;
    }
    if (secret.length)
      notes.push(
        `Left out ${r.name}’s ${list(secret)}: ${secret.length === 1 ? 'it' : 'they'} looked like a secret’s value. Name the secret in the file, never its value.`,
      );
    kept.push({ id: r.id, kind: r.kind, name: r.name, ...(Object.keys(attrs).length ? { attrs } : {}) });
  }
  if (reported)
    notes.push(
      `Kept only the settings ${environment.provider} manages: what the platform reports by itself, like versions and sizes, is left out so the file doesn’t drift by itself.`,
    );
  for (const [kind, names] of unmanaged)
    notes.push(
      `Left out ${names.length} ${kind}${names.length === 1 ? '' : 's'} (${list(names)}): ${environment.provider} doesn’t manage that kind.`,
    );
  if (kept.length > DESIRED_MAX_RESOURCES) {
    notes.push(
      `Kept the first ${DESIRED_MAX_RESOURCES} of ${kept.length} resources: a file holds at most ${DESIRED_MAX_RESOURCES}. Point the environment’s target at what the repository runs.`,
    );
    kept.length = DESIRED_MAX_RESOURCES;
  }

  const desired = desiredFrom({ resources: kept, relations: [] });
  const json = `${JSON.stringify({ version: DESIRED_VERSION, provider: environment.provider, resources: desired.resources }, null, 2)}\n`;
  const checked = checkDesiredFile(json, { provider, expectProvider: environment.provider });
  // The inventory and the file share their rules, so this only fails on a bug: say where rather than return a bad file.
  if ('error' in checked)
    throw new Error(
      `the draft for ${environment.name} isn’t valid at ${checked.error.field ?? 'the top'}: ${checked.error.message}`,
    );
  return { path: desiredPath(environment.name), json, resources: kept.length, observeOnly, notes };
}
