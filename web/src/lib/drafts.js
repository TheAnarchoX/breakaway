// Drafts of the New task, New idea, and New agent forms (WEB-84): what the owner typed stays when the dialog
// closes by a click outside it or Escape, and comes back when it opens again, even after a reload. Cancel and a
// successful submit throw it away. Pure apart from the storage it's given, so it's tested in the Workers pool.

const PREFIX = 'tasks.draft.';

/** @typedef {Record<string, string | string[]>} DraftFields */

/** The storage drafts live in, or null when the browser blocks it (then a draft lasts until the form closes). */
const local = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/**
 * The saved draft for form `key`, or null.
 * @param {string} key
 * @returns {DraftFields | null}
 */
export function readDraft(key, storage = local()) {
  try {
    const fields = JSON.parse(storage?.getItem(PREFIX + key) ?? 'null');
    return fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : null;
  } catch {
    return null;
  }
}

/**
 * Saves form `key`'s fields, or forgets them when nothing was typed.
 * @param {string} key
 * @param {{ fields: DraftFields, typed: boolean }} draft
 */
export function writeDraft(key, { fields, typed }, storage = local()) {
  try {
    if (typed) storage?.setItem(PREFIX + key, JSON.stringify(fields));
    else storage?.removeItem(PREFIX + key);
  } catch {
    /* storage full or blocked: the draft just isn't kept */
  }
}

/** @param {string} key */
export function clearDraft(key, storage = local()) {
  writeDraft(key, { fields: {}, typed: false }, storage);
}

const TEXT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'number', '']);

/**
 * A form's fields as a draft: text, selects, the picked radio, and each checkbox group's checked values. `typed`
 * says whether any text field holds more than spaces: a form with nothing typed isn't worth keeping.
 * @param {Iterable<any>} elements a form's `elements`
 * @returns {{ fields: DraftFields, typed: boolean }}
 */
export function draftOf(elements) {
  /** @type {DraftFields} */
  const fields = {};
  let typed = false;
  for (const el of elements) {
    const { name, type } = el;
    if (!name || el.disabled) continue;
    if (type === 'checkbox') {
      const list = Array.isArray(fields[name]) ? /** @type {string[]} */ (fields[name]) : [];
      fields[name] = el.checked ? [...list, el.value] : list;
    } else if (type === 'radio') {
      if (el.checked) fields[name] = el.value;
    } else if (el.tagName === 'SELECT') {
      fields[name] = el.value;
    } else if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && TEXT_TYPES.has(type ?? ''))) {
      fields[name] = el.value;
      if (el.value.trim()) typed = true;
    }
  }
  return { fields, typed };
}

/**
 * Puts a draft back into a form's fields. Fields the draft doesn't name keep what the form set.
 * @param {Iterable<any>} elements a form's `elements`
 * @param {DraftFields} fields
 */
export function fillDraft(elements, fields) {
  for (const el of elements) {
    const { name, type } = el;
    if (!name || !Object.hasOwn(fields, name)) continue;
    const saved = fields[name];
    if (type === 'checkbox') el.checked = Array.isArray(saved) && saved.includes(el.value);
    else if (type === 'radio') el.checked = el.value === saved;
    else if (typeof saved !== 'string') continue;
    // A select keeps its own choice when the saved one isn't among its options any more.
    else if (el.tagName === 'SELECT') {
      if ([...el.options].some((o) => o.value === saved)) el.value = saved;
    } else if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') el.value = saved;
  }
}
