/**
 * /mcp for a person's own token (BRK-327, docs/specs/BRK-299-people-and-roles.md, point 2): the same tools, with the
 * same gates as the API's routes. The MCP tools call the store directly, so a person's calls go through `personStore`,
 * which stands where the store would:
 *
 *   a read     asks the store what it's about first, as personRoute does with src/reads.js: one in a repository the
 *              person has no grant in is a 404, as if it weren't there, and the install's own reads are the owner's
 *              and the `*` grant's. Its answer comes back with what's in other repositories taken out.
 *   a write    on something in a repository they have no grant in is a 404, as a read of it is; otherwise it asks
 *              permitApi with the person as the actor and the agent the request names as `by`, as the API's gate does,
 *              then carries the person to the store, so the write names them. Its answer is filtered too.
 *
 * A store method that isn't here is refused: deny by default, like the API's guarded store (src/people.js). The
 * owner's /mcp never comes through here.
 */
import { NOT_FOR_PEOPLE } from './people.js';
import { isHidden, lostTarget, scrub, writeReads } from './reads.js';

/**
 * @typedef {import('./reads.js').Read} Read
 * @typedef {{ read: Read, args?: any[] }} ReadCall         a read, and the arguments the store gets (the person added)
 * @typedef {{ write: string, target: Record<string, any>, args: any[] }} WriteCall   an action on a target
 * @typedef {{ board: true }} BoardCall                       the board's own follow-up to a call already let through
 * @typedef {ReadCall | WriteCall | BoardCall} Call
 */

/** `?repo=`-shaped: the repository the tool works in, which the MCP tools always name. */
const inRepo = (repo, absent = /** @type {'default' | 'all' | 'install'} */ ('default')) => ({
  repo: repo ? String(repo) : null,
  absent,
});

/**
 * What each store call the MCP server makes is, for a person: the read src/reads.js would see for its API route, or
 * the action the route's gate asks. `actor` is `{ person, press: false }`: a bearer token is never a press, and the
 * store's write methods take it where the API's routes hand it over.
 * @type {Record<string, (actor: { person: string, press: false }, agent: string, ...args: any[]) => Call>}
 */
const CALLS = {
  // Reads, as GET /api/… names them.
  health: () => ({ read: { install: true } }),
  reposApi: () => ({ read: { list: true } }),
  list: () => ({ read: { list: true } }),
  get: (_a, _g, ref) => ({ read: { target: { task: ref } } }),
  footprintApi: (_a, _g, ref) => ({ read: { target: { task: ref } } }),
  messagesWaitingApi: (_a, _g, ref) => ({ read: { target: { task: ref } } }),
  // Whether an agent may change a task it doesn't hold: a read about that task.
  crossTaskRightsApi: (_a, _g, _agent, ref) => ({ read: { target: { task: ref } } }),
  pelotonApi: () => ({ read: { list: true } }),
  specsApi: (_a, _g, slug) => ({ read: inRepo(slug) }),
  specApi: (_a, _g, slug) => ({ read: inRepo(slug) }),
  githubPullApi: (_a, _g, _number, slug) => ({ read: inRepo(slug) }),
  routinePromptApi: (_a, _g, slug) => ({ read: inRepo(slug) }),
  agentCoreApi: (_a, _g, slug) => ({ read: inRepo(slug) }),
  // A feature counts only the tasks the person sees (BRK-323): the store takes them as its reader.
  featuresApi: (actor) => ({ read: { list: true }, args: [{ person: actor.person }] }),
  featureApi: (actor, _g, slug) => ({ read: { target: { feature: slug } }, args: [slug, { person: actor.person }] }),
  // Architect's reads (src/mcp-infra.js), as GET /api/infra/… names them.
  environmentsApi: (_a, _g, q) => ({ read: inRepo(q?.repo, 'all') }),
  environmentApi: (_a, _g, ref, q) => ({ read: { target: { environment: ref, repo: q?.repo ?? null } } }),
  desiredOneApi: (_a, _g, name, q) => ({ read: { target: { environment: name, repo: q?.repo ?? null } } }),
  inventoryApi: (_a, _g, q) => ({
    read: q?.environment ? { target: { environment: q.environment, repo: q.repo ?? null } } : inRepo(q?.repo, 'all'),
  }),
  plansApi: (_a, _g, q) => ({
    read: q?.environment ? { target: { environment: q.environment, repo: q.repo ?? null } } : inRepo(q?.repo, 'all'),
  }),
  planApi: (_a, _g, n) => ({ read: { target: { plan: n } } }),
  incidentsApi: (_a, _g, q) => ({
    read: q?.environment ? { target: { environment: q.environment, repo: q.repo ?? null } } : inRepo(q?.repo, 'all'),
  }),
  infraSignalsApi: (_a, _g, q) => ({ read: signalsRead(q) }),
  infraSignalDaysApi: (_a, _g, q) => ({ read: signalsRead(q) }),

  // Writes, with the gate their API route asks (src/worker.js). No MCP tool forces, starts by itself, or changes a
  // horizon-* tag, so none of them needs task.plan.
  next: (actor, _g, input) => ({
    write: input?.claim ? 'task.write' : 'read',
    target: { repo: input?.repo },
    args: [{ ...input, actor }],
  }),
  claim: (actor, _g, ref, agent, force, repo) => ({
    write: 'task.write',
    target: { task: ref },
    args: [ref, agent, force, repo, actor],
  }),
  release: (actor, _g, ref, agent, force) => ({
    write: 'task.write',
    target: { task: ref },
    args: [ref, agent, force, actor],
  }),
  comment: (actor, _g, ref, text, by) => ({ write: 'task.write', target: { task: ref }, args: [ref, text, by, actor] }),
  quoteOwner: (actor, _g, ref, quote, press) => ({
    write: 'task.write',
    target: { task: ref },
    args: [ref, { ...quote, actor }, press],
  }),
  create: (actor, _g, items, options) => ({
    write: 'task.write',
    target: { repos: (items ?? []).map((item) => item?.repo) },
    args: [items, { ...options, actor }],
  }),
  update: (actor, _g, ref, changes) => ({
    write: 'task.write',
    target: { task: ref },
    args: [ref, { ...changes, actor }],
  }),
  pingCreate: (actor, _g, ref, ping) => ({
    write: 'task.write',
    target: { task: ref },
    args: [ref, { ...ping, actor }],
  }),
  taskReviewApi: (actor, _g, ref, review) => ({
    write: 'task.write',
    target: { task: ref },
    args: [ref, { ...review, actor }],
  }),
  pelotonPostApi: (actor, _g, peloton, post) => ({
    write: 'task.write',
    target: { peloton },
    args: [peloton, { ...post, actor }],
  }),
  // The push for a ping pingCreate just made, after the answer, as the API's route sends it.
  pushPing: () => ({ board: true }),
};

/** Signals by environment, as GET /api/infra/signals reads them; the MCP tool always names one or its repository. */
function signalsRead(q) {
  const environment = q?.environmentId ?? q?.environment;
  return environment ? { target: { environment, repo: q?.repo ?? null } } : inRepo(q?.repo, 'all');
}

/**
 * The store, for a person's MCP calls: every call gated and filtered as the API gates and filters the same route.
 * @param {any} store the install's TaskStore stub
 * @param {{ handle: string }} person who the personal token is
 * @param {string} agent the agent the request names (X-Breakaway-Agent), which every MCP write is by
 */
export function personStore(store, person, agent) {
  const actor = /** @type {{ person: string, press: false }} */ ({ person: person.handle, press: false });
  /** What the person can't see, read once per request: a write changes no grant. */
  let hidden;
  const hiddenFor = async (read) => {
    const gate = await store.readGateApi({ person: person.handle }, read);
    if (gate.status !== 200) return { refused: gate };
    hidden ??= { repos: new Set(gate.body.hidden.repos), tasks: new Set(gate.body.hidden.tasks) };
    return { hidden };
  };
  return new Proxy(
    {},
    {
      get(_, name) {
        const rule = CALLS[/** @type {string} */ (name)];
        if (!rule) return async () => ({ status: 403, body: { error: NOT_FOR_PEOPLE } });
        return async (/** @type {any[]} */ ...args) => {
          const call = rule(actor, agent, ...args);
          if ('board' in call) return store[name](...args);
          if ('write' in call) {
            // A write on something they can't read isn't there, as a read of it isn't: the role's refusal would name
            // the repository it's in. Its reads are the API gate's (BRK-337), so both answer alike.
            for (const read of writeReads(call.target)) {
              const seen = await hiddenFor(read);
              if (seen.refused) return seen.refused;
            }
            const permit = await store.permitApi(actor, call.write, { ...call.target, by: agent, agent });
            if (permit.status !== 200) return permit;
            const shown = hidden ?? (await hiddenFor(null)).hidden;
            return filtered(await store[name](...call.args), shown, null);
          }
          const seen = await hiddenFor(call.read);
          if (seen.refused) return seen.refused;
          return filtered(await store[name](...(call.args ?? args)), seen.hidden, call.read);
        };
      },
    },
  );
}

/**
 * A store answer with what the person can't see taken out, as personRoute filters the API's: a read whose answer is
 * itself about something hidden, or that lost what it asked about to the scrub, is a 404.
 * @param {{ status: number, body: any }} result
 * @param {{ repos: Set<string>, tasks: Set<string> }} hidden
 * @param {Read | null} read
 */
function filtered(result, hidden, read) {
  const { status, body } = result;
  if (!body || typeof body !== 'object') return result;
  const gone = { status: 404, body: { error: read && 'single' in read ? read.single : 'not found' } };
  if (status < 300 && read && isHidden(body, hidden)) return gone;
  const shown = scrub(body, hidden);
  if (status < 300 && read && ('target' in read || 'single' in read) && lostTarget(body, shown)) return gone;
  if (status >= 400 && typeof body.error === 'string' && typeof shown?.error !== 'string')
    shown.error = 'that didn’t work';
  return { ...result, body: shown };
}
