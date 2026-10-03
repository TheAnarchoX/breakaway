/**
 * Five-field cron text in UTC for routine schedules (docs/specs/IDEA-4-routines.md):
 * `minute hour day-of-month month day-of-week`, each `*`, a number, a range `a-b`, a list `a,b`,
 * or any of them with a step (`1-5/2`, or a star with a step for “every n”). Day of week is 0 to 7 (0 and 7 are Sunday).
 * Like classic cron, when both day fields are restricted a day matches if either does.
 */
const FIELDS = [
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['day of month', 1, 31],
  ['month', 1, 12],
  ['day of week', 0, 7],
];
const MINUTE_MS = 60_000;
const WINDOW_MS = 10 * MINUTE_MS; // a tick this late still counts as the slot's

function parseField(part, [name, min, max]) {
  const values = new Set();
  for (const piece of part.split(',')) {
    const m = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/u.exec(piece);
    if (!m) throw new Error(`the ${name} “${piece}” isn’t valid`);
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) throw new Error(`the ${name} step must be at least 1`);
    let from = min;
    let to = max;
    if (m[1] !== '*') {
      [from, to = m[2] === undefined ? from : max] = m[1].split('-').map(Number);
    }
    if (from < min || to > max || from > to) throw new Error(`the ${name} must be from ${min} to ${max}`);
    for (let v = from; v <= to; v += step) values.add(name === 'day of week' && v === 7 ? 0 : v);
  }
  return values;
}

/** Parses cron text into what `matches` needs; throws an Error saying what's wrong. */
export function parseCron(text) {
  const parts = String(text ?? '')
    .trim()
    .split(/\s+/u);
  if (parts.length !== 5)
    throw new Error('a schedule has five fields: minute hour day-of-month month day-of-week (UTC), like “0 9 * * 1”');
  const [minute, hour, dom, month, dow] = parts.map((p, i) =>
    parseField(p, /** @type {[string, number, number]} */ (FIELDS[i])),
  );
  return { minute, hour, dom, month, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

function dayMatches(c, d) {
  const dom = c.dom.has(d.getUTCDate());
  const dow = c.dow.has(d.getUTCDay());
  if (c.domAny) return dow;
  if (c.dowAny) return dom;
  return dom || dow;
}

/** Whether the UTC minute containing `ms` is a slot. */
export function matches(c, ms) {
  const d = new Date(ms);
  return (
    c.minute.has(d.getUTCMinutes()) &&
    c.hour.has(d.getUTCHours()) &&
    c.month.has(d.getUTCMonth() + 1) &&
    dayMatches(c, d)
  );
}

/** The latest slot (start of its minute, ms) within the last ten minutes up to `now`, or null. */
export function latestSlot(c, now) {
  const end = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  for (let t = end; t > now - WINDOW_MS; t -= MINUTE_MS) if (matches(c, t)) return t;
  return null;
}

/** The first slot after `now` (ms), looking up to five years ahead, or null (like 30 February). */
export function nextSlot(c, now) {
  let t = (Math.floor(now / MINUTE_MS) + 1) * MINUTE_MS;
  const limit = now + 5 * 366 * 86_400_000;
  while (t < limit) {
    const d = new Date(t);
    if (!c.month.has(d.getUTCMonth() + 1) || !dayMatches(c, d)) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    } else if (!c.hour.has(d.getUTCHours())) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1);
    } else if (!c.minute.has(d.getUTCMinutes())) {
      t += MINUTE_MS;
    } else {
      return t;
    }
  }
  return null;
}
