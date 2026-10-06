/**
 * `npx breakaway infra`'s reads (CLI-13, docs/specs/IDEA-19-architect.md, "CLI"): the environments, one environment's
 * inventory and drift, plans, signals, and incidents, as text or JSON, from the board's API.
 *
 * Read only: every request is a GET, so an agent's token reads Architect and never changes it. Approving, rejecting,
 * freezing, and changing an environment are the owner's, on the board. The requests go through `get`, which the CLI
 * gives (and the tests mock), and which answers `{ ok, status, data }` for any answer.
 */
import { sentAt } from './session-messages.js';

/** The reads `infra` takes; `infra` alone is `infra environments`. */
export const INFRA_READS = ['environments', 'show', 'plans', 'plan', 'signals', 'incidents'];

/** What a plan's state reads as (brand/README.md, "Infrastructure words"). */
export const PLAN_STATE_LABELS = {
  draft: 'Draft',
  waiting: 'Waiting for you',
  approved: 'Approved',
  rejected: 'Rejected',
  applying: 'Applying',
  applied: 'Applied',
  failed: 'Failed',
  'rolled back': 'Rolled back',
};

const DESIRED_LABELS = {
  valid: 'valid',
  invalid: 'can’t be read',
  'to-add': 'no environment for it',
  refused: 'not used: observe only',
};

const POLICY_LABELS = {
  allowed: 'allowed',
  'needs-owner': 'it waits for you',
  refused: 'refused',
};

const SOURCE_LABELS = {
  'pull-request': 'a pull request',
  drift: 'drift',
  envelope: 'an envelope',
  incident: 'an incident',
  deploy: 'the deploy flow',
};

/** A read `infra` can't do, with what to do instead. */
export class InfraReadError extends Error {}
const bad = (message) => {
  throw new InfraReadError(message);
};

const enc = encodeURIComponent;
const query = (fields) => {
  const q = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${enc(String(v))}`)
    .join('&');
  return q ? `?${q}` : '';
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A board from before a route answers 404 with "no route for …". */
const noRoute = (res) => res.status === 404 && /^no route for/u.test(String(res.data?.error ?? ''));

/**
 * The answer's data, or an InfraReadError that says what failed: `what` names what an older board doesn't have yet.
 * @param {{ ok: boolean, status: number, data: any }} res
 * @param {string} what
 */
function answer(res, what) {
  if (res.ok) return res.data;
  if (noRoute(res))
    bad(`this board doesn’t have ${what} yet: its owner updates it to a release that does, then try again.`);
  if (res.status === 0) bad(`can’t reach the board (${res.data?.error ?? 'no answer'}).`);
  return bad(res.data?.error ?? `HTTP ${res.status}`);
}

/**
 * An amount a month, as the brand writes it: "$4.60 a month", a fall with a minus sign.
 * @param {number | null | undefined} amount
 * @param {string | null | undefined} currency
 */
export function money(amount, currency) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  let text;
  try {
    text = new Intl.NumberFormat('en', { style: 'currency', currency: currency || 'USD' }).format(Math.abs(amount));
  } catch {
    text = `${Math.abs(amount).toFixed(2)} ${currency}`;
  }
  return `${amount < 0 ? '−' : ''}${text} a month`;
}

/** One value in a change's settings, short. */
const short = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text === undefined ? '–' : text.length > 60 ? `${text.slice(0, 59)}…` : text;
};

// ---- environments ------------------------------------------------------------------------

/** One environment in the list: its name, kind, provider and target, and what's worth knowing now. */
export function environmentLine(env, { withRepo = false } = {}) {
  const bits = [env.kind, env.provider ?? 'no provider', env.target].filter(Boolean);
  const notes = [];
  if (env.frozen) notes.push('frozen');
  if (env.observeOnly) notes.push(env.runsTheBoard ? 'observe only: runs this board' : 'observe only');
  if (typeof env.driftCount === 'number' && env.driftCount > 0) notes.push(`drift: ${env.driftCount}`);
  if (env.waitingPlan) notes.push(`${env.waitingPlan} waits for you`);
  if (env.task?.wid) notes.push(`for ${env.task.wid}`);
  const name = withRepo ? `${env.repo}/${env.name}` : env.name;
  return `${name.padEnd(withRepo ? 28 : 14)}  ${bits.join(' · ')}${notes.length ? `  (${notes.join('; ')})` : ''}`;
}

/** `infra` and `infra environments`: the repository's environments, or every one when the board doesn't know it. */
export function environmentsText({ environments }, repo) {
  if (!environments.length)
    return repo
      ? `No environments in ${repo} yet. The owner adds one on the board’s Infrastructure view.`
      : 'No environments yet. The owner adds one on the board’s Infrastructure view.';
  return [
    ...environments.map((env) => environmentLine(env, { withRepo: !repo })),
    '',
    'One environment: npx breakaway infra show <environment>',
  ].join('\n');
}

// ---- one environment ---------------------------------------------------------------------

/** What a resource's health and cost read as, in a few words. */
function resourceState(r) {
  const bits = [];
  if (r.health) bits.push(`${r.health.state}${r.health.text ? `: ${r.health.text}` : ''}`);
  const cost = r.cost ? money(r.cost.amount, r.cost.currency) : null;
  if (cost) bits.push(`${cost}, estimated`);
  return bits.join(' · ');
}

/**
 * The drift lines (BRK-184): the count, the resources that differ with what a plan would do to each, and the plan that
 * covers it. A board from before drift sends no count, which reads like one that hasn't compared yet.
 */
function driftLines(env) {
  const drift = env.drift ?? null;
  const checked = drift?.checked ? `, checked ${sentAt(drift.checked)}` : '';
  if (drift?.error) return [`  Drift       couldn’t compare: ${drift.error}`];
  if (typeof env.driftCount !== 'number') return ['  Drift       not compared yet'];
  if (!env.driftCount) return [`  Drift       none: what runs matches the repository${checked}`];
  const out = [
    `  Drift       ${plural(env.driftCount, 'resource differs', 'resources differ')} from the repository${checked}`,
  ];
  for (const r of drift?.resources ?? []) out.push(`              ${r.op ? `${r.op} ` : ''}${r.kind} ${r.name}`);
  if (drift?.plan)
    out.push(
      `              ${drift.planMatches === false ? `${drift.plan} no longer matches it` : `${drift.plan} puts it back`}: npx breakaway infra plan ${drift.plan}`,
    );
  return out;
}

/**
 * `infra show <environment>`: the environment, its desired state and drift, and its inventory with what each resource
 * uses.
 * @param {{ environment: any, resources: any[], relations: any[], desired: any | null }} data
 */
export function environmentText({ environment: env, resources, relations, desired }) {
  const out = [`${env.name} · ${env.repo}`, ''];
  const row = (k, v) => v && out.push(`  ${k.padEnd(11)} ${v}`);
  row('Kind', env.kind);
  row('Provider', env.provider ?? 'none yet: the owner picks one on the board');
  row('Target', env.target);
  if (env.task) row('Task', `${env.task.wid ?? env.task.uuid} · ${env.task.description}`);
  row('Frozen', env.frozen ? `yes${env.frozenAt ? `, since ${sentAt(env.frozenAt)}` : ''}` : 'no');
  if (env.observeOnly)
    out.push(
      `  Observe only: the board watches it and never changes it${env.runsTheBoard ? ', because it runs this board' : ''}.`,
    );
  if (env.waitingPlan) row('Plan', `${env.waitingPlan} waits for you: npx breakaway infra plan ${env.waitingPlan}`);
  if (desired) {
    const problem = desired.problem ?? desired.error?.message;
    row(
      'Desired',
      `${desired.path}${desired.sha ? ` at ${String(desired.sha).slice(0, 7)}` : ''}: ${DESIRED_LABELS[desired.state] ?? desired.state}${problem ? `, ${problem}` : ''}`,
    );
  } else if (!env.observeOnly) {
    row('Desired', `none yet: add .github/breakaway-infra/${env.name}.json to the default branch by pull request`);
  }
  if (!env.observeOnly) out.push(...driftLines(env));
  out.push('');
  if (!resources.length) {
    out.push(
      env.provider
        ? 'No resources yet: the board reads them from the provider on its next refresh.'
        : 'No resources: connect a provider and give the environment a target on the board.',
    );
    return out.join('\n');
  }
  const names = new Map(resources.map((r) => [r.id, `${r.kind} ${r.name}`]));
  out.push(`Resources (${resources.length})`);
  for (const r of resources) {
    const state = resourceState(r);
    out.push(state ? `  ${`${r.kind} ${r.name}`.padEnd(32)}  ${state}` : `  ${r.kind} ${r.name}`);
    for (const rel of relations.filter((x) => x.from === r.id))
      out.push(`    uses ${names.get(rel.to) ?? rel.to} (${rel.kind})`);
  }
  return out.join('\n');
}

// ---- plans -------------------------------------------------------------------------------

/** What a plan changes the monthly cost by, in a few words, or null when it isn't known. */
function costWords(cost) {
  if (!cost || typeof cost.delta !== 'number') return null;
  if (cost.delta === 0) return 'no change in cost';
  const amount = money(Math.abs(cost.delta), cost.currency);
  return `${cost.delta > 0 ? 'adds' : 'saves'} ${amount}`;
}

/** Where a plan came from: "a pull request (#12)". */
function sourceWords(source) {
  if (!source) return null;
  const label = SOURCE_LABELS[source.kind] ?? source.kind;
  if (!source.ref) return label;
  return `${label} (${source.kind === 'pull-request' ? `#${source.ref}` : source.ref})`;
}

/** One plan in the list. */
export function planLine(plan, { withRepo = false } = {}) {
  const where = withRepo ? `${plan.repo}/${plan.environment.name}` : plan.environment.name;
  const bits = [plural(plan.changes, 'change')];
  const cost = costWords(plan.cost);
  if (cost) bits.push(cost);
  if (!plan.reversible) bits.push('can’t be undone');
  const from = sourceWords(plan.source);
  if (from) bits.push(`from ${from}`);
  return `${plan.id.padEnd(9)} ${(PLAN_STATE_LABELS[plan.state] ?? plan.state).padEnd(15)}  ${where.padEnd(withRepo ? 24 : 12)}  ${bits.join(' · ')}  ${sentAt(plan.created)}`;
}

/**
 * `infra plans`: newest first, with how to see older ones.
 * @param {{ plans: any[], more: boolean }} data
 * @param {string | null} repo
 * @param {{ state?: string }} [filter]
 */
export function plansText({ plans, more }, repo, { state } = {}) {
  if (!plans.length)
    return state
      ? `No plans ${(PLAN_STATE_LABELS[state] ?? state).toLowerCase()}${repo ? ` in ${repo}` : ''}.`
      : `No plans${repo ? ` in ${repo}` : ''} yet. A plan comes from a pull request that changes an environment’s desired state, from drift, or from an envelope.`;
  const out = plans.map((p) => planLine(p, { withRepo: !repo }));
  out.push('', 'One plan: npx breakaway infra plan <id>');
  if (more) out.push(`Older: npx breakaway infra plans --before ${plans[plans.length - 1].id}`);
  return out.join('\n');
}

/** A change's settings, key by key: what it sets, or what it changes from and to. */
function changeLines(change) {
  const before = change.before ?? {};
  const after = change.after ?? {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const out = [];
  for (const key of keys) {
    const was = JSON.stringify(before[key]);
    const now = JSON.stringify(after[key]);
    if (change.op === 'create') out.push(`      ${key}: ${short(after[key])}`);
    else if (change.op === 'update' && was !== now)
      out.push(`      ${key}: ${short(before[key])} → ${key in after ? short(after[key]) : '(removed)'}`);
  }
  return out;
}

/**
 * `infra plan <id>`: what it changes, what it costs, what else it touches, and whether it can be undone. A preview
 * (`infra check`, CLI-14) has no ID or state: it's what a plan would hold, kept nowhere.
 * @param {{ plan: any }} data
 */
export function planText({ plan }) {
  const out = [
    plan.id
      ? `${plan.id} · ${PLAN_STATE_LABELS[plan.state] ?? plan.state} · ${plan.environment.name} · ${plan.repo}`
      : `${plan.environment.name} · ${plan.repo} · the plan it would make, a preview the board doesn’t keep`,
    '',
  ];
  const row = (k, v) => v && out.push(`  ${k.padEnd(11)} ${v}`);
  row('From', sourceWords(plan.source));
  row('Made by', plan.agent ? `${plan.agent} (an agent)` : plan.by === 'owner' ? 'you' : plan.by);
  row('Provider', [plan.provider, plan.target].filter(Boolean).join(', '));
  row('Desired', plan.desiredSha ? `at ${String(plan.desiredSha).slice(0, 7)}` : null);
  row('Made', sentAt(plan.created));
  if (plan.updated && plan.updated !== plan.created) row('Updated', sentAt(plan.updated));

  const cost = plan.cost;
  if (cost) {
    const words = costWords(cost) ?? 'not known';
    const span =
      typeof cost.now === 'number' && typeof cost.after === 'number'
        ? `: ${money(cost.now, cost.currency)} → ${money(cost.after, cost.currency)}`
        : '';
    const unknown = cost.unknown?.length ? ` (not known for ${cost.unknown.join(', ')})` : '';
    row('Cost', `${words}${span}, estimated${unknown}`);
  }
  row(
    'Undo',
    plan.reversible
      ? 'it can be undone'
      : `can’t be undone: ${plan.irreversible.map((c) => `${c.op} ${c.name}${c.why ? ` (${c.why})` : ''}`).join('; ')}`,
  );

  // The policy's answer (BRK-181), one reason a line; a board from before policy sends none.
  if (plan.policy) {
    row('Policy', POLICY_LABELS[plan.policy.outcome] ?? plan.policy.outcome);
    for (const reason of plan.policy.reasons ?? []) out.push(`              ${reason}`);
  }

  const changes = plan.diff?.changes ?? [];
  out.push('', `What changes (${plan.changes})`);
  if (!changes.length) out.push('  Nothing: what runs already matches the desired state.');
  for (const c of changes) {
    out.push(`  ${c.op.padEnd(8)} ${c.kind} ${c.name}${c.reversible ? '' : '  (can’t be undone)'}`);
    out.push(...changeLines(c));
  }

  const blast = plan.blastRadius;
  if (blast) {
    out.push('', 'What else it touches');
    const all = blast.resources ?? [];
    const named = (id) => all.find((r) => r.id === id)?.name ?? id;
    const leaning = all.filter((r) => !r.changed);
    if (!leaning.length) out.push('  Nothing else leans on what it changes.');
    for (const r of leaning)
      out.push(
        `  ${r.kind ?? 'resource'} ${r.name ?? r.id}${r.leansOn ? `, through ${r.leansOn.relation} to ${named(r.leansOn.id)}` : ''}`,
      );
    for (const d of blast.deletesInUse ?? [])
      out.push(
        `  It deletes ${d.name}, and ${d.by.map(named).join(', ')} still ${d.by.length === 1 ? 'uses' : 'use'} it.`,
      );
  }
  return out.join('\n');
}

// ---- signals -----------------------------------------------------------------------------

/** One signal: when, how loud, what kind, where, and what it said. */
export function signalLine(s) {
  const where = [s.environment, s.resource].filter(Boolean).join(' · ');
  const value = s.value === null || s.value === undefined ? '' : ` (${s.value})`;
  return `${sentAt(s.at)}  ${s.level.padEnd(8)}  ${s.kind.padEnd(6)}  ${where}  ${s.text}${value}`;
}

/**
 * `infra signals`: newest first.
 * @param {{ signals: any[], more: boolean }} data
 * @param {{ environment?: string }} [filter]
 */
export function signalsText({ signals, more }, { environment } = {}) {
  if (!signals.length)
    return `No signals${environment ? ` for ${environment}` : ''} yet. The board hears them from each environment’s provider: its health, its alerts, and its cost.`;
  const out = signals.map(signalLine);
  if (more) out.push('', `Older: npx breakaway infra signals --before ${signals[signals.length - 1].id}`);
  return out.join('\n');
}

/** `infra signals --days`: one line a day for each environment, resource, and kind. */
export function signalDaysText({ days }) {
  if (!days.length) return 'No daily summaries yet: the board folds signals older than a week into them.';
  return days
    .map((d) => {
      const levels = ['critical', 'warning', 'info']
        .filter((l) => d[l])
        .map((l) => `${d[l]} ${l}`)
        .join(', ');
      const where = [d.environment, d.resource].filter(Boolean).join(' · ');
      return `${d.day}  ${d.kind.padEnd(6)}  ${where}  ${plural(d.count, 'signal')}${levels ? ` (${levels})` : ''}  last: ${d.text}`;
    })
    .join('\n');
}

// ---- incidents ---------------------------------------------------------------------------

/** One incident: its work ID, what broke, and who's on it. */
export function incidentLine(t) {
  const notes = [];
  if (t.claim) notes.push(`claimed by ${t.claim}`);
  if (t.status !== 'pending') notes.push(t.status);
  return `${String(t.wid ?? t.uuid.slice(0, 8)).padEnd(8)}  ${t.description}${notes.length ? `  (${notes.join('; ')})` : ''}`;
}

/** `infra incidents`: tasks tagged +incident. */
export function incidentsText(incidents, repo, { status = 'pending' } = {}) {
  if (!incidents.length)
    return `No ${status === 'pending' ? 'open ' : ''}incidents${repo ? ` in ${repo}` : ''}. A signal that crosses a rule opens one, as a task tagged +incident.`;
  return [...incidents.map(incidentLine), '', 'One incident: npx breakaway show <ID>'].join('\n');
}

// ---- the command -------------------------------------------------------------------------

/**
 * Runs one `infra` read.
 * @param {string[]} args what follows `infra`
 * @param {{ get: (path: string) => Promise<{ ok: boolean, status: number, data: any }>, repo: string | null,
 *   opts: Record<string, any>, inRepo?: (task: any) => boolean }} ctx
 * @returns {Promise<{ data: any, text: string }>}
 */
export async function infraRead(args, { get, repo, opts = {}, inRepo = () => true }) {
  const sub = args[0] ?? 'environments';
  const repoQuery = repo ?? undefined;

  if (sub === 'environments') {
    const data = answer(await get(`infra/environments${query({ repo: repoQuery })}`), 'environments');
    return { data, text: environmentsText(data, repo) };
  }

  if (sub === 'show') {
    const ref = args[1] ?? bad('infra show <environment>: name one, like production (npx breakaway infra lists them).');
    const { environment } = answer(
      await get(`infra/environments/${enc(ref)}${query({ repo: repoQuery })}`),
      'environments',
    );
    const scope = query({ repo: environment.repo, environment: environment.id });
    const inventory = await get(`infra/inventory${scope}`);
    // A board from before the inventory still shows the environment.
    const { resources = [], relations = [] } = noRoute(inventory) ? {} : answer(inventory, 'an inventory');
    const desiredRes = await get(`infra/desired/${enc(environment.name)}${query({ repo: environment.repo })}`);
    const desired = desiredRes.ok
      ? desiredRes.data.desired
      : desiredRes.status === 404
        ? null
        : answer(desiredRes, 'desired states');
    const data = { environment, resources, relations, desired };
    return { data, text: environmentText(data) };
  }

  if (sub === 'plans') {
    const path = `infra/plans${query({
      repo: repoQuery,
      environment: opts.environment,
      state: opts.state,
      before: opts.before,
      limit: opts.limit,
    })}`;
    const data = answer(await get(path), 'plans');
    return { data, text: plansText(data, repo, { state: opts.state }) };
  }

  if (sub === 'plan') {
    const ref = args[1] ?? bad('infra plan <id>: name one, like plan-12 (npx breakaway infra plans lists them).');
    const data = answer(await get(`infra/plans/${enc(ref)}`), 'plans');
    return { data, text: planText(data) };
  }

  if (sub === 'signals') {
    // An environment's name is only unique within its repository, so name it by its ID once the board says which.
    let environmentId;
    let names = null;
    if (opts.environment) {
      const { environment } = answer(
        await get(`infra/environments/${enc(opts.environment)}${query({ repo: repoQuery })}`),
        'environments',
      );
      environmentId = environment.id;
    } else if (repo && !opts.all) {
      names = answer(await get(`infra/environments${query({ repo })}`), 'environments').environments;
    }
    const fields = { environmentId, resource: opts.resource, source: opts.source, kind: opts.kind };
    if (opts.days) {
      const data = answer(await get(`infra/signals/days${query(fields)}`), 'signals');
      if (names) data.days = data.days.filter((d) => ofRepo(d, names));
      return { data, text: signalDaysText(data) };
    }
    const data = answer(
      await get(`infra/signals${query({ ...fields, level: opts.level, before: opts.before, limit: opts.limit })}`),
      'signals',
    );
    if (names) data.signals = data.signals.filter((s) => ofRepo(s, names));
    return { data, text: signalsText(data, { environment: opts.environment }) };
  }

  if (sub === 'incidents') {
    const status = opts.status ?? 'pending';
    const { tasks } = answer(await get(`tasks${query({ status })}`), 'tasks');
    const incidents = tasks.filter((t) => (t.tags ?? []).includes('incident') && (opts.all || inRepo(t)));
    return { data: { incidents }, text: incidentsText(incidents, opts.all ? null : repo, { status }) };
  }

  return bad(
    `infra has no "${sub}"; it has ${['init', 'check', ...INFRA_READS].join(', ')}. npx breakaway help says what each does.`,
  );
}

/** Whether a signal or a day's summary is about one of these environments: by ID, or by name when it has none. */
function ofRepo(s, environments) {
  if (s.environmentId !== null && s.environmentId !== undefined)
    return environments.some((e) => e.id === s.environmentId);
  return environments.some((e) => e.name === s.environment);
}
