/**
 * Who may do what (BRK-301, docs/specs/BRK-299-people-and-roles.md, points 3 and 4): one table of actions and one
 * check, `can(actor, action, repository)`, which every gate on the board calls, in the Worker and in the store.
 *
 * An actor is who's behind a request, resolved from its credential, never from the `by` it sends:
 *
 *   person   'owner' for the board's token and its cookie; a person's handle for their passkey's session or token
 *   grants   the person's `[{ repository, role }]` (the owner has none: the owner is above every role, everywhere)
 *   press    true for a signed-in browser (the owner's cookie or a person's session), false for a bearer token;
 *            left out where the question isn't asked (the store, behind a gate that already asked it)
 *   agent    the agent's name when the request names one (`by`): an agent acts under the agent ceiling
 *   for      the person an agent's run is for, when the board started it: an agent never has more rights than them
 *
 * The rules, in order: an action that's press-only needs a press, and an agent is never a press; an action agents
 * may not do refuses every agent, whoever started it; the owner may do everything else; an action that's the owner's
 * refuses everyone else; and otherwise the person's role in the repository (or `*`) must reach the action's role,
 * and so must the role of the person a run is for. Install-wide actions (no repository) count only the `*` grant.
 *
 * Pure: no storage and no network, so the Worker, the store, and the tests share it.
 */

export const OWNER = 'owner';
/** Every repository, including ones added later (point 3). */
export const EVERY_REPO = '*';

/** The roles, lowest first. The owner isn't one: it's above all of them. */
export const ROLE_RANK = { viewer: 1, member: 2, maintainer: 3 };

/**
 * @typedef {'viewer' | 'member' | 'maintainer' | 'owner'} Need
 * @typedef {{ role: Need, press?: boolean, agents?: boolean, starts?: boolean, what: string }} Rule
 */

/**
 * Every gated action (the spec's table in point 3), by what it needs: `role`, a `press` (a signed-in browser),
 * whether a named agent may do it (`agents`), and whether it starts an agent (`starts`, so it runs on the starter's
 * Claude: BRK-302, and BRK-334 for the starts other than PERSON_STARTS). Every write names the person behind it (BRK-303). `what` finishes "only … can …" in a refusal.
 * @type {Record<string, Rule>}
 */
export const ACTIONS = {
  // Reading (BRK-323 filters reads by it).
  read: { role: 'viewer', agents: true, what: 'see it' },

  // Pull requests, deploys, workflows, and releases.
  'pull.write': {
    role: 'maintainer',
    press: true,
    what: 'publish, update, merge, or set auto-merge on a pull request',
  },
  'deploy.promote': { role: 'maintainer', press: true, what: 'promote or roll back' },
  'workflow.run': { role: 'maintainer', press: true, what: 'run a workflow' },
  'release.prerelease': { role: 'maintainer', press: true, what: 'build a pre-release' },
  'release.publish': { role: 'maintainer', what: 'release a package' },
  'release.pull': { role: 'member', agents: true, what: 'pull a release in' },
  'github.sync': { role: 'member', agents: true, what: 'sync with GitHub' },
  'spec.status': { role: 'maintainer', press: true, what: 'mark a spec approved or built' },

  // Plans, changes, and policy.
  'plan.create': { role: 'member', agents: true, what: 'make a plan' },
  'plan.approve': { role: 'maintainer', press: true, what: 'approve or reject a plan' },
  'plan.start-again': { role: 'maintainer', press: true, what: 'start a plan’s run again' },
  'plan.front': { role: 'member', press: true, what: 'put a plan in front of you' },
  'change.propose': { role: 'member', press: true, what: 'change an environment' },
  'change.approve': { role: 'maintainer', press: true, what: 'approve or reject a change' },
  'policy.propose': { role: 'member', press: true, what: 'propose a policy change' },
  'policy.tighten': { role: 'maintainer', press: true, what: 'approve or reject a policy change' },
  'policy.loosen': { role: 'owner', press: true, what: 'approve a policy change that loosens it' },

  // Envelopes, environments, and the rest of Infrastructure.
  'envelope.set': { role: 'maintainer', press: true, what: 'set or widen an envelope' },
  'envelope.set-production': {
    role: 'owner',
    press: true,
    what: 'set or widen an envelope on production',
  },
  'envelope.revoke': { role: 'maintainer', press: true, what: 'revoke or narrow an envelope' },
  // An act is a runbook run's agent's, with its act key: never a person's (the key decides).
  'envelope.act': { role: 'owner', agents: true, what: 'act inside an envelope' },
  'environment.write': {
    role: 'maintainer',
    press: true,
    what: 'add, change, or remove an environment',
  },
  'environment.freeze': { role: 'maintainer', press: true, what: 'freeze or unfreeze an environment' },
  'environment.describe': {
    role: 'maintainer',
    press: true,
    starts: true,
    what: 'have an agent describe an environment as code',
  },
  'inventory.refresh': {
    role: 'member',
    press: true,
    what: 'refresh the inventory or compare an environment now',
  },
  'infra.check': { role: 'member', agents: true, what: 'check a desired state' },
  'lock.release': { role: 'maintainer', press: true, what: 'release an environment’s lock' },
  'drift.break-glass': { role: 'maintainer', press: true, what: 'mark drift as break-glass' },
  'github-environment.make': { role: 'maintainer', press: true, what: 'make a GitHub environment' },
  'short-lived.ask': { role: 'member', press: true, what: 'ask for a short-lived environment' },
  'runbook.trigger': { role: 'maintainer', press: true, what: 'change a routine’s signal trigger' },
  currency: { role: 'owner', press: true, what: 'set the board’s currency or fetch its rate' },
  'provider.connect': { role: 'owner', press: true, what: 'connect or forget a provider' },

  // Decisions, pings, and agents.
  'decision.answer': { role: 'maintainer', what: 'answer or reopen a decision' },
  'decision.carry-on': {
    role: 'maintainer',
    press: true,
    starts: true,
    what: 'send answers and start the next run',
  },
  'ping.apply': { role: 'maintainer', press: true, what: 'apply a ping’s proposal' },
  'ping.resolve': { role: 'maintainer', press: true, what: 'dismiss a ping or mark it handled' },
  'agent.start': { role: 'member', agents: true, starts: true, what: 'start an agent' },
  'agent.force': { role: 'maintainer', starts: true, what: 'force start an agent' },
  'agent.next': { role: 'maintainer', agents: true, starts: true, what: 'start the next agents' },
  'agent.general': {
    role: 'maintainer',
    starts: true,
    what: 'start a general agent, an agent that reviews a pull request, or one that makes routines',
  },
  'agent.message': { role: 'maintainer', press: true, what: 'message an agent' },
  'agent.settings': { role: 'owner', what: 'change the agents’ settings' },

  // Tasks.
  'task.write': { role: 'member', agents: true, what: 'add, change, claim, or comment on a task' },
  'task.plan': {
    role: 'maintainer',
    agents: true,
    what: 'force-release a claim, set a task to start by itself, or change a horizon-* tag',
  },
  'task.quote': { role: 'maintainer', press: true, what: 'quote someone’s words on a task' },
  'task.unquote': { role: 'maintainer', press: true, what: 'remove a quote from a task' },
  'planning.undo': { role: 'maintainer', press: true, what: 'undo an agent’s change' },
  'risk.answer': { role: 'maintainer', press: true, what: 'answer a risky-path finding' },
  'horizon.close': { role: 'owner', what: 'close a horizon' },

  // Features, chases, and the peloton.
  'feature.edit': { role: 'member', agents: true, what: 'add a feature, or change its title, brief, or release' },
  'feature.shape': {
    role: 'maintainer',
    what: 'change a feature’s state, planned dates, or shape, or delete it',
  },
  chase: { role: 'maintainer', starts: true, what: 'start or stop a chase' },
  'peloton.post': { role: 'member', press: true, what: 'post on the peloton' },
  'peloton.plan': { role: 'maintainer', press: true, what: 'revise a chase’s plan' },

  // Routines.
  'routine.write': { role: 'maintainer', what: 'make, change, or run a routine, or change its triggers' },
  'routine.settings': { role: 'owner', what: 'pause routines or set their daily cap' },

  // Repositories and kickoffs.
  'repo.add': { role: 'owner', what: 'add, remove, or release a repository' },
  'repo.modify': { role: 'maintainer', what: 'change a repository’s settings' },
  'repo.init': { role: 'maintainer', press: true, what: 'add the board’s files' },
  'repo.routine': { role: 'owner', press: true, what: 'connect or forget a repository’s routine' },
  'repo.deploys': { role: 'maintainer', press: true, what: 'turn on deploys' },
  'repo.move': { role: 'maintainer', press: true, starts: true, what: 'move a repository to the deploy flow' },
  kickoff: { role: 'owner', press: true, what: 'kick off, change, or stop a project' },

  // Connections, the install, sign-ins, and notifications.
  'connections.check': { role: 'member', press: true, what: 'run Check now' },
  'connections.owner': { role: 'owner', press: true, what: 'override GitHub’s status or dismiss a connection note' },
  'github.setup': { role: 'owner', what: 'set up the GitHub App' },
  'install.update': { role: 'owner', press: true, what: 'update or roll back the Worker' },
  'install.admin': { role: 'owner', what: 'import, rebuild, or backfill the board' },
  // MCP sign-ins and notifications stay the owner's until a person has their own (BRK-323, WEB-124).
  oauth: { role: 'owner', press: true, what: 'approve or revoke a sign-in' },
  push: { role: 'owner', press: true, what: 'change notifications' },

  // People (point 3, "Managing people"): the store checks which people and roles, on top.
  'people.manage': { role: 'maintainer', press: true, what: 'invite people or change who’s on the board' },
};

/**
 * A person's role in a repository: their grant there, or their `*` grant, whichever is higher. With no repository
 * (an install-wide action), only the `*` grant counts.
 * @param {{ repository: string, role: string }[] | undefined} grants
 * @param {string | null | undefined} repository
 * @returns {'viewer' | 'member' | 'maintainer' | null}
 */
export function roleIn(grants, repository) {
  let best = null;
  for (const g of grants ?? []) {
    if (g.repository !== EVERY_REPO && (!repository || g.repository !== repository)) continue;
    const rank = ROLE_RANK[/** @type {keyof typeof ROLE_RANK} */ (g.role)] ?? 0;
    if (rank > (best ? ROLE_RANK[best] : 0)) best = /** @type {'viewer' | 'member' | 'maintainer'} */ (g.role);
  }
  return best;
}

/**
 * @typedef {{ person: string, grants?: { repository: string, role: string }[] }} Person
 * @typedef {Person & { press?: boolean, agent?: string | null, for?: Person | null }} Actor
 * @typedef {{ code: 'unknown' | 'press' | 'agent' | 'owner' | 'role', message: string }} Refusal
 */

const article = (role) => (role === 'owner' ? 'the owner' : `a ${role}`);

/**
 * Why `person` can't, by role alone (null when they can).
 * @param {Person} person
 * @param {Rule} rule
 * @param {string | null} repository
 * @returns {Refusal | null}
 */
function roleRefusal(person, rule, repository) {
  if (person.person === OWNER) return null;
  if (rule.role === 'owner') return { code: 'owner', message: `only the owner can ${rule.what}` };
  const role = roleIn(person.grants, repository);
  if (role && ROLE_RANK[role] >= ROLE_RANK[rule.role]) return null;
  const where = repository ? ` in ${repository}` : ' on every repository';
  const is = role ? `${person.person} is a ${role}${where}` : `${person.person} has no role${where}`;
  return { code: 'role', message: `only ${article(rule.role)}${where} can ${rule.what}, and ${is}` };
}

/**
 * Why `actor` may not do `action` in `repository`, or null when they may.
 * @param {Actor} actor
 * @param {string} action
 * @param {string | null} [repository] null for an install-wide action
 * @returns {Refusal | null}
 */
export function refusal(actor, action, repository = null) {
  const rule = ACTIONS[action];
  if (!rule) return { code: 'unknown', message: `nobody can ${action}: the board has no such action` };
  if (rule.press && actor.press === false)
    return { code: 'press', message: `only the signed-in web board can ${rule.what}` };
  if (actor.agent && !rule.agents)
    return { code: 'agent', message: `agents never ${rule.what}, whoever started them: a person does, on the board` };
  const own = roleRefusal(actor, rule, repository);
  if (own) return own;
  // An agent never has more rights than the person its run is for.
  if (actor.agent && actor.for) {
    const theirs = roleRefusal(actor.for, rule, repository);
    if (theirs) return { code: 'role', message: `${actor.agent} acts for ${actor.for.person}, and ${theirs.message}` };
  }
  return null;
}

/**
 * Whether `actor` may do `action` in `repository` (null: install-wide). The one check every gate calls.
 * @param {Actor} actor
 * @param {string} action
 * @param {string | null} [repository]
 */
export function can(actor, action, repository = null) {
  return refusal(actor, action, repository) === null;
}

/**
 * The words a person sees for a start that doesn't run on their own Claude yet (BRK-302 opened Start, fixing a pull
 * request, and fixing an alert). TODO(BRK-334): a chase, Start next, general, review, and routine-making agents, carry
 * on, describe, and move run on the starter's Claude too, and this goes.
 */
export const OTHER_STARTS =
  'agents you start run on your own Claude routine, and this kind of start doesn’t yet (BRK-334): ask the owner to start it';

/** The starts a person makes on their own Claude, or on a routine the owner lends them (BRK-302). */
export const PERSON_STARTS = new Set(['agent.start', 'agent.force']);

/** The owner, behind the board's token (`press: false`) or its cookie (`press: true`). */
export const ownerActor = (press) => ({ person: OWNER, grants: [], press });

/** Whether `by` names an agent for this actor: not empty, not `owner`, and not the person's own handle. */
export function agentOf(by, person = OWNER) {
  const name = typeof by === 'string' ? by.trim() : by === undefined || by === null ? '' : String(by);
  if (!name || name === OWNER || name === person) return null;
  return name;
}
