/**
 * `npx breakaway infra act <environment> <resource> scale <n>|restart` (CLI-24, docs/specs/IDEA-19-architect.md,
 * "Envelopes"): a runbook's agent asks for one scale or restart, for the run it holds. It's the one change a run may
 * ask for, and it's the CLI's only: Architect's MCP tools stay read only.
 *
 * The request is POST /api/infra/envelopes/<environment>/act (BRK-186) with { resource, change, value, task, by, key }:
 * `key` is the run's own act key (BRK-252), from BREAKAWAY_ACT_KEY, set from the `Act key:` line of the run's payload
 * and never a flag, so it stays out of the command line. The board checks the agent holds the runbook's run and has
 * its key, builds the plan itself, and answers whether the envelope the owner
 * approved covers it (the executor applies it) or it waits for the owner. The board's words go through unchanged when
 * it refuses. The requests go through `get` and `post`, which the CLI gives (and the tests mock), and which answer
 * `{ ok, status, data }` for any answer.
 */
import { PLAN_STATE_LABELS } from './infra-read.js';

/** An act the CLI won't send, with what to do instead. */
export class InfraActError extends Error {}
const bad = (message) => {
  throw new InfraActError(message);
};

const enc = encodeURIComponent;
const USAGE = 'infra act <environment> <resource> scale <n>|restart';
/** Where the run's act key comes from. */
export const ACT_KEY_VARIABLE = 'BREAKAWAY_ACT_KEY';

/**
 * What follows `infra act`, as the act route's body.
 * @param {string[]} args
 * @returns {{ environment: string, resource: string, change: 'scale' | 'restart', value: number | null }}
 */
export function parseAct(args) {
  const [environment, resource, change, value, ...rest] = args;
  if (!environment || !resource || !change)
    bad(`${USAGE}: name the environment, the resource, and the change, like infra act production widgets-api scale 4.`);
  if (change === 'restart') {
    if (value !== undefined) bad(`${USAGE}: a restart takes no number.`);
    return { environment, resource, change: 'restart', value: null };
  }
  if (change !== 'scale') bad(`${USAGE}: the change is scale or restart, not ${change}.`);
  if (value === undefined || !/^\d{1,5}$/u.test(value)) bad(`${USAGE}: scale needs a whole number, like scale 4.`);
  if (rest.length) bad(`${USAGE}: one change at a time.`);
  return { environment, resource, change: 'scale', value: Number(value) };
}

/**
 * The run this agent holds: `--task` when it names one, else the only routine run in this repository it has claimed.
 * The board checks it's a runbook's either way.
 * @param {{ task?: string, get: (path: string) => Promise<{ ok: boolean, status: number, data: any }>,
 *   agent: string, inRepo: (task: any) => boolean }} ctx
 */
export async function heldRun({ task, get, agent, inRepo }) {
  if (task) return String(task);
  const res = await get('tasks?status=pending');
  if (!res.ok) bad(res.data?.error ?? `HTTP ${res.status}`);
  const runs = (res.data.tasks ?? []).filter((t) => t.claim === agent && t.project === 'routines' && inRepo(t));
  if (runs.length === 1) return runs[0].wid ?? runs[0].uuid;
  if (!runs.length)
    bad(
      `${agent} holds no routine run here: only a runbook’s agent acts in an envelope, for the run it holds. Name it with --task <ID>.`,
    );
  return bad(`${agent} holds ${runs.length} runs (${runs.map((t) => t.wid).join(', ')}): name one with --task <ID>.`);
}

/**
 * What the board answered, in words: inside the envelope it applies without a press; outside it waits for the owner.
 * @param {{ act: { inside: boolean, why: string, plan: any } }} data
 * @param {{ environment: string, resource: string, change: string, value: number | null }} asked
 */
export function actText({ act }, asked) {
  const what = asked.change === 'scale' ? `Scale ${asked.resource} to ${asked.value}` : `Restart ${asked.resource}`;
  const plan = act.plan ?? {};
  const state = PLAN_STATE_LABELS[plan.state] ?? plan.state;
  const out = act.inside
    ? [
        `${what} in ${asked.environment}: inside its envelope (${act.why}).`,
        `${plan.id} · ${state}: it applies without a press.`,
      ]
    : [
        `${what} in ${asked.environment}: waits for the owner (${act.why}).`,
        `${plan.id} · ${state}: the owner approves or rejects it on the board.`,
      ];
  out.push('', `The plan: npx breakaway infra plan ${plan.id}`);
  return out.join('\n');
}

/**
 * Runs `infra act`. `code` is what the CLI exits with: 1 when the board refuses the act.
 * @param {string[]} args what follows `infra act`
 * @param {{ get: (path: string) => Promise<{ ok: boolean, status: number, data: any }>,
 *   post: (path: string, body: any) => Promise<{ ok: boolean, status: number, data: any }>,
 *   repo: string | null, agent: string, opts?: Record<string, any>, inRepo?: (task: any) => boolean,
 *   key?: string | null }} ctx `key` is the run's act key, from BREAKAWAY_ACT_KEY
 * @returns {Promise<{ data: any, text: string, code: number }>}
 */
export async function infraAct(args, { get, post, repo, agent, opts = {}, inRepo = () => true, key = null }) {
  const asked = parseAct(args);
  if (opts.key !== undefined)
    bad(`the act key never goes on the command line: set ${ACT_KEY_VARIABLE} to the Act key in your payload.`);
  if (!key?.trim())
    bad(
      `set ${ACT_KEY_VARIABLE} to the Act key in your payload first: only the agent the board started on a runbook’s run has one.`,
    );
  const task = await heldRun({ task: opts.task, get, agent, inRepo });
  const res = await post(`infra/envelopes/${enc(asked.environment)}/act`, {
    resource: asked.resource,
    change: asked.change,
    value: asked.value,
    task,
    by: agent,
    key: key.trim(),
    ...(repo ? { repo } : {}),
  });
  if (res.ok) return { data: res.data, text: actText(res.data, asked), code: 0 };
  if (res.status === 0) bad(`can’t reach the board (${res.data?.error ?? 'no answer'}).`);
  if (res.status === 404 && /^no route for/u.test(String(res.data?.error ?? '')))
    bad('this board doesn’t have envelopes yet: its owner updates it to a release that does, then try again.');
  const error = res.data?.error ?? `HTTP ${res.status}`;
  return { data: { status: res.status, error }, text: `The board refused it: ${error}`, code: 1 };
}
