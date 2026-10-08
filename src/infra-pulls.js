/**
 * Plans from pull requests (docs/specs/IDEA-19-architect.md, "Change"; BRK-185), the pure part. A pull request that
 * changes a desired-state or policy file in `.github/breakaway-infra/` gets the plan each changed environment would
 * make, with its policy results and cost change, as one check on its head commit, and the board's pull request page
 * shows the same. Merging applies nothing: the plan made from the default branch waits for the owner.
 *
 * This file says which files a pull request touches, how the check concludes, and what it says. Pure and Node-safe:
 * no store and no network.
 */
import { DESIRED_DIR, environmentOfFile } from './infra-desired.js';
import { money, POLICY_FILE } from './infra-policy.js';

/** The check's name on the pull request. */
export const INFRA_CHECK_NAME = 'breakaway: infrastructure plan';

/** At most this many pull requests are planned in one sync; the rest wait for the next. */
export const MAX_PULLS_PER_SYNC = 3;

/** At most this many environments are planned for one pull request. */
export const MAX_ENVIRONMENTS_PER_PULL = 5;

/** GitHub keeps a check's summary to 65,535 characters. */
const SUMMARY_MAX = 60_000;

/** How many changes the check lists for one environment before it says how many more there are. */
const CHANGES_LISTED = 30;

/**
 * What a pull request's files change in the desired-state folder: the environments whose file it adds, changes, or
 * removes (a rename counts for both names), and whether it changes the policy. Files in folders below it, and files
 * the folder skips (not JSON, or reserved like scaling.json), don't count.
 * @param {Array<{ filename: string, previous_filename?: string, status?: string }>} files GitHub's list
 * @returns {{ touched: boolean, policy: boolean, environments: Array<{ environment: string, path: string, removed: boolean }>, problems: Array<{ path: string, message: string }> }}
 */
export function infraFilesIn(files) {
  /** @type {Map<string, { environment: string, path: string, removed: boolean }>} */
  const environments = new Map();
  /** @type {Array<{ path: string, message: string }>} */
  const problems = [];
  let policy = false;
  const see = (path, removed) => {
    if (!path?.startsWith(`${DESIRED_DIR}/`)) return;
    const name = path.slice(DESIRED_DIR.length + 1);
    if (name.includes('/')) return;
    if (name === POLICY_FILE) {
      policy = true;
      return;
    }
    const of = environmentOfFile(name);
    if (of === null) return;
    if ('problem' in of) {
      if (!removed) problems.push({ path, message: of.problem });
      return;
    }
    const had = environments.get(of.environment);
    environments.set(of.environment, {
      environment: of.environment,
      path: had && !had.removed ? had.path : path,
      removed: removed && (had?.removed ?? true),
    });
  };
  for (const f of files ?? []) {
    see(f.filename, f.status === 'removed');
    // A renamed file's old name is gone from that environment.
    if (f.previous_filename && f.previous_filename !== f.filename) see(f.previous_filename, true);
  }
  return {
    touched: policy || environments.size > 0 || problems.length > 0,
    policy,
    environments: [...environments.values()].sort((a, b) => a.environment.localeCompare(b.environment)),
    problems,
  };
}

/**
 * One environment's part of the check:
 * - `planned`: the file checks and the provider planned it (`preview`, the same shape as `npx breakaway infra check`'s);
 * - `invalid`: the file doesn't check (`error`);
 * - `to-add`: no environment has the file's name: the owner adds it on the board, or the file is renamed;
 * - `refused`: the environment is observe only, so it takes no desired state;
 * - `removed`: the pull request removes the file: the board stops comparing it, and changes nothing there;
 * - `failed`: the provider couldn't plan it (`problem` says why).
 * @typedef {object} EnvironmentCheck
 * @property {string} environment
 * @property {number | null} environmentId
 * @property {string} path
 * @property {'planned' | 'invalid' | 'to-add' | 'refused' | 'removed' | 'failed'} state
 * @property {string | null} problem
 * @property {import('./infra-desired.js').DesiredError | null} error
 * @property {Record<string, any> | null} preview
 * @property {{ name: string, from: 'change' | 'desired', label?: string } | null} [target] the target an environment
 *   with none is planned with (BRK-298): its change's, or the one of the provider's target kind (`label`, a Worker)
 *   its file makes
 */

/**
 * @typedef {object} PullCheck
 * @property {EnvironmentCheck[]} environments
 * @property {{ path: string, ok: boolean, error: import('./infra-desired.js').DesiredError | null,
 *   lines?: import('./infra-policy-changes.js').PolicyLine[] | null } | null} policy
 *   the policy file, when the pull request changes it, with what it loosens and tightens when it checks (WEB-123)
 * @property {Array<{ path: string, message: string }>} problems files no environment could have
 * @property {number} skipped environments past MAX_ENVIRONMENTS_PER_PULL, not planned
 * @property {string | null} [runner] what the apply workflow still needs before Approve (BRK-307): a waiting note,
 *   never a failure
 */

/** Whether one environment's part fails the check: a file that doesn't check, or a plan the policy refuses. */
const fails = (/** @type {EnvironmentCheck} */ e) =>
  e.state === 'invalid' || e.state === 'refused' || e.preview?.policy?.outcome === 'refused';

/**
 * How the check concludes: `failure` when a file doesn't check, an environment is observe only, or the policy refuses
 * a plan; `neutral` when something couldn't be planned (an environment to add, or the provider didn't answer);
 * otherwise `success`, even when a plan will wait for the owner: that's the default, and merging applies nothing.
 * @param {PullCheck} check
 * @returns {'success' | 'neutral' | 'failure'}
 */
export function infraConclusion(check) {
  if (check.problems.length || (check.policy && !check.policy.ok) || check.environments.some(fails)) return 'failure';
  if (check.environments.some((e) => e.state === 'to-add' || e.state === 'failed') || check.skipped) return 'neutral';
  return 'success';
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const names = (list) =>
  list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`;

/** What one plan does to the cost, in words. */
export function costWords(cost) {
  if (!cost || cost.delta === null || cost.delta === undefined) return 'cost change not known';
  if (cost.delta === 0) return cost.complete ? 'no cost change' : 'no known cost change';
  const words = `${cost.delta > 0 ? 'adds' : 'saves'} ${money(Math.abs(cost.delta), cost.currency)} a month`;
  return cost.complete ? words : `${words}, and some of it isn’t known`;
}

/** What the policy says about a plan, in words: what happens once it's planned from the default branch. */
export function policyWords(policy) {
  if (!policy) return null;
  const which = policy.policy === 'repository' ? 'the repository’s policy' : 'the default policy';
  if (policy.outcome === 'refused') return `Refused by ${which}.`;
  if (policy.outcome === 'allowed') return `Let through by ${which}’s rule “${policy.rule}”.`;
  return `Waits for you, by ${which}.`;
}

/** Which target an environment with none was planned with (BRK-298). */
export const targetWords = (/** @type {EnvironmentCheck} */ e) =>
  e.target?.from === 'change'
    ? `${e.environment} has no target yet: planned with ${e.target.name}, the target its change gives it.`
    : `${e.environment} has no target yet: planned with ${e.target?.name}, the one ${e.target?.label ?? 'target'} its file makes.`;

/** One environment's line in the title. */
function shortLine(/** @type {EnvironmentCheck} */ e) {
  if (e.state === 'invalid') return `${e.path} doesn’t check`;
  if (e.state === 'refused') return `${e.environment} is observe only`;
  if (e.state === 'to-add') return `${e.environment} isn’t on the board yet`;
  if (e.state === 'failed') return `${e.environment} couldn’t be planned`;
  if (e.state === 'removed') return `${e.environment}’s file is removed`;
  if (e.preview?.policy?.outcome === 'refused') return `the policy refuses ${e.environment}’s plan`;
  return null;
}

/**
 * The check's title: what's wrong first, else what the plans change.
 * @param {PullCheck} check
 */
export function infraTitle(check) {
  const first = check.problems[0];
  if (first) return `${first.path} isn’t an environment’s file`;
  if (check.policy && !check.policy.ok) return `${check.policy.path} doesn’t check`;
  const wrong = check.environments.filter(fails).map(shortLine).filter(Boolean);
  if (wrong.length) return upper(wrong[0]) + (wrong.length > 1 ? `, and ${plural(wrong.length - 1, 'more')}` : '');
  const planned = check.environments.filter((e) => e.state === 'planned');
  const changes = planned.reduce((n, e) => n + (e.preview?.changes ?? 0), 0);
  const open = check.environments.filter((e) => e.state === 'to-add' || e.state === 'failed').map(shortLine);
  if (open.length) return upper(open[0]);
  const removed = check.environments.filter((e) => e.state === 'removed').map((e) => e.environment);
  if (!planned.length && removed.length)
    return `No plan: ${names(removed)} ${removed.length === 1 ? 'loses its' : 'lose their'} desired state`;
  if (!planned.length) return 'No plan: the pull request changes no environment’s desired state';
  if (!changes) return `No changes: ${names(planned.map((e) => e.environment))} already match`;
  return `${plural(changes, 'change')} to ${names(planned.filter((e) => e.preview?.changes).map((e) => e.environment))}`;
}

const upper = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const cell = (v) =>
  String(v ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');

/** One environment's section of the summary. */
function section(/** @type {EnvironmentCheck} */ e) {
  const lines = [`### ${e.environment}`, ''];
  if (e.state === 'invalid') {
    const at = e.error?.line ? ` on line ${e.error.line}` : '';
    const field = e.error?.field ? `\`${e.error.field}\`: ` : '';
    lines.push(`\`${e.path}\` doesn’t check${at}. ${field}${e.error?.message ?? ''}`);
    return lines;
  }
  if (e.state !== 'planned') {
    lines.push(e.problem ?? '');
    return lines;
  }
  const p = e.preview ?? {};
  if (e.target) lines.push(targetWords(e), '');
  if (!p.changes) {
    lines.push(`Nothing to change: ${e.environment} already matches \`${e.path}\`.`);
    return lines;
  }
  const facts = [
    plural(p.changes, 'change'),
    costWords(p.cost),
    p.reversible ? 'can be undone' : 'can’t all be undone',
  ];
  if (p.blastRadius?.affected) facts.push(`touches ${plural(p.blastRadius.affected, 'other resource')}`);
  lines.push(upper(facts.join(' · ')), '', '| Change | Name | Kind |', '| --- | --- | --- |');
  for (const c of (p.diff?.changes ?? []).slice(0, CHANGES_LISTED))
    lines.push(`| ${cell(c.op)} | ${cell(c.name)} | ${cell(c.kind)} |`);
  if (p.changes > CHANGES_LISTED) lines.push('', `And ${plural(p.changes - CHANGES_LISTED, 'more change')}.`);
  for (const i of p.irreversible ?? []) lines.push('', `Can’t be undone: ${i.op} \`${cell(i.name)}\`. ${i.why}`.trim());
  if (p.policy) {
    lines.push('', `**Policy:** ${policyWords(p.policy)}`);
    for (const reason of p.policy.reasons ?? []) lines.push(`- ${reason}`);
  }
  return lines;
}

/**
 * One environment's section for a pull request from outside the repository (BRK-253): what happened, never what the
 * environment holds. The resource names, the blast radius, and the provider's words stay on the board's page, so a
 * fork can't push `{ resources: [] }` to read every resource in scope, or a provider's refusal, off a public check.
 */
function brief(/** @type {EnvironmentCheck} */ e) {
  const lines = [`### ${e.environment}`, ''];
  if (e.state === 'planned')
    lines.push(e.preview?.changes ? `${upper(plural(e.preview.changes, 'change'))}.` : 'Nothing to change.');
  else lines.push(`${upper(shortLine(e) ?? `${e.environment} wasn’t planned`)}.`);
  const policy = e.preview?.policy ? policyWords(e.preview.policy) : null;
  if (policy) lines.push('', `**Policy:** ${policy}`);
  return lines;
}

/**
 * The check's summary, in Markdown: each environment's plan and policy, then what merging does. For a pull request
 * from outside the repository (`outside`, a fork's), each environment's section is brief: the check is public.
 * @param {PullCheck} check
 * @param {{ page?: string | null, outside?: boolean }} [links] the board's page for the pull request, when the board
 *   has an address
 */
export function infraSummary(check, { page = null, outside = false } = {}) {
  const lines = [];
  if (outside)
    lines.push(
      'This pull request comes from outside the repository, so the plan’s detail (what it changes, and what the provider said) is only on the board.',
      '',
    );
  for (const p of check.problems) lines.push(`\`${p.path}\`: ${p.message}`, '');
  if (check.policy && !check.policy.ok) {
    const e = check.policy.error;
    lines.push(
      `\`${check.policy.path}\` doesn’t check${e?.line ? ` on line ${e.line}` : ''}. ${e?.field ? `\`${e.field}\`: ` : ''}${e?.message ?? ''}`,
      'Until it’s fixed, the default policy decides.',
      '',
    );
  }
  if (check.policy?.ok && check.policy.lines) {
    const loosens = check.policy.lines.filter((l) => l.effect === 'loosens');
    const tightens = check.policy.lines.filter((l) => l.effect === 'tightens');
    if (loosens.length)
      lines.push(
        '**Loosens your policy.** These will no longer wait for you:',
        ...loosens.map((l) => `- ${l.line}`),
        '',
      );
    if (tightens.length) lines.push('**Tightens your policy:**', ...tightens.map((l) => `- ${l.line}`), '');
    if (!loosens.length && !tightens.length)
      lines.push(`\`${check.policy.path}\` changes how it’s written, not what waits for you.`, '');
  }
  for (const e of check.environments) lines.push(...(outside ? brief(e) : section(e)), '');
  if (check.skipped)
    lines.push(`${plural(check.skipped, 'more environment')} not planned: split the pull request to see them.`, '');
  if (check.runner) lines.push(`**Before Approve:** ${check.runner}`, '');
  lines.push(
    '---',
    'Merging applies nothing. Once it’s merged, the board plans from the default branch, and the plan waits for you on the board unless the policy lets it through.',
  );
  if (page) lines.push('', `[See it on the board](${page})`);
  const text = lines.join('\n');
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text;
}
