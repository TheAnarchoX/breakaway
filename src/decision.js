/**
 * Decisions as questions and answers (docs/specs/IDEA-6-decisions-with-questions.md): the shape of a
 * decision's questions, checking the owner's answers against them, and the plain summary comment.
 * Pure functions; the store decides who may submit and writes the properties.
 */

export class DecisionError extends Error {}

export const TYPES = ['open', 'yesno', 'choice', 'multi', 'rank', 'scale', 'date'];
const CHOICES = ['choice', 'multi', 'rank'];
export const MAX_QUESTIONS = 20;
export const MAX_BYTES = 20 * 1024;
const MAX_TEXT = 10000;
const MAX_PROMPT = 2000;
const MAX_COMMENT = 1000;
const ID = /^[\w-]{1,32}$/u;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v.trim() : '');

function checkText(value, what, max) {
  if (typeof value !== 'string' || !value.trim()) throw new DecisionError(`${what} can't be empty`);
  if (value.length > max) throw new DecisionError(`${what} can be up to ${max} characters`);
  return value.trim();
}

function optionalText(value, what, max) {
  if (value === undefined || value === null || value === '') return undefined;
  return checkText(value, what, max);
}

const whole = (v) => typeof v === 'number' && Number.isInteger(v);

/** Checks a decision's questions and returns them cleaned up (only known fields kept). */
export function validateQuestions(input) {
  if (!Array.isArray(input)) throw new DecisionError('a decision is a list of questions');
  if (!input.length) throw new DecisionError('a decision needs at least one question');
  if (input.length > MAX_QUESTIONS) throw new DecisionError(`a decision can have up to ${MAX_QUESTIONS} questions`);
  if (JSON.stringify(input).length > MAX_BYTES) throw new DecisionError('a decision can be up to 20 KB');
  const seen = new Set();
  return input.map((raw, index) => {
    if (!isObject(raw)) throw new DecisionError(`question ${index + 1} must be an object`);
    if (typeof raw.id !== 'string' || !ID.test(raw.id))
      throw new DecisionError(`question ${index + 1} needs an id of letters, digits, - and _ (up to 32)`);
    if (seen.has(raw.id)) throw new DecisionError(`the question id "${raw.id}" is used twice`);
    seen.add(raw.id);
    if (!TYPES.includes(raw.type)) throw new DecisionError(`"${raw.id}": type is one of ${TYPES.join(', ')}`);
    const q = { id: raw.id, type: raw.type, prompt: checkText(raw.prompt, `"${raw.id}": the prompt`, MAX_PROMPT) };
    const help = optionalText(raw.help, `"${raw.id}": help`, MAX_PROMPT);
    if (help) q.help = help;
    if (raw.required === false) q.required = false;
    if (CHOICES.includes(q.type)) {
      if (!Array.isArray(raw.options) || raw.options.length < 2)
        throw new DecisionError(`"${raw.id}" needs at least 2 options`);
      const ids = new Set();
      q.options = raw.options.map((o) => {
        if (!isObject(o) || typeof o.id !== 'string' || !ID.test(o.id) || o.id === 'other')
          throw new DecisionError(`"${raw.id}": each option needs an id of letters, digits, - and _ (not "other")`);
        if (ids.has(o.id)) throw new DecisionError(`"${raw.id}": the option id "${o.id}" is used twice`);
        ids.add(o.id);
        const option = { id: o.id, label: checkText(o.label, `"${raw.id}": an option's label`, 200) };
        const note = optionalText(o.note, `"${raw.id}": an option's note`, 500);
        if (note) option.note = note;
        return option;
      });
      if (q.type !== 'rank' && raw.other === true) q.other = true;
    }
    if (q.type === 'multi') {
      for (const key of ['min', 'max']) {
        if (raw[key] === undefined) continue;
        if (!whole(raw[key]) || raw[key] < 0 || raw[key] > q.options.length)
          throw new DecisionError(`"${raw.id}": ${key} is a whole number up to the number of options`);
        q[key] = raw[key];
      }
      if (q.min !== undefined && q.max !== undefined && q.min > q.max)
        throw new DecisionError(`"${raw.id}": min can't be more than max`);
    }
    if (q.type === 'scale') {
      if (!whole(raw.min) || !whole(raw.max) || raw.min >= raw.max)
        throw new DecisionError(`"${raw.id}": a scale needs whole numbers with min below max`);
      q.min = raw.min;
      q.max = raw.max;
      for (const key of ['minLabel', 'maxLabel']) {
        const label = optionalText(raw[key], `"${raw.id}": ${key}`, 100);
        if (label) q[key] = label;
      }
    }
    return q;
  });
}

function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** One question's answer, checked and cleaned. Returns null when it is blank and the question is optional. */
function checkAnswer(q, raw) {
  const name = `"${q.prompt}"`;
  const blank =
    raw === undefined ||
    raw === null ||
    !isObject(raw) ||
    raw.value === undefined ||
    raw.value === null ||
    raw.value === '' ||
    (Array.isArray(raw.value) && !raw.value.length && q.type !== 'multi') ||
    (typeof raw.value === 'string' && !raw.value.trim());
  if (blank) {
    if (raw !== undefined && raw !== null && !isObject(raw))
      throw new DecisionError(`${name}: the answer is an object with a value`);
    if (q.required !== false) throw new DecisionError(`${name} needs an answer`);
    return null;
  }
  const { value } = raw;
  const answer = {};
  const ids = q.options?.map((o) => o.id) ?? [];
  const known = (id) => ids.includes(id) || (q.other && id === 'other');
  const other = () => {
    if (!q.other) return;
    answer.other = optionalText(raw.other, `${name}: something else`, 500);
  };
  switch (q.type) {
    case 'open':
      if (typeof value !== 'string') throw new DecisionError(`${name}: write an answer`);
      if (value.length > MAX_TEXT) throw new DecisionError(`${name}: an answer can be up to ${MAX_TEXT} characters`);
      answer.value = value.trim();
      break;
    case 'yesno':
      if (value !== 'yes' && value !== 'no') throw new DecisionError(`${name}: answer yes or no`);
      answer.value = value;
      break;
    case 'choice':
      if (typeof value !== 'string' || !known(value))
        throw new DecisionError(`${name}: "${String(value).slice(0, 40)}" is not an option`);
      answer.value = value;
      if (value === 'other') {
        other();
        if (!answer.other) throw new DecisionError(`${name}: say what "something else" is`);
      }
      break;
    case 'multi': {
      if (!Array.isArray(value)) throw new DecisionError(`${name}: answer with a list of options`);
      const bad = value.find((id) => typeof id !== 'string' || !known(id));
      if (bad !== undefined) throw new DecisionError(`${name}: "${String(bad).slice(0, 40)}" is not an option`);
      if (new Set(value).size !== value.length) throw new DecisionError(`${name}: pick each option once`);
      const min = q.min ?? (q.required === false ? 0 : 1);
      if (value.length < min) {
        if (!value.length && q.required === false) return null;
        throw new DecisionError(`${name}: pick at least ${min}`);
      }
      if (q.max !== undefined && value.length > q.max) throw new DecisionError(`${name}: pick at most ${q.max}`);
      answer.value = value;
      if (value.includes('other')) {
        other();
        if (!answer.other) throw new DecisionError(`${name}: say what "something else" is`);
      }
      break;
    }
    case 'rank': {
      if (!Array.isArray(value)) throw new DecisionError(`${name}: answer with the options in order`);
      const bad = value.find((id) => !ids.includes(id));
      if (bad !== undefined) throw new DecisionError(`${name}: "${String(bad).slice(0, 40)}" is not an option`);
      if (value.length !== ids.length || new Set(value).size !== ids.length)
        throw new DecisionError(`${name}: put every option in order, once each`);
      answer.value = value;
      break;
    }
    case 'scale':
      if (!whole(value)) throw new DecisionError(`${name}: answer with a whole number`);
      if (value < q.min || value > q.max)
        throw new DecisionError(`${name}: answer with a number between ${q.min} and ${q.max}`);
      answer.value = value;
      break;
    case 'date':
      if (!validDay(value)) throw new DecisionError(`${name}: answer with a date like 2026-10-10`);
      answer.value = value;
      break;
    default:
      throw new DecisionError(`${name}: unknown question type`);
  }
  if (answer.other === undefined) delete answer.other;
  const comment = optionalText(raw.comment, `${name}: the comment`, MAX_COMMENT);
  if (comment) answer.comment = comment;
  return answer;
}

/** Checks the owner's answers against the questions; returns `{ <id>: { value, other?, comment? } }`. */
export function validateAnswers(questions, input) {
  if (!isObject(input)) throw new DecisionError('answers is an object with one entry per question id');
  for (const id of Object.keys(input))
    if (!questions.some((q) => q.id === id)) throw new DecisionError(`there's no question "${id}"`);
  const answers = {};
  for (const q of questions) {
    const answer = checkAnswer(q, input[q.id]);
    if (answer) answers[q.id] = answer;
  }
  return answers;
}

/** After the questions were edited: the answers that still fit, and the ids of those that don't. */
export function keepAnswers(questions, answers) {
  const kept = {};
  const dropped = [];
  for (const [id, answer] of Object.entries(answers ?? {})) {
    const q = questions.find((x) => x.id === id);
    try {
      const checked = q && checkAnswer(q, answer);
      if (checked) kept[id] = checked;
      else dropped.push(id);
    } catch {
      dropped.push(id);
    }
  }
  return { answers: kept, dropped };
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function show(q, answer) {
  const label = (id) => (id === 'other' ? answer.other : (q.options.find((o) => o.id === id)?.label ?? id));
  const { value } = answer;
  if (q.type === 'choice') return label(value);
  if (q.type === 'multi' || q.type === 'rank') return value.map(label).join(', ');
  if (q.type === 'open') return clip(value.replace(/\s+/gu, ' '), 200);
  return String(value);
}

/** The plain comment the board adds when a decision is submitted. Nothing reads it back. */
export function summarize(questions, answers) {
  const parts = questions.map((q) => {
    const answer = answers[q.id];
    const body = answer
      ? `${show(q, answer)}${answer.comment ? ` (${clip(answer.comment.replace(/\s+/gu, ' '), 200)})` : ''}`
      : 'no answer';
    return `${clip(text(q.prompt).replace(/\s+/gu, ' '), 60)} = ${body}`;
  });
  return `Decided by the owner: ${parts.join('; ')}`;
}
