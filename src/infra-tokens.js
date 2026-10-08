/**
 * Guided token setup (BRK-304; docs/specs/IDEA-19-architect.md, "Tokens"): the checklist that walks an owner through
 * the board's read token and each environment's write token, from Connections and from Kickoff. Pure: what GitHub's
 * answers about one GitHub environment mean, as steps that are done, missing, or can't be checked, each with what to
 * do. The reads are in store-infra-tokens.js.
 *
 * The board never asks for, sees, or keeps a write token. It says which permissions the token needs (the provider's
 * `writeToken`), checks the GitHub environment exists and lets only the default branch deploy (deployBranchProblem,
 * BRK-250), and checks a secret of the right name is there: GitHub lists environment secrets by name only, never
 * their values.
 */
import { deployBranchProblem } from './infra-runs.js';

/** The checklist's steps for one GitHub environment, in order. */
export const ENVIRONMENT_STEPS = ['environment', 'branch', 'secret'];

/**
 * One step: `ok` true when done, false when missing, null when the board couldn't check it (`fix` says why).
 * @typedef {{ id: string, label: string, ok: boolean | null, fix: string | null }} SetupStep
 */

/** Where a repository's GitHub environments are, on GitHub. */
export const environmentsUrl = (github) => `https://github.com/${github}/settings/environments`;

/**
 * Whether the App may make a GitHub environment and its branch rule: GitHub asks for Administration write for both
 * ("Create or update an environment", "Create a deployment branch policy"). The board needs it for nothing else, so
 * it's never one of Connections' needed permissions: without it, the owner follows the steps by hand.
 * @param {Record<string, string> | null | undefined} permissions the installation's
 */
export const canMakeEnvironments = (permissions) => ['write', 'admin'].includes(String(permissions?.administration));

/** The steps to make GitHub environment `name` by hand, with only `branch` allowed to deploy. */
export function environmentByHand(github, name, branch) {
  return `On GitHub, ${github} → Settings → Environments → New environment, name it ${name}; under Deployment branches and tags choose Selected branches and tags and add only ${branch}`;
}

/** The steps to add the write token as a secret of GitHub environment `name`. */
export function secretByHand(github, name, secret) {
  return `On GitHub, ${github} → Settings → Environments → ${name} → Add environment secret: name it ${secret} and paste the write token there, never on the board`;
}

/**
 * A read GitHub refused, in words: a 403 names the App permission it needs.
 * @param {{ status: number, reason?: string | null, message?: string }} error
 * @param {string} what
 * @param {string} permission the App permission the read needs, as GitHub's settings page names it
 */
export function refusedRead(error, what, permission) {
  if (error.status === 403)
    return `GitHub refused to show ${what}: give the board’s GitHub App ${permission} (Settings → Developer settings → GitHub Apps → Permissions & events), then accept it on the installation`;
  return `GitHub answered ${error.status} for ${what}: ${error.reason ?? error.message ?? 'try again'}`;
}

/**
 * The steps for one GitHub environment, from what GitHub said.
 * @param {object} input
 * @param {string} input.github the repository, `owner/name`
 * @param {string} input.name the GitHub environment
 * @param {string} input.branch the default branch
 * @param {string} input.secret the secret the write token goes in
 * @param {any} input.environment GitHub's answer for the environment, null when there's none
 * @param {Array<{ name?: string, type?: string }> | null} [input.policies] its selected branches, when it has them
 * @param {string[] | null} [input.secrets] its secrets' names, null when they couldn't be read
 * @param {{ environment?: string, policies?: string, secrets?: string }} [input.problems] reads that failed, in words
 * @returns {SetupStep[]}
 */
export function environmentSteps({
  github,
  name,
  branch,
  secret,
  environment,
  policies = null,
  secrets = null,
  problems = {},
}) {
  const unknown = (id, label, why) => ({ id, label, ok: null, fix: why });
  const made = { id: 'environment', label: `GitHub environment ${name}` };
  const rule = { id: 'branch', label: `Only ${branch} deploys to it` };
  const kept = { id: 'secret', label: `Its secret ${secret}` };
  if (problems.environment)
    return [
      unknown(made.id, made.label, problems.environment),
      unknown(rule.id, rule.label, 'checked once the environment can be read'),
      unknown(kept.id, kept.label, 'checked once the environment can be read'),
    ];
  if (!environment)
    return [
      { ...made, ok: false, fix: environmentByHand(github, name, branch) },
      { ...rule, ok: false, fix: `comes with the environment: allow only ${branch}` },
      { ...kept, ok: false, fix: secretByHand(github, name, secret) },
    ];
  const branchProblem = problems.policies ?? deployBranchProblem(name, branch, environment, policies);
  const has = secrets ? secrets.includes(secret) : null;
  return [
    { ...made, ok: true, fix: null },
    problems.policies
      ? unknown(rule.id, rule.label, problems.policies)
      : { ...rule, ok: !branchProblem, fix: branchProblem ? capital(branchProblem) : null },
    problems.secrets
      ? unknown(kept.id, kept.label, problems.secrets)
      : { ...kept, ok: has, fix: has ? null : secretByHand(github, name, secret) },
  ];
}

const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * What the board may change on an existing GitHub environment to fix its branch rule: only add the default branch
 * when the rule already names chosen branches and lacks it. It never turns a rule on, off, or over, never removes a
 * branch, and never touches reviewers, wait timers, or secrets; anything else is the owner's, by hand.
 * @param {any} environment GitHub's answer
 * @param {Array<{ name?: string, type?: string }> | null} policies
 * @param {string} branch
 * @returns {'none' | 'add-branch' | 'by-hand'}
 */
export function branchRuleFix(environment, policies, branch) {
  const rule = environment?.deployment_branch_policy;
  if (!rule || rule.protected_branches || !rule.custom_branch_policies) return 'by-hand';
  const list = policies ?? [];
  if (list.some((p) => p.name === branch && (p.type ?? 'branch') === 'branch'))
    return list.length === 1 ? 'none' : 'by-hand';
  return list.length ? 'by-hand' : 'add-branch';
}

/** Whether every step of a checklist is done. */
export const stepsDone = (steps) => steps.every((s) => s.ok === true);
