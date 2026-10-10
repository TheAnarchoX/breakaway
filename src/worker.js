/**
 * The task board's Worker.
 *
 *   /v1/client/*  TaskChampion sync protocol, for `task sync` (the install's client ID only)
 *   /api/*        JSON API for `npx breakaway`, agents, and the web app (token or cookie)
 *   /github/*     GitHub App webhooks and the end of its setup (docs/specs/CLD-24-github.md)
 *   /mcp          the board as an MCP server, for agents' MCP clients (token only; docs/specs/IDEA-24-mcp-server.md)
 *   /oauth/*, /.well-known/oauth-*  the sign-in MCP apps use for /mcp, approved by the owner on the board (BRK-157)
 *   /login        exchanges the token for a cookie; /logout clears it (and ends a person's session)
 *   everything else: the web app's static files (./public)
 *
 * Logs hold no task content: only what failed and why.
 */
import { authenticate, login, logout, sameOrigin } from './auth.js';
import { isUuid } from './crypto.js';
import { appCredentials, verifyWebhook } from './github.js';
import { workflowsChanged } from './workflows.js';
import { install } from './install.js';
import { handleMcp } from './mcp.js';
import { handleOAuth, oauthApi } from './oauth.js';
import { CLI_VERSION } from './cli-version.js';
import { releaseOf } from './build.js';
import { unreadableSecrets } from './secrets.js';
import { BREAKAWAY_REPO } from './updates.js';
import { RUNNER_HEADER } from './infra-runner.js';
import { plansDates } from './store-features.js';
import { endPersonSession, guardStore, peopleOwnerApi, peoplePublic, personApi, personOf } from './people.js';
import { ACTIONS, agentOf, ownerActor } from './permissions.js';
import { isHidden, lostTarget, readOf, scrub, writeReads } from './reads.js';

export { TaskStore } from './store.js';

const HISTORY_SEGMENT = 'application/vnd.taskchampion.history-segment';
const SNAPSHOT = 'application/vnd.taskchampion.snapshot';
/** SQLite rows in a Durable Object hold up to 2 MB. */
const MAX_BODY = 1_900_000;

function store(env) {
  const ns = env.TASKS_JURISDICTION ? env.STORE.jurisdiction(env.TASKS_JURISDICTION) : env.STORE;
  // The install's one Durable Object; a Worker without TASKS_INSTALL uses the legacy name (src/install.js).
  return ns.get(ns.idFromName(install(env).store));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Public, for the deploy pipeline's check: says nothing about tasks (docs/specs/CLD-27).
    if (url.pathname === '/api/ping' && request.method === 'GET') {
      // Whether the bound secrets load, by binding name and never a value, so a deploy can tell (BRK-96).
      const unreadable = await unreadableSecrets(env);
      return withHeaders(
        json(200, {
          ok: true,
          version: env.VERSION?.id ?? null,
          release: releaseOf(env),
          secrets: { ok: unreadable.length === 0, unreadable },
        }),
      );
    }
    if (url.pathname.startsWith('/v1/client/')) return withHeaders(await handleSync(request, env, url));
    const fire = /^\/api\/routines\/([a-z][a-z0-9-]{0,39})\/fire$/u.exec(url.pathname);
    if (fire && request.method === 'POST') return withHeaders(await fireRoutine(request, env, fire[1]));
    // The apply runner (BRK-183): its GitHub OIDC token, not the board's sign-in, says which run asks.
    const run = /^\/api\/infra\/runs\/([^/]+)$/u.exec(url.pathname);
    if (run && request.headers.has(RUNNER_HEADER)) return withHeaders(await runnerCall(request, env, url, run[1]));
    if (url.pathname.startsWith('/api/')) {
      // The frozen CLI number, so an old copy of the CLI in another repository says how to switch (CLD-193), and the
      // release this build is, so a checkout of the board's own repository can say it's behind (BRK-148).
      const res = withHeaders(await handleApi(request, env, url, ctx));
      res.headers.set('X-Tasks-Cli', String(CLI_VERSION));
      res.headers.set('X-Tasks-Release', releaseOf(env));
      return res;
    }
    if (url.pathname === '/mcp') {
      const res = withHeaders(
        await handleMcp(request, env, store(env), {
          maxBody: MAX_BODY,
          waitUntil: (promise) => ctx?.waitUntil(promise),
        }),
      );
      res.headers.set('X-Tasks-Release', releaseOf(env));
      return res;
    }
    if (url.pathname.startsWith('/oauth/') || url.pathname.startsWith('/.well-known/oauth-')) {
      const res = await handleOAuth(request, store(env));
      if (res) return withHeaders(res);
    }
    if (url.pathname === '/github/webhook' && request.method === 'POST')
      return withHeaders(await githubWebhook(request, env));
    if (url.pathname === '/github/connected' && request.method === 'GET') return githubConnected(url, env);
    if (url.pathname === '/login' && request.method === 'POST') return login(request, env);
    if (url.pathname === '/logout' && request.method === 'POST') {
      if (sameOrigin(request)) await endPersonSession(request, store(env));
      return logout(request);
    }
    return env.ASSETS.fetch(request);
  },

  /** Every few minutes: catch up with GitHub, in case a webhook went missing. */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(store(env).tick('cron'));
  },
};

// ---- GitHub ------------------------------------------------------------------------------

async function githubWebhook(request, env) {
  const credentials = await appCredentials(env);
  if (!credentials) return text(503, 'the GitHub App is not connected yet');
  const body = new Uint8Array(await request.arrayBuffer());
  const event = request.headers.get('X-GitHub-Event') ?? '';
  const verified = await verifyWebhook(credentials.webhookSecret, body, request.headers.get('X-Hub-Signature-256'));
  await store(env).connectionsWebhookSeen(verified, event); // for the Connections view: when, never what
  if (!verified) return text(401, 'bad signature');
  if (event === 'ping') return text(200, 'pong');
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return text(400, 'bad payload');
  }
  // breakaway's own release: an install that follows a channel looks for it soon (BRK-10).
  if (
    event === 'release' &&
    payload.action === 'published' &&
    String(payload.repository?.full_name ?? '').toLowerCase() ===
      (env.TASKS_BREAKAWAY_REPO || BREAKAWAY_REPO).toLowerCase()
  )
    await store(env).updatesReleased();
  // The delivery's repository decides which one syncs; one that isn't registered is ignored.
  const result = await store(env).githubWebhook(event, payload.action ?? null, {
    full: payload.repository?.full_name ?? null,
    workflowsChanged: workflowsChanged(event, payload),
  });
  if (result.status === 'ignored') return text(202, 'other repository, ignored');
  if (result.repo) await store(env).connectionsWebhookRepo(result.repo); // Connections: when, per repository
  // Routines listening for this event (CLD-69), of the repository it came from (CLD-127).
  await store(env).githubRoutines(event, payload, result.repo);
  return text(202, 'scheduled');
}

/** GitHub sends the owner back here after creating the App; the board shows the next step. */
async function githubConnected(url, env) {
  const code = url.searchParams.get('code') ?? '';
  const ok = /^[\w-]{8,128}$/u.test(code) && (await store(env).githubCheckState(url.searchParams.get('state')));
  const target = ok ? `/#/github?connect=${encodeURIComponent(code)}` : '/#/github?connect=failed';
  return new Response(null, { status: 303, headers: { Location: target, 'Cache-Control': 'no-store' } });
}

// ---- Routine triggers --------------------------------------------------------------------

const MAX_TRIGGER_BODY = 16 * 1024;

/** The bytes of a small body, or null when it's over the limit (never reads more than the limit). */
async function readSmallBody(request) {
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_TRIGGER_BODY) return null;
  if (!request.body) return new Uint8Array();
  const chunks = [];
  let size = 0;
  for await (const chunk of request.body) {
    size += chunk.length;
    if (size > MAX_TRIGGER_BODY) return null;
    chunks.push(chunk);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * POST /api/routines/<slug>/fire: a routine's webhook/API trigger. It has no owner token; a per-trigger
 * secret (Authorization: Bearer, or X-Routine-Secret / Cloudflare's cf-webhook-auth for services that only send a header) is what
 * authenticates it, and the secret alone decides. Nothing in the body reaches the run but a labelled comment.
 */
async function fireRoutine(request, env, slug) {
  const header = request.headers.get('Authorization') ?? '';
  const cloudflare = (request.headers.get('cf-webhook-auth') ?? '').trim();
  const secret = header.startsWith('Bearer ')
    ? header.slice(7).trim()
    : (request.headers.get('X-Routine-Secret') ?? '').trim() || cloudflare;
  const source = cloudflare && cloudflare === secret ? 'cloudflare' : 'api';
  const raw = await readSmallBody(request);
  const result = await store(env).routinesFire(slug, secret, raw, source);
  return json(result.status, result.body);
}

/** GET and POST /api/infra/runs/<plan> from the apply runner: what it asks, checked by the store against its token. */
async function runnerCall(request, env, url, plan) {
  if (request.method !== 'GET' && request.method !== 'POST')
    return json(405, { error: 'GET the plan, or POST a step' });
  let body = {};
  if (request.method === 'POST') {
    const raw = await readBody(request);
    if (!raw) return json(413, { error: 'a step’s report is too large' });
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return json(400, { error: 'the body must be JSON' });
    }
  }
  let ref;
  try {
    ref = decodeURIComponent(plan);
  } catch {
    return json(400, { error: 'that isn’t a plan’s ID' });
  }
  const result = await store(env).infraRunnerApi(ref, {
    method: request.method,
    token: request.headers.get(RUNNER_HEADER) ?? '',
    origin: url.origin,
    body,
  });
  return json(result.status, result.body);
}

function withHeaders(response) {
  const res = new Response(response.body, response);
  res.headers.set('Cache-Control', 'no-store, max-age=0');
  res.headers.set('X-Robots-Tag', 'noindex');
  return res;
}

const text = (status, body) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

/** Whether a task's add or change plans what only a maintainer plans: autostart, or a horizon-* tag (BRK-301). */
function plansTask(item) {
  if (!item || typeof item !== 'object') return false;
  const tags = [item.tags, item.addTags, item.removeTags].flatMap((t) =>
    Array.isArray(t) ? t : typeof t === 'string' ? t.split(',') : [],
  );
  return (
    (item.autostart !== undefined && item.autostart !== null) ||
    tags.some((t) => String(t).trim().startsWith('horizon-'))
  );
}
const json = (status, body) => Response.json(body, { status });

async function readBody(request) {
  const length = Number(request.headers.get('Content-Length') ?? 0);
  if (length > MAX_BODY) return null;
  const body = new Uint8Array(await request.arrayBuffer());
  return body.length > MAX_BODY ? null : body;
}

// ---- TaskChampion sync protocol (taskchampion-sync-server server/src/api) -----------------

async function handleSync(request, env, url) {
  const clientId = (request.headers.get('X-Client-Id') ?? '').toLowerCase();
  if (!isUuid(clientId)) return text(400, 'bad x-client-id');
  if (!(await store(env).allowsClient(clientId))) return text(403, 'unknown x-client-id');

  const [, , , action, id] = url.pathname.split('/');
  const method = request.method;
  if (id !== undefined && !isUuid(id)) return text(400, 'bad version id');
  const versionId = id?.toLowerCase();

  if (action === 'get-child-version' && method === 'GET' && versionId) {
    const result = await store(env).getChildVersion(versionId);
    if (result.status === 'notfound') return text(404, 'no such version');
    if (result.status === 'gone')
      return text(410, 'this replica last synced with another server: start it again (docs/tasks.md)');
    return new Response(result.segment, {
      headers: {
        'Content-Type': HISTORY_SEGMENT,
        'X-Version-Id': result.versionId,
        'X-Parent-Version-Id': result.parentVersionId,
      },
    });
  }

  if (action === 'add-version' && method === 'POST' && versionId) {
    if (contentType(request) !== HISTORY_SEGMENT) return text(400, 'Bad content-type');
    const body = await readBody(request);
    if (!body) return text(413, 'history segment too large');
    if (!body.length) return text(400, 'Empty body');
    const result = await store(env).addVersion(clientId, versionId, body);
    if (result.status === 'forbidden') return text(403, 'unknown x-client-id');
    if (result.status === 'conflict')
      return new Response(null, { status: 409, headers: { 'X-Parent-Version-Id': result.expected } });
    const headers = { 'X-Version-Id': result.versionId };
    if (result.urgency !== 'none') headers['X-Snapshot-Request'] = `urgency=${result.urgency}`;
    return new Response(null, { status: 200, headers });
  }

  if (action === 'add-snapshot' && method === 'POST' && versionId) {
    if (contentType(request) !== SNAPSHOT) return text(400, 'Bad content-type');
    const body = await readBody(request);
    if (!body) return text(413, 'Snapshot over maximum allowed size');
    if (!body.length) return text(400, 'No snapshot supplied');
    const result = await store(env).addSnapshot(clientId, versionId, body);
    if (result.status === 'forbidden') return text(403, 'unknown x-client-id');
    return new Response(null, { status: 200 });
  }

  if (action === 'snapshot' && method === 'GET' && id === undefined) {
    const snap = await store(env).getSnapshot();
    if (!snap) return text(404, 'no snapshot');
    return new Response(snap.data, { headers: { 'Content-Type': SNAPSHOT, 'X-Version-Id': snap.versionId } });
  }

  return text(404, 'not found');
}

function contentType(request) {
  return (request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
}

// ---- Images on tasks (docs/specs/IDEA-8-images-on-ideas.md) -------------------------------

const MAX_IMAGE_BODY = 1024 * 1024 + 1;

/** Image routes carry raw bytes, not JSON, so they're handled before the body is parsed. Null when the path isn't one. */
async function handleImages(request, url, method, s, gate) {
  const parts = url.pathname.split('/').slice(2).map(decodeURIComponent);
  const send = (result) => json(result.status, result.body);
  const header = (name) => {
    try {
      return decodeURIComponent(request.headers.get(name) ?? '');
    } catch {
      return '';
    }
  };
  if (parts[0] === 'tasks' && parts[2] === 'attachments' && parts.length === 3) {
    if (method === 'GET') return send(await s.attachmentsList(parts[1]));
    if (method !== 'POST') return null;
    const no = await gate('task.write', { task: parts[1] });
    if (no) return no;
    if (Number(request.headers.get('Content-Length') ?? 0) > MAX_IMAGE_BODY)
      return json(413, { error: 'each image can be up to 1 MB, so shrink it or crop it first' });
    const bytes = await request.arrayBuffer();
    return send(
      await s.attachmentAdd(parts[1], bytes, { name: header('X-Attachment-Name'), alt: header('X-Attachment-Alt') }),
    );
  }
  // A kickoff's images (IDEA-26) are the owner's, from the signed-in browser only; they're read like any image.
  if (parts[0] === 'kickoffs' && parts[2] === 'images' && (parts.length === 3 || parts.length === 4)) {
    if (method === 'GET') return null;
    const no = await gate('kickoff', { install: true }, 'only the signed-in web board can change a kickoff’s images');
    if (no) return no;
    if (parts.length === 4 && method === 'DELETE') return send(await s.kickoffImageDelete(parts[1], parts[3]));
    if (parts.length !== 3 || method !== 'POST') return null;
    if (Number(request.headers.get('Content-Length') ?? 0) > MAX_IMAGE_BODY)
      return json(413, { error: 'each image can be up to 1 MB, so shrink it or crop it first' });
    const bytes = await request.arrayBuffer();
    return send(
      await s.kickoffImageAdd(parts[1], bytes, { name: header('X-Attachment-Name'), alt: header('X-Attachment-Alt') }),
    );
  }
  if (parts[0] === 'attachments' && parts.length === 2 && /^\d{1,9}$/u.test(parts[1])) {
    if (method === 'DELETE') {
      const no = await gate('task.write', { attachment: parts[1] });
      if (no) return no;
      return send(await s.attachmentDelete(parts[1]));
    }
    if (method === 'GET') {
      const result = await s.attachmentGet(parts[1]);
      if (result.status !== 200) return send(result);
      return new Response(result.data, {
        headers: {
          'Content-Type': result.type,
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': 'inline; filename="image"',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        },
      });
    }
  }
  return null;
}

// ---- JSON API ----------------------------------------------------------------------------

/** When this isolate last told the store the API token was used, so a busy CLI costs it a call a minute at most. */
let cliNotedAt = 0;

async function handleApi(request, env, url, ctx) {
  // Signing in with a passkey, and joining by invite, need no credential: they're how a person gets one (BRK-300).
  const open = await peoplePublic(request, env, url, store(env));
  if (open) return open;
  const via = await authenticate(request, env);
  if (via) return routeApi(request, env, url, ctx, via, null);
  // Not the owner: a person, or nobody (docs/specs/BRK-299-people-and-roles.md, points 2 and 3).
  const person = await personOf(request, store(env));
  if (!person) return json(401, { error: 'sign in first: send the token as "Authorization: Bearer <token>"' });
  const first = url.pathname.split('/')[2];
  if (first === 'session' || first === 'me') return personApi(request, env, url, person, store(env));
  return personRoute(request, env, url, ctx, person);
}

/**
 * A person's request past their own settings (BRK-323): they see only the repositories they have a grant in. A read
 * asks the store first what it's about (src/reads.js): one in a repository they can't read is a 404, as if it
 * weren't there, and the install's own reads are the owner's and the `*` grant's. A route that isn't a read they may
 * make is refused. Every answer, a write's too, comes back with what they can't see taken out.
 */
async function personRoute(request, env, url, ctx, person) {
  let parts;
  try {
    parts = url.pathname.split('/').slice(2).map(decodeURIComponent);
  } catch {
    return json(400, { error: 'the path isn’t valid' });
  }
  const read = request.method === 'GET' ? readOf(parts, url.searchParams) : null;
  if (request.method === 'GET' && !read) return json(404, { error: `no route for GET ${url.pathname}` });
  const gate = await store(env).readGateApi({ person: person.handle }, read);
  if (gate.status !== 200) return json(gate.status, gate.body);
  // An environment named with no ?repo= is the one in a repository they see (BRK-341): the route looks the name up
  // again, so it's told which, or it would answer that two repositories have it, naming one they can't see.
  if (read && gate.body.repo && !url.searchParams.get('repo')) url.searchParams.set('repo', gate.body.repo);
  if (!read) request = await environmentWhereTheySee(request, env, url, parts, person);
  const res = await routeApi(request, env, url, ctx, person.via, person, read !== null);
  if (!(res.headers.get('Content-Type') ?? '').startsWith('application/json')) return res;
  let body;
  try {
    body = await res.clone().json();
  } catch {
    return res;
  }
  const hidden = { repos: new Set(gate.body.hidden.repos), tasks: new Set(gate.body.hidden.tasks) };
  // A read whose answer is itself about something they can't see (an agent's listening, by its name) isn't there.
  if (res.status < 300 && read && isHidden(body, hidden))
    return json(404, { error: 'single' in read ? read.single : 'not found' });
  const shown = scrub(body, hidden);
  if (res.status < 300 && read && ('target' in read || 'single' in read) && lostTarget(body, shown))
    return json(404, { error: 'single' in read ? read.single : 'not found' });
  if (res.status >= 400 && body && typeof body.error === 'string' && typeof shown?.error !== 'string')
    shown.error = 'that didn’t work';
  return json(res.status, shown);
}

/** Architect's writes that name an environment in their path, as /api/infra/<what>/<environment>[/…]. */
const ENVIRONMENT_PATHS = new Set(['environments', 'envelopes', 'locks', 'drift', 'break-glass']);

/**
 * A person's write on an environment by its name, with no repository named, as the one in a repository they see
 * (BRK-341): the request with `?repo=`, and the body's `repo`, set to it. Anything else, including a name they see
 * nowhere, goes on as it came, for the gate to answer.
 * @param {Request} request
 * @param {any} env
 * @param {URL} url changed in place
 * @param {string[]} parts
 * @param {{ handle: string }} person
 * @returns {Promise<Request>}
 */
async function environmentWhereTheySee(request, env, url, parts, person) {
  if (parts[0] !== 'infra' || url.searchParams.get('repo')) return request;
  const inBody = parts[1] === 'plans' && parts.length === 2;
  if (!inBody && !(ENVIRONMENT_PATHS.has(parts[1]) && parts.length >= 3)) return request;
  let body = null;
  try {
    const raw = await request.clone().text();
    body = raw ? JSON.parse(raw) : null;
  } catch {
    return request;
  }
  const object = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  const name = inBody ? object?.environment : parts[2];
  if (typeof name !== 'string' || !name.trim() || object?.repo) return request;
  const found = await store(env).readGateApi({ person: person.handle }, { target: { environment: name, repo: null } });
  if (found.status !== 200 || !found.body.repo) return request;
  url.searchParams.set('repo', found.body.repo);
  if (!object) return request;
  // The body grows, so its old length goes: the new request's is the new body's.
  const headers = new Headers(request.headers);
  headers.delete('Content-Length');
  return new Request(url, {
    method: request.method,
    headers,
    body: JSON.stringify({ ...object, repo: found.body.repo }),
  });
}

/**
 * Every API route past sign-in. `via` is how the request signed in: the owner's `token` or `cookie`, or a person's
 * `person-token` or `person-cookie`, whose `person` it is. Every route that changes something asks `gate` first, which
 * asks the one permissions module (src/permissions.js) with the person behind the credential, never with `by`.
 * `readable` is a person's read that personRoute's gate has let through.
 */
async function routeApi(request, env, url, ctx, via, person, readable = false) {
  const actor = person ? { person: person.handle, press: via === 'person-cookie' } : ownerActor(via === 'cookie');
  // A press is a signed-in browser: the owner's cookie or a person's session, never a bearer token (BRK-299 point 3).
  const press = actor.press;
  /** Who a read is for, when it counts what they can see: a person, or null for the owner (BRK-323). */
  const reader = person ? { person: person.handle } : null;
  // A call with the token is the CLI (or a script with it), never the web board's cookie: Set up the board's CLI step (BRK-143).
  if (via === 'token' && Date.now() - cliNotedAt > 60_000) {
    cliNotedAt = Date.now();
    ctx?.waitUntil(store(env).connectionsCliSeen());
  }
  const method = request.method;
  if (press && method !== 'GET' && !sameOrigin(request)) return json(403, { error: 'cross-origin request refused' });

  // A person's request reaches the store only once a gate has let it through: anything else is refused (BRK-301).
  // A person's read has been through its own gate already (personRoute).
  let gated = readable;
  /** @type {any} */
  const s = person ? guardStore(store(env), () => gated) : store(env);
  let by = null;
  let agent = null;
  /** The repositories a person's last gate checked, so a route can keep them to those. */
  /** @type {(string | null)[]} */
  let repos = [];
  /**
   * Whether the request may do `action` on `target` (a repository, a task, a plan, …: src/store-permissions.js says
   * which). The press comes first, in the words the route has always used; the owner may do everything else here
   * (the store's own checks refuse an agent's `by`, as before); a person's role is the store's to check, with their
   * grants. Answers the refusal, or null to go on. A person's gate gives back the repositories it checked. A person's
   * write on something they can't read is a 404 with the read's words, before their role is asked (BRK-337).
   * @param {string} action
   * @param {Record<string, any>} [target]
   * @param {string} [words]
   */
  const gate = async (action, target = {}, words) => {
    const rule = ACTIONS[action];
    if (rule.press && !press) return json(403, { error: words ?? `only the signed-in web board can ${rule.what}` });
    if (person) {
      for (const read of writeReads(target)) {
        const seen = await store(env).readGateApi({ person: person.handle }, read);
        if (seen.status !== 200) return json(seen.status, seen.body);
      }
      const permit = await store(env).permitApi(actor, action, { ...target, by, agent });
      if (permit.status !== 200) return json(permit.status, permit.body);
      gated = true;
      repos = permit.body.repos;
    }
    return null;
  };

  const images = await handleImages(request, url, method, s, gate);
  if (images) return images;

  let body = {};
  if (method !== 'GET') {
    const raw = await request.text();
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { error: 'the body must be JSON' });
      }
    }
  }
  // Who's behind the request is its credential's, never its body's: the store reads `actor` from here.
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    body.actor = actor;
    by = body.by ?? null;
    agent = typeof body.agent === 'string' ? body.agent : null;
  }
  if (person) {
    // A person's `by` is only ever an agent's name: never the owner, the board, or a routine (BRK-301).
    const items = Array.isArray(body) ? body : Array.isArray(body?.tasks) ? body.tasks : [body];
    if (items.some((item) => /^(owner|board)$|^routine:/u.test(String(item?.by ?? '').trim())))
      return json(403, { error: 'by names an agent: owner, board, and routines are the board’s own names' });
  }

  const parts = url.pathname.split('/').slice(2).map(decodeURIComponent);
  const send = (result) => json(result.status, result.body);
  /** A task write by a person names them (BRK-301): with no agent's `by`, it's theirs, by handle. */
  const theirs = (item) =>
    person && item && typeof item === 'object' && !agentOf(item.by, person.handle)
      ? { ...item, by: person.handle }
      : item;

  if (parts[0] === 'session' && method === 'GET') {
    // Which board this is, for the web app and the CLI: its name and where it answers, never a secret.
    // An install on workers.dev has no URL of its own: it's where it was asked.
    const { name, url: home, docs } = install(env);
    return json(200, { ok: true, via, install: { name, url: home ?? url.origin, docs } });
  }
  const people = await peopleOwnerApi(parts, method, body, actor, person ? store(env) : s, env, request);
  if (people) return people;
  if (parts[0] === 'health' && method === 'GET') {
    const result = await s.health();
    // Which install this is, so the owner's commands that write its secrets refuse another's config (BRK-95):
    // names and an ID, never a secret.
    const { worker, secretsPrefix, secretsStore, installRepository } = install(env);
    return send({
      ...result,
      body: {
        ...result.body,
        cli: CLI_VERSION,
        release: releaseOf(env),
        install: { worker, secretsPrefix, ...(secretsStore === undefined ? {} : { secretsStore }), installRepository },
      },
    });
  }
  if (parts[0] === 'activity' && method === 'GET') {
    return send(
      await s.activity({
        limit: url.searchParams.get('limit') ?? undefined,
        before: url.searchParams.get('before') ?? undefined,
      }),
    );
  }
  // Every open task's footprint at once (WEB-130), for the Graph view; one task's is GET /api/tasks/:id/footprint.
  if (parts[0] === 'footprints' && parts.length === 1 && method === 'GET')
    return send(await s.footprintsApi(url.searchParams.get('repo') || null));
  if (parts[0] === 'stats' && parts.length === 1 && method === 'GET')
    return send(
      await s.statsApi({
        days: url.searchParams.get('days') ?? undefined,
        tz: url.searchParams.get('tz') ?? undefined,
        repo: url.searchParams.get('repo') ?? undefined,
      }),
    );
  if (parts[0] === 'next' && parts.length === 1 && method === 'POST') {
    const no = await gate(body.claim ? 'task.write' : 'read', { repo: body.repo });
    if (no) return no;
    // A person's next is in the repository they asked for, or the default: never another's.
    return send(await s.next(person ? { ...body, repo: repos[0] } : body));
  }
  if (parts[0] === 'backfill' && parts[1] === 'structure' && parts.length === 2 && method === 'POST') {
    const no = await gate('install.admin', { install: true });
    if (no) return no;
    return send(await s.backfillStructureApi());
  }
  // Pulling a release into now (BRK-126) or next (BRK-209): the owner's or an agent's, whose pull is kept for undo (BRK-274).
  if (parts[0] === 'releases' && parts[2] === 'pull' && parts.length === 3 && method === 'POST') {
    const no = await gate('release.pull', { release: parts[1], into: body.into });
    if (no) return no;
    return send(await s.releasePullApi(parts[1], body));
  }
  // Undoing an agent's change to the plan (BRK-274) is the owner's, from the signed-in web board.
  if (parts[0] === 'planning' && parts[2] === 'undo' && parts.length === 3 && method === 'POST') {
    const no = await gate(
      'planning.undo',
      { planning: parts[1] },
      'only the signed-in web board can undo an agent’s change',
    );
    if (no) return no;
    return send(await s.planningUndoApi(parts[1], { actor }));
  }
  if (parts[0] === 'horizons' && parts[1] === 'close' && parts.length === 2 && method === 'POST') {
    const no = await gate('horizon.close', { install: true });
    if (no) return no;
    return send(await s.closeHorizon({ dryRun: Boolean(body.dryRun) }));
  }
  if (parts[0] === 'admin' && parts[1] === 'rebuild' && method === 'POST') {
    const no = await gate('install.admin', { install: true });
    if (no) return no;
    return send(await s.rebuild());
  }
  // Restoring the board from an export (BRK-234): the owner's, into an empty board only (an agent's `by` is refused).
  if (parts[0] === 'import' && parts.length === 1 && method === 'POST') {
    const no = await gate('install.admin', { install: true });
    if (no) return no;
    return send(await s.importApi(body));
  }
  if (parts[0] === 'github' && parts.length === 1 && method === 'GET')
    return send(await s.githubOverview(url.searchParams.get('repo')));
  // Connections (IDEA-14): anyone signed in reads them; Check now asks GitHub live and dismissing a note is the owner's, so both are the signed-in browser's only.
  if (parts[0] === 'connections') {
    if (parts.length === 1 && method === 'GET') return send(await s.connectionsApi(url.origin));
    if (parts[1] === 'check' && parts.length === 2 && method === 'POST') {
      const no = await gate('connections.check', { install: true }, 'only the signed-in web board can run Check now');
      if (no) return no;
      return send(await s.connectionsCheckApi(url.origin));
    }
    // Treat GitHub as working while its status page lags behind (BRK-218): the owner's call, so the browser's only.
    if (parts[1] === 'github-status' && parts[2] === 'override' && parts.length === 3 && method === 'POST') {
      const no = await gate(
        'connections.owner',
        { install: true },
        'only the signed-in web board can override GitHub’s status',
      );
      if (no) return no;
      return send(await s.githubStatusOverrideApi(body));
    }
    if (parts[1] === 'notices' && parts.length === 4 && parts[3] === 'dismiss' && method === 'POST') {
      const no = await gate(
        'connections.owner',
        { install: true },
        'only the signed-in web board can dismiss a connection note',
      );
      if (no) return no;
      return send(await s.connectionNoticeDismiss(parts[2]));
    }
  }
  // A provider's read-only token (BRK-194): the owner's form on Connections, the signed-in browser only, never the
  // bearer token agents hold. Reading it is Connections' GET; nothing ever answers with the token.
  if (
    parts[0] === 'infra' &&
    parts[1] === 'connections' &&
    parts.length === 3 &&
    (method === 'PUT' || method === 'DELETE')
  ) {
    const no = await gate('provider.connect', { install: true }, 'only the signed-in web board can connect a provider');
    if (no) return no;
    return send(method === 'PUT' ? await s.infraConnectApi(parts[2], body) : await s.infraForgetApi(parts[2], body));
  }
  // Self-update (BRK-53): an install with no repository of its own updates its Worker from the board. Every change is
  // the owner's, from the signed-in browser only: never the bearer token agents and the CLI hold.
  if (parts[0] === 'self-update') {
    if (parts.length === 1 && method === 'GET') return send(await s.selfUpdateApi());
    if (
      parts.length === 2 &&
      method === 'POST' &&
      ['enable', 'disable', 'start', 'rollback', 'check'].includes(parts[1])
    ) {
      const no = await gate(
        'install.update',
        { install: true },
        'only the signed-in web board can update or roll back the Worker',
      );
      if (no) return no;
      if (parts[1] === 'enable') return send(await s.selfUpdateEnable(body));
      if (parts[1] === 'disable') return send(await s.selfUpdateDisable());
      if (parts[1] === 'rollback') return send(await s.selfUpdateRollback());
      if (parts[1] === 'check') return send(await s.selfUpdateCheck());
      return send(await s.selfUpdateStart({ origin: url.origin }));
    }
  }
  // Repositories on the board (IDEA-14): anyone signed in reads them; adding and changing is the owner's (an agent's `by` is refused).
  if (parts[0] === 'repos') {
    if (parts.length === 1 && method === 'GET') return send(await s.reposApi());
    // The Add a repository wizard (CLD-194): a registered repository's steps, or one's by owner/name before it's registered.
    if (parts[1] === 'setup' && parts.length === 2 && method === 'GET') {
      const q = url.searchParams;
      return send(
        await s.repoSetupApi({ slug: q.get('slug'), github: q.get('github'), check: q.get('check') === '1' }),
      );
    }
    if (parts.length === 2 && method === 'GET') return send(await s.repoApi(parts[1]));
    if (parts.length === 1 && method === 'POST') {
      const no = await gate('repo.add', { install: true });
      if (no) return no;
      return send(await s.reposAddApi(body));
    }
    if (parts.length === 2 && method === 'PATCH') {
      const no = await gate('repo.modify', { repo: parts[1] });
      if (no) return no;
      return send(await s.reposModifyApi(parts[1], body));
    }
    if (parts.length === 2 && method === 'DELETE') {
      const no = await gate('repo.add', { install: true });
      if (no) return no;
      return send(await s.reposRemoveApi(parts[1], body));
    }
    if (parts.length === 3 && parts[2] === 'release' && method === 'POST') {
      const no = await gate('repo.add', { install: true });
      if (no) return no;
      return send(await s.reposReleaseApi(parts[1], body));
    }
    // Add the board's files (BRK-132): the owner's press writes an empty repository's first commit through the App.
    if (parts.length === 3 && parts[2] === 'init' && method === 'POST') {
      const no = await gate('repo.init', { repo: parts[1] }, 'only the signed-in web board can add the board’s files');
      if (no) return no;
      return send(await s.boardFilesApi(parts[1], { by: body.by, actor, origin: install(env).url ?? url.origin }));
    }
    // Lend the repository's routine to people with none of their own (BRK-302): the owner's press, like connecting it.
    if (
      parts.length === 4 &&
      parts[2] === 'routine' &&
      parts[3] === 'lend' &&
      (method === 'PUT' || method === 'DELETE')
    ) {
      const no = await gate('repo.routine', { install: true }, 'only the signed-in web board can lend a routine');
      if (no) return no;
      return send(await s.repoRoutineLendApi(parts[1], method === 'PUT', body));
    }
    // Connect a routine from the board (BRK-133): the owner's form, the signed-in browser only, never the bearer token.
    if (parts.length === 3 && parts[2] === 'routine' && (method === 'PUT' || method === 'DELETE')) {
      const no = await gate('repo.routine', { install: true }, 'only the signed-in web board can connect a routine');
      if (no) return no;
      return send(
        method === 'PUT' ? await s.repoRoutineConnectApi(parts[1], body) : await s.repoRoutineForgetApi(parts[1], body),
      );
    }
    // Turn on deploys (WEB-13) is the owner's press on the GitHub page: the signed-in browser only, never the bearer token.
    if (parts.length === 3 && parts[2] === 'pipeline' && method === 'POST') {
      const no = await gate('repo.deploys', { repo: parts[1] }, 'only the signed-in web board can turn on deploys');
      if (no) return no;
      return send(await s.turnOnDeploysApi(parts[1], body));
    }
    // Move to breakaway's deploy flow (WEB-12): the owner's press adds the move's task and starts its agent. The
    // signed-in browser only, never the bearer token agents hold.
    if (parts.length === 3 && parts[2] === 'move' && method === 'POST') {
      const no = await gate(
        'repo.move',
        { repo: parts[1] },
        'only the signed-in web board can move a repository to the deploy flow',
      );
      if (no) return no;
      return send(await s.moveApi(parts[1], body));
    }
  }
  // Kickoffs (IDEA-26): anyone signed in reads them; starting, changing, registering, and stopping one is the
  // owner's, from the signed-in browser only, never the bearer token agents and the CLI hold.
  if (parts[0] === 'kickoffs' && parts.length <= 3) {
    if (parts.length === 1 && method === 'GET')
      return send(await s.kickoffsApi({ idea: url.searchParams.get('idea'), repo: url.searchParams.get('repo') }));
    if (parts.length === 2 && method === 'GET')
      return send(await s.kickoffApi(parts[1], { check: url.searchParams.get('check') === '1' }));
    if (method !== 'GET') {
      const no = await gate(
        'kickoff',
        { install: true },
        'only the signed-in web board can kick off, change, or stop a project',
      );
      if (no) return no;
    }
    if (parts.length === 1 && method === 'POST') return send(await s.kickoffsCreateApi(body));
    if (parts.length === 2 && method === 'PATCH') return send(await s.kickoffsModifyApi(parts[1], body));
    if (parts.length === 2 && method === 'DELETE') return send(await s.kickoffsDeleteApi(parts[1], body));
    if (parts[2] === 'register' && method === 'POST') return send(await s.kickoffsRegisterApi(parts[1], body));
    if (parts[2] === 'run-it' && method === 'POST') return send(await s.kickoffsRunItApi(parts[1], body));
  }
  // A draft of an environment's desired state (BRK-240): read only, so agents with the token may ask as well as the owner.
  if (
    parts[0] === 'infra' &&
    parts[1] === 'environments' &&
    parts[3] === 'draft' &&
    parts.length === 4 &&
    method === 'GET'
  )
    return send(await s.infraDraftApi(parts[2], { repo: url.searchParams.get('repo') }));
  // What the console may change on an environment (BRK-262): read only, like the draft.
  if (
    parts[0] === 'infra' &&
    parts[1] === 'environments' &&
    parts[3] === 'editable' &&
    parts.length === 4 &&
    method === 'GET'
  )
    return send(await s.infraEditableApi(parts[2], { repo: url.searchParams.get('repo') }));
  // Describe it as code (WEB-92): anyone signed in reads the open task; starting one is the owner's press, from the
  // signed-in browser only, since it starts an agent.
  if (parts[0] === 'infra' && parts[1] === 'environments' && parts[3] === 'describe' && parts.length === 4) {
    const repo = url.searchParams.get('repo');
    if (method === 'GET') return send(await s.infraDescribeApi(parts[2], { repo }));
    if (method === 'POST') {
      const no = await gate(
        'environment.describe',
        { environment: parts[2], repo },
        'only the signed-in web board can have an agent describe an environment as code',
      );
      if (no) return no;
      return send(await s.infraDescribeStartApi(parts[2], { repo, by: body.by, force: body.force, actor }));
    }
  }
  // Changes from the console (BRK-259): anyone signed in reads them and the templates; previewing, proposing, and
  // rejecting one are the owner's, from the signed-in browser only, never the bearer token agents and the CLI hold.
  if (
    parts[0] === 'infra' &&
    parts[1] === 'environments' &&
    ['changes', 'templates'].includes(parts[3]) &&
    parts.length === 4
  ) {
    const repo = url.searchParams.get('repo');
    if (method === 'GET')
      return send(
        await (parts[3] === 'changes'
          ? s.infraChangesListApi(parts[2], { repo })
          : s.infraChangeTemplatesApi(parts[2], { repo })),
      );
    if (parts[3] === 'changes' && method === 'POST') {
      const no = await gate(
        'change.propose',
        { environment: parts[2], repo },
        'only the signed-in web board can change an environment',
      );
      if (no) return no;
      return send(await s.infraChangesApi(parts[2], { repo, ...body }));
    }
  }
  if (parts[0] === 'infra' && parts[1] === 'changes' && parts.length === 2 && method === 'GET')
    return send(
      await s.infraChangeByPullApi({ repo: url.searchParams.get('repo'), pull: url.searchParams.get('pull') }),
    );
  if (parts[0] === 'infra' && parts[1] === 'changes' && parts.length <= 4) {
    if (parts.length === 3 && method === 'GET') return send(await s.infraChangeApi(parts[2]));
    if (parts.length === 4 && parts[3] === 'reject' && method === 'POST') {
      const no = await gate('change.approve', { change: parts[2] }, 'only the signed-in web board can reject a change');
      if (no) return no;
      return send(await s.infraChangeRejectApi(parts[2], body));
    }
    // Approve (BRK-260) merges the change's pull request as the owner's action: the signed-in browser only, like Merge.
    if (parts.length === 4 && parts[3] === 'approve' && method === 'POST') {
      const no = await gate(
        'change.approve',
        { change: parts[2] },
        'only the signed-in web board can approve a change',
      );
      if (no) return no;
      return send(await s.infraChangeApproveApi(parts[2], body));
    }
  }
  // Who approves an environment's plans and changes (BRK-303): anyone who reads the environment reads its rule;
  // tightening it is a maintainer's press, loosening it the owner's (the store checks which).
  if (
    parts[0] === 'infra' &&
    parts[1] === 'environments' &&
    parts[3] === 'approval' &&
    parts.length === 4 &&
    ['GET', 'PUT'].includes(method)
  ) {
    const repo = url.searchParams.get('repo');
    if (method === 'GET') return send(await s.approvalRuleApi(parts[2], { repo }));
    const no = await gate(
      'policy.tighten',
      { environment: parts[2], repo },
      'only the signed-in web board can change who approves a plan',
    );
    if (no) return no;
    return send(await s.approvalRuleSetApi(parts[2], { repo, ...body }));
  }
  // Environments (BRK-174): anyone signed in reads them; adding, changing, and removing one is the owner's, from the
  // signed-in browser only, never the bearer token agents and the CLI hold (BRK-233). An agent's `by` is refused too.
  if (parts[0] === 'infra' && parts[1] === 'environments' && parts.length <= 3) {
    const repo = url.searchParams.get('repo');
    if (method === 'GET')
      return send(await (parts.length === 2 ? s.environmentsApi({ repo }) : s.environmentApi(parts[2], { repo })));
    if (['POST', 'PATCH', 'DELETE'].includes(method)) {
      const no = await gate(
        'environment.write',
        parts.length === 2 ? { repo: body.repo } : { environment: parts[2], repo },
        'only the signed-in web board can add, change, or remove an environment',
      );
      if (no) return no;
    }
    if (parts.length === 2 && method === 'POST') return send(await s.environmentsCreateApi(body));
    if (parts.length === 3 && method === 'PATCH')
      return send(await s.environmentsModifyApi(parts[2], { repo, ...body }));
    if (parts.length === 3 && method === 'DELETE')
      return send(await s.environmentsDeleteApi(parts[2], { repo, ...body }));
  }
  // Desired state (BRK-180): read only, from each repository's default branch; it changes by pull request.
  if (parts[0] === 'infra' && parts[1] === 'desired' && parts.length <= 3 && method === 'GET') {
    const repo = url.searchParams.get('repo');
    return send(await (parts.length === 2 ? s.desiredApi({ repo }) : s.desiredOneApi(parts[2], { repo })));
  }
  // Policy (BRK-181): read only, from each repository's default branch, or the default; it changes by pull request.
  if (parts[0] === 'infra' && parts[1] === 'policy' && parts.length === 2 && method === 'GET')
    return send(await s.policyApi({ repo: url.searchParams.get('repo') }));
  // The Policy view (WEB-123): anyone signed in reads it; previewing, proposing, approving, and rejecting a policy
  // change are the owner's, from the signed-in browser only, never the bearer token agents and the CLI hold.
  if (parts[0] === 'infra' && parts[1] === 'policy' && parts[2] === 'view' && parts.length === 3 && method === 'GET')
    return send(await s.infraPolicyViewApi({ repo: url.searchParams.get('repo') }));
  if (parts[0] === 'infra' && parts[1] === 'policy' && parts[2] === 'changes' && method === 'POST') {
    const no = await gate(
      parts.length === 3 ? 'policy.propose' : 'policy.tighten',
      parts.length === 3 ? { repo: body.repo } : { policyChange: parts[3] },
      'only the signed-in web board can change the policy',
    );
    if (no) return no;
    if (parts.length === 3) return send(await s.infraPolicyChangesApi(body));
    if (parts.length === 5 && parts[4] === 'approve') return send(await s.infraPolicyChangeApproveApi(parts[3], body));
    if (parts.length === 5 && parts[4] === 'reject') return send(await s.infraPolicyChangeRejectApi(parts[3], body));
  }
  // Scaling rules (BRK-241): read only, from each repository's default branch; they change by pull request.
  if (parts[0] === 'infra' && parts[1] === 'scaling' && parts.length === 2 && method === 'GET')
    return send(await s.scalingApi({ repo: url.searchParams.get('repo') }));
  // The board's currency (BRK-226): anyone signed in reads it; setting it and its rate is the owner's, from the
  // signed-in browser only.
  if (parts[0] === 'infra' && parts[1] === 'currency' && parts.length === 2) {
    if (method === 'GET') return send(await s.currencyApi());
    if (method === 'PUT') {
      const no = await gate('currency', { install: true }, 'only the signed-in web board can set the board’s currency');
      if (no) return no;
      return send(await s.currencySetApi(body));
    }
  }
  // Fetch today's rate (BRK-239): only on the owner's press in Settings, from the signed-in browser; it fills the field.
  if (
    parts[0] === 'infra' &&
    parts[1] === 'currency' &&
    parts[2] === 'rate' &&
    parts.length === 3 &&
    method === 'POST'
  ) {
    const no = await gate('currency', { install: true }, 'only the signed-in web board can fetch a rate');
    if (no) return no;
    return send(await s.currencyRateApi(body));
  }
  // infra check's preview (CLI-14): the plan a checkout's file would make, kept nowhere, so an agent may ask.
  if (parts[0] === 'infra' && parts[1] === 'check' && parts.length === 2 && method === 'POST') {
    const no = await gate('infra.check', { repo: body.repo });
    if (no) return no;
    return send(await s.infraCheckApi(body));
  }
  // Inventory (BRK-177): anyone signed in reads it and when the board last looked; a refresh is the board's own (the
  // cron, a token just pasted) or the owner's Refresh, from the signed-in browser only (BRK-248). An agent's `by` is
  // refused too.
  if (parts[0] === 'infra' && parts[1] === 'inventory') {
    const q = (name) => url.searchParams.get(name);
    if (parts.length === 3 && parts[2] === 'refresh' && method === 'GET')
      return send(await s.inventoryRefreshStateApi());
    if (parts.length === 3 && parts[2] === 'refresh' && method === 'POST') {
      const no = await gate(
        'inventory.refresh',
        { install: true },
        'only the signed-in web board can refresh the inventory',
      );
      if (no) return no;
      return send(await s.inventoryRefreshApi(body));
    }
    if (parts.length === 2 && method === 'GET')
      return send(
        await s.inventoryApi({
          repo: q('repo'),
          environment: q('environment'),
          provider: q('provider'),
          kind: q('kind'),
        }),
      );
    if (parts.length >= 3 && method === 'GET')
      return send(
        await s.inventoryResourceApi(parts.slice(2).join('/'), { repo: q('repo'), environment: q('environment') }),
      );
  }
  // Cost (BRK-199): read only, by environment, repository, and owning task, with budgets and each month's series.
  if (parts[0] === 'infra' && parts[1] === 'costs' && parts.length === 2 && method === 'GET')
    return send(
      await s.costsApi({ repo: url.searchParams.get('repo'), environment: url.searchParams.get('environment') }),
    );
  // Environment locks (BRK-179): anyone signed in reads them; the executor takes and releases them inside the board
  // (BRK-183), and releasing one by force is the owner's, from the signed-in browser only.
  if (parts[0] === 'infra' && parts[1] === 'locks' && parts.length <= 3) {
    const repo = url.searchParams.get('repo');
    if (method === 'GET')
      return send(await (parts.length === 2 ? s.locksApi({ repo }) : s.lockApi(parts[2], { repo })));
    if (parts.length === 3 && method === 'DELETE') {
      const no = await gate(
        'lock.release',
        { environment: parts[2], repo },
        'only the signed-in web board can release an environment’s lock',
      );
      if (no) return no;
      return send(await s.lockReleaseApi(parts[2], { repo, actor }));
    }
  }
  // The executor's runs (BRK-183): anyone signed in reads them. The runner's own calls come in with its OIDC token,
  // above; nothing here changes a run.
  if (parts[0] === 'infra' && parts[1] === 'runs' && parts.length <= 3 && method === 'GET')
    return send(
      await (parts.length === 2
        ? s.runsApi({ repo: url.searchParams.get('repo'), environment: url.searchParams.get('environment') })
        : s.runApi(parts[2])),
    );
  // Envelopes (BRK-186): anyone signed in reads them; setting, changing, and revoking one is the owner's, from the
  // signed-in browser only. An act is a runbook's agent's, for the run it holds; the board builds its plan.
  if (parts[0] === 'infra' && parts[1] === 'envelopes' && parts.length <= 4) {
    const repo = url.searchParams.get('repo');
    if (parts.length === 4 && parts[3] === 'act' && method === 'POST') {
      const no = await gate('envelope.act', { environment: parts[2], repo });
      if (no) return no;
      return send(await s.envelopeActApi(parts[2], body));
    }
    if (parts.length <= 3 && method === 'GET')
      return send(await (parts.length === 2 ? s.envelopesApi({ repo }) : s.envelopeApi(parts[2], { repo })));
    if (parts.length === 3 && ['PUT', 'DELETE'].includes(method)) {
      const no = await gate(
        method === 'PUT' ? 'envelope.set' : 'envelope.revoke',
        { environment: parts[2], repo },
        'only the signed-in web board can set or revoke an envelope',
      );
      if (no) return no;
      return send(
        await (method === 'PUT'
          ? s.envelopeSetApi(parts[2], { repo, ...body })
          : s.envelopeRevokeApi(parts[2], { repo, ...body })),
      );
    }
  }
  // Approve and reject (BRK-182): the owner's alone, from the signed-in browser only, like Merge; never the bearer
  // token agents and the CLI hold. An agent's `by` is refused too.
  if (parts[0] === 'infra' && parts[1] === 'plans' && parts.length === 4 && ['approve', 'reject'].includes(parts[3])) {
    if (method !== 'POST') return json(405, { error: `${parts[3]} a plan with POST` });
    const no = await gate('plan.approve', { plan: parts[2] }, `only the signed-in web board can ${parts[3]} a plan`);
    if (no) return no;
    return send(await (parts[3] === 'approve' ? s.planApproveApi(parts[2], body) : s.planRejectApi(parts[2], body)));
  }
  // Start the run again (BRK-308): the owner's, from the signed-in browser only, for a run that applied nothing.
  if (parts[0] === 'infra' && parts[1] === 'plans' && parts.length === 4 && parts[3] === 'start-again') {
    if (method !== 'POST') return json(405, { error: 'start a plan’s run again with POST' });
    const no = await gate(
      'plan.start-again',
      { plan: parts[2] },
      'only the signed-in web board can start a plan’s run again',
    );
    if (no) return no;
    return send(await s.runStartAgainApi(parts[2], body));
  }
  // Plans (BRK-178): anyone signed in reads them; the owner and agents make drafts, which the board computes from the
  // environment's desired state; only the owner puts one in front of the owner, from the signed-in browser only.
  if (parts[0] === 'infra' && parts[1] === 'plans' && parts.length <= 3) {
    const q = (name) => url.searchParams.get(name) ?? undefined;
    if (method === 'GET')
      return send(
        await (parts.length === 2
          ? s.plansApi({
              repo: q('repo'),
              environment: q('environment'),
              state: q('state'),
              before: q('before'),
              limit: q('limit'),
            })
          : s.planApi(parts[2])),
      );
    if (parts.length === 2 && method === 'POST') {
      const no = await gate('plan.create', { environment: body.environment, repo: body.repo });
      if (no) return no;
      return send(await s.plansCreateApi(body));
    }
    if (parts.length === 3 && method === 'PATCH') {
      const no = await gate(
        'plan.front',
        { plan: parts[2] },
        'only the signed-in web board can put a plan in front of you',
      );
      if (no) return no;
      return send(await s.planModifyApi(parts[2], body));
    }
  }
  // Drift (BRK-184): anyone signed in reads it; comparing an environment now is the owner's, from the signed-in browser
  // only (the cron compares them anyway). A plan it makes is a draft.
  if (parts[0] === 'infra' && parts[1] === 'drift' && parts.length <= 3) {
    const repo = url.searchParams.get('repo');
    if (method === 'GET')
      return send(await (parts.length === 2 ? s.driftApi({ repo }) : s.driftOneApi(parts[2], { repo })));
    if (parts.length === 3 && method === 'POST') {
      const no = await gate(
        'inventory.refresh',
        { environment: parts[2], repo },
        'only the signed-in web board can compare an environment now',
      );
      if (no) return no;
      return send(await s.driftCheckApi(parts[2], { repo, ...body }));
    }
  }
  // Clean up (BRK-201): anyone signed in reads what nobody owns; only the board flags it, on drift's comparison.
  if (parts[0] === 'infra' && parts[1] === 'cleanup' && parts.length === 2 && method === 'GET')
    return send(
      await s.cleanupApi({ repo: url.searchParams.get('repo'), environment: url.searchParams.get('environment') }),
    );
  // Break-glass (BRK-187): anyone signed in reads the marks; marking drift as break-glass is the owner's, from the
  // signed-in browser only. It records the change and makes a task to put it into code; it never undoes it.
  if (parts[0] === 'infra' && parts[1] === 'break-glass' && parts.length <= 3) {
    const repo = url.searchParams.get('repo');
    if (parts.length === 2 && method === 'GET')
      return send(await s.breakGlassApi({ repo, environment: url.searchParams.get('environment') }));
    if (parts.length === 3 && method === 'POST') {
      const no = await gate(
        'drift.break-glass',
        { environment: parts[2], repo },
        'only the signed-in web board can mark drift as break-glass',
      );
      if (no) return no;
      return send(await s.breakGlassMarkApi(parts[2], { repo, ...body }));
    }
  }
  // Guided token setup (BRK-304): anyone signed in reads the checklist; Make it on GitHub is the owner's, from the
  // signed-in browser only. The board never takes a write token: the owner adds it on GitHub.
  if (parts[0] === 'infra' && parts[1] === 'tokens') {
    if (parts.length === 2 && method === 'GET')
      return send(await s.infraTokensApi({ repo: url.searchParams.get('repo'), fresh: url.searchParams.get('fresh') }));
    if (parts.length === 4 && parts[2] === 'environments' && method === 'POST') {
      const no = await gate(
        'github-environment.make',
        { repo: url.searchParams.get('repo') },
        'only the signed-in web board can make a GitHub environment',
      );
      if (no) return no;
      return send(await s.infraTokensMakeApi(parts[3], { repo: url.searchParams.get('repo') }, body));
    }
  }
  // Short-lived environments (BRK-200): anyone signed in reads the requests; asking for one from the board is the
  // owner's, from the signed-in browser only. Agents ask with the +environment tag; either way, plans decide.
  if (parts[0] === 'infra' && parts[1] === 'short-lived' && parts.length <= 3) {
    if (parts.length === 2 && method === 'GET')
      return send(await s.shortLivedApi({ repo: url.searchParams.get('repo') }));
    if (parts.length === 3 && method === 'POST') {
      const no = await gate(
        'short-lived.ask',
        { task: parts[2] },
        'only the signed-in web board asks for an environment; agents tag their task +environment',
      );
      if (no) return no;
      return send(await s.shortLivedAskApi(parts[2], body));
    }
  }
  // Features (IDEA-28): anyone signed in reads them, and agents shaping an idea may add one; aiming one at a
  // release, changing it, and deleting it are the owner's (an agent's `by` is refused).
  if (parts[0] === 'features') {
    // A feature's planned dates are the owner's on the board (WEB-104): the CLI's token reads them and can't set them.
    if ((method === 'POST' || method === 'PATCH') && !press && plansDates(body))
      return json(403, {
        error: 'only the owner plans a feature’s dates, signed in to the web board: the CLI reads them',
      });
    if (parts.length === 1 && method === 'GET') return send(await s.featuresApi(reader));
    if (parts.length === 1 && method === 'POST') {
      // A new feature is its tasks' repositories', or its idea's; one with neither is the whole board's. Making one
      // from tasks, or shaping it, or giving it a state or dates, is a maintainer's; the rest a member's.
      const shapes = 'tasks' in body || 'from' in body || body.shape || 'state' in body || plansDates(body);
      const no = await gate(
        shapes ? 'feature.shape' : 'feature.edit',
        Array.isArray(body.tasks)
          ? { tasks: body.tasks }
          : body.from
            ? { task: body.from }
            : body.shape?.repo
              ? { repo: body.shape.repo }
              : { install: true },
      );
      if (no) return no;
      return send(await s.featuresCreateApi(body));
    }
    if (parts.length === 2 && method === 'GET') return send(await s.featureApi(parts[1], reader));
    if (parts.length === 2 && method === 'PATCH') {
      const no = await gate('state' in body || plansDates(body) ? 'feature.shape' : 'feature.edit', {
        feature: parts[1],
      });
      if (no) return no;
      return send(await s.featuresModifyApi(parts[1], body));
    }
    if (parts.length === 2 && method === 'DELETE') {
      const no = await gate('feature.shape', { feature: parts[1] });
      if (no) return no;
      return send(await s.featuresDeleteApi(parts[1], body));
    }
    // A chase (section 3) is the owner's: an agent's `by` is refused.
    if (parts.length === 3 && parts[2] === 'chase' && method === 'POST') {
      const no = await gate('chase', { feature: parts[1] });
      if (no) return no;
      return send(await s.featureChaseApi(parts[1], body));
    }
    // A chase's digest (BRK-277): anyone signed in reads it.
    if (parts.length === 4 && parts[2] === 'digests' && method === 'GET')
      return send(await s.featureDigestApi(parts[1], parts[3]));
    // The road captain's log and handover (BRK-275): the captain's own, by its `by`.
    if (parts.length === 3 && parts[2] === 'captain' && method === 'POST') {
      const no = await gate('task.write', { feature: parts[1] });
      if (no) return no;
      return send(await s.featureCaptainApi(parts[1], body));
    }
  }
  if (parts[0] === 'routines') {
    if (parts.length === 1 && method === 'GET') return send(await s.routinesApi());
    if (parts.length === 1 && method === 'POST') {
      const no = await gate('routine.write', { repo: body.repo });
      if (no) return no;
      return send(await s.routinesCreateApi(body));
    }
    // Make with an agent (BRK-220 section 2): the owner's, from the board or the owner's own CLI (no agent's `by`).
    if (parts[1] === 'agent' && parts.length === 2 && method === 'POST') {
      const no = await gate('agent.general', { repo: body.repo });
      if (no) return no;
      return send(await s.routinesAgentApi(body));
    }
    if (parts[1] === 'settings' && parts.length === 2 && (method === 'PATCH' || method === 'POST')) {
      const no = await gate('routine.settings', { install: true });
      if (no) return no;
      return send(await s.routinesSettingsApi(body));
    }
    if (
      (parts.length === 2 && method === 'PATCH') ||
      (parts[2] === 'triggers' && parts.length === 3 && method === 'POST') ||
      (parts[2] === 'triggers' && parts.length === 4 && method === 'DELETE') ||
      (parts[2] === 'run' && parts.length === 3 && method === 'POST')
    ) {
      const no = await gate('routine.write', { routine: parts[1] });
      if (no) return no;
    }
    if (parts.length === 2 && method === 'PATCH') return send(await s.routinesModifyApi(parts[1], body));
    if (parts[2] === 'triggers' && parts.length === 3 && method === 'POST')
      return send(await s.routinesTriggerCreateApi(parts[1], body));
    if (parts[2] === 'triggers' && parts.length === 4 && method === 'DELETE')
      return send(await s.routinesTriggerRevokeApi(parts[1], parts[3], body));
    if (parts[2] === 'run' && parts.length === 3 && method === 'POST')
      return send(await s.routinesRunApi(parts[1], body));
  }
  // A repository's specs (IDEA-31, section 2), read from GitHub: the path is the file's, like docs/specs/BRK-1-x.md.
  if (parts[0] === 'specs' && method === 'GET') {
    if (parts.length === 1) return send(await s.specsApi(url.searchParams.get('repo')));
    return send(await s.specApi(url.searchParams.get('repo'), parts.slice(1).join('/')));
  }
  // Runbooks (BRK-196): anyone signed in reads them; a routine's signal trigger is the owner's, from the signed-in
  // browser only, since it lets a signal start an agent.
  if (parts[0] === 'infra' && parts[1] === 'runbooks' && parts.length <= 3) {
    if (parts.length === 2 && method === 'GET') return send(await s.runbooksApi());
    if (parts.length === 3 && (method === 'PUT' || method === 'DELETE')) {
      const no = await gate(
        'runbook.trigger',
        { routine: parts[2] },
        'only the signed-in web board can change a routine’s signal trigger',
      );
      if (no) return no;
      return send(await (method === 'PUT' ? s.runbookSetApi(parts[2], body) : s.runbookRemoveApi(parts[2], body)));
    }
  }
  // Incidents (BRK-197): read only; the board opens them from the signals stream, and each one is a +incident task.
  if (parts[0] === 'infra' && parts[1] === 'incidents' && parts.length <= 3 && method === 'GET') {
    const q = url.searchParams;
    if (parts.length === 3) return send(await s.incidentApi(parts[2]));
    return send(
      await s.incidentsApi({
        repo: q.get('repo') ?? undefined,
        environment: q.get('environment') ?? undefined,
        open: q.get('open') ?? undefined,
        before: q.get('before') ?? undefined,
        limit: q.get('limit') ?? undefined,
      }),
    );
  }
  // Architect's signals (BRK-190): read only, for the token and the cookie alike; providers and the deploy flow write
  // inside the store. /days is the daily summaries the cron folds older signals into.
  if (
    parts[0] === 'infra' &&
    parts[1] === 'signals' &&
    (parts.length === 2 || (parts.length === 3 && parts[2] === 'days'))
  ) {
    if (method !== 'GET') return json(405, { error: 'signals are read only here: providers report them to the board' });
    const q = url.searchParams;
    const query = {
      environment: q.get('environment') ?? undefined,
      environmentId: q.get('environmentId') ?? undefined,
      resource: q.get('resource') ?? undefined,
      source: q.get('source') ?? undefined,
      kind: q.get('kind') ?? undefined,
    };
    if (parts.length === 3) return send(await s.infraSignalDaysApi(query));
    return send(
      await s.infraSignalsApi({
        ...query,
        level: q.get('level') ?? undefined,
        before: q.get('before') ?? undefined,
        limit: q.get('limit') ?? undefined,
      }),
    );
  }
  // A provider's account-wide alerts (BRK-255): kept once per provider, not in each environment's stream. Read only.
  if (parts[0] === 'infra' && parts[1] === 'account-alerts' && parts.length === 2) {
    if (method !== 'GET') return json(405, { error: 'account-wide alerts are read only here: providers report them' });
    const q = url.searchParams;
    return send(
      await s.infraAccountAlertsApi({ source: q.get('source') ?? undefined, limit: q.get('limit') ?? undefined }),
    );
  }
  // Which of a provider's alerts reach the board (BRK-191): a live read with its read-only token, for the token and the
  // cookie alike. The alerts themselves are signals (kind=alert).
  if (parts[0] === 'infra' && parts[1] === 'alerts' && parts.length === 2) {
    if (method !== 'GET') return json(405, { error: 'alerts are set up in the provider’s dashboard, not here' });
    return send(await s.infraAlertsApi({ provider: url.searchParams.get('provider') ?? undefined }));
  }
  // Mark approved and Mark built on a spec (BRK-215) open a pull request: the owner's press, from the signed-in
  // browser only, never the bearer token agents and the CLI hold.
  if (parts[0] === 'specs' && parts.length > 1 && method === 'POST') {
    const no = await gate(
      'spec.status',
      { repo: url.searchParams.get('repo') ?? body?.repo },
      'only the signed-in web board can mark a spec approved or built',
    );
    if (no) return no;
    return send(
      await s.specStatusApi(url.searchParams.get('repo') ?? body?.repo ?? null, parts.slice(1).join('/'), body),
    );
  }
  // Sign-ins from MCP apps (BRK-157): approving, denying, listing, and revoking are the owner's, from the
  // signed-in browser only, never the bearer token agents and the CLI hold.
  if (parts[0] === 'oauth') {
    const no = await gate('oauth', { install: true }, 'only the signed-in web board can approve or revoke a sign-in');
    if (no) return no;
    const res = await oauthApi(parts, method, body, s, url.origin);
    if (res) return res;
  }
  if (parts[0] === 'pings' && parts.length === 1 && method === 'GET') return send(await s.pingsApi(reader));
  // Architect's audit trail (BRK-175): read only, for the token and the cookie alike; the control plane appends inside
  // the store, and nothing changes or removes an entry.
  if (parts[0] === 'infra' && parts[1] === 'audit' && parts.length === 2) {
    if (method !== 'GET')
      return json(405, { error: 'the audit trail is append-only: entries can’t be changed or removed' });
    const q = url.searchParams;
    return send(
      await s.infraAuditApi({
        environment: q.get('environment') ?? undefined,
        environmentId: q.get('environmentId') ?? undefined,
        repo: q.get('repo') ?? undefined,
        kind: q.get('kind') ?? undefined,
        plan: q.get('plan') ?? undefined,
        before: q.get('before') ?? undefined,
        limit: q.get('limit') ?? undefined,
      }),
    );
  }
  // The peloton (IDEA-32, IDEA-36): agents post as the holder of a claimed task, with the bearer token. A post from
  // the signed-in browser is the owner's, and only the signed-in browser posts as the owner, never the bearer token.
  if (parts[0] === 'peloton') {
    if (parts.length === 1 && method === 'GET') return send(await s.pelotonApi(url.searchParams.get('agent')));
    // Listening and the open posts always name the agent, so a repository whose slug is `listen` or `open` keeps its page.
    if (parts.length === 2 && parts[1] === 'listen' && url.searchParams.has('agent') && method === 'GET')
      return send(await s.pelotonListenApi(url.searchParams.get('agent'), url.searchParams.get('task')));
    if (parts.length === 2 && parts[1] === 'open' && url.searchParams.has('agent') && method === 'GET')
      return send(await s.pelotonOpenApi(url.searchParams.get('agent'), url.searchParams.get('task')));
    if (parts.length === 2 && method === 'GET') return send(await s.pelotonDetailApi(parts[1]));
    // From the signed-in board a post is a person's own; with the token, an agent's.
    if (parts.length === 2 && method === 'POST') {
      const no = await gate(press ? 'peloton.post' : 'task.write', { peloton: parts[1] });
      if (no) return no;
      return send(await (press ? s.pelotonOwnerPostApi(parts[1], body) : s.pelotonPostApi(parts[1], body)));
    }
    if (parts.length === 3 && parts[2] === 'plan' && method === 'GET') return send(await s.pelotonPlanApi(parts[1]));
    if (parts.length === 3 && parts[2] === 'plan' && method === 'PUT') {
      const no = await gate(press ? 'peloton.plan' : 'task.write', { peloton: parts[1] });
      if (no) return no;
      return send(await (press ? s.pelotonOwnerPlanApi(parts[1], body) : s.pelotonPlanReviseApi(parts[1], body)));
    }
  }
  // Notifications are the owner's: the signed-in browser only, never the bearer token agents hold.
  if (parts[0] === 'push' && parts.length <= 2) {
    const no = await gate('push', { install: true }, 'only the signed-in web board can change notifications');
    if (no) return no;
    if (parts.length === 1 && method === 'GET') return send(await s.pushConfigApi());
    if (parts[1] === 'subscriptions' && method === 'POST') return send(await s.pushSubscribeApi(body));
    if (parts[1] === 'subscriptions' && method === 'DELETE') return send(await s.pushUnsubscribeApi(body));
  }
  // Resolving a ping is the owner's: the signed-in browser only, never the bearer token agents and the CLI hold.
  if (
    parts[0] === 'pings' &&
    parts.length === 3 &&
    method === 'POST' &&
    ['apply', 'dismiss', 'handled'].includes(parts[2])
  ) {
    const no = await gate(
      parts[2] === 'apply' ? 'ping.apply' : 'ping.resolve',
      { ping: parts[1] },
      'only the signed-in web board can apply, dismiss, or mark a ping handled',
    );
    if (no) return no;
    if (parts[2] === 'apply') return send(await s.pingApply(parts[1], body));
    return send(await (parts[2] === 'dismiss' ? s.pingDismiss(parts[1], body) : s.pingHandled(parts[1], body)));
  }
  if (parts[0] === 'agents') {
    if (parts.length === 1 && method === 'GET') return send(await s.agentsApi({ actor }));
    if (parts[1] === 'prompt' && parts.length === 2 && method === 'GET')
      return send(await s.routinePromptApi(url.searchParams.get('repo')));
    if (parts[1] === 'start' && method === 'POST') {
      const no = await gate(body.force ? 'agent.force' : 'agent.start', { task: body.ref });
      if (no) return no;
      return send(
        await s.agentsStartApi(body.ref, body.note ? String(body.note) : null, body.mode ? String(body.mode) : null, {
          force: body.force,
          anyway: Boolean(body.anyway),
          by: body.by,
          actor,
        }),
      );
    }
    if (parts[1] === 'general' && parts.length === 2 && method === 'POST') {
      const no = await gate('agent.general', { repo: body.repo });
      if (no) return no;
      return send(await s.agentsGeneralApi(body));
    }
    if (parts[1] === 'next' && method === 'POST') {
      const no = await gate('agent.next', { repo: body.repo });
      if (no) return no;
      return send(
        await s.agentsNextApi({
          count: body.count,
          horizon: body.horizon ?? null,
          repo: body.repo ?? null,
          dryRun: Boolean(body.dryRun),
        }),
      );
    }
    if (parts[1] === 'settings' && (method === 'PATCH' || method === 'POST')) {
      const no = await gate('agent.settings', { install: true });
      if (no) return no;
      return send(
        await s.agentsSettingsApi({
          max: body.max,
          hourly: body.hourly,
          autostart: body.autostart,
          alerts: body.alerts,
          perArea: body.perArea,
          plan: body.plan,
          by: body.by,
          actor,
        }),
      );
    }
  }
  if (parts[0] === 'github' && parts[1] === 'pulls' && parts.length === 3 && method === 'GET')
    return send(await s.githubPullApi(parts[2], url.searchParams.get('repo')));
  if (parts[0] === 'github' && parts[1] === 'pulls' && parts[3] === 'file' && parts.length === 4 && method === 'GET')
    return send(
      await s.githubPullFileApi(parts[2], {
        path: url.searchParams.get('path'),
        side: url.searchParams.get('side'),
        slug: url.searchParams.get('repo'),
      }),
    );
  if (parts[0] === 'github' && parts[1] === 'pulls' && parts[3] === 'fix' && parts.length === 4 && method === 'POST') {
    const no = await gate(body.force ? 'agent.force' : 'agent.start', {
      repo: body.repo ?? url.searchParams.get('repo'),
    });
    if (no) return no;
    return send(await s.fixPrApi(parts[2], { ...body, repo: body.repo ?? url.searchParams.get('repo') }));
  }
  // Merging is the owner's: the signed-in browser only, never the bearer token agents and the CLI hold.
  if (
    parts[0] === 'github' &&
    parts[1] === 'pulls' &&
    parts.length === 4 &&
    method === 'POST' &&
    ['update-branch', 'merge', 'auto-merge', 'publish'].includes(parts[3])
  ) {
    const no = await gate(
      'pull.write',
      { repo: body.repo ?? url.searchParams.get('repo') },
      'only the signed-in web board can publish, update, merge, or set auto-merge on a pull request',
    );
    if (no) return no;
    return send(
      await s.githubWrite(parts[2], parts[3], {
        sha: body.sha,
        method: body.method,
        enable: body.enable,
        setting: body.setting,
        repo: body.repo ?? url.searchParams.get('repo'),
        actor,
      }),
    );
  }
  // Promote and Roll back are the owner's too: the signed-in browser only, and the workflows check everything again.
  if (parts[0] === 'github' && ['promote', 'rollback'].includes(parts[1]) && parts.length === 2 && method === 'POST') {
    const no = await gate(
      'deploy.promote',
      { repo: body.repo ?? url.searchParams.get('repo') },
      'only the signed-in web board can promote or roll back',
    );
    if (no) return no;
    return send(
      await s.githubRelease(parts[1], {
        sha: body.sha,
        destructiveOk: body.destructiveOk,
        version: body.version,
        reason: body.reason,
        repo: body.repo ?? url.searchParams.get('repo'),
        actor,
      }),
    );
  }
  // Release a package's pre-release as stable (BRK-103), with what main works toward next (WEB-39): the owner's, from the signed-in browser or the owner's own CLI
  // (a token with no agent's name). The board only starts release.yml's stable job; npm waits for the owner's 2FA.
  if (parts[0] === 'github' && parts[1] === 'release' && parts.length === 2 && method === 'POST') {
    if (!press && agentOf(body.by, actor.person))
      return json(403, { error: 'only the owner can release a package; agents never start a release' });
    const no = await gate('release.publish', { repo: body.repo ?? url.searchParams.get('repo') });
    if (no) return no;
    return send(
      await s.githubRelease('release', {
        version: body.version,
        next: body.next,
        repo: body.repo ?? url.searchParams.get('repo'),
        actor,
      }),
    );
  }
  // Build a pre-release (WEB-113): starts the release workflow's pre-release job on the default branch. The owner's,
  // from the signed-in browser only; an agent never starts one.
  if (parts[0] === 'github' && parts[1] === 'prerelease' && parts.length === 2 && method === 'POST') {
    const no = await gate(
      'release.prerelease',
      { repo: body.repo ?? url.searchParams.get('repo') },
      'only the signed-in web board can build a pre-release',
    );
    if (no) return no;
    if (agentOf(body.by, actor.person))
      return json(403, { error: 'only the owner builds a pre-release; agents never start one' });
    return send(await s.githubRelease('prerelease', { repo: body.repo ?? url.searchParams.get('repo') }));
  }
  // Workflows that run by hand (BRK-224): anyone signed in lists them; running one is the owner's, from the signed-in
  // browser only, never the bearer token agents, the CLI, the MCP server, and routines hold.
  if (parts[0] === 'github' && parts[1] === 'workflows' && parts.length === 2 && method === 'GET')
    return send(await s.workflowsApi(url.searchParams.get('repo')));
  if (
    parts[0] === 'github' &&
    parts[1] === 'workflows' &&
    parts[2] === 'run' &&
    parts.length === 3 &&
    method === 'POST'
  ) {
    const no = await gate(
      'workflow.run',
      { repo: body.repo ?? url.searchParams.get('repo') },
      'only the signed-in web board can run a workflow',
    );
    if (no) return no;
    return send(
      await s.runWorkflowApi({
        repo: body.repo ?? url.searchParams.get('repo'),
        workflow: body.workflow,
        ref: body.ref,
        inputs: body.inputs,
        actor,
      }),
    );
  }
  if (parts[0] === 'github' && parts[1] === 'packages' && parts.length === 2 && method === 'GET')
    return send(await s.packagesApi(url.searchParams.get('repo')));
  if (parts[0] === 'github' && parts[1] === 'sync' && method === 'POST') {
    const no = await gate('github.sync', { repo: body.repo ?? url.searchParams.get('repo') });
    if (no) return no;
    return send(await s.githubSyncApi(body.repo ?? url.searchParams.get('repo')));
  }
  if (parts[0] === 'github' && parts[1] === 'alerts' && parts[3] === 'fix' && method === 'POST') {
    const no = await gate(body.force ? 'agent.force' : 'agent.start', {
      repo: body.repo ?? url.searchParams.get('repo'),
    });
    if (no) return no;
    return send(
      await s.fixAlertApi(parts[2], body.note ? String(body.note) : null, body.repo ?? url.searchParams.get('repo'), {
        force: body.force,
        by: body.by,
        actor,
      }),
    );
  }
  if (
    parts[0] === 'github' &&
    parts[1] === 'pulls' &&
    parts[3] === 'review' &&
    parts.length === 4 &&
    method === 'POST'
  ) {
    const no = await gate(body.force ? 'agent.force' : 'agent.general', {
      repo: body.repo ?? url.searchParams.get('repo'),
    });
    if (no) return no;
    return send(
      await s.reviewPullApi(parts[2], body.note ? String(body.note) : null, body.repo ?? url.searchParams.get('repo'), {
        force: body.force,
        by: body.by,
        actor,
      }),
    );
  }
  if (parts[0] === 'github' && parts[1] === 'setup' && method === 'POST') {
    const no = await gate('github.setup', { install: true });
    if (no) return no;
    return json(200, await s.githubSetup(url.origin));
  }
  // Rotation is for the owner's CLI (bearer token), never the web board's cookie.
  if (parts[0] === 'admin' && parts[1] === 'rekey' && method === 'POST' && via === 'token')
    return send(await s.rekey(body.clientId, body.key));

  if (parts[0] === 'tasks') {
    const [, ref, action] = parts;
    if (!ref) {
      if (method === 'GET') return send(await s.list(url.searchParams.get('status') ?? 'pending'));
      if (method === 'POST') {
        const items = Array.isArray(body) ? body : Array.isArray(body.tasks) ? body.tasks : [body];
        const no = await gate(items.some(plansTask) ? 'task.plan' : 'task.write', {
          repos: items.map((item) => item?.repo),
        });
        if (no) return no;
        // Anyone adding a task first hears of the open ones it resembles (BRK-283); `force` on an item adds it anyway.
        return send(await s.create(items.map(theirs), { similar: true, actor }));
      }
    } else if (!action) {
      if (method === 'GET') return send(await s.get(ref));
      if (method === 'PATCH') {
        const no = await gate(plansTask(body) ? 'task.plan' : 'task.write', { task: ref });
        if (no) return no;
        return send(await s.update(ref, theirs(body)));
      }
    } else if (action === 'messages') {
      // Telling an agent what to do is the owner's: the signed-in browser only, never the bearer token every agent holds (IDEA-15).
      if (parts.length === 3 && method === 'POST') {
        const no = await gate('agent.message', { task: ref }, 'only the signed-in web board can message an agent');
        if (no) return no;
        return send(await s.messageSendApi(ref, body));
      }
      if (parts.length === 3 && method === 'GET') return send(await s.messagesApi(ref));
      if (parts[3] === 'waiting' && parts.length === 4 && method === 'GET')
        return send(await s.messagesWaitingApi(ref, url.searchParams.get('agent')));
    } else if (action === 'said') {
      // The owner's words (BRK-284): their own quote and removing one are the signed-in board's; an agent quotes with its name.
      if (parts.length === 3 && method === 'POST') {
        const no = await gate(press ? 'task.quote' : 'task.write', { task: ref });
        if (no) return no;
        return send(await s.quoteOwner(ref, body, press));
      }
      if (parts.length === 4 && method === 'DELETE') {
        const no = await gate(
          'task.unquote',
          { task: ref },
          "only the owner, on the signed-in web board, removes the owner's words",
        );
        if (no) return no;
        return send(await s.unquoteOwner(ref, parts[3]));
      }
    } else if (action === 'decision' && parts[3] === 'answers' && parts.length === 4) {
      // Send answers and carry on starts an agent (BRK-134): the owner's press on the signed-in board, never the bearer token.
      if (method === 'POST' || method === 'DELETE') {
        const no = await gate(
          method === 'POST' && body.carryOn ? 'decision.carry-on' : 'decision.answer',
          { task: ref },
          'only the signed-in web board can send answers and start the next run',
        );
        if (no) return no;
      }
      if (method === 'POST') return send(await s.submitDecision(ref, body));
      if (method === 'DELETE') return send(await s.reopenDecision(ref, body));
    } else if (method === 'POST') {
      // Taking another's claim, or the owner's hand on a task's paths, is a maintainer's; the rest a member's.
      const plans =
        ((action === 'claim' || action === 'release') && body.force) ||
        (action === 'paths' && (press || !String(body.agent ?? '').trim()));
      const need = action === 'risk-answer' && press && !body.by ? 'risk.answer' : plans ? 'task.plan' : 'task.write';
      const no = await gate(need, { task: ref });
      if (no) return no;
      if (action === 'claim') {
        // A cloud session's report on its environment verifies the routine that started it (BRK-142), claimed or not.
        if (body.session) await s.sessionReport(ref, body.session);
        return send(await s.claim(ref, body.agent, Boolean(body.force), body.repo, actor));
      }
      if (action === 'release') return send(await s.release(ref, body.agent, Boolean(body.force), actor));
      if (action === 'done') return send(await s.done(ref, body.note, theirs(body).by, actor));
      if (action === 'comments' || action === 'annotate')
        return send(await s.comment(ref, body.text, theirs(body).by, actor));
      if (action === 'review') return send(await s.taskReviewApi(ref, body));
      if (action === 'risk-review') return send(await s.riskReviewApi(ref, body));
      if (action === 'risk-answer')
        return send(
          await s.riskAnswerApi(ref, body, {
            owner: press && !body.by,
            person: person && press && !body.by ? person.handle : null,
          }),
        );
      if (action === 'session') return send(await s.sessionLogApi(ref, body));
      // Path claims (IDEA-55 section 1a): an agent's for the task it holds; the signed-in board's, or no agent's, are the owner's.
      if (action === 'paths' && parts.length === 3) return send(await s.pathsApi(ref, body, { owner: press }));
      if (action === 'pings') {
        const result = await s.pingCreate(ref, body);
        // A new ping of a kind that needs the owner sends a push, after the answer (it never holds the agent up).
        if (result.status === 201 && result.body.ping.push) ctx?.waitUntil(s.pushPing(result.body.ping.id));
        return send(result);
      }
    } else if (action === 'footprint' && parts.length === 3 && method === 'GET') {
      return send(await s.footprintApi(ref));
    } else if (action === 'risk-review' && method === 'GET') {
      return send(await s.riskReviewsApi(ref));
    } else if (action === 'session' && method === 'GET') {
      return send(await s.sessionApi(ref, url.searchParams.get('after')));
    }
  }
  return json(404, { error: `no route for ${method} ${url.pathname}` });
}
