/**
 * Sign-in from MCP apps (BRK-157, docs/specs/IDEA-24-mcp-server.md, section 8): the board as the OAuth
 * authorization server for its own /mcp, so claude.ai and Claude Desktop can connect without a header.
 *
 *   /.well-known/oauth-protected-resource[/mcp]  what /mcp is and who signs in for it (RFC 9728)
 *   /.well-known/oauth-authorization-server      the endpoints below (RFC 8414)
 *   /oauth/register                              a public client registers itself (RFC 7591)
 *   /oauth/authorize                             checks the request and sends the browser to the consent page
 *   /oauth/token                                 a code or a refresh token for a new pair of tokens
 *
 * The consent step is the owner's press on the signed-in board (/#/authorize/<request>), through the cookie-only
 * routes in worker.js. Every code and token is made here and only its SHA-256 goes to the store.
 */

/** Where an access token or a refresh token starts, so /mcp knows one from the board's token without asking. */
export const ACCESS_PREFIX = 'bka_';
export const REFRESH_PREFIX = 'bkr_';
export const SCOPE = 'mcp';

const MAX_BODY = 16 * 1024;
const MAX_REDIRECTS = 5;
const MAX_REDIRECT = 2000;
const MAX_CLIENT_NAME = 100;
const MAX_STATE = 1000;
const PKCE = /^[A-Za-z0-9._~-]{43,128}$/u;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const ID = /^[\w-]{20,64}$/u;

const encoder = new TextEncoder();

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

/** 256 random bits, as 43 URL-safe characters. */
export const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

/** A code's or a token's SHA-256, as hex: all the store ever keeps of it. */
export async function hashOf(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(value)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** PKCE's S256: the challenge a verifier makes. */
const s256 = async (verifier) => base64url(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)));

/** The address a browser goes back to, with the answer's fields added. */
export function backTo(redirect, fields) {
  const url = new URL(redirect);
  for (const [k, v] of Object.entries(fields))
    if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, v);
  return url.toString();
}

const resourceOf = (origin) => `${origin}/mcp`;
/** The protected resource metadata's address, which /mcp's 401 names. */
export const metadataUrl = (origin) => `${origin}/.well-known/oauth-protected-resource/mcp`;

const noStore = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };
const jsonResponse = (status, body, headers = {}) =>
  Response.json(body, { status, headers: { ...noStore, ...headers } });
const oauthError = (status, error, description) =>
  jsonResponse(status, { error, ...(description ? { error_description: description } : {}) });
const page = (status, text) =>
  new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...noStore } });

/** A resource a client names is this board's /mcp (the trailing slash aside), or none at all. */
function rightResource(value, origin) {
  if (value === null || value === undefined || value === '') return true;
  return String(value).replace(/\/$/u, '') === resourceOf(origin);
}

/** A redirect address the board will send a code to: https, or http on the loopback for a desktop app. */
function redirectOk(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_REDIRECT) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || value.includes('#') || url.username || url.password) return false;
  if (url.protocol === 'https:') return Boolean(url.hostname);
  return url.protocol === 'http:' && LOOPBACK.has(url.hostname);
}

/**
 * The well-known metadata and the /oauth/* endpoints. Null when the path is neither.
 * @param {Request} request
 * @param {any} store the install's TaskStore stub
 * @returns {Promise<Response | null>}
 */
export async function handleOAuth(request, store) {
  const url = new URL(request.url);
  const origin = url.origin;
  const path = url.pathname;
  const method = request.method;
  if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
    if (method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
    return Response.json({
      resource: resourceOf(origin),
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
      scopes_supported: [SCOPE],
      resource_name: 'breakaway',
    });
  }
  if (path === '/.well-known/oauth-authorization-server') {
    if (method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
    return Response.json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [SCOPE],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: false,
    });
  }
  if (path === '/oauth/register') {
    if (method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    return register(request, store);
  }
  if (path === '/oauth/authorize') {
    if (method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
    return authorize(url, store);
  }
  if (path === '/oauth/token') {
    if (method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    return token(request, store, origin);
  }
  return null;
}

/** The body as JSON or a form, or null when it's neither or too large. */
async function readFields(request) {
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_BODY) return null;
  const raw = await request.text();
  if (raw.length > MAX_BODY) return null;
  const type = (request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'application/json') {
    try {
      const value = JSON.parse(raw);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }
  if (type === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(raw));
  return null;
}

/** POST /oauth/register: a public client, with its name and redirect addresses. */
async function register(request, store) {
  const body = await readFields(request);
  if (!body) return oauthError(400, 'invalid_client_metadata', 'send the client’s metadata as a JSON object');
  const redirects = body.redirect_uris;
  if (
    !Array.isArray(redirects) ||
    !redirects.length ||
    redirects.length > MAX_REDIRECTS ||
    !redirects.every(redirectOk)
  )
    return oauthError(
      400,
      'invalid_redirect_uri',
      `redirect_uris is 1 to ${MAX_REDIRECTS} addresses, each https, or http on localhost, with no fragment`,
    );
  const method = body.token_endpoint_auth_method ?? 'none';
  if (method !== 'none')
    return oauthError(
      400,
      'invalid_client_metadata',
      'the board takes public clients only: token_endpoint_auth_method none',
    );
  const grants = body.grant_types ?? ['authorization_code', 'refresh_token'];
  if (!Array.isArray(grants) || grants.some((g) => !['authorization_code', 'refresh_token'].includes(g)))
    return oauthError(400, 'invalid_client_metadata', 'grant_types is authorization_code and refresh_token');
  const responses = body.response_types ?? ['code'];
  if (!Array.isArray(responses) || responses.some((r) => r !== 'code'))
    return oauthError(400, 'invalid_client_metadata', 'response_types is code');
  const given = typeof body.client_name === 'string' ? body.client_name.trim() : '';
  const name = (given || 'An MCP client').slice(0, MAX_CLIENT_NAME);
  const id = randomToken();
  const saved = await store.oauthRegister({ id, name, redirects });
  if (!saved.ok)
    return oauthError(429, 'temporarily_unavailable', 'too many clients are waiting to sign in: try again tomorrow');
  return jsonResponse(201, {
    client_id: id,
    client_id_issued_at: Math.floor(saved.created / 1000),
    client_name: name,
    redirect_uris: redirects,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
}

/**
 * GET /oauth/authorize. An unknown client or a redirect address it didn't register is a page, never a redirect; the
 * rest goes back to the client as an OAuth error. A good request waits for the owner on the board's consent page.
 */
async function authorize(url, store) {
  const q = url.searchParams;
  const origin = url.origin;
  const clientId = q.get('client_id') ?? '';
  const client = ID.test(clientId) ? await store.oauthClient(clientId) : null;
  if (!client) return page(400, 'This app isn’t registered with the board. Start the sign-in again from the app.');
  const asked = q.get('redirect_uri');
  const redirect = asked ?? (client.redirects.length === 1 ? client.redirects[0] : null);
  if (!redirect || !client.redirects.includes(redirect))
    return page(
      400,
      'The address this app asked to go back to isn’t one it registered, so the board won’t send it there.',
    );
  const state = q.get('state');
  const back = (error, description) =>
    new Response(null, {
      status: 303,
      headers: {
        Location: backTo(redirect, { error, error_description: description, state, iss: origin }),
        ...noStore,
      },
    });
  if (q.get('response_type') !== 'code') return back('unsupported_response_type', 'response_type is code');
  const challenge = q.get('code_challenge') ?? '';
  if (q.get('code_challenge_method') !== 'S256' || !PKCE.test(challenge))
    return back('invalid_request', 'PKCE is required: code_challenge with code_challenge_method S256');
  if (state !== null && state.length > MAX_STATE) return back('invalid_request', 'state is too long');
  if (!rightResource(q.get('resource'), origin)) return back('invalid_target', `resource is ${resourceOf(origin)}`);
  const id = randomToken();
  const kept = await store.oauthRequestAdd({
    id,
    client: client.id,
    redirect,
    challenge,
    state,
    resource: q.get('resource'),
  });
  if (!kept) return back('temporarily_unavailable', 'too many sign-ins are waiting: try again in a few minutes');
  return new Response(null, { status: 303, headers: { Location: `/#/authorize/${id}`, ...noStore } });
}

/** A new pair of tokens, and their hashes for the store. */
async function newPair() {
  const access = `${ACCESS_PREFIX}${randomToken()}`;
  const refresh = `${REFRESH_PREFIX}${randomToken()}`;
  return { access, refresh, hashes: { accessHash: await hashOf(access), refreshHash: await hashOf(refresh) } };
}

const issued = (pair) =>
  jsonResponse(200, {
    access_token: pair.access,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: pair.refresh,
    scope: SCOPE,
  });

/** POST /oauth/token: a code from Approve, or a refresh token, for a new pair. */
async function token(request, store, origin) {
  const body = await readFields(request);
  if (!body) return oauthError(400, 'invalid_request', 'send the fields as application/x-www-form-urlencoded');
  const field = (name) => (typeof body[name] === 'string' ? body[name] : '');
  const client = field('client_id');
  if (!ID.test(client)) return oauthError(400, 'invalid_client', 'client_id is the one the board registered');
  if (!rightResource(body.resource, origin))
    return oauthError(400, 'invalid_target', `resource is ${resourceOf(origin)}`);
  const grant = field('grant_type');
  if (grant === 'authorization_code') {
    const verifier = field('code_verifier');
    if (!PKCE.test(verifier)) return oauthError(400, 'invalid_grant', 'code_verifier is required');
    const code = field('code');
    if (!code) return oauthError(400, 'invalid_request', 'code is required');
    const pair = await newPair();
    const refused = await store.oauthRedeem(
      await hashOf(code),
      { client, redirect: field('redirect_uri'), challenge: await s256(verifier) },
      { id: randomToken(), ...pair.hashes },
    );
    if (refused) return oauthError(400, 'invalid_grant', refused);
    return issued(pair);
  }
  if (grant === 'refresh_token') {
    const refresh = field('refresh_token');
    if (!refresh.startsWith(REFRESH_PREFIX)) return oauthError(400, 'invalid_grant', 'refresh_token is required');
    const pair = await newPair();
    if (!(await store.oauthRefresh(await hashOf(refresh), client, pair.hashes)))
      return oauthError(400, 'invalid_grant', 'the refresh token is wrong, used, or revoked: sign in again');
    return issued(pair);
  }
  return oauthError(400, 'unsupported_grant_type', 'grant_type is authorization_code or refresh_token');
}

/**
 * The cookie-only routes behind the consent page and the list on Connections: /api/oauth/... `parts` is the path
 * after /api/. Null when the path isn't one.
 * @param {string[]} parts
 * @param {string} method
 * @param {any} body
 * @param {any} store
 * @param {string} origin
 */
export async function oauthApi(parts, method, body, store, origin) {
  const send = (result) => Response.json(result.body, { status: result.status, headers: noStore });
  if (parts[1] === 'requests' && parts.length === 3 && method === 'GET')
    return send(await store.oauthRequestApi(parts[2]));
  if (parts[1] === 'requests' && parts.length === 4 && method === 'POST' && parts[3] === 'approve') {
    const code = randomToken();
    const result = await store.oauthApproveApi(parts[2], body, await hashOf(code));
    if (result.status !== 200) return send(result);
    const { redirect, state } = result.body;
    return send({ status: 200, body: { redirect: backTo(redirect, { code, state, iss: origin }) } });
  }
  if (parts[1] === 'requests' && parts.length === 4 && method === 'POST' && parts[3] === 'deny') {
    const result = await store.oauthDenyApi(parts[2]);
    if (result.status !== 200) return send(result);
    const { redirect, state } = result.body;
    const fields = {
      error: 'access_denied',
      error_description: 'The board’s owner denied the sign-in.',
      state,
      iss: origin,
    };
    return send({ status: 200, body: { redirect: backTo(redirect, fields) } });
  }
  if (parts[1] === 'connections' && parts.length === 2 && method === 'GET')
    return send(await store.oauthConnectionsApi());
  if (parts[1] === 'connections' && parts.length === 3 && method === 'DELETE')
    return send(await store.oauthRevokeApi(parts[2]));
  return null;
}

/**
 * The connection a bearer on /mcp belongs to: `{ connection }` for a live access token, `{ invalid: true }` for one
 * that looks like a connection's but isn't live (so the client refreshes), and null for anything else.
 * @param {Request} request
 * @param {any} store
 */
export async function connectionOf(request, store) {
  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return null;
  const value = header.slice(7).trim();
  if (!value.startsWith(ACCESS_PREFIX) && !value.startsWith(REFRESH_PREFIX)) return null;
  if (!value.startsWith(ACCESS_PREFIX)) return { invalid: true };
  const connection = await store.oauthAccess(await hashOf(value));
  return connection ? { connection } : { invalid: true };
}
