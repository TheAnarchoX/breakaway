/**
 * People signing in (BRK-300, docs/specs/BRK-299-people-and-roles.md, points 1, 2, and 9), the Worker's side:
 *
 *   GET  /api/signin                  whether anyone has a passkey yet, so the sign-in page offers one (public)
 *   POST /api/signin/options, /api/signin          a passkey sign-in: its challenge, then its answer (public)
 *   GET  /api/join/:code              who invited you, with what role (public: the code is the credential)
 *   POST /api/join/:code/options, /api/join/:code  your name, handle, and first passkey; uses the invite up
 *   /api/me, /api/me/*                a person's own name, passkeys, personal tokens, and sessions; the owner's own
 *                                     name and passkeys (BRK-328)
 *   /api/people, /api/people/*        the owner's: people, invites, grants, Reset, and remove
 *
 * The owner is the board's token, and its cookie, exactly as before (src/auth.js). A person's credential is
 * something else: a personal token (`bkp_…`) or a session cookie (`p<id>.<secret>`), neither of which the owner's
 * checks accept, so a person never passes a gate the owner's cookie passes. Since BRK-301, a person's writes go
 * through the Worker's routes, each behind a gate that asks src/permissions.js with their role; since BRK-323, their
 * reads do too, filtered to the repositories they have a grant in (src/reads.js).
 */
import { COOKIE, ownerSessionCookie, sameOrigin } from './auth.js';
import { install } from './install.js';
import { OWNER } from './permissions.js';
import { SESSION_DAYS, TOKEN_PREFIX, hashOf } from './store-people.js';

const MAX_BODY = 64 * 1024;
const SESSION = /^p([\w-]{16,64})\.([\w-]{40,64})$/u;
const TOKEN = /^bkp_[\w-]{40,64}$/u;

const json = (status, body, headers = {}) => Response.json(body, { status, headers });
const send = (result, headers) => json(result.status, result.body, headers);

/** What a person's request gets from a route that never asked whether they may: refused, rather than let through. */
export const NOT_YET = 'this isn’t open to people on this board yet: ask the owner';

/**
 * The store, for a person's request: a call goes through only once a gate has let the request through (BRK-301).
 * Any other call answers 403, so a route that forgot its gate refuses a person instead of acting for them.
 * @param {any} stub the store's Durable Object stub
 * @param {() => boolean} isGated
 */
export function guardStore(stub, isGated) {
  return new Proxy(
    {},
    {
      get(_, name) {
        return (/** @type {any[]} */ ...args) =>
          isGated() ? stub[name](...args) : Promise.resolve({ status: 403, body: { error: NOT_YET } });
      },
    },
  );
}

/**
 * The relying party a passkey is made for: the board's host, from the install's config (src/install.js), or where
 * it was asked when the install has no URL of its own (workers.dev, `wrangler dev`).
 * @returns {{ id: string, origin: string, name: string }}
 */
export function relyingParty(env, request) {
  const { url, name } = install(env);
  const origin = new URL(url ?? request.url).origin;
  return { id: new URL(origin).hostname, origin, name: name || 'breakaway' };
}

/** A session's name in a person's list: the browser and the system, from the user agent, and nothing more. */
export function deviceOf(request) {
  const ua = request.headers.get('User-Agent') ?? '';
  const browser = /Edg\//u.test(ua)
    ? 'Edge'
    : /Firefox\//u.test(ua)
      ? 'Firefox'
      : /Chrome\//u.test(ua)
        ? 'Chrome'
        : /Safari\//u.test(ua)
          ? 'Safari'
          : 'A browser';
  const system = /iPhone|iPad/u.test(ua)
    ? 'iOS'
    : /Android/u.test(ua)
      ? 'Android'
      : /Mac OS X/u.test(ua)
        ? 'macOS'
        : /Windows/u.test(ua)
          ? 'Windows'
          : /Linux/u.test(ua)
            ? 'Linux'
            : null;
  return system ? `${browser} on ${system}` : browser;
}

function readCookie(request) {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return null;
}

/** A person's session cookie, split, or null when the cookie isn't one (the owner's, or none). */
function sessionCookie(request) {
  const match = SESSION.exec(readCookie(request) ?? '');
  return match ? { id: match[1], secret: match[2] } : null;
}

/** Whether a request carries a personal token, good or not: /mcp refuses those by name. */
export function hasPersonalToken(request) {
  return (request.headers.get('Authorization') ?? '').startsWith(`Bearer ${TOKEN_PREFIX}`);
}

/**
 * The person behind a request's credential, or null. Call it only when the owner's own check failed.
 * @returns {Promise<null | { handle: string, name: string, via: 'person-token' | 'person-cookie', session?: string }>}
 */
export async function personOf(request, store) {
  const header = request.headers.get('Authorization') ?? '';
  if (header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (!TOKEN.test(token)) return null;
    const found = await store.personOfToken(await hashOf(token));
    return found ? { handle: found.handle, name: found.name, via: 'person-token' } : null;
  }
  const cookie = sessionCookie(request);
  if (!cookie) return null;
  const found = await store.personOfSession(cookie.id, await hashOf(cookie.secret));
  return found ? { handle: found.handle, name: found.name, via: 'person-cookie', session: found.session } : null;
}

function cookieHeader(value, maxAge) {
  return { 'Set-Cookie': `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` };
}

async function readJson(request) {
  if (request.method === 'GET') return {};
  const raw = await request.text();
  if (raw.length > MAX_BODY) return null;
  if (!raw) return {};
  try {
    const body = JSON.parse(raw);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * A sign-in that worked: the person, and the cookie that makes it last (never the session's secret in the body). The
 * owner's passkey (BRK-328) gets the owner's own cookie, the token's, so it's the owner's session like /login's.
 */
async function signedIn(result, env) {
  if (result.status >= 300) return send(result);
  if (result.body.owner) {
    const cookie = await ownerSessionCookie(env);
    if (!cookie)
      return json(503, { error: 'the board has no token to sign you in with: set it with npx breakaway init-secrets' });
    return json(200, { ok: true, ...result.body }, { 'Set-Cookie': cookie });
  }
  const { session, maxAge, ...body } = result.body;
  return json(result.status, { ok: true, ...body }, cookieHeader(session, maxAge));
}

/** /api/signin and /api/join/*: open to anyone, since signing in is how you get a credential. Null for other paths. */
export async function peoplePublic(request, env, url, store) {
  const parts = url.pathname.split('/').slice(2);
  const method = request.method;
  const isSignin = parts[0] === 'signin' && (parts.length === 1 || (parts.length === 2 && parts[1] === 'options'));
  const isJoin = parts[0] === 'join' && (parts.length === 2 || (parts.length === 3 && parts[2] === 'options'));
  if (!isSignin && !isJoin) return null;
  if (method === 'GET' && isSignin && parts.length === 1) return json(200, { passkeys: await store.peopleAny() });
  if (method === 'GET' && isJoin && parts.length === 2) return send(await store.peopleJoinInfo(parts[1]));
  if (method !== 'POST') return json(405, { error: 'use POST' });
  // A passkey checks its own origin, but the cookie these set must only ever be asked for by the board itself.
  if (!sameOrigin(request)) return json(403, { error: 'cross-origin request refused' });
  const body = await readJson(request);
  if (body === null) return json(400, { error: 'the body must be a JSON object' });
  const rp = relyingParty(env, request);
  if (isSignin)
    return parts.length === 2
      ? send(await store.peopleSigninOptions(rp))
      : signedIn(await store.peopleSignin(body, rp, deviceOf(request)), env);
  return parts.length === 3
    ? send(await store.peopleJoinOptions(parts[1], body, rp))
    : signedIn(await store.peopleJoin(parts[1], body, rp, deviceOf(request)), env);
}

/**
 * A person's own: who they are, and their name, passkeys, personal tokens, and sessions. Everything else goes through
 * the Worker's routes, by role and by grant (BRK-301, BRK-323). A personal token only reads here: it can't make more
 * tokens or passkeys, or end sessions, so a token left in an agent's environment can't make itself a way in that lasts.
 */
export async function personApi(request, env, url, person, store) {
  const parts = url.pathname.split('/').slice(2).map(decodeURIComponent);
  const method = request.method;
  const cookie = person.via === 'person-cookie';
  if (cookie && method !== 'GET' && !sameOrigin(request)) return json(403, { error: 'cross-origin request refused' });

  if (parts[0] === 'session' && parts.length === 1 && method === 'GET') {
    const { name, url: home, docs } = install(env);
    const body = {
      ok: true,
      via: person.via,
      person: { handle: person.handle, name: person.name },
      install: { name, url: home ?? url.origin, docs },
    };
    // A session that's used lasts: the browser's cookie is renewed with it.
    return cookie ? json(200, body, cookieHeader(readCookie(request), SESSION_DAYS * 86400)) : json(200, body);
  }
  if (parts[0] !== 'me') return json(403, { error: NOT_YET });
  if (parts.length === 1 && method === 'GET') return send(await store.personMe(person.handle, person.session ?? null));
  // Their own Claude (BRK-302): the plan, caps, and routines they connected, never a routine's URL or token.
  if (parts[1] === 'claude' && parts.length === 2 && method === 'GET')
    return send(await store.personClaudeApi(person.handle));
  if (!cookie)
    return json(403, {
      error: 'a personal token only reads your settings: change them on the web board, signed in with your passkey',
    });

  const body = await readJson(request);
  if (body === null) return json(400, { error: 'the body must be a JSON object' });
  const rp = relyingParty(env, request);
  const [, what, id] = parts;
  if (parts.length === 1 && method === 'PATCH') return send(await store.personRename(person.handle, body));
  if (what === 'claude' && parts.length === 2 && method === 'PATCH')
    return send(await store.personClaudeSetApi(person.handle, body));
  if (what === 'routines' && parts.length === 3) {
    if (method === 'PUT') return send(await store.personRoutineConnectApi(person.handle, id, body));
    if (method === 'DELETE') return send(await store.personRoutineForgetApi(person.handle, id));
  }
  if (what === 'tokens') {
    if (parts.length === 2 && method === 'POST') return send(await store.personTokenCreate(person.handle, body));
    if (parts.length === 3 && method === 'DELETE') return send(await store.personTokenRevoke(person.handle, id));
  }
  if (what === 'passkeys') {
    if (parts.length === 3 && id === 'options' && method === 'POST')
      return send(await store.personPasskeyOptions(person.handle, rp));
    if (parts.length === 2 && method === 'POST') return send(await store.personPasskeyAdd(person.handle, body, rp));
    if (parts.length === 3 && method === 'PATCH') return send(await store.personPasskeyRename(person.handle, id, body));
    if (parts.length === 3 && method === 'DELETE') return send(await store.personPasskeyRemove(person.handle, id));
  }
  if (what === 'sessions') {
    if (parts.length === 3 && method === 'DELETE') {
      const result = await store.personSessionEnd(person.handle, id);
      return id === person.session && result.status === 200 ? send(result, cookieHeader('', 0)) : send(result);
    }
    // Sign out everywhere: this browser too.
    if (parts.length === 2 && method === 'DELETE')
      return send(await store.personSessionsEndAll(person.handle), cookieHeader('', 0));
  }
  return json(404, { error: 'no such route' });
}

/**
 * /api/people/*: who's on the board (point 3, "Managing people"). The owner reads it with the token or the cookie; a
 * person reads the people they share a repository with. Changing who's in is a press on the signed-in board (the spec's table, People:
 * press-only): the owner's for anyone, and a maintainer's for members and viewers of the repositories they maintain,
 * which the store checks. `actor` is the request's (src/permissions.js). Null for other paths.
 */
export async function peopleOwnerApi(parts, method, body, actor, store, env, request) {
  if (parts[0] === 'me' && actor.person === OWNER) return ownerMe(parts, method, body, actor, store, env, request);
  if (parts[0] !== 'people') return null;
  // A person's Claude (BRK-302): the owner reads it and sets the limits on it, with the token or the cookie.
  if (parts.length === 3 && parts[2] === 'claude') {
    if (method === 'GET') return send(await store.personClaudeOwnerApi(parts[1], { actor }));
    if (method === 'PATCH') return send(await store.personLimitsApi(parts[1], body));
    return json(405, { error: 'use GET or PATCH' });
  }
  if (method === 'GET') {
    if (parts.length !== 1) return json(404, { error: 'no such route' });
    // A person sees the people they share a repository with (BRK-323); the owner, everyone.
    return send(await (actor.person === OWNER ? store.peopleList() : store.peopleListFor(actor.person)));
  }
  if (!actor.press) return json(403, { error: 'only the signed-in web board can change who’s on the board' });
  // The owner's reach is everyone's; a person's, the store works out from their grants.
  const by = actor.person === OWNER ? null : actor.person;
  if (parts[1] === 'invites') {
    if (parts.length === 2 && method === 'POST') return send(await store.peopleInviteCreate(body, by));
    if (parts.length === 3 && method === 'DELETE') return send(await store.peopleInviteRevoke(parts[2], by));
  } else if (parts.length === 2) {
    if (method === 'PATCH') return send(await store.peopleGrantsSet(parts[1], body, by));
    if (method === 'DELETE') return send(await store.peopleRemove(parts[1], by));
  } else if (parts.length === 3 && parts[2] === 'reset' && method === 'POST') {
    return send(await store.peopleReset(parts[1], by));
  }
  return json(404, { error: 'no such route' });
}

/**
 * /api/me for the owner (BRK-328): their display name and their own passkeys. Reading takes the token or the cookie;
 * a change is the owner's press, on the signed-in board. The owner has no personal tokens or sessions here: the token
 * is theirs, and rotate-token signs every owner session out.
 */
async function ownerMe(parts, method, body, actor, store, env, request) {
  const [, what, id] = parts;
  if (parts.length === 1 && method === 'GET') return send(await store.ownerMe());
  if (method !== 'GET' && !actor.press)
    return json(403, { error: 'only the signed-in web board can change your name or passkeys' });
  if (parts.length === 1 && method === 'PATCH') return send(await store.ownerRename(body));
  if (what === 'passkeys') {
    if (parts.length === 3 && id === 'options' && method === 'POST')
      return send(await store.ownerPasskeyOptions(relyingParty(env, request)));
    if (parts.length === 2 && method === 'POST')
      return send(await store.ownerPasskeyAdd(body, relyingParty(env, request)));
    if (parts.length === 3 && method === 'PATCH') return send(await store.ownerPasskeyRename(id, body));
    if (parts.length === 3 && method === 'DELETE') return send(await store.ownerPasskeyRemove(id));
  }
  if (what === 'tokens' || what === 'sessions')
    return json(404, {
      error: 'the owner signs in with the board’s token: rotate-token replaces it and signs you out everywhere',
    });
  return json(404, { error: 'no such route' });
}

/** /logout with a person's cookie also ends that session on the board, so the cookie is no good if it was copied. */
export async function endPersonSession(request, store) {
  const cookie = sessionCookie(request);
  if (cookie) await store.personSignOut(cookie.id, cookie.secret);
}
