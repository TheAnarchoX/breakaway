import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { LEGACY } from '../src/mcp.js';
import { api } from './helpers.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';

// Sign-in from MCP apps (BRK-157, docs/specs/IDEA-24-mcp-server.md, section 8).

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const RESOURCE = `${ORIGIN}/mcp`;
const json = async (res) => ({ status: res.status, ...(await res.json()) });

const b64u = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
const VERIFIER = 'a-verifier-that-is-long-enough-for-pkce-0123456789abcdef';
const challengeOf = async (verifier) => b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));

/** The signed-in browser: the cookie from /login. */
let cookie;
async function signIn() {
  const res = await SELF.fetch(`${ORIGIN}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: TEST_API_TOKEN }),
  });
  return res.headers.get('Set-Cookie').split(';')[0];
}

/** The board's own API from the signed-in browser. */
const board = (path, { method = 'GET', body } = {}) =>
  SELF.fetch(`${ORIGIN}/api/${path}`, {
    method,
    headers: { Cookie: cookie, Origin: ORIGIN, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const register = (body) =>
  SELF.fetch(`${ORIGIN}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const token = (fields) =>
  SELF.fetch(`${ORIGIN}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });

/** /oauth/authorize with these query fields; the answer, not followed. */
const authorize = (fields) =>
  SELF.fetch(`${ORIGIN}/oauth/authorize?${new URLSearchParams(fields)}`, { redirect: 'manual' });

/** POST /mcp as an MCP client of the revision before the newest, with a bearer token and optional headers. */
let next = 1;
const mcp = (method, params, bearer, headers = {}) =>
  SELF.fetch(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': LEGACY,
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: next++, method, ...(params ? { params } : {}) }),
  });

/** Registers a client and starts an authorization: the request the consent page shows. */
async function start({ verifier = VERIFIER, state = 'xyz' } = {}) {
  const client = await json(await register({ client_name: 'Claude', redirect_uris: [CALLBACK] }));
  const res = await authorize({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: CALLBACK,
    code_challenge: await challengeOf(verifier),
    code_challenge_method: 'S256',
    state,
    resource: RESOURCE,
    scope: 'mcp',
  });
  expect(res.status).toBe(303);
  const location = res.headers.get('Location');
  const m = /^\/#\/authorize\/([\w-]{20,64})$/u.exec(location);
  expect(m, location).not.toBeNull();
  return { client, request: m[1] };
}

/** The whole flow, approved as `agent` for `repo`: the client and its tokens. */
async function connect({ name = 'Claude on my phone', repo = 'widgets', agent = 'claude-app' } = {}) {
  const { client, request } = await start();
  const approved = await json(
    await board(`oauth/requests/${request}/approve`, { method: 'POST', body: { name, repo, agent } }),
  );
  expect(approved.status).toBe(200);
  const back = new URL(approved.redirect);
  const code = back.searchParams.get('code');
  const tokens = await json(
    await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK,
      client_id: client.client_id,
      code_verifier: VERIFIER,
      resource: RESOURCE,
    }),
  );
  expect(tokens.status).toBe(200);
  return { client, tokens };
}

describe('sign-in from MCP apps (BRK-157)', () => {
  beforeAll(async () => {
    cookie = await signIn();
    expect(
      (await api('repos', { method: 'POST', body: { slug: 'gizmos', github: 'acme/gizmos', areas: ['gizmo:GZ'] } }))
        .status,
    ).toBe(201);
    expect(
      (
        await api('tasks', {
          method: 'POST',
          body: [
            { description: 'A widgets task', project: 'ops', who: 'agent', horizon: 'now' },
            { description: 'A gizmos task', repo: 'gizmos', project: 'gizmo', who: 'agent', horizon: 'now' },
          ],
        })
      ).status,
    ).toBe(201);
  });

  describe('discovery', () => {
    it('says where to sign in when /mcp is called without a token', async () => {
      const res = await mcp('ping');
      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toBe(
        `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
      );
    });

    it('describes the resource and the board as its authorization server', async () => {
      for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
        const res = await SELF.fetch(`${ORIGIN}${path}`);
        expect(res.status).toBe(200);
        const meta = await res.json();
        expect(meta.resource).toBe(RESOURCE);
        expect(meta.authorization_servers).toEqual([ORIGIN]);
        expect(meta.bearer_methods_supported).toEqual(['header']);
      }
      const meta = await (await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).json();
      expect(meta).toMatchObject({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/oauth/authorize`,
        token_endpoint: `${ORIGIN}/oauth/token`,
        registration_endpoint: `${ORIGIN}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['mcp'],
      });
    });
  });

  describe('registration', () => {
    it('registers a public client with https or loopback redirect addresses', async () => {
      const res = await json(
        await register({ client_name: 'Claude', redirect_uris: [CALLBACK, 'http://127.0.0.1:33418/callback'] }),
      );
      expect(res.status).toBe(201);
      expect(res.client_id).toMatch(/^[\w-]{20,64}$/u);
      expect(res.token_endpoint_auth_method).toBe('none');
      expect(res.redirect_uris).toEqual([CALLBACK, 'http://127.0.0.1:33418/callback']);
    });

    it('refuses redirect addresses it would not send a code to', async () => {
      for (const uris of [
        [],
        ['http://evil.example/cb'],
        ['javascript:alert(1)'],
        ['https://claude.ai/cb#frag'],
        ['not a url'],
        Array.from({ length: 6 }, (_, i) => `https://claude.ai/${i}`),
      ]) {
        const res = await json(await register({ client_name: 'x', redirect_uris: uris }));
        expect(res.status, JSON.stringify(uris)).toBe(400);
        expect(res.error).toBe('invalid_redirect_uri');
      }
      expect(
        (await json(await register({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'client_secret_basic' })))
          .error,
      ).toBe('invalid_client_metadata');
    });
  });

  describe('authorization', () => {
    it('shows a page, never a redirect, for an unknown client or a redirect address it didn’t register', async () => {
      const { client } = await start();
      const challenge = await challengeOf(VERIFIER);
      const base = { response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256' };
      for (const fields of [
        { ...base, client_id: 'nobody-registered-this-client', redirect_uri: CALLBACK },
        { ...base, client_id: client.client_id, redirect_uri: 'https://evil.example/cb' },
      ]) {
        const res = await authorize(fields);
        expect(res.status).toBe(400);
        expect(res.headers.get('Location')).toBeNull();
        expect(res.headers.get('Content-Type')).toMatch(/^text\/plain/u);
      }
    });

    it('sends an authorization without S256 PKCE, or for another resource, back to the client with an error', async () => {
      const { client } = await start();
      const challenge = await challengeOf(VERIFIER);
      const base = { response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK, state: 's1' };
      for (const fields of [
        { ...base, code_challenge: challenge, code_challenge_method: 'plain' },
        { ...base },
        { ...base, code_challenge: challenge, code_challenge_method: 'S256', response_type: 'token' },
        { ...base, code_challenge: challenge, code_challenge_method: 'S256', resource: 'https://other.example/mcp' },
      ]) {
        const res = await authorize(fields);
        expect(res.status).toBe(303);
        const back = new URL(res.headers.get('Location'));
        expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
        expect(back.searchParams.get('error')).toMatch(/^(invalid_request|unsupported_response_type|invalid_target)$/u);
        expect(back.searchParams.get('state')).toBe('s1');
      }
    });

    it('shows the request to the signed-in board only', async () => {
      const { request } = await start();
      const res = await json(await board(`oauth/requests/${request}`));
      expect(res.status).toBe(200);
      expect(res.request).toMatchObject({ client: 'Claude', redirectHost: 'claude.ai' });
      expect(res.repos.map((r) => r.slug)).toEqual(expect.arrayContaining(['widgets', 'gizmos']));

      // An agent's token can neither read nor approve a sign-in.
      expect((await api(`oauth/requests/${request}`)).status).toBe(403);
      expect(
        (
          await api(`oauth/requests/${request}/approve`, {
            method: 'POST',
            body: { name: 'x', repo: 'widgets', agent: 'claude-x' },
          })
        ).status,
      ).toBe(403);
      expect((await board('oauth/requests/no-such-request-anywhere-here')).status).toBe(404);
    });

    it('refuses an approval without a name, with a repository the board doesn’t track, or with the owner’s name', async () => {
      const { request } = await start();
      for (const body of [
        { name: '', repo: 'widgets', agent: 'claude-x' },
        { name: 'x', repo: 'nowhere', agent: 'claude-x' },
        { name: 'x', repo: 'widgets', agent: 'owner' },
        { name: 'x', repo: 'widgets', agent: 'board' },
        { name: 'x', repo: 'widgets', agent: 'has spaces' },
      ]) {
        const res = await board(`oauth/requests/${request}/approve`, { method: 'POST', body });
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      // The request is still there to approve properly.
      expect((await board(`oauth/requests/${request}`)).status).toBe(200);
    });

    it('sends a denial back to the client as access_denied, and forgets the request', async () => {
      const { request } = await start({ state: 'deny-me' });
      const res = await json(await board(`oauth/requests/${request}/deny`, { method: 'POST' }));
      expect(res.status).toBe(200);
      const back = new URL(res.redirect);
      expect(back.searchParams.get('error')).toBe('access_denied');
      expect(back.searchParams.get('state')).toBe('deny-me');
      expect((await board(`oauth/requests/${request}`)).status).toBe(404);
    });
  });

  describe('tokens', () => {
    it('swaps a code for tokens once, and only with the right verifier, client, and redirect address', async () => {
      const { client, request } = await start({ state: 'abc' });
      const approved = await json(
        await board(`oauth/requests/${request}/approve`, {
          method: 'POST',
          body: { name: 'Claude', repo: 'widgets', agent: 'claude-app' },
        }),
      );
      const back = new URL(approved.redirect);
      expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
      expect(back.searchParams.get('state')).toBe('abc');
      expect(back.searchParams.get('iss')).toBe(ORIGIN);
      const code = back.searchParams.get('code');
      const fields = {
        grant_type: 'authorization_code',
        code,
        redirect_uri: CALLBACK,
        client_id: client.client_id,
        code_verifier: VERIFIER,
      };
      for (const wrong of [
        { code_verifier: 'b'.repeat(50) },
        { redirect_uri: 'http://127.0.0.1/cb' },
        { client_id: 'another-client-entirely-here' },
        { resource: 'https://other.example/mcp' },
      ]) {
        const res = await json(await token({ ...fields, ...wrong }));
        expect(res.status, JSON.stringify(wrong)).toBe(400);
        expect(res.error).toMatch(/^(invalid_grant|invalid_client|invalid_target)$/u);
      }
      const ok = await token(fields);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('Cache-Control')).toMatch(/no-store/u);
      const tokens = await ok.json();
      expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp' });
      expect(tokens.access_token).toMatch(/^bka_[\w-]{43}$/u);
      expect(tokens.refresh_token).toMatch(/^bkr_[\w-]{43}$/u);
      // A code works once.
      expect((await json(await token(fields))).error).toBe('invalid_grant');
      expect((await json(await token({ ...fields, grant_type: 'password' }))).error).toBe('unsupported_grant_type');
    });

    it('works on /mcp for its one repository and agent name, whatever the headers say', async () => {
      const { tokens } = await connect({ repo: 'widgets', agent: 'claude-app' });
      const bearer = tokens.access_token;
      const init = await json(
        await mcp(
          'initialize',
          { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 'c', version: '1' } },
          bearer,
        ),
      );
      expect(init.result.serverInfo.name).toBe('breakaway');

      const listed = await json(
        await mcp('tools/call', { name: 'list_tasks', arguments: {} }, bearer, { 'X-Breakaway-Repo': 'gizmos' }),
      );
      const titles = listed.result.structuredContent.tasks.map((t) => t.description);
      expect(titles).toContain('A widgets task');
      expect(titles).not.toContain('A gizmos task');

      const all = (await json(await api('tasks'))).tasks;
      const gizmo = all.find((t) => t.description === 'A gizmos task');
      const widget = all.find((t) => t.description === 'A widgets task');
      // Another repository's task is refused, as the CLI's claim is.
      const refused = await json(
        await mcp('tools/call', { name: 'claim_task', arguments: { task: gizmo.wid } }, bearer, {
          'X-Breakaway-Repo': 'gizmos',
          'X-Breakaway-Agent': 'someone-else',
        }),
      );
      expect(refused.result.isError).toBe(true);
      // Its own repository's claims as the connection's agent, not the header's.
      const claimed = await json(
        await mcp('tools/call', { name: 'claim_task', arguments: { task: widget.wid } }, bearer, {
          'X-Breakaway-Agent': 'someone-else',
        }),
      );
      expect(claimed.result.isError).toBeUndefined();
      const shown = await json(await api(`tasks/${widget.wid}`));
      expect(shown.task.claim).toBe('claude-app');
      await api(`tasks/${widget.wid}/release`, { method: 'POST', body: { agent: 'claude-app' } });
    });

    it('refuses its repository’s tools once that repository leaves the board, and says to revoke it', async () => {
      expect(
        (
          await api('repos', {
            method: 'POST',
            body: { slug: 'doohickeys', github: 'acme/doohickeys', areas: ['doo:DH'] },
          })
        ).status,
      ).toBe(201);
      const { tokens } = await connect({ repo: 'doohickeys' });
      expect((await api('repos/doohickeys', { method: 'DELETE', body: {} })).status).toBe(200);
      const res = await json(await mcp('tools/call', { name: 'list_tasks', arguments: {} }, tokens.access_token));
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toMatch(/doohickeys.*revoke/u);
    });

    it('is refused on /api/*, on sync, and everywhere but /mcp', async () => {
      const { tokens } = await connect();
      expect((await api('tasks', { token: tokens.access_token })).status).toBe(401);
      expect((await api('session', { token: tokens.access_token })).status).toBe(401);
      expect((await api('tasks', { token: tokens.refresh_token })).status).toBe(401);
      // The refresh token isn't an access token.
      expect((await mcp('ping', undefined, tokens.refresh_token)).status).toBe(401);
    });

    it('refreshes by rotating both tokens: the old pair stops working', async () => {
      const { client, tokens } = await connect();
      const fresh = await json(
        await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }),
      );
      expect(fresh.status).toBe(200);
      expect(fresh.access_token).not.toBe(tokens.access_token);
      expect((await mcp('ping', undefined, fresh.access_token)).status).toBe(200);
      const old = await mcp('ping', undefined, tokens.access_token);
      expect(old.status).toBe(401);
      expect(old.headers.get('WWW-Authenticate')).toMatch(/error="invalid_token"/u);
      expect(
        (
          await json(
            await token({
              grant_type: 'refresh_token',
              refresh_token: tokens.refresh_token,
              client_id: client.client_id,
            }),
          )
        ).error,
      ).toBe('invalid_grant');
      // Another client can't use it.
      const other = await json(await register({ client_name: 'x', redirect_uris: [CALLBACK] }));
      expect(
        (
          await json(
            await token({
              grant_type: 'refresh_token',
              refresh_token: fresh.refresh_token,
              client_id: other.client_id,
            }),
          )
        ).error,
      ).toBe('invalid_grant');
    });

    it('stops working once the owner revokes the connection on the board', async () => {
      const { client, tokens } = await connect({ name: 'Revoke me' });
      expect((await mcp('ping', undefined, tokens.access_token)).status).toBe(200);

      const list = await json(await board('oauth/connections'));
      const mine = list.connections.find((c) => c.name === 'Revoke me');
      expect(mine).toMatchObject({ repo: 'widgets', agent: 'claude-app', client: 'Claude' });
      expect(mine.used).toBeTruthy();
      expect(JSON.stringify(list)).not.toContain(tokens.access_token);

      // Listing and revoking are the signed-in board's.
      expect((await api('oauth/connections')).status).toBe(403);
      expect((await api(`oauth/connections/${mine.id}`, { method: 'DELETE' })).status).toBe(403);

      expect((await board(`oauth/connections/${mine.id}`, { method: 'DELETE' })).status).toBe(200);
      expect((await mcp('ping', undefined, tokens.access_token)).status).toBe(401);
      expect(
        (
          await json(
            await token({
              grant_type: 'refresh_token',
              refresh_token: tokens.refresh_token,
              client_id: client.client_id,
            }),
          )
        ).error,
      ).toBe('invalid_grant');
      expect((await json(await board('oauth/connections'))).connections.some((c) => c.id === mine.id)).toBe(false);
    });
  });

  // Last, because it fills the board's room for new clients.
  describe('limits', () => {
    it('keeps at most 20 clients that no connection uses yet', async () => {
      let res;
      for (let i = 0; i < 25; i++) {
        res = await register({ client_name: `spam ${i}`, redirect_uris: [CALLBACK] });
        if (res.status === 429) break;
        expect(res.status).toBe(201);
      }
      expect(res.status).toBe(429);
      expect((await res.json()).error).toBe('temporarily_unavailable');
    });
  });

  describe('signing in on the way', () => {
    it('comes back to the consent page after the board’s sign-in', async () => {
      const go = (next) =>
        SELF.fetch(`${ORIGIN}/login`, {
          method: 'POST',
          redirect: 'manual',
          headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: TEST_API_TOKEN, next }),
        });
      expect((await go('#/authorize/abcdefghijklmnopqrstuvwxyz012345')).headers.get('Location')).toBe(
        '/#/authorize/abcdefghijklmnopqrstuvwxyz012345',
      );
      for (const next of ['https://evil.example/', '//evil.example', '#/board', '/#/authorize/x'])
        expect((await go(next)).headers.get('Location'), next).toBe('/');
    });
  });
});
