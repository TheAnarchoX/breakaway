/**
 * Bring your own Claude (BRK-302, docs/specs/BRK-299-people-and-roles.md, point 5): what a person's agents may use.
 *
 * A person connects their own Claude routine for a repository and picks the Claude plan it runs on. Their agents at
 * once and starts an hour come from that plan the way the owner's come from theirs (src/plans.js): the plan's defaults,
 * which the person may change up to the plan's ceilings, and never above what the owner allows them. A person with no
 * routine of their own in a repository starts there only when the owner lends the repository's routine, and then on
 * the owner's plan, so those starts get the owner's decision (BRK-322): 1 at once and 5 an hour, which the owner may
 * lower too.
 *
 * Pure: no storage and no network, so the store and the tests share it.
 */
import { hourlyCeiling, isPlan, planOf } from './plans.js';

/** A person's starts on a routine the owner lends them (BRK-322): the owner's plan pays for them. */
export const LENT_CAPS = Object.freeze({ max: 1, hourly: 5 });

/** The hold key of a person's own routine in a repository: Claude holds each routine apart (BRK-144). */
export const personHoldKey = (slug, handle) => `routine_hold:${slug}:person:${handle}`;

/**
 * @typedef {{ max: number | null, hourly: number | null }} Limits what's set: null is "not set"
 * @typedef {{ max: number, hourly: number }} Caps
 */

/** The smaller of `n` and a limit, when the limit is set. */
const under = (n, limit) => (Number.isInteger(limit) && limit >= 0 ? Math.min(n, limit) : n);

/**
 * The most a person on plan `plan` may set, for `routines` routines of their own: the plan's agents at once, and
 * Claude's starts an hour for that many routines.
 * @param {string} plan
 * @param {number} routines
 * @returns {Caps}
 */
export function personCeilings(plan, routines) {
  return { max: planOf(plan).agents.most, hourly: hourlyCeiling(routines) };
}

/**
 * A person's caps on their own routines: what they set, else their plan's defaults, never above the plan's ceilings
 * or the owner's limits. Null while they have no plan (no routine of their own yet).
 * @param {{ plan: string | null, routines: number, own?: Limits, owner?: Limits }} person
 * @returns {Caps | null}
 */
export function personCaps({ plan, routines, own = { max: null, hourly: null }, owner = { max: null, hourly: null } }) {
  if (!plan || !isPlan(plan)) return null;
  const { agents, hourly } = planOf(plan);
  const most = personCeilings(plan, routines);
  const max = Math.min(own.max ?? agents.default, most.max);
  const perHour = Math.min(own.hourly ?? Math.min(hourly.default, most.hourly), most.hourly);
  return { max: under(max, owner.max), hourly: under(perHour, owner.hourly) };
}

/**
 * A person's caps on a lent routine: 1 at once and 5 an hour, or less when the owner lowered them.
 * @param {Limits} [owner]
 * @returns {Caps}
 */
export function lentCaps(owner = { max: null, hourly: null }) {
  return { max: under(LENT_CAPS.max, owner.max), hourly: under(LENT_CAPS.hourly, owner.hourly) };
}

/**
 * Checks a limit someone set: a whole number from `least` to `most`, or null to go back to the default.
 * @param {unknown} value
 * @param {{ least: number, most: number, what: string }} rule
 * @returns {{ value: number | null } | { error: string }}
 */
export function checkLimit(value, { least, most, what }) {
  if (value === null || value === '') return { value: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n < least || n > most) return { error: `${what} is a number from ${least} to ${most}` };
  return { value: n };
}
