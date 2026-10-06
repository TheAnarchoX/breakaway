/**
 * A made-up Cloudflare account for the first provider's tests (BRK-189), shaped like the API's answers BRK-188 wrote
 * down. Every ID, name, and hostname is invented: the repository is public, so nothing here comes from a real account.
 *
 * The account runs `acme-api`, which calls `acme-auth`, binds a Durable Object class that runs in `acme-rooms` (with a
 * container), and uses a D1 database, KV, R2, and a queue, served by a route and a custom domain. `acme-other` and what
 * it alone uses belong to no environment, so discovery must never reach them.
 *
 * `cloudflareApi()` returns a `fetch` that answers from the fixture and records each call; a test changes `answers`
 * to make one fail.
 */

export const ACCOUNT = '0000000000000000000000000000a001';
export const ZONE = '0000000000000000000000000000f001';
export const D1_ID = '00000000-0000-4000-8000-00000000d001';
export const D1_OTHER = '00000000-0000-4000-8000-00000000d002';
export const KV_CACHE = '0000000000000000000000000000b001';
export const KV_SESSIONS = '0000000000000000000000000000b002';
export const KV_OTHER = '0000000000000000000000000000b003';
export const QUEUE_JOBS = '0000000000000000000000000000c001';
export const QUEUE_OTHER = '0000000000000000000000000000c002';
export const DO_ROOMS = '0000000000000000000000000000e001';
export const DO_COUNTER = '0000000000000000000000000000e002';
export const DO_OTHER = '0000000000000000000000000000e003';
export const CONTAINER = '0000000000000000000000000000e101';
export const CONTAINER_OTHER = '0000000000000000000000000000e102';

/** Values a Worker's settings or deployments carry that the inventory must never keep. */
export const NEVER_KEPT = ['hello-from-acme-vars', 'acme-json-config-value', 'deployer@example.com'];

const ok = (result, extra = {}) => ({ success: true, errors: [], messages: [], result, ...extra });
const page = (result, n, of) => ok(result, { result_info: { page: n, per_page: 100, total_pages: of } });

/** The account's answers, by path (with its query, when it has one). */
export function cloudflareAnswers() {
  const a = `/accounts/${ACCOUNT}`;
  const script = (name, bindings, extra = {}) => ({
    [`${a}/workers/scripts/${name}/settings`]: ok({
      bindings,
      compatibility_date: '2026-09-01',
      compatibility_flags: ['nodejs_compat'],
      usage_model: 'standard',
      observability: { enabled: true, head_sampling_rate: 1 },
      placement: {},
      ...extra,
    }),
    [`${a}/workers/scripts/${name}/deployments`]: ok({
      deployments: [
        {
          id: `dep-${name}`,
          created_on: '2026-10-01T09:00:00Z',
          source: 'wrangler',
          strategy: 'percentage',
          author_email: 'deployer@example.com',
          annotations: { 'workers/message': 'ship it' },
          versions: [{ version_id: `ver-${name}-2`, percentage: 100 }],
        },
      ],
    }),
    [`${a}/workers/scripts/${name}/secrets`]: ok(
      name === 'acme-api'
        ? [
            { name: 'API_KEY', type: 'secret_text' },
            { name: 'SIGNING_SECRET', type: 'secret_text' },
          ]
        : [],
    ),
    [`${a}/workers/scripts/${name}/schedules`]: ok({
      schedules: name === 'acme-api' ? [{ cron: '*/5 * * * *', created_on: '2026-09-01T00:00:00Z' }] : [],
    }),
  });
  return {
    '/accounts?page=1&per_page=50': page([{ id: ACCOUNT, name: 'Acme' }], 1, 1),
    [`${a}/workers/scripts`]: ok([
      { id: 'acme-api', handlers: ['scheduled', 'fetch', 'queue'], usage_model: 'standard' },
      { id: 'acme-auth', handlers: ['fetch'] },
      { id: 'acme-rooms', handlers: ['fetch'] },
      { id: 'acme-other', handlers: ['fetch'] },
    ]),
    ...script('acme-api', [
      { type: 'd1', name: 'DB', id: D1_ID },
      { type: 'kv_namespace', name: 'CACHE', namespace_id: KV_CACHE },
      { type: 'r2_bucket', name: 'FILES', bucket_name: 'acme-files' },
      { type: 'queue', name: 'JOBS', queue_name: 'acme-jobs' },
      { type: 'service', name: 'AUTH', service: 'acme-auth', environment: 'production' },
      { type: 'durable_object_namespace', name: 'ROOMS', class_name: 'Room', script_name: 'acme-rooms' },
      { type: 'durable_object_namespace', name: 'COUNTER', class_name: 'Counter' },
      { type: 'secret_text', name: 'API_KEY' },
      { type: 'plain_text', name: 'GREETING', text: 'hello-from-acme-vars' },
      { type: 'json', name: 'CONFIG', json: { flag: 'acme-json-config-value' } },
    ]),
    ...script('acme-auth', [{ type: 'kv_namespace', name: 'SESSIONS', namespace_id: KV_SESSIONS }]),
    ...script('acme-rooms', [{ type: 'durable_object_namespace', name: 'ROOM', class_name: 'Room' }]),
    ...script('acme-other', [
      { type: 'kv_namespace', name: 'OTHER', namespace_id: KV_OTHER },
      { type: 'd1', name: 'DB', id: D1_OTHER },
    ]),
    [`${a}/d1/database/${D1_ID}`]: ok({
      uuid: D1_ID,
      name: 'acme-db',
      version: 'production',
      num_tables: 12,
      file_size: 4096,
      read_replication: { mode: 'disabled' },
    }),
    [`${a}/storage/kv/namespaces?page=1&per_page=100`]: page(
      [
        { id: KV_CACHE, title: 'acme-cache', supports_url_encoding: true },
        { id: KV_OTHER, title: 'acme-other-kv', supports_url_encoding: true },
      ],
      1,
      2,
    ),
    [`${a}/storage/kv/namespaces?page=2&per_page=100`]: page(
      [{ id: KV_SESSIONS, title: 'acme-sessions', supports_url_encoding: true }],
      2,
      2,
    ),
    [`${a}/r2/buckets?per_page=1000`]: ok({
      buckets: [
        { name: 'acme-files', creation_date: '2026-01-01T00:00:00Z', location: 'WEUR', storage_class: 'Standard' },
        { name: 'acme-other-files', creation_date: '2026-01-01T00:00:00Z', location: 'ENAM' },
      ],
    }),
    // No CORS set: Cloudflare answers 404.
    [`${a}/r2/buckets/acme-files/lifecycle`]: ok({
      rules: [{ id: 'expire-tmp', enabled: true, conditions: { prefix: 'tmp/' } }],
    }),
    [`${a}/r2/buckets/acme-files/domains/custom`]: ok({
      domains: [{ domain: 'files.acme.example', enabled: true, zoneName: 'acme.example' }],
    }),
    [`${a}/queues?page=1&per_page=100`]: page(
      [
        {
          queue_id: QUEUE_JOBS,
          queue_name: 'acme-jobs',
          consumers: [{ script: 'acme-api', type: 'worker' }],
          producers: [{ script: 'acme-api', type: 'worker' }],
          settings: { delivery_delay: 0, delivery_paused: false, message_retention_period: 345600 },
        },
        {
          queue_id: QUEUE_OTHER,
          queue_name: 'acme-other-jobs',
          consumers: [{ script: 'acme-other', type: 'worker' }],
          settings: {},
        },
      ],
      1,
      1,
    ),
    [`${a}/queues/${QUEUE_JOBS}/consumers`]: ok([
      {
        consumer_id: 'consumer-1',
        type: 'worker',
        script: 'acme-api',
        settings: { batch_size: 10, max_retries: 3, max_wait_time_ms: 5000, max_concurrency: 4 },
        dead_letter_queue: 'acme-jobs-dlq',
      },
    ]),
    [`${a}/workers/durable_objects/namespaces?page=1&per_page=100`]: page(
      [
        { id: DO_ROOMS, name: 'acme-rooms_Room', script: 'acme-rooms', class: 'Room', use_sqlite: true },
        { id: DO_COUNTER, name: 'acme-api_Counter', script: 'acme-api', class: 'Counter', use_sqlite: false },
        { id: DO_OTHER, name: 'acme-other_Thing', script: 'acme-other', class: 'Thing', use_sqlite: true },
      ],
      1,
      1,
    ),
    [`${a}/containers/applications`]: ok([
      {
        id: CONTAINER,
        name: 'acme-rooms-sandbox',
        scheduling_policy: 'default',
        instances: 2,
        max_instances: 5,
        configuration: { image: 'registry.example/acme/sandbox:1', instance_type: 'basic' },
        durable_objects: { namespace_id: DO_ROOMS },
        health: { instances: { active: 2, assigned: 2, healthy: 2 } },
      },
      {
        id: CONTAINER_OTHER,
        name: 'acme-other-box',
        scheduling_policy: 'default',
        instances: 1,
        max_instances: 1,
        durable_objects: { namespace_id: DO_OTHER },
      },
    ]),
    [`/zones?account.id=${ACCOUNT}&page=1&per_page=50`]: page([{ id: ZONE, name: 'acme.example' }], 1, 1),
    [`/zones/${ZONE}/workers/routes`]: ok([
      { id: '0000000000000000000000000000d101', pattern: 'api.acme.example/*', script: 'acme-api' },
      { id: '0000000000000000000000000000d102', pattern: 'other.acme.example/*', script: 'acme-other' },
    ]),
    [`${a}/workers/domains`]: ok([
      {
        id: '0000000000000000000000000000d201',
        hostname: 'app.acme.example',
        service: 'acme-api',
        environment: 'production',
        zone_id: ZONE,
        zone_name: 'acme.example',
      },
      {
        id: '0000000000000000000000000000d202',
        hostname: 'other.acme.example',
        service: 'acme-other',
        zone_id: ZONE,
        zone_name: 'acme.example',
      },
    ]),
    '/user/tokens/verify': ok({ id: 'token-id', status: 'active' }),
    '/graphql': cloudflareUsage(),
  };
}

/**
 * Seven days of made-up usage, by GraphQL dataset, as Cloudflare's analytics answers it: the rows a query for the
 * dataset gets back, grouped by the resource (and the action, where the dataset has one). Each dataset also answers a
 * row for a resource outside the environment, which `cost` must ignore.
 * @returns {Record<string, Array<Record<string, unknown>>>}
 */
export function cloudflareUsageRows() {
  return {
    workersInvocationsAdaptive: [
      { sum: { requests: 700_000, cpuTimeUs: 3_500_000_000 }, dimensions: { scriptName: 'acme-api' } },
      { sum: { requests: 70_000, cpuTimeUs: 70_000_000 }, dimensions: { scriptName: 'acme-auth' } },
      { sum: { requests: 9_000_000, cpuTimeUs: 9_000_000_000 }, dimensions: { scriptName: 'acme-other' } },
    ],
    durableObjectsInvocationsAdaptiveGroups: [
      { sum: { requests: 140_000 }, dimensions: { namespaceId: DO_ROOMS } },
      { sum: { requests: 7_000 }, dimensions: { namespaceId: DO_COUNTER } },
      { sum: { requests: 1_000_000 }, dimensions: { namespaceId: DO_OTHER } },
    ],
    durableObjectsPeriodicGroups: [
      { sum: { activeTime: 1_400_000_000_000 }, dimensions: { namespaceId: DO_ROOMS } },
      { sum: { activeTime: 1_000_000_000_000 }, dimensions: { namespaceId: DO_OTHER } },
    ],
    durableObjectsStorageGroups: [
      { max: { storedBytes: 2_000_000_000 }, dimensions: { namespaceId: DO_ROOMS } },
      { max: { storedBytes: 9_000_000_000 }, dimensions: { namespaceId: DO_OTHER } },
    ],
    d1AnalyticsAdaptiveGroups: [
      { sum: { rowsRead: 70_000_000, rowsWritten: 700_000 }, dimensions: { databaseId: D1_ID } },
      { sum: { rowsRead: 1, rowsWritten: 1 }, dimensions: { databaseId: D1_OTHER } },
    ],
    d1StorageAdaptiveGroups: [
      { max: { databaseSizeBytes: 4_000_000_000 }, dimensions: { databaseId: D1_ID } },
      { max: { databaseSizeBytes: 9_000_000_000 }, dimensions: { databaseId: D1_OTHER } },
    ],
    kvOperationsAdaptiveGroups: [
      { sum: { requests: 2_100_000 }, dimensions: { namespaceId: KV_CACHE, actionType: 'read' } },
      { sum: { requests: 70_000 }, dimensions: { namespaceId: KV_CACHE, actionType: 'write' } },
      { sum: { requests: 7_000 }, dimensions: { namespaceId: KV_SESSIONS, actionType: 'read' } },
      { sum: { requests: 700 }, dimensions: { namespaceId: KV_SESSIONS, actionType: 'delete' } },
      { sum: { requests: 700 }, dimensions: { namespaceId: KV_SESSIONS, actionType: 'list' } },
      { sum: { requests: 9_000_000 }, dimensions: { namespaceId: KV_OTHER, actionType: 'write' } },
    ],
    kvStorageAdaptiveGroups: [
      { max: { byteCount: 1_000_000_000 }, dimensions: { namespaceId: KV_CACHE } },
      { max: { byteCount: 9_000_000_000 }, dimensions: { namespaceId: KV_OTHER } },
    ],
    r2OperationsAdaptiveGroups: [
      { sum: { requests: 70_000 }, dimensions: { bucketName: 'acme-files', actionType: 'PutObject' } },
      { sum: { requests: 700_000 }, dimensions: { bucketName: 'acme-files', actionType: 'GetObject' } },
      { sum: { requests: 7_000 }, dimensions: { bucketName: 'acme-files', actionType: 'DeleteObject' } },
      { sum: { requests: 9_000_000 }, dimensions: { bucketName: 'acme-other-files', actionType: 'PutObject' } },
    ],
    r2StorageAdaptiveGroups: [
      { max: { payloadSize: 99_000_000_000, metadataSize: 1_000_000_000 }, dimensions: { bucketName: 'acme-files' } },
      { max: { payloadSize: 9_000_000_000_000, metadataSize: 0 }, dimensions: { bucketName: 'acme-other-files' } },
    ],
    queueMessageOperationsAdaptiveGroups: [
      { sum: { billableOperations: 210_000 }, dimensions: { queueId: QUEUE_JOBS } },
      { sum: { billableOperations: 9_000_000 }, dimensions: { queueId: QUEUE_OTHER } },
    ],
  };
}

/**
 * Cloudflare's GraphQL analytics, answering a query from `rows` by the dataset it names. A dataset whose rows are a
 * string answers that as a GraphQL error, the way Cloudflare does for a field or a range it won't serve.
 * @param {Record<string, unknown>} [rows]
 */
export function cloudflareUsage(rows = cloudflareUsageRows()) {
  /** @param {{ query: string, variables: Record<string, unknown> }} body */
  return (body) => {
    const dataset = Object.keys(rows).find((d) => body.query.includes(` ${d}(`));
    if (!dataset) return { data: null, errors: [{ message: 'unknown field' }] };
    const answer = rows[dataset];
    if (typeof answer === 'string') return { data: null, errors: [{ message: answer }] };
    return { data: { viewer: { accounts: [{ rows: answer }] } }, errors: null };
  };
}

/**
 * A `fetch` that answers from `answers` by path and records each call. An answer that is a number is that status, with
 * Cloudflare's error shape; a path it doesn't know answers 404.
 * @param {Record<string, unknown>} [answers]
 */
export function cloudflareApi(answers = cloudflareAnswers()) {
  /** @type {Array<{ method: string, path: string, auth: string | null, body?: any }>} */
  const calls = [];
  /** @type {typeof fetch & { calls: typeof calls, answers: typeof answers }} */
  const api = Object.assign(
    async (input, init = {}) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/client\/v4/u, '') + url.search;
      const headers = new Headers(init.headers);
      calls.push({
        method: init.method ?? 'GET',
        path,
        auth: headers.get('authorization'),
        ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      const answer = answers[path];
      if (typeof answer === 'function') return Response.json(answer(JSON.parse(String(init.body))));
      if (answer === undefined || typeof answer === 'number') {
        const status = typeof answer === 'number' ? answer : 404;
        return Response.json(
          { success: false, errors: [{ code: status, message: status === 404 ? 'not found' : 'refused' }] },
          { status },
        );
      }
      return Response.json(answer);
    },
    { calls, answers },
  );
  return api;
}
