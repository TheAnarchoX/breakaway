/**
 * The owner's Claude plan (CLD-198) and the limits it sets on the board's agents and routines.
 *
 * Claude has no API that says which plan an account is on, so the owner picks it in the Agents view
 * (or `agents plan <id>`). Claude's own limits on starting a routine are the same on every plan
 * (https://code.claude.com/docs/en/routines#usage-and-limits): 30 starts an hour for each routine and
 * 100 API starts an hour for the account. What a plan changes is how much the sessions may use: Max 5x
 * and Max 20x give five and twenty times Pro's usage. So a plan sets the ceilings and defaults of the
 * board's own limits (agents at once, starts an hour, routine runs a day), never Claude's.
 */

/** Claude's limits on starting a routine, on every plan. */
export const CLAUDE_LIMITS = { routineHourly: 30, accountHourly: 100 };

/**
 * Each plan's limits for the board: `most` is the ceiling the owner can set, `default` what a plan
 * change sets. `usage` is the plan's usage against Pro's, for the view.
 */
export const PLANS = {
  pro: {
    name: 'Pro',
    usage: 1,
    agents: { most: 6, default: 3 },
    hourly: { default: 20 },
    routinesDaily: { most: 100, default: 10 },
    routineDaily: { most: 50, default: 3 },
  },
  max5: {
    name: 'Max 5x',
    usage: 5,
    agents: { most: 12, default: 6 },
    hourly: { default: 30 },
    routinesDaily: { most: 250, default: 25 },
    routineDaily: { most: 100, default: 6 },
  },
  max20: {
    name: 'Max 20x',
    usage: 20,
    agents: { most: 24, default: 10 },
    hourly: { default: 60 },
    routinesDaily: { most: 500, default: 50 },
    routineDaily: { most: 200, default: 10 },
  },
};

/** The board's limits were made for Pro, so a board that never picked a plan keeps them. */
export const DEFAULT_PLAN = 'pro';

export const planOf = (id) => PLANS[id] ?? PLANS[DEFAULT_PLAN];

export const isPlan = (id) => Object.hasOwn(PLANS, id);

/** The most starts an hour the board can use: Claude's 30 for each connected routine, and 100 for the account. */
export const hourlyCeiling = (routines) =>
  Math.min(CLAUDE_LIMITS.accountHourly, CLAUDE_LIMITS.routineHourly * Math.max(1, Number(routines) || 0));

/** A plan's limits with the hourly ceiling for this many routines, for the views and the CLI. */
export function planLimits(id, routines) {
  const plan = planOf(id);
  return {
    agents: plan.agents.most,
    hourly: hourlyCeiling(routines),
    routinesDaily: plan.routinesDaily.most,
    routineDaily: plan.routineDaily.most,
    routineHourly: CLAUDE_LIMITS.routineHourly,
    accountHourly: CLAUDE_LIMITS.accountHourly,
  };
}

/** Every plan, in order, for the plan picker. */
export const planChoices = () =>
  Object.entries(PLANS).map(([id, p]) => ({
    id,
    name: p.name,
    usage: p.usage,
    agents: p.agents,
    hourly: p.hourly,
    routinesDaily: p.routinesDaily,
    routineDaily: p.routineDaily,
  }));
