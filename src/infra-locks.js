/**
 * Architect's environment locks (docs/specs/IDEA-19-architect.md, "Executor"; BRK-179): one apply at a time per
 * environment. The executor (BRK-183) takes the environment's lock before it applies, renews it while it works, and
 * releases it when it's done; a lock it never releases expires by itself, and the owner can release one by force.
 * Pure, so the rules are tested without the Durable Object; the table and the API are in store-infra-locks.js.
 */
import { InputError } from './model.js';

export const MINUTE = 60_000;
/** Long enough for an apply, its health check, and a rollback; the executor renews it while it works. */
export const LOCK_TTL_MINUTES = 15;
/** Never longer: a lock nobody renews frees the environment within the hour. */
export const LOCK_TTL_MAX_MINUTES = 60;

/** Who holds it, like `executor` or `executor:plan-12`: shown on the board, never a person's name. */
const HOLDER = /^[\w.:#/-]{1,64}$/u;
/** The plan the lock is for (BRK-178), as the audit trail names it. */
const PLAN = /^[\w.:#/-]{1,100}$/u;

/** @param {unknown} value */
export function checkHolder(value) {
  const holder = String(value ?? '').trim();
  if (!HOLDER.test(holder))
    throw new InputError(
      'holder names who takes the lock, like executor:plan-12 (up to 64 letters, digits, and . : # / - _)',
    );
  return holder;
}

/** @param {unknown} value @returns {string | null} */
export function checkPlanRef(value) {
  if (value === undefined || value === null || value === '') return null;
  const plan = String(value).trim();
  if (!PLAN.test(plan)) throw new InputError('plan is the plan’s ID (up to 100 letters, digits, and . : # / - _)');
  return plan;
}

/**
 * How long the lock lasts from now, in milliseconds: the default when none is given, else whole minutes up to the cap.
 * @param {unknown} minutes
 */
export function lockTtl(minutes) {
  if (minutes === undefined || minutes === null) return LOCK_TTL_MINUTES * MINUTE;
  if (!Number.isInteger(minutes) || Number(minutes) < 1 || Number(minutes) > LOCK_TTL_MAX_MINUTES)
    throw new InputError(`minutes is a whole number from 1 to ${LOCK_TTL_MAX_MINUTES}`);
  return Number(minutes) * MINUTE;
}

/** Whether a lock still holds at `now`. @param {{ expires: number }} row @param {number} now */
export const held = (row, now) => Boolean(row) && Number(row.expires) > now;

/**
 * The lock as the API shows it: never its token, which only the taker gets, once.
 * @param {{ environment: number, repo: string, name: string, holder: string, plan: string | null, taken: number, renewed: number, expires: number }} row
 */
export function lockView(row) {
  return {
    environment: { id: Number(row.environment), repo: row.repo, name: row.name },
    holder: row.holder,
    plan: row.plan ?? null,
    taken: new Date(Number(row.taken)).toISOString(),
    renewed: new Date(Number(row.renewed)).toISOString(),
    expires: new Date(Number(row.expires)).toISOString(),
  };
}
