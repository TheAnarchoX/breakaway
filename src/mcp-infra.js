/**
 * Architect's reads on the MCP server (BRK-202, docs/specs/IDEA-19-architect.md, "CLI"): the same reads as
 * `npx breakaway infra` (CLI-13), as read-only tools, so an agent in any MCP client reads environments, inventory,
 * plans, signals, and incidents. There are no write tools: an agent proposes a change by pull request, and approving,
 * rejecting, freezing, and applying are never an agent's.
 *
 * Each tool calls the same TaskStore method as the GET route the CLI reads, and answers with short text and the API's
 * JSON as structuredContent. The tools are made by `infraTools`, which src/mcp.js calls with its own helpers, so a
 * refusal reads like every other tool's.
 */
import { PLAN_STATES } from './infra-plans.js';
import { SIGNAL_KINDS, SIGNAL_LEVELS } from './infra-provider.js';

/** The tools' names, in the order tools/list gives them. */
export const INFRA_TOOL_NAMES = [
  'infra_environments',
  'infra_environment',
  'infra_plans',
  'infra_plan',
  'infra_signals',
  'infra_incidents',
];

/** What a plan's state reads as to an agent (brand/README.md, "Infrastructure words"). */
const PLAN_STATE_WORDS = {
  draft: 'Draft',
  waiting: 'Waiting for the owner',
  approved: 'Approved',
  rejected: 'Rejected',
  applying: 'Applying',
  applied: 'Applied',
  failed: 'Failed',
  'rolled back': 'Rolled back',
};

const SOURCE_WORDS = {
  'pull-request': 'a pull request',
  drift: 'drift',
  envelope: 'an envelope',
  incident: 'an incident',
  deploy: 'the deploy flow',
};

/** At most this many plans or signals in one answer (the store's own most). */
const SHOWN_MAX = 200;

const ENVIRONMENT = {
  type: 'string',
  description: 'An environment of this repository, by its name (like production) or its ID',
  pattern: '^[a-z0-9][a-z0-9-]{0,39}$',
  maxLength: 40,
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const when = (at) => (at ? String(at).slice(0, 16).replace('T', ' ') : '');

/** An amount a month, as the brand writes it: "$4.60 a month", a fall with a minus sign. */
function money(amount, currency) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  let text;
  try {
    text = new Intl.NumberFormat('en', { style: 'currency', currency: currency || 'USD' }).format(Math.abs(amount));
  } catch {
    text = `${Math.abs(amount).toFixed(2)} ${currency}`;
  }
  return `${amount < 0 ? '−' : ''}${text} a month`;
}

function environmentLine(env) {
  const notes = [];
  if (env.frozen) notes.push('frozen');
  if (env.observeOnly) notes.push(env.runsTheBoard ? 'observe only: runs this board' : 'observe only');
  if (typeof env.driftCount === 'number' && env.driftCount > 0) notes.push(`drift: ${env.driftCount}`);
  if (env.waitingPlan) notes.push(`${env.waitingPlan} waits for the owner`);
  if (env.task?.wid) notes.push(`for ${env.task.wid}`);
  const bits = [env.kind, env.provider ?? 'no provider', env.target].filter(Boolean).join(' · ');
  return `${env.name} (${env.id}): ${bits}${notes.length ? `  (${notes.join('; ')})` : ''}`;
}

function environmentText({ environment: env, resources, relations, desired }) {
  const out = [`${env.name} · ${env.repo} · ${env.kind}`];
  out.push(`Provider: ${env.provider ?? 'none yet'}${env.target ? `, target ${env.target}` : ''}`);
  if (env.frozen) out.push(`Frozen${env.frozenAt ? ` since ${when(env.frozenAt)} UTC` : ''}: every plan is refused.`);
  if (env.observeOnly)
    out.push(
      `Observe only: the board watches it and never changes it${env.runsTheBoard ? ', because it runs this board' : ''}.`,
    );
  if (desired) {
    const problem = desired.problem ?? desired.error?.message;
    out.push(
      `Desired state: ${desired.path}${desired.sha ? ` at ${String(desired.sha).slice(0, 7)}` : ''}, ${desired.state}${problem ? `: ${problem}` : ''}`,
    );
  } else if (!env.observeOnly) {
    out.push(`Desired state: none yet. Propose .github/breakaway-infra/${env.name}.json by pull request.`);
  }
  if (!resources.length) {
    out.push(env.provider ? 'No resources yet.' : 'No resources: the environment has no provider or target yet.');
    return out.join('\n');
  }
  const names = new Map(resources.map((r) => [r.id, `${r.kind} ${r.name}`]));
  out.push('', `Resources (${resources.length})`);
  for (const r of resources) {
    const state = [];
    if (r.health) state.push(`${r.health.state}${r.health.text ? `: ${r.health.text}` : ''}`);
    const cost = r.cost ? money(r.cost.amount, r.cost.currency) : null;
    if (cost) state.push(`${cost}, estimated`);
    out.push(`  ${r.kind} ${r.name}${state.length ? `  ${state.join(' · ')}` : ''}`);
    for (const rel of relations.filter((x) => x.from === r.id))
      out.push(`    ${rel.kind} ${names.get(rel.to) ?? rel.to}`);
  }
  return out.join('\n');
}

function costWords(cost) {
  if (!cost || typeof cost.delta !== 'number') return null;
  if (cost.delta === 0) return 'no change in cost';
  return `${cost.delta > 0 ? 'adds' : 'saves'} ${money(Math.abs(cost.delta), cost.currency)}`;
}

function sourceWords(source) {
  if (!source) return null;
  const label = SOURCE_WORDS[source.kind] ?? source.kind;
  return source.ref ? `${label} (${source.ref})` : label;
}

function planLine(plan) {
  const bits = [plural(plan.changes, 'change')];
  const cost = costWords(plan.cost);
  if (cost) bits.push(cost);
  if (!plan.reversible) bits.push('can’t be undone');
  const from = sourceWords(plan.source);
  if (from) bits.push(`from ${from}`);
  return `${plan.id}  ${PLAN_STATE_WORDS[plan.state] ?? plan.state}  ${plan.environment.name}  ${bits.join(' · ')}  ${when(plan.created)}`;
}

function planText(plan) {
  const out = [`${plan.id} · ${PLAN_STATE_WORDS[plan.state] ?? plan.state} · ${plan.environment.name} · ${plan.repo}`];
  const from = sourceWords(plan.source);
  if (from) out.push(`From ${from}${plan.agent ? `, made by ${plan.agent}` : ''}.`);
  const cost = costWords(plan.cost);
  if (cost) out.push(`Cost: ${cost}, estimated.`);
  out.push(
    plan.reversible
      ? 'It can be undone.'
      : `It can’t be undone: ${(plan.irreversible ?? []).map((c) => `${c.op} ${c.name}${c.why ? ` (${c.why})` : ''}`).join('; ')}.`,
  );
  if (plan.policy) {
    out.push(`Policy: ${plan.policy.outcome}.`);
    for (const reason of plan.policy.reasons ?? []) out.push(`  ${reason}`);
  }
  const changes = plan.diff?.changes ?? [];
  out.push('', `What changes (${plan.changes})`);
  if (!changes.length) out.push('  Nothing: what runs already matches the desired state.');
  for (const c of changes) out.push(`  ${c.op} ${c.kind} ${c.name}${c.reversible ? '' : ' (can’t be undone)'}`);
  const leaning = (plan.blastRadius?.resources ?? []).filter((r) => !r.changed);
  if (plan.blastRadius) {
    out.push('', 'What else it touches');
    if (!leaning.length) out.push('  Nothing else leans on what it changes.');
    for (const r of leaning) out.push(`  ${r.kind ?? 'resource'} ${r.name ?? r.id}`);
  }
  return out.join('\n');
}

function signalLine(s) {
  const where = [s.environment, s.resource].filter(Boolean).join(' · ');
  const value = s.value === null || s.value === undefined ? '' : ` (${s.value})`;
  return `${when(s.at)}  ${s.level}  ${s.kind}  ${where}  ${s.text}${value}`;
}

function dayLine(d) {
  const levels = ['critical', 'warning', 'info']
    .filter((l) => d[l])
    .map((l) => `${d[l]} ${l}`)
    .join(', ');
  const where = [d.environment, d.resource].filter(Boolean).join(' · ');
  return `${d.day}  ${d.kind}  ${where}  ${plural(d.count, 'signal')}${levels ? ` (${levels})` : ''}  last: ${d.text}`;
}

/** Whether a signal or a day's summary is about one of these environments: by ID, or by name when it has none. */
function ofEnvironments(s, environments) {
  if (s.environmentId !== null && s.environmentId !== undefined)
    return environments.some((e) => e.id === s.environmentId);
  return environments.some((e) => e.name === s.environment);
}

/**
 * The tools, made with src/mcp.js's helpers: `input` builds a schema, `readOnly` is the read-only annotations,
 * `body` unwraps the store's answer (or throws the tool's error), `scoped` names the repository, and `fail` throws a
 * tool's error.
 * @param {{ input: (properties?: any, required?: string[]) => any, readOnly: any, body: (result: any) => any,
 *   scoped: (ctx: any) => Promise<{ slug: string, registry: any }>, fail: (message: string) => never }} helpers
 */
export function infraTools({ input, readOnly, body, scoped, fail }) {
  /** This repository's environment, by name or ID: another repository's is refused. */
  const environmentOf = async (ctx, ref) => {
    const { slug } = await scoped(ctx);
    const { environment } = body(await ctx.store.environmentApi(ref, { repo: slug }));
    // The store finds an environment by its ID in any repository.
    if (environment.repo !== slug) fail(`no environment ${ref} in ${slug}`);
    return environment;
  };

  return [
    {
      name: 'infra_environments',
      title: 'Environments',
      description:
        'This repository’s environments (Architect): each one’s kind, provider and target, and whether it’s frozen, observe only, drifted, or has a plan waiting for the owner. Read only.',
      inputSchema: input(),
      annotations: readOnly,
      async run(_args, ctx) {
        const { slug } = await scoped(ctx);
        const data = body(await ctx.store.environmentsApi({ repo: slug }));
        const text = data.environments.length
          ? data.environments.map(environmentLine).join('\n')
          : `No environments in ${slug} yet. The owner adds one on the board’s Infrastructure view.`;
        return { text, data: { repo: slug, ...data } };
      },
    },
    {
      name: 'infra_environment',
      title: 'An environment',
      description:
        'One environment in full: its desired state, and its inventory (each resource with its health, its estimated cost, and what it uses). Settings are redacted; the board keeps no secret values. Read only.',
      inputSchema: input({ environment: ENVIRONMENT }, ['environment']),
      annotations: readOnly,
      async run(args, ctx) {
        const environment = await environmentOf(ctx, args.environment);
        const { resources, relations } = body(
          await ctx.store.inventoryApi({ repo: environment.repo, environment: String(environment.id) }),
        );
        const found = await ctx.store.desiredOneApi(environment.name, { repo: environment.repo });
        const desired = found.status === 404 ? null : body(found).desired;
        const data = { environment, resources, relations, desired };
        return { text: environmentText(data), data };
      },
    },
    {
      name: 'infra_plans',
      title: 'Plans',
      description:
        'This repository’s plans, newest first: each one’s state, environment, how many changes, the cost change, whether it can be undone, and where it came from. Read only: approving is the owner’s, on the board.',
      inputSchema: input({
        environment: { ...ENVIRONMENT, description: 'Only this environment’s plans' },
        state: { type: 'string', enum: PLAN_STATES, description: 'Only plans in this state' },
        before: {
          type: 'string',
          pattern: '^(plan-)?\\d{1,15}$',
          description: 'Older than this plan, like plan-40, to read further back',
        },
        limit: { type: 'integer', minimum: 1, maximum: SHOWN_MAX, description: 'At most this many (50 by default)' },
      }),
      annotations: readOnly,
      async run(args, ctx) {
        const { slug } = await scoped(ctx);
        const data = body(
          await ctx.store.plansApi({
            repo: slug,
            environment: args.environment,
            state: args.state,
            before: args.before,
            limit: args.limit,
          }),
        );
        const text = data.plans.length
          ? [
              ...data.plans.map(planLine),
              ...(data.more ? [`Older: call again with before ${data.plans[data.plans.length - 1].id}.`] : []),
            ].join('\n')
          : `No plans${args.state ? ` ${PLAN_STATE_WORDS[args.state].toLowerCase()}` : ''} in ${slug}${args.environment ? ` for ${args.environment}` : ''} yet.`;
        return { text, data: { repo: slug, ...data } };
      },
    },
    {
      name: 'infra_plan',
      title: 'A plan',
      description:
        'One plan in full: what it changes, the cost change, the blast radius, whether it can be undone, and the policy’s answer. Read only: approving is the owner’s, on the board, and the board applies.',
      inputSchema: input(
        { plan: { type: 'string', pattern: '^(plan-)?\\d{1,15}$', description: 'The plan’s ID, like plan-12' } },
        ['plan'],
      ),
      annotations: readOnly,
      async run(args, ctx) {
        const { slug } = await scoped(ctx);
        const { plan } = body(await ctx.store.planApi(args.plan));
        // The same lens as the lists: a plan of another repository on the board isn't this one's to read.
        if (plan.repo !== slug) fail(`no plan ${args.plan} in ${slug}`);
        return { text: planText(plan), data: { plan } };
      },
    },
    {
      name: 'infra_signals',
      title: 'Signals',
      description:
        'The signal stream for this repository’s environments, newest first: health, the platform’s alerts, and cost, redacted. Raw signals are kept a week; days gives the daily summaries, kept 90 days. Read only.',
      inputSchema: input({
        environment: { ...ENVIRONMENT, description: 'Only this environment’s signals' },
        resource: { type: 'string', maxLength: 200, description: 'Only this resource’s, by its ID' },
        kind: { type: 'string', enum: SIGNAL_KINDS, description: 'Only this kind' },
        level: { type: 'string', enum: SIGNAL_LEVELS, description: 'Only this level (not with days)' },
        source: { type: 'string', maxLength: 64, description: 'Only from this source, like a provider’s ID' },
        days: { type: 'boolean', description: 'The daily summaries instead of the raw signals' },
        before: { type: 'integer', minimum: 1, description: 'Older than this signal’s ID, to read further back' },
        limit: { type: 'integer', minimum: 1, maximum: SHOWN_MAX, description: 'At most this many (50 by default)' },
      }),
      annotations: readOnly,
      async run(args, ctx) {
        const { slug } = await scoped(ctx);
        // An environment's name is only unique within its repository, so the stream is read by the environment's ID.
        const environments = args.environment
          ? [await environmentOf(ctx, args.environment)]
          : body(await ctx.store.environmentsApi({ repo: slug })).environments;
        const fields = {
          environmentId: args.environment ? String(environments[0].id) : undefined,
          resource: args.resource,
          source: args.source,
          kind: args.kind,
        };
        if (args.days) {
          if (args.level || args.before || args.limit) fail('days takes no level, before, or limit');
          const { days } = body(await ctx.store.infraSignalDaysApi(fields));
          const kept = days.filter((d) => ofEnvironments(d, environments));
          const text = kept.length ? kept.map(dayLine).join('\n') : 'No daily summaries yet.';
          return { text, data: { repo: slug, days: kept } };
        }
        const { signals, more } = body(
          await ctx.store.infraSignalsApi({
            ...fields,
            level: args.level,
            before: args.before === undefined ? undefined : String(args.before),
            limit: args.limit === undefined ? undefined : String(args.limit),
          }),
        );
        const kept = signals.filter((s) => ofEnvironments(s, environments));
        const text = kept.length
          ? [
              ...kept.map(signalLine),
              ...(more ? [`Older: call again with before ${signals[signals.length - 1].id}.`] : []),
            ].join('\n')
          : `No signals${args.environment ? ` for ${args.environment}` : ` in ${slug}`} yet.`;
        return { text, data: { repo: slug, signals: kept, more } };
      },
    },
    {
      name: 'infra_incidents',
      title: 'Incidents',
      description:
        'This repository’s incidents: tasks tagged +incident, the open ones, or the finished ones with closed. show_task reads one in full. Read only.',
      inputSchema: input({
        closed: { type: 'boolean', description: 'The finished incidents instead of the open ones' },
      }),
      annotations: readOnly,
      async run(args, ctx) {
        const { slug, registry } = await scoped(ctx);
        const { tasks } = body(await ctx.store.list(args.closed ? 'completed' : 'pending'));
        const incidents = tasks.filter(
          (t) => (t.repo || registry.default) === slug && (t.tags ?? []).includes('incident'),
        );
        const text = incidents.length
          ? incidents
              .map(
                (t) =>
                  `${t.wid ?? String(t.uuid).slice(0, 8)}  ${t.description}${t.claim ? `  (claimed by ${t.claim})` : ''}`,
              )
              .join('\n')
          : `No ${args.closed ? 'finished' : 'open'} incidents in ${slug}.`;
        return { text, data: { repo: slug, closed: Boolean(args.closed), incidents } };
      },
    },
  ];
}
