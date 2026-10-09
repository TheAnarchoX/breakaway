/**
 * People signing in (BRK-300, docs/specs/BRK-299-people-and-roles.md, points 1, 2, and 9), the Worker's side:
 *
 *   GET  /api/signin                  whether anyone has a passkey yet, so the sign-in page offers one (public)
 *   POST /api/signin/options, /api/signin          a passkey sign-in: its challenge, then its answer (public)
 *   GET  /api/join/:code              who invited you, with what role (public: the code is the credential)
 *   POST /api/join/:code/options, /api/join/:code  your name, handle, and first passkey; uses the invite up
 *   /api/me, /api/me/*                a person's own name, passkeys, personal tokens, and sessions
 *   /api/people, /api/people/*        the owner's: people, invites, grants, Reset, and remove
 *
 * The owner is the board's token, and its cookie, exactly as before (src/auth.js). A person's credential is
 * something else: a personal token (`bkp_…`) or a session cookie (`p<id>.<secret>`), neither of which the owner's
 * checks accept, so a person never passes a gate the owner's cookie passes. Until roles are enforced (BRK-301 and
 * BRK-323), a person's credential opens only the routes above that are theirs, and every other route refuses it.
 */
import { COOKIE, sameOrigin } from './auth.js';
import { install } from './install.js';
import { SESSION_DAYS, TOKEN_PREFIX, hashOf } from './store-people.js';

const MAX_BODY = 64 * 1024;
const SESSION = /^p([\w-]{16,64})\.([\w-]{40,64})$/u;
const TOKEN = /^bkp_[\w-]{40,64}$/u;

const json = (status, body, headers = {}) => Response.json(body, { status, headers });
const send = (result, headers) => json(result.status, result.body, headers);

/** Refused to a person until BRK-301 and BRK-323 open what each role may do (point 9 of the spec). */
export const NOT_YET =
  'people can only sign in and look after their own passkeys, tokens, and sessions on this board for now: roles come in a later update';

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

/** A sign-in that worked: the person, and the cookie that makes it last (never the session's secret in the body). */
function signedIn(result) {
  if (result.status >= 300) return send(result);
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
      : signedIn(await store.peopleSignin(body, rp, deviceOf(request)));
  return parts.length === 3
    ? send(await store.peopleJoinOptions(parts[1], body, rp))
    : signedIn(await store.peopleJoin(parts[1], body, rp, deviceOf(request)));
}

/**
 * Every API request a person's credential makes. Deny by default: what's here is theirs, and everything else is
 * refused, until BRK-301 and BRK-323 open the rest by role. A personal token only reads: it can't make more tokens or
 * passkeys, or end sessions, so a token left in an agent's environment can't make itself a way in that lasts.
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
  if (!cookie)
    return json(403, {
      error: 'a personal token only reads your settings: change them on the web board, signed in with your passkey',
    });

  const body = await readJson(request);
  if (body === null) return json(400, { error: 'the body must be a JSON object' });
  const rp = relyingParty(env, request);
  const [, what, id] = parts;
  if (parts.length === 1 && method === 'PATCH') return send(await store.personRename(person.handle, body));
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
 * /api/people/* for the owner (`via` is the owner's 'token' or 'cookie'). Reading works with either; changing who's
 * in is a press on the signed-in board (the spec's table, People: press-only). Null for other paths.
 */
export async function peopleOwnerApi(parts, method, body, via, store) {
  if (parts[0] !== 'people') return null;
  if (method === 'GET')
    return parts.length === 1 ? send(await store.peopleList()) : json(404, { error: 'no such route' });
  if (via !== 'cookie') return json(403, { error: 'only the signed-in web board can change who’s on the board' });
  if (parts[1] === 'invites') {
    if (parts.length === 2 && method === 'POST') return send(await store.peopleInviteCreate(body));
    if (parts.length === 3 && method === 'DELETE') return send(await store.peopleInviteRevoke(parts[2]));
  } else if (parts.length === 2) {
    if (method === 'PATCH') return send(await store.peopleGrantsSet(parts[1], body));
    if (method === 'DELETE') return send(await store.peopleRemove(parts[1]));
  } else if (parts.length === 3 && parts[2] === 'reset' && method === 'POST') {
    return send(await store.peopleReset(parts[1]));
  }
  return json(404, { error: 'no such route' });
}

/** /logout with a person's cookie also ends that session on the board, so the cookie is no good if it was copied. */
export async function endPersonSession(request, store) {
  const cookie = sessionCookie(request);
  if (cookie) await store.personSignOut(cookie.id, cookie.secret);
}
