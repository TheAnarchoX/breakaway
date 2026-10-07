/**
 * Cloudflare's GraphQL analytics, for Architect's first provider (docs/specs/IDEA-19-architect.md, "First provider:
 * Cloudflare"; BRK-193 for cost, BRK-191 for health). It reads with the board's read-only token (Account Analytics
 * Read), through `ctx.fetch` so tests mock it, and asks one query per dataset for the whole environment, never one per
 * resource: GraphQL allows 300 queries per 5 minutes on top of the API's own limit. It stops on a 429 rather than
 * retrying, since Cloudflare then refuses every call for five minutes.
 *
 * `analyticsQuery` sends one query; `readDataset` reads one dataset's rows for some resources over a window and adds
 * them up per resource; COST_DATASETS and HEALTH_DATASETS are the datasets cost and health read. Pure apart from
 * `fetch`, so the CLI can import it.
 */

/** @typedef {import('./infra-provider.js').ProviderContext} ProviderContext */

export const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
const PERMISSION = 'Account Analytics Read';

/** An answer the analytics refused: `status` is Cloudflare's, or 400 for an error it gave about the query. */
export class AnalyticsError extends Error {
  /** @param {string} message @param {number} status @param {string} [permission] the permission a 403 needs */
  constructor(message, status, permission) {
    super(message);
    this.status = status;
    if (permission) this.permission = permission;
  }
}

/**
 * Sends one query to the analytics and answers its `data`, or throws an AnalyticsError: a 429 (stop for five
 * minutes), a 403 naming Account Analytics Read, a 502 when Cloudflare can't be reached, and a 400 with what
 * Cloudflare said when it answered the query with errors. A POST, but only of a `query`: the analytics schema has no
 * mutations, and this refuses one anyway.
 * @param {ProviderContext} ctx
 * @param {string} query
 * @param {Record<string, unknown>} variables
 */
export async function analyticsQuery(ctx, query, variables) {
  if (!/^\s*query\b/u.test(query) || /\bmutation\b/u.test(query))
    throw new Error('the Cloudflare analytics are only read: that isn’t a query');
  if (!ctx.token) throw new AnalyticsError('no read-only token: connect Cloudflare on Connections', 401);
  const doFetch = ctx.fetch ?? fetch;
  let res;
  try {
    res = await doFetch(GRAPHQL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ctx.token}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (error) {
    throw new AnalyticsError(`couldn’t reach Cloudflare (${String(error?.message ?? error).slice(0, 100)})`, 502);
  }
  if (res.status === 429)
    throw new AnalyticsError(
      'Cloudflare’s rate limit was reached, so reading the analytics stopped: it refuses every call for 5 minutes, then try again',
      429,
    );
  const json = await res.json().catch(() => null);
  if (res.status === 403) {
    // What Cloudflare said too, since a refusal isn't always the permission the board guesses (BRK-254).
    const first = Array.isArray(json?.errors) ? json.errors[0] : null;
    const said = first
      ? [first.code, first.message]
          .filter((x) => x != null && x !== '')
          .join(': ')
          .slice(0, 200)
      : '';
    throw new AnalyticsError(
      `Cloudflare refused the analytics: the token needs ${PERMISSION}${said ? ` (Cloudflare said ${said})` : ''}`,
      403,
      PERMISSION,
    );
  }
  if (!res.ok) throw new AnalyticsError(`Cloudflare answered ${res.status} to the analytics`, res.status);
  const errors = Array.isArray(json?.errors) ? json.errors : [];
  if (errors.length) {
    const said = errors
      .map((e) => e?.message)
      .filter(Boolean)
      .join('; ')
      .slice(0, 200);
    throw new AnalyticsError(`Cloudflare’s analytics said: ${said || 'the query failed'}`, 400);
  }
  ctx.reached?.add(PERMISSION);
  return json?.data ?? null;
}

/**
 * One analytics dataset: its GraphQL name, the dimension that names a resource in it, the time field it filters on,
 * the fields it sums, takes the most of, or averages over the window, and an optional second dimension (`by`) its sums
 * are split by. `kind` and `label` are for whoever reads it: the resource kind it's about, and what it measures, in
 * words.
 * @typedef {object} Dataset
 * @property {string} dataset
 * @property {string} key
 * @property {'date' | 'datetime'} time
 * @property {string[]} [sum]
 * @property {string[]} [max]
 * @property {string[]} [avg] averaged by Cloudflare per row; read at the worst row's (the highest)
 * @property {string} [by]
 * @property {string} kind
 * @property {string} label
 */

/**
 * The query for one dataset: its rows over the window for the resources named in `$keys`, grouped by the resource
 * (and `by`, when it has one).
 * @param {Dataset} d
 */
export function datasetQuery(d) {
  const type = d.time === 'date' ? 'Date' : 'Time';
  const fields = [
    d.sum ? `sum { ${d.sum.join(' ')} }` : '',
    d.max ? `max { ${d.max.join(' ')} }` : '',
    d.avg ? `avg { ${d.avg.join(' ')} }` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const dims = [d.key, d.by].filter(Boolean).join(' ');
  return `query Usage($account: string!, $from: ${type}!, $to: ${type}!, $keys: [string!]) { viewer { accounts(filter: { accountTag: $account }) { rows: ${d.dataset}(limit: 10000, filter: { ${d.time}_geq: $from, ${d.time}_leq: $to, ${d.key}_in: $keys }) { ${fields} dimensions { ${dims} } } } } }`;
}

/**
 * Reads one dataset for the resources named `keys` (each as the dataset's `key` dimension names it) over `from` to
 * `to`, and adds it up per resource: each `sum` field summed (as `field:<by>` when the dataset has a `by`), each `max`
 * field at its most, and each `avg` field at its worst row's. A row for any other resource is ignored. Throws what `analyticsQuery` throws.
 * @param {ProviderContext} ctx
 * @param {{ account: string, dataset: Dataset, keys: string[], from: Date, to: Date }} what
 * @returns {Promise<Map<string, Record<string, number>>>} usage by key; a key with no rows has no entry
 */
export async function readDataset(ctx, { account, dataset: d, keys, from, to }) {
  /** @type {Map<string, Record<string, number>>} */
  const usage = new Map();
  if (!keys.length) return usage;
  const at = (t) => (d.time === 'date' ? t.toISOString().slice(0, 10) : t.toISOString());
  const data = await analyticsQuery(ctx, datasetQuery(d), { account, from: at(from), to: at(to), keys });
  const wanted = new Set(keys);
  for (const row of data?.viewer?.accounts?.[0]?.rows ?? []) {
    const key = String(row?.dimensions?.[d.key] ?? '');
    if (!wanted.has(key)) continue;
    const u = usage.get(key) ?? {};
    usage.set(key, u);
    const suffix = d.by ? `:${row.dimensions[d.by]}` : '';
    for (const f of d.sum ?? []) u[f + suffix] = (u[f + suffix] ?? 0) + (Number(row.sum?.[f]) || 0);
    for (const f of d.max ?? []) u[f] = Math.max(u[f] ?? 0, Number(row.max?.[f]) || 0);
    for (const f of d.avg ?? []) u[f] = Math.max(u[f] ?? 0, Number(row.avg?.[f]) || 0);
  }
  return usage;
}

/**
 * The datasets cost reads (BRK-188's "Cost" rows), one query each for the whole environment. Durable Objects' duration
 * is `activeTime` in durableObjectsPeriodicGroups, in microseconds; Workers' CPU time is `cpuTimeUs`.
 * @type {Record<string, Dataset>}
 */
export const COST_DATASETS = {
  workers: {
    dataset: 'workersInvocationsAdaptive',
    kind: 'worker',
    key: 'scriptName',
    time: 'datetime',
    sum: ['requests', 'cpuTimeUs'],
    label: 'requests and CPU time',
  },
  doRequests: {
    dataset: 'durableObjectsInvocationsAdaptiveGroups',
    kind: 'durable-object',
    key: 'namespaceId',
    time: 'date',
    sum: ['requests'],
    label: 'requests',
  },
  doDuration: {
    dataset: 'durableObjectsPeriodicGroups',
    kind: 'durable-object',
    key: 'namespaceId',
    time: 'date',
    sum: ['activeTime'],
    label: 'duration',
  },
  doStorage: {
    dataset: 'durableObjectsStorageGroups',
    kind: 'durable-object',
    key: 'namespaceId',
    time: 'date',
    max: ['storedBytes'],
    label: 'stored data',
  },
  d1Rows: {
    dataset: 'd1AnalyticsAdaptiveGroups',
    kind: 'd1',
    key: 'databaseId',
    time: 'date',
    sum: ['rowsRead', 'rowsWritten'],
    label: 'rows read and written',
  },
  d1Storage: {
    dataset: 'd1StorageAdaptiveGroups',
    kind: 'd1',
    key: 'databaseId',
    time: 'date',
    max: ['databaseSizeBytes'],
    label: 'stored data',
  },
  kvOperations: {
    dataset: 'kvOperationsAdaptiveGroups',
    kind: 'kv',
    key: 'namespaceId',
    time: 'date',
    sum: ['requests'],
    by: 'actionType',
    label: 'operations',
  },
  kvStorage: {
    dataset: 'kvStorageAdaptiveGroups',
    kind: 'kv',
    key: 'namespaceId',
    time: 'date',
    max: ['byteCount'],
    label: 'stored data',
  },
  r2Operations: {
    dataset: 'r2OperationsAdaptiveGroups',
    kind: 'r2',
    key: 'bucketName',
    time: 'datetime',
    sum: ['requests'],
    by: 'actionType',
    label: 'operations',
  },
  r2Storage: {
    dataset: 'r2StorageAdaptiveGroups',
    kind: 'r2',
    key: 'bucketName',
    time: 'datetime',
    max: ['payloadSize', 'metadataSize'],
    label: 'stored data',
  },
  queueOperations: {
    dataset: 'queueMessageOperationsAdaptiveGroups',
    kind: 'queue',
    key: 'queueId',
    time: 'datetime',
    sum: ['billableOperations'],
    label: 'operations',
  },
};

/** How far back health looks: errors and slowness in the last this many minutes (BRK-188's "Observe" rows). */
export const HEALTH_WINDOW_MINUTES = 15;

/**
 * The datasets health reads (BRK-188's "Observe" rows), one query each for the whole environment, over the last
 * HEALTH_WINDOW_MINUTES. Which fields each dataset serves at minute resolution is checked against a real account when
 * the owner first tries Architect (BRK-205); a dataset Cloudflare won't answer leaves its resources' health unknown.
 * @type {Record<string, Dataset>}
 */
export const HEALTH_DATASETS = {
  workers: {
    dataset: 'workersInvocationsAdaptive',
    kind: 'worker',
    key: 'scriptName',
    time: 'datetime',
    sum: ['requests', 'errors'],
    label: 'requests and errors',
  },
  durableObjects: {
    dataset: 'durableObjectsInvocationsAdaptiveGroups',
    kind: 'durable-object',
    key: 'namespaceId',
    time: 'datetime',
    sum: ['requests', 'errors'],
    label: 'requests and errors',
  },
  d1: {
    dataset: 'd1AnalyticsAdaptiveGroups',
    kind: 'd1',
    key: 'databaseId',
    time: 'datetime',
    sum: ['readQueries', 'writeQueries'],
    avg: ['queryBatchTimeMs'],
    label: 'queries and their time',
  },
  kv: {
    dataset: 'kvOperationsAdaptiveGroups',
    kind: 'kv',
    key: 'namespaceId',
    time: 'datetime',
    sum: ['requests'],
    label: 'operations',
  },
  r2: {
    dataset: 'r2OperationsAdaptiveGroups',
    kind: 'r2',
    key: 'bucketName',
    time: 'datetime',
    sum: ['requests'],
    by: 'responseStatusCode',
    label: 'operations by response status',
  },
  queues: {
    dataset: 'queuesBacklogAdaptiveGroups',
    kind: 'queue',
    key: 'queueId',
    time: 'datetime',
    avg: ['messages'],
    label: 'backlog',
  },
};
