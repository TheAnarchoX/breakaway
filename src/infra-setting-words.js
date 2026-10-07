/**
 * Settings in words (WEB-110): what a change to a resource's settings says on the console's change card, in the
 * stream, in the pull request the board opens, and on a plan's diff. Never raw JSON: a Worker's bindings read one
 * binding at a time ('+ CHAT (Durable Object)', '− OLD_QUEUE', 'ASSETS unchanged'), and a setting reads as its name
 * and its values ('usage model standard → bundled'). A list of bindings in another order is the same list, so an edit
 * that only reorders one changes nothing. Pure and provider-agnostic: a provider names its binding types on its
 * bindings field (`targets` and `typeLabels`, src/infra-provider.js's EditableField); a type it doesn't name reads
 * from the type itself. Node-safe, so the web app and the tests use it too.
 */

/** A value in a line of words is cut at this many characters. */
export const WORDS_MAX = 60;

const isObject = (/** @type {unknown} */ v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** A setting's key in words: `usageModel` and `usage_model` both read as "usage model". */
export function keyWords(/** @type {string} */ key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[_.-]+/gu, ' ')
    .trim()
    .toLowerCase();
}

/** Cuts a line of words at `max` characters. */
const cut = (/** @type {string} */ s, max = WORDS_MAX) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * A value in words, short: text as it is, yes or no, a list joined with commas, a binding or an item by its name, and
 * an object as its keys and values. `unset` is what a missing value reads as.
 * @param {unknown} value
 * @param {{ unset?: string, max?: number }} [options]
 * @returns {string}
 */
export function valueWords(value, { unset = 'unset', max = WORDS_MAX } = {}) {
  const inner = (/** @type {unknown} */ v) => {
    if (v === undefined || v === null) return unset;
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (typeof v === 'string' || typeof v === 'number') return String(v);
    if (Array.isArray(v)) {
      if (!v.length) return 'none';
      return v.map((x) => (isObject(x) && typeof x.name === 'string' ? x.name : inner(x))).join(', ');
    }
    if (isObject(v)) {
      const entries = Object.entries(/** @type {object} */ (v));
      if (!entries.length) return 'none';
      // A setting kept as `{ enabled }` reads as on or off, with anything else it carries.
      return entries
        .map(([k, x]) =>
          k === 'enabled' && typeof x === 'boolean' ? (x ? 'on' : 'off') : `${keyWords(k)} ${inner(x)}`,
        )
        .join(', ');
    }
    return String(v);
  };
  return cut(inner(value), max);
}

/** Whether a list holds bindings, or other items known by their name: every item an object with a name. */
export const namedList = (/** @type {unknown} */ v) =>
  Array.isArray(v) && v.length > 0 && v.every((x) => isObject(x) && typeof x.name === 'string');

/** A value with every object's keys in order, so two of the same read the same. */
function normal(/** @type {unknown} */ v) {
  if (v === undefined) return null;
  if (Array.isArray(v)) return v.map(normal);
  if (isObject(v))
    return Object.fromEntries(
      Object.entries(/** @type {object} */ (v))
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([k, x]) => [k, normal(x)]),
    );
  return v;
}

/**
 * Whether two values of a setting are the same: whatever the order of an object's keys, and, for a list of bindings
 * (items known by their name), whatever the order of the list.
 * @param {unknown} a
 * @param {unknown} b
 */
export function sameSetting(a, b) {
  if (namedList(a) && namedList(b)) {
    const la = /** @type {any[]} */ (a);
    const lb = /** @type {any[]} */ (b);
    if (la.length !== lb.length) return false;
    const by = new Map(lb.map((x) => [x.name, x]));
    return by.size === lb.length && la.every((x) => by.has(x.name) && sameSetting(x, by.get(x.name)));
  }
  return JSON.stringify(normal(a)) === JSON.stringify(normal(b));
}

/**
 * A binding type in words: what the provider calls it, else the type itself ("durable object namespace").
 * @param {string} type
 * @param {Record<string, string>} [labels]
 */
export function bindingTypeWords(type, labels = {}) {
  return labels[type] ?? keyWords(type);
}

/**
 * The words a provider's bindings field gives its binding types: its targets' labels and its `typeLabels`.
 * @param {{ targets?: { type: string, label: string }[], typeLabels?: Record<string, string> } | null | undefined} field
 * @returns {Record<string, string>}
 */
export function bindingLabels(field) {
  return {
    ...Object.fromEntries((field?.targets ?? []).map((t) => [t.type, t.label])),
    ...(field?.typeLabels ?? {}),
  };
}

/**
 * Two lists of bindings compared one binding at a time, by name: the ones added, removed, changed (another type, or
 * something it binds to that differs; a field one side doesn't give isn't compared), and unchanged, in words.
 * @param {unknown} before
 * @param {unknown} after
 * @param {Record<string, string>} [labels] the provider's words for each binding type
 * @returns {{ added: string[], removed: string[], changed: string[], unchanged: string[] }}
 */
export function bindingChanges(before, after, labels = {}) {
  const list = (/** @type {unknown} */ v) =>
    Array.isArray(v) ? v.filter((x) => isObject(x) && typeof x.name === 'string') : [];
  const was = new Map(list(before).map((b) => [b.name, b]));
  const now = list(after);
  const names = new Set(now.map((b) => b.name));
  const type = (/** @type {any} */ b) => (typeof b.type === 'string' ? ` (${bindingTypeWords(b.type, labels)})` : '');
  /** @type {{ added: string[], removed: string[], changed: string[], unchanged: string[] }} */
  const out = { added: [], removed: [], changed: [], unchanged: [] };
  for (const b of now) {
    const had = was.get(b.name);
    if (!had) out.added.push(`+ ${b.name}${type(b)}`);
    else if (
      had.type !== b.type ||
      Object.keys(b).some((k) => k in had && !sameSetting(had[k], b[k])) ||
      // A binding to a resource the change names (by its ID in the file) instead of what it bound to before.
      (b.resource !== undefined && had.resource === undefined)
    )
      out.changed.push(`~ ${b.name}${type(b)}`);
    else out.unchanged.push(b.name);
  }
  for (const b of was.values()) if (!names.has(b.name)) out.removed.push(`− ${b.name}`);
  return out;
}

/**
 * A change to a list of bindings in a line: what's added, removed, and changed, then what stays ("ASSETS
 * unchanged"), or null when nothing does but the order.
 * @param {unknown} before
 * @param {unknown} after
 * @param {Record<string, string>} [labels]
 * @returns {string | null}
 */
export function bindingWords(before, after, labels = {}) {
  const c = bindingChanges(before, after, labels);
  const moved = [...c.added, ...c.removed, ...c.changed];
  if (!moved.length) return null;
  const kept = c.unchanged.length
    ? c.unchanged.length > 3
      ? `${c.unchanged.length} unchanged`
      : `${c.unchanged.join(', ')} unchanged`
    : '';
  return [moved.join(', '), kept].filter(Boolean).join('; ');
}

/**
 * One setting's change in words, without the resource's name: "usage model standard → bundled", or a list of
 * bindings one binding at a time ("bindings + CHAT (Durable Object); ASSETS unchanged"). Null when it changes
 * nothing.
 * @param {{ label: string, before: unknown, after: unknown, labels?: Record<string, string>, unset?: string }} change
 *   `before` undefined: the resource didn't have the setting
 * @returns {string | null}
 */
export function settingWords({ label, before, after, labels = {}, unset = 'unset' }) {
  if (sameSetting(before ?? null, after ?? null)) return null;
  if (namedList(before) || namedList(after)) {
    const words = bindingWords(before, after, labels);
    if (words) return `${label} ${words}`;
  }
  // A setting the resource didn't have reads as what it becomes.
  if (before === undefined) return `${label} → ${valueWords(after, { unset })}`;
  return `${label} ${valueWords(before, { unset })} → ${valueWords(after, { unset })}`;
}

/**
 * Why an edit that leaves a setting as it is changes nothing, in words: "acme-api’s bindings are the same in another
 * order".
 * @param {string} name the resource's
 * @param {string} label the setting's
 * @param {unknown} before what it is now
 */
export function sameWords(name, label, before) {
  if (namedList(before) && /** @type {unknown[]} */ (before).length > 1)
    return `${name}’s ${label} are the same in another order`;
  return `${name}’s ${label} is already ${valueWords(before, { unset: 'unset' })}`;
}
