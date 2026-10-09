/**
 * What a person reads (BRK-323, docs/specs/BRK-299-people-and-roles.md, point 3, "What a person sees"): only the
 * repositories they have a grant in. Two halves, both pure, so the Worker, the store, and the tests share them:
 *
 *   readOf(parts, query)   what a GET route is about: a task, a plan, an environment, … (asked of the store, which
 *                          answers 404 when it's in a repository the person can't read, as if it weren't there), a
 *                          repository named in `?repo=`, the whole install (the owner's, or the `*` grant's), or a list
 *                          the scrub filters. A route that isn't here is refused: deny by default.
 *   scrub(value, hidden)   every answer a person gets, read or write, with whatever belongs to a repository they can't
 *                          read taken out: list items, map keys, task links (depends, blocking, related), and the
 *                          repositories' own names.
 *
 * The owner never comes through here: their reads are unchanged.
 */

/**
 * @typedef {{ target: Record<string, any> }} Targeted      about one thing: the store finds its repository
 * @typedef {{ repo: string | null, absent: 'default' | 'all' | 'install' }} ByRepo
 *   about `?repo=`; without one, the default repository's, every repository's (filtered), or the whole install's
 * @typedef {{ install: true }} Install                      about the whole install: the owner or the `*` grant
 * @typedef {{ list: true }} List                            every repository's things, filtered
 * @typedef {{ single: string }} Single  one thing whose repository its answer says: a 404 with these words when the
 *                                       scrub takes it out
 * @typedef {Targeted | ByRepo | Install | List | Single} Read
 */

const install = /** @type {Install} */ ({ install: true });
const list = /** @type {List} */ ({ list: true });

/**
 * What a person's GET is about, or null when it's no route a person reads.
 * @param {string[]} parts the path after /api/, decoded
 * @param {URLSearchParams} q
 * @returns {Read | null}
 */
export function readOf(parts, q) {
  const [a, b, c] = parts;
  const n = parts.length;
  const repo = q.get('repo') || null;
  /** @type {(absent: ByRepo['absent']) => ByRepo} */
  const byRepo = (absent) => ({ repo, absent });
  const environment = (name) => ({ target: { environment: name, repo } });

  switch (a) {
    // The install's own state, its connections, its updates, its notifications, and MCP sign-ins.
    case 'health':
    case 'connections':
    case 'self-update':
    case 'push':
    case 'oauth':
    case 'kickoffs':
      return install;
    case 'activity':
    case 'pings':
    case 'routines':
      return n === 1 ? list : null;
    case 'tasks':
      if (n === 1) return list;
      // The task's own reads: itself, its messages, its footprint, risky-path reviews, its session, and images.
      return { target: { task: b } };
    case 'attachments':
      return n === 2 ? { target: { attachment: b } } : null;
    case 'footprints':
      return n === 1 ? byRepo('all') : null;
    // Counts over every repository say how much is in the ones a person can't see, so a person names one.
    case 'stats':
      return n === 1 ? byRepo('install') : null;
    case 'repos':
      if (n === 1) return list;
      if (b === 'setup') return install;
      return n === 2 ? { target: { repo: b } } : null;
    case 'features':
      if (n === 1) return list;
      if (n === 2 || (n === 4 && c === 'digests')) return { target: { feature: b } };
      return null;
    case 'specs':
      return byRepo('default');
    case 'peloton':
      if (n === 1) return list;
      // An agent's listening and its open posts: every room it rides, filtered.
      if (n === 2 && (b === 'listen' || b === 'open') && q.has('agent')) return list;
      if (n === 2 || (n === 3 && c === 'plan')) return { target: { peloton: b } };
      return null;
    case 'agents':
      if (n === 1) return list;
      if (b === 'prompt' && n === 2) return byRepo('default');
      return null;
    case 'people':
      return n === 1 ? list : null;
    case 'github':
      if (n === 1) return byRepo('default');
      if (b === 'pulls' || b === 'workflows' || b === 'packages') return byRepo('default');
      return null;
    case 'infra':
      return infraReadOf(parts, q, byRepo, environment);
    default:
      return null;
  }

  /**
   * Architect's reads: an environment's by its name or ID, the rest by `?repo=`. The audit of every environment, the
   * providers' account-wide alerts, and when the inventory was last refreshed are the install's.
   */
  function infraReadOf(parts, q, byRepo, environment) {
    const [, b, c] = parts;
    const n = parts.length;
    switch (b) {
      case 'environments':
        if (n === 2) return byRepo('all');
        return n <= 4 ? environment(c) : null;
      case 'desired':
      case 'drift':
      case 'locks':
      case 'envelopes':
        if (n === 2) return byRepo('all');
        return n === 3 ? environment(c) : null;
      case 'changes':
        if (n === 2) return byRepo('default');
        return n === 3 ? { target: { change: c } } : null;
      case 'plans':
        if (n === 2) return q.get('environment') ? environment(q.get('environment')) : byRepo('all');
        return n === 3 ? { target: { plan: c } } : null;
      case 'policy':
        return n === 2 || (n === 3 && c === 'view') ? byRepo('default') : null;
      case 'tokens':
        return n === 2 ? byRepo('default') : null;
      case 'scaling':
      case 'cleanup':
      case 'break-glass':
      case 'short-lived':
      case 'inventory':
      case 'runs':
      case 'incidents':
      case 'signals':
        if (n === 3 && b === 'inventory' && c === 'refresh') return install;
        if (n === 3 && b === 'runs') return { target: { plan: String(c).replace(/^plan-/u, '') } };
        if (n === 3 && b === 'incidents') return { single: `no incident ${String(c).slice(0, 40)}` };
        if (q.get('environment')) return environment(q.get('environment'));
        if (q.get('environmentId')) return environment(q.get('environmentId'));
        return byRepo('all');
      // What it costs adds up every environment: a person names a repository.
      case 'costs':
        if (q.get('environment')) return environment(q.get('environment'));
        return byRepo('install');
      case 'audit':
        if (q.get('environmentId')) return environment(q.get('environmentId'));
        if (q.get('environment')) return environment(q.get('environment'));
        if (q.get('plan')) return { target: { plan: q.get('plan') } };
        return byRepo('install');
      case 'runbooks':
        return n === 2 ? list : null;
      case 'currency':
        // The board's currency: what costs are shown in, for anyone who sees a cost.
        return n === 2 ? list : null;
      case 'account-alerts':
      case 'alerts':
        return install;
      default:
        return null;
    }
  }
}

/**
 * What a person can't see: the repositories they have no grant in (their slugs and GitHub names) and those
 * repositories' tasks (their UUIDs and work IDs).
 * @typedef {{ repos: Set<string>, tasks: Set<string> }} Hidden
 */

/** Keys whose value names a repository: a slug or a GitHub `owner/name` (a repository's peloton is its slug). */
const REPO_KEYS = new Set(['repo', 'repository', 'repoSlug', 'slug', 'github', 'fullName', 'full_name', 'peloton']);
/** Keys whose value names a task: its UUID or its work ID. */
const TASK_KEYS = new Set(['uuid', 'task', 'taskUuid', 'wid', 'idea', 'ref', 'owner_task', 'ownerTask']);

/**
 * Whether `item` belongs to something hidden: a repository, by any key that names one, or a task, by any key that
 * names one. A string is hidden when it is one of those names.
 * @param {unknown} item
 * @param {Hidden} hidden
 */
export function isHidden(item, hidden) {
  if (typeof item === 'string') return hidden.repos.has(item) || hidden.tasks.has(item);
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  for (const [key, value] of Object.entries(item)) {
    if (!REPO_KEYS.has(key) && !TASK_KEYS.has(key)) continue;
    // What it's about can be an object of its own: an Activity event's task.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (isHidden(value, hidden)) return true;
      continue;
    }
    if (typeof value !== 'string') continue;
    if (REPO_KEYS.has(key) && hidden.repos.has(value)) return true;
    if (TASK_KEYS.has(key) && hidden.tasks.has(value)) return true;
  }
  return false;
}

/** A work ID in the board's own words ("it waits for GAD-1"). */
const WID_IN_TEXT = /\b[A-Z]+-\d+\b/gu;
/** What a hidden task's work ID becomes in the board's words. */
export const UNSEEN_TASK = 'a task you can’t see';

/**
 * `value` with everything hidden taken out: an array loses its hidden items, an object its keys named for something
 * hidden, and a hidden object or name that isn't in an array becomes null. A string that names a hidden GitHub
 * repository in a URL or a reference (`acme/gadgets#12`) becomes null too, and a hidden task's work ID in the board's
 * own words becomes "a task you can’t see". New values; `value` is untouched.
 * @param {unknown} value
 * @param {Hidden} hidden
 * @returns {any}
 */
export function scrub(value, hidden) {
  if (!hidden.repos.size && !hidden.tasks.size) return value;
  const names = [...hidden.repos].filter((name) => name.includes('/'));
  const mentions = (text) => names.some((name) => text.includes(`${name}/`) || text.includes(`${name}#`));
  const words = (text) => text.replace(WID_IN_TEXT, (wid) => (hidden.tasks.has(wid) ? UNSEEN_TASK : wid));
  const walk = (v) => {
    if (typeof v === 'string') return mentions(v) || isHidden(v, hidden) ? null : words(v);
    if (!v || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.filter((item) => !isHidden(item, hidden) && !isMention(item)).map(walk);
    /** @type {Record<string, any>} */
    const out = {};
    for (const [key, item] of Object.entries(v)) {
      if (hidden.repos.has(key) || hidden.tasks.has(key)) continue;
      out[key] = isHidden(item, hidden) && typeof item === 'object' ? null : walk(item);
    }
    return out;
  };
  const isMention = (item) => typeof item === 'string' && mentions(item);
  return walk(value);
}

/**
 * Whether the answer to a read about one thing lost that thing to the scrub: its top-level object came back null.
 * Then the person gets a 404, as if it weren't there.
 * @param {any} before
 * @param {any} after
 */
export function lostTarget(before, after) {
  if (!before || typeof before !== 'object' || Array.isArray(before)) return false;
  return Object.keys(before).some(
    (key) => before[key] && typeof before[key] === 'object' && !Array.isArray(before[key]) && after?.[key] === null,
  );
}
