/**
 * Who may use the API and web app: anyone holding TASKS_API_TOKEN, sent as a bearer token
 * (agents, the CLI) or exchanged once at /login for a signed cookie (the web app).
 *
 * The cookie is `<expiry>.<HMAC-SHA256(token, "session:<expiry>")>`, so rotating the token signs
 * every browser out. Cookie requests that change something must come from this origin.
 */
import { secret } from './secrets.js';

export const COOKIE = '__Host-sw_tasks';
const SESSION_DAYS = 180;
const encoder = new TextEncoder();

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

/** Constant-time comparison of two strings (by their SHA-256, so lengths don't leak). */
export async function sameSecret(a, b) {
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', encoder.encode(String(s)))));
  return crypto.subtle.timingSafeEqual(x, y);
}

async function sign(token, expiry) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return base64url(await crypto.subtle.sign('HMAC', key, encoder.encode(`session:${expiry}`)));
}

function readCookie(request) {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return null;
}

export function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  return origin !== null && origin === new URL(request.url).origin;
}

/**
 * Shorter than this, a token could be guessed, so nobody signs in with it: a board deployed with the Deploy to
 * Cloudflare button's form left blank or filled in by hand (CLD-139). init-secrets makes 43 characters.
 */
export const MIN_TOKEN_LENGTH = 32;

/** The API token, or null when it's missing, blank, or too short to accept. */
async function apiToken(env) {
  const token = env.TASKS_API_TOKEN ? (await secret(env, 'TASKS_API_TOKEN')).trim() : '';
  return token.length >= MIN_TOKEN_LENGTH ? token : null;
}

/** Returns 'token', 'cookie', or null. */
export async function authenticate(request, env) {
  const token = await apiToken(env);
  if (!token) return null;
  const header = request.headers.get('Authorization') ?? '';
  if (header.startsWith('Bearer ')) return (await sameSecret(header.slice(7).trim(), token)) ? 'token' : null;
  const cookie = readCookie(request);
  if (!cookie) return null;
  const [expiry, signature] = cookie.split('.');
  if (!/^\d+$/u.test(expiry ?? '') || Number(expiry) < Date.now()) return null;
  return (await sameSecret(signature ?? '', await sign(token, expiry))) ? 'cookie' : null;
}

/** POST /login with a form field `token`: sets the cookie and goes back to the board. */
export async function login(request, env) {
  if (!sameOrigin(request)) return new Response('Forbidden', { status: 403 });
  const form = await request.formData().catch(() => null);
  const given = String(form?.get('token') ?? '').trim();
  const token = await apiToken(env);
  if (!given || !token || !(await sameSecret(given, token))) return redirect('/?signin=failed');
  const expiry = String(Date.now() + SESSION_DAYS * 86_400_000);
  const value = `${expiry}.${await sign(token, expiry)}`;
  return redirect(
    '/',
    `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`,
  );
}

export function logout(request) {
  if (!sameOrigin(request)) return new Response('Forbidden', { status: 403 });
  return redirect('/', `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
}

function redirect(location, cookie) {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  if (cookie) headers.set('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}
