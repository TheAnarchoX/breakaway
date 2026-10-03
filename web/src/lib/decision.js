// The answer form's logic (docs/specs/IDEA-6-decisions-with-questions.md): what an answer looks like
// per question type, whether it is complete, what to send, and how it reads. Pure, so the component
// stays about layout. The board checks everything again on Submit.

const CHOICES = ['choice', 'multi', 'rank'];

/** A question type the form knows; anything else shows as an open question, as the spec says. */
export const typeOf = (q) =>
  ['open', 'yesno', 'choice', 'multi', 'rank', 'scale', 'date'].includes(q.type) ? q.type : 'open';

const blank = (v) => v === undefined || v === null || (typeof v === 'string' && !v.trim());

/** What the form starts with: the submitted answers when there are any, else nothing (a rank starts in the given order). */
export function startingDraft(questions, answers = {}) {
  const draft = {};
  for (const q of questions) {
    const a = answers[q.id];
    if (a) draft[q.id] = { value: a.value, other: a.other ?? '', comment: a.comment ?? '' };
    else if (typeOf(q) === 'rank') draft[q.id] = { value: q.options.map((o) => o.id), other: '', comment: '' };
  }
  return draft;
}

/** Drops from a saved draft what no longer fits the questions (they may have been edited since). */
export function fitDraft(questions, draft) {
  const fit = {};
  if (!draft || typeof draft !== 'object') return fit;
  for (const q of questions) {
    const d = draft[q.id];
    if (!d || typeof d !== 'object') continue;
    const ids = q.options?.map((o) => o.id) ?? [];
    const known = (id) => ids.includes(id) || (q.other && id === 'other');
    const type = typeOf(q);
    let ok = true;
    if (type === 'choice') ok = typeof d.value === 'string' && known(d.value);
    else if (type === 'multi') ok = Array.isArray(d.value) && d.value.every(known);
    else if (type === 'rank')
      ok = Array.isArray(d.value) && d.value.length === ids.length && ids.every((id) => d.value.includes(id));
    else if (type === 'scale') ok = Number.isInteger(d.value) && d.value >= q.min && d.value <= q.max;
    else if (type === 'yesno') ok = d.value === 'yes' || d.value === 'no';
    else ok = typeof d.value === 'string' || d.value === undefined;
    if (ok) fit[q.id] = { value: d.value, other: String(d.other ?? ''), comment: String(d.comment ?? '') };
  }
  return fit;
}

/** Whether a question's draft answer is complete. Optional questions may stay blank. */
export function isAnswered(q, d) {
  const type = typeOf(q);
  const v = d?.value;
  if (blank(v) || (Array.isArray(v) && !v.length && type !== 'multi')) return q.required === false;
  if (type === 'choice') return v !== 'other' || !blank(d.other);
  if (type === 'multi') {
    const min = q.min ?? (q.required === false ? 0 : 1);
    if (v.length < min || (q.max !== undefined && v.length > q.max)) return false;
    return !v.includes('other') || !blank(d.other);
  }
  return true;
}

/** The questions still needing an answer. */
export const missing = (questions, draft) => questions.filter((q) => !isAnswered(q, draft[q.id]));

/** The body for Submit: one entry per answered question. */
export function toAnswers(questions, draft) {
  const answers = {};
  for (const q of questions) {
    const d = draft[q.id];
    const type = typeOf(q);
    if (!d || blank(d.value) || (type === 'multi' && !d.value.length)) continue;
    const a = {
      value: typeof d.value === 'string' && type !== 'choice' && type !== 'yesno' ? d.value.trim() : d.value,
    };
    const picked = type === 'multi' ? d.value.includes('other') : d.value === 'other';
    if (q.other && picked && !blank(d.other)) a.other = d.other.trim();
    if (!blank(d.comment)) a.comment = d.comment.trim();
    answers[q.id] = a;
  }
  return answers;
}

/** An answer as words, for the submitted view. */
export function describe(q, a) {
  if (!a) return 'No answer';
  const type = typeOf(q);
  const label = (id) =>
    id === 'other' ? `Something else: ${a.other ?? ''}` : (q.options?.find((o) => o.id === id)?.label ?? id);
  if (type === 'yesno') return a.value === 'yes' ? 'Yes' : 'No';
  if (type === 'choice') return label(a.value);
  if (type === 'multi') return a.value.length ? a.value.map(label).join(', ') : 'None';
  if (type === 'rank') return a.value.map((id, i) => `${i + 1}. ${label(id)}`).join('  ');
  if (type === 'scale') return String(a.value);
  return String(a.value);
}

export const hasOptions = (q) => CHOICES.includes(typeOf(q));

// ---- drafts, kept in this browser until submitted -------------------------------------------

const key = (uuid) => `tasks.decision.${uuid}`;

export function loadDraft(uuid) {
  try {
    return JSON.parse(localStorage.getItem(key(uuid)) ?? 'null');
  } catch {
    return null;
  }
}

export function saveDraft(uuid, draft) {
  try {
    localStorage.setItem(key(uuid), JSON.stringify(draft));
  } catch {
    /* storage blocked: the draft lasts until reload */
  }
}

export function clearDraft(uuid) {
  try {
    localStorage.removeItem(key(uuid));
  } catch {
    /* nothing to clear */
  }
}
