/**
 * The task board's Worker.
 *
 *   /v1/client/*  TaskChampion sync protocol, for `task sync` (the install's client ID only)
 *   /api/*        JSON API for `npx breakaway`, agents, and the web app (token or cookie)
 *   /github/*     GitHub App webhooks and the end of its setup (docs/specs/CLD-24-github.md)
 *   /login        exchanges the token for a cookie; /logout clears it
 *   everything else: the web app's static files (./public)
 *
 * Logs hold no task content: only what failed and why.
 */
import { authenticate, login, logout, sameOrigin } from './auth.js';
import { isUuid } from './crypto.js';
import { appCredentials, verifyWebhook } from './github.js';
import { install } from './install.js';
import { CLI_VERSION } from './cli-version.js';
import { releaseOf } from './build.js';
import { unreadableSecrets } from './secrets.js';
import { BREAKAWAY_REPO } from './updates.js';

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
    if (url.pathname.startsWith('/api/')) {
      // The CLI version this build carries, so an older copy of the CLI in another repository can say so (CLD-193).
      const res = withHeaders(await handleApi(request, env, url, ctx));
      res.headers.set('X-Tasks-Cli', String(CLI_VERSION));
      return res;
    }
    if (url.pathname === '/github/webhook' && request.method === 'POST')
      return withHeaders(await githubWebhook(request, env));
    if (url.pathname === '/github/connected' && request.method === 'GET') return githubConnected(url, env);
    if (url.pathname === '/login' && request.method === 'POST') return login(request, env);
    if (url.pathname === '/logout' && request.method === 'POST') return logout(request);
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

function withHeaders(response) {
  const res = new Response(response.body, response);
  res.headers.set('Cache-Control', 'no-store, max-age=0');
  res.headers.set('X-Robots-Tag', 'noindex');
  return res;
}

const text = (status, body) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
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
async function handleImages(request, env, url, method) {
  const parts = url.pathname.split('/').slice(2).map(decodeURIComponent);
  const s = store(env);
  const send = (result) => json(result.status, result.body);
  if (parts[0] === 'tasks' && parts[2] === 'attachments' && parts.length === 3) {
    if (method === 'GET') return send(await s.attachmentsList(parts[1]));
    if (method !== 'POST') return null;
    if (Number(request.headers.get('Content-Length') ?? 0) > MAX_IMAGE_BODY)
      return json(413, { error: 'each image can be up to 1 MB, so shrink it or crop it first' });
    const bytes = await request.arrayBuffer();
    const header = (name) => {
      try {
        return decodeURIComponent(request.headers.get(name) ?? '');
      } catch {
        return '';
      }
    };
    return send(
      await s.attachmentAdd(parts[1], bytes, { name: header('X-Attachment-Name'), alt: header('X-Attachment-Alt') }),
    );
  }
  if (parts[0] === 'attachments' && parts.length === 2 && /^\d{1,9}$/u.test(parts[1])) {
    if (method === 'DELETE') return send(await s.attachmentDelete(parts[1]));
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

async function handleApi(request, env, url, ctx) {
  const via = await authenticate(request, env);
  if (!via) return json(401, { error: 'sign in first: send the token as "Authorization: Bearer <token>"' });
  const method = request.method;
  if (via === 'cookie' && method !== 'GET' && !sameOrigin(request))
    return json(403, { error: 'cross-origin request refused' });

  const images = await handleImages(request, env, url, method);
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

  const parts = url.pathname.split('/').slice(2).map(decodeURIComponent);
  const s = store(env);
  const send = (result) => json(result.status, result.body);

  if (parts[0] === 'session' && method === 'GET') {
    // Which board this is, for the web app and the CLI: its name and where it answers, never a secret.
    // An install on workers.dev has no URL of its own: it's where it was asked.
    const { name, url: home, docs } = install(env);
    return json(200, { ok: true, via, install: { name, url: home ?? url.origin, docs } });
  }
  if (parts[0] === 'health' && method === 'GET') {
    const result = await s.health();
    return send({ ...result, body: { ...result.body, cli: CLI_VERSION, release: releaseOf(env) } });
  }
  if (parts[0] === 'activity' && method === 'GET') {
    return send(
      await s.activity({
        limit: url.searchParams.get('limit') ?? undefined,
        before: url.searchParams.get('before') ?? undefined,
      }),
    );
  }
  if (parts[0] === 'stats' && parts.length === 1 && method === 'GET')
    return send(
      await s.statsApi({
        days: url.searchParams.get('days') ?? undefined,
        tz: url.searchParams.get('tz') ?? undefined,
        repo: url.searchParams.get('repo') ?? undefined,
      }),
    );
  if (parts[0] === 'next' && parts.length === 1 && method === 'POST') return send(await s.next(body));
  if (parts[0] === 'backfill' && parts[1] === 'structure' && parts.length === 2 && method === 'POST')
    return send(await s.backfillStructureApi());
  if (parts[0] === 'horizons' && parts[1] === 'close' && parts.length === 2 && method === 'POST')
    return send(await s.closeHorizon({ dryRun: Boolean(body.dryRun) }));
  if (parts[0] === 'admin' && parts[1] === 'rebuild' && method === 'POST') return send(await s.rebuild());
  if (parts[0] === 'github' && parts.length === 1 && method === 'GET')
    return send(await s.githubOverview(url.searchParams.get('repo')));
  // Connections (IDEA-14): anyone signed in reads them; Check now asks GitHub live and dismissing a note is the owner's, so both are the signed-in browser's only.
  if (parts[0] === 'connections') {
    if (parts.length === 1 && method === 'GET') return send(await s.connectionsApi(url.origin));
    if (parts[1] === 'check' && parts.length === 2 && method === 'POST') {
      if (via !== 'cookie') return json(403, { error: 'only the signed-in web board can run Check now' });
      return send(await s.connectionsCheckApi(url.origin));
    }
    if (parts[1] === 'notices' && parts.length === 4 && parts[3] === 'dismiss' && method === 'POST') {
      if (via !== 'cookie') return json(403, { error: 'only the signed-in web board can dismiss a connection note' });
      return send(await s.connectionNoticeDismiss(parts[2]));
    }
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
      if (via !== 'cookie')
        return json(403, { error: 'only the signed-in web board can update or roll back the Worker' });
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
    if (parts.length === 1 && method === 'POST') return send(await s.reposAddApi(body));
    if (parts.length === 2 && method === 'PATCH') return send(await s.reposModifyApi(parts[1], body));
    if (parts.length === 2 && method === 'DELETE') return send(await s.reposRemoveApi(parts[1], body));
    if (parts.length === 3 && parts[2] === 'release' && method === 'POST')
      return send(await s.reposReleaseApi(parts[1], body));
  }
  if (parts[0] === 'routines') {
    if (parts.length === 1 && method === 'GET') return send(await s.routinesApi());
    if (parts.length === 1 && method === 'POST') return send(await s.routinesCreateApi(body));
    if (parts[1] === 'settings' && parts.length === 2 && (method === 'PATCH' || method === 'POST'))
      return send(await s.routinesSettingsApi(body));
    if (parts.length === 2 && method === 'PATCH') return send(await s.routinesModifyApi(parts[1], body));
    if (parts[2] === 'triggers' && parts.length === 3 && method === 'POST')
      return send(await s.routinesTriggerCreateApi(parts[1], body));
    if (parts[2] === 'triggers' && parts.length === 4 && method === 'DELETE')
      return send(await s.routinesTriggerRevokeApi(parts[1], parts[3], body));
    if (parts[2] === 'run' && parts.length === 3 && method === 'POST')
      return send(await s.routinesRunApi(parts[1], body));
  }
  if (parts[0] === 'pings' && parts.length === 1 && method === 'GET') return send(await s.pingsApi());
  // Notifications are the owner's: the signed-in browser only, never the bearer token agents hold.
  if (parts[0] === 'push' && parts.length <= 2) {
    if (via !== 'cookie') return json(403, { error: 'only the signed-in web board can change notifications' });
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
    if (via !== 'cookie')
      return json(403, { error: 'only the signed-in web board can apply, dismiss, or mark a ping handled' });
    if (parts[2] === 'apply') return send(await s.pingApply(parts[1], body));
    return send(await (parts[2] === 'dismiss' ? s.pingDismiss(parts[1]) : s.pingHandled(parts[1])));
  }
  if (parts[0] === 'agents') {
    if (parts.length === 1 && method === 'GET') return send(await s.agentsApi());
    if (parts[1] === 'prompt' && parts.length === 2 && method === 'GET')
      return send(await s.routinePromptApi(url.searchParams.get('repo')));
    if (parts[1] === 'start' && method === 'POST')
      return send(
        await s.agentsStartApi(body.ref, body.note ? String(body.note) : null, body.mode ? String(body.mode) : null, {
          force: body.force,
          by: body.by,
        }),
      );
    if (parts[1] === 'general' && parts.length === 2 && method === 'POST') return send(await s.agentsGeneralApi(body));
    if (parts[1] === 'next' && method === 'POST')
      return send(
        await s.agentsNextApi({
          count: body.count,
          horizon: body.horizon ?? null,
          repo: body.repo ?? null,
          dryRun: Boolean(body.dryRun),
        }),
      );
    if (parts[1] === 'settings' && (method === 'PATCH' || method === 'POST'))
      return send(
        await s.agentsSettingsApi({
          max: body.max,
          hourly: body.hourly,
          autostart: body.autostart,
          alerts: body.alerts,
          plan: body.plan,
          by: body.by,
        }),
      );
  }
  if (parts[0] === 'github' && parts[1] === 'pulls' && parts.length === 3 && method === 'GET')
    return send(await s.githubPullApi(parts[2], url.searchParams.get('repo')));
  if (parts[0] === 'github' && parts[1] === 'pulls' && parts[3] === 'fix' && parts.length === 4 && method === 'POST')
    return send(await s.fixPrApi(parts[2], { ...body, repo: body.repo ?? url.searchParams.get('repo') }));
  // Merging is the owner's: the signed-in browser only, never the bearer token agents and the CLI hold.
  if (
    parts[0] === 'github' &&
    parts[1] === 'pulls' &&
    parts.length === 4 &&
    method === 'POST' &&
    ['update-branch', 'merge', 'auto-merge', 'publish'].includes(parts[3])
  ) {
    if (via !== 'cookie')
      return json(403, {
        error: 'only the signed-in web board can publish, update, merge, or set auto-merge on a pull request',
      });
    return send(
      await s.githubWrite(parts[2], parts[3], {
        sha: body.sha,
        method: body.method,
        enable: body.enable,
        setting: body.setting,
        repo: body.repo ?? url.searchParams.get('repo'),
      }),
    );
  }
  // Promote and Roll back are the owner's too: the signed-in browser only, and the workflows check everything again.
  if (parts[0] === 'github' && ['promote', 'rollback'].includes(parts[1]) && parts.length === 2 && method === 'POST') {
    if (via !== 'cookie') return json(403, { error: 'only the signed-in web board can promote or roll back' });
    return send(
      await s.githubRelease(parts[1], {
        sha: body.sha,
        destructiveOk: body.destructiveOk,
        version: body.version,
        reason: body.reason,
        repo: body.repo ?? url.searchParams.get('repo'),
      }),
    );
  }
  if (parts[0] === 'github' && parts[1] === 'sync' && method === 'POST')
    return send(await s.githubSyncApi(body.repo ?? url.searchParams.get('repo')));
  if (parts[0] === 'github' && parts[1] === 'alerts' && parts[3] === 'fix' && method === 'POST')
    return send(
      await s.fixAlertApi(parts[2], body.note ? String(body.note) : null, body.repo ?? url.searchParams.get('repo'), {
        force: body.force,
        by: body.by,
      }),
    );
  if (parts[0] === 'github' && parts[1] === 'pulls' && parts[3] === 'review' && parts.length === 4 && method === 'POST')
    return send(
      await s.reviewPullApi(parts[2], body.note ? String(body.note) : null, body.repo ?? url.searchParams.get('repo'), {
        force: body.force,
        by: body.by,
      }),
    );
  if (parts[0] === 'github' && parts[1] === 'setup' && method === 'POST')
    return json(200, await s.githubSetup(url.origin));
  // Rotation is for the owner's CLI (bearer token), never the web board's cookie.
  if (parts[0] === 'admin' && parts[1] === 'rekey' && method === 'POST' && via === 'token')
    return send(await s.rekey(body.clientId, body.key));

  if (parts[0] === 'tasks') {
    const [, ref, action] = parts;
    if (!ref) {
      if (method === 'GET') return send(await s.list(url.searchParams.get('status') ?? 'pending'));
      if (method === 'POST') {
        const items = Array.isArray(body) ? body : Array.isArray(body.tasks) ? body.tasks : [body];
        return send(await s.create(items));
      }
    } else if (!action) {
      if (method === 'GET') return send(await s.get(ref));
      if (method === 'PATCH') return send(await s.update(ref, body));
    } else if (action === 'messages') {
      // Telling an agent what to do is the owner's: the signed-in browser only, never the bearer token every agent holds (IDEA-15).
      if (parts.length === 3 && method === 'POST') {
        if (via !== 'cookie') return json(403, { error: 'only the signed-in web board can message an agent' });
        return send(await s.messageSendApi(ref, body));
      }
      if (parts.length === 3 && method === 'GET') return send(await s.messagesApi(ref));
      if (parts[3] === 'waiting' && parts.length === 4 && method === 'GET')
        return send(await s.messagesWaitingApi(ref, url.searchParams.get('agent')));
    } else if (action === 'decision' && parts[3] === 'answers' && parts.length === 4) {
      if (method === 'POST') return send(await s.submitDecision(ref, body));
      if (method === 'DELETE') return send(await s.reopenDecision(ref, body));
    } else if (method === 'POST') {
      if (action === 'claim') return send(await s.claim(ref, body.agent, Boolean(body.force), body.repo));
      if (action === 'release') return send(await s.release(ref, body.agent, Boolean(body.force)));
      if (action === 'done') return send(await s.done(ref, body.note, body.by));
      if (action === 'comments' || action === 'annotate') return send(await s.comment(ref, body.text, body.by));
      if (action === 'session') return send(await s.sessionLogApi(ref, body));
      if (action === 'pings') {
        const result = await s.pingCreate(ref, body);
        // A new ping of a kind that needs the owner sends a push, after the answer (it never holds the agent up).
        if (result.status === 201 && result.body.ping.push) ctx?.waitUntil(s.pushPing(result.body.ping.id));
        return send(result);
      }
    } else if (action === 'session' && method === 'GET') {
      return send(await s.sessionApi(ref, url.searchParams.get('after')));
    }
  }
  return json(404, { error: `no route for ${method} ${url.pathname}` });
}
