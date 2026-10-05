/**
 * TaskStore's sign-ins from Claude's apps (BRK-157, docs/specs/IDEA-24-mcp-server.md, section 8): the OAuth clients
 * that registered, the authorizations waiting for the owner on the board, the codes the owner's Approve gave out, and
 * the connections with their tokens.
 *
 * The Worker makes every code and token and sends only its SHA-256 here, so the store never holds one it could give
 * back. A connection is good on /mcp only, for one repository and one agent name, until the owner revokes it.
 */
import { InputError } from './model.js';

/** Clients no connection uses yet: anyone can register one, so there's a cap, and they're forgotten after a day. */
export const MAX_IDLE_CLIENTS = 20;
const CLIENT_DAYS = 1;
/** Authorizations waiting for the owner, and how long one waits. */
export const MAX_REQUESTS = 50;
export const REQUEST_MS = 10 * 60_000;
/** How long a code from Approve stays good, and an access token. A refresh token lasts until the owner revokes it. */
export const CODE_MS = 5 * 60_000;
export const ACCESS_SECONDS = 3600;
/** A connection's name, and how often its "last used" moves, so a busy client doesn't write on every call. */
const MAX_NAME = 80;
const USED_EVERY_MS = 60_000;

const AGENT = /^[\w.@:/-]{1,64}$/u;
/** The owner's and the board's own names: an agent never signs as one of them (as on /mcp, section 2). */
const RESERVED = /^(owner|board|routine:.*)$/iu;
const ID = /^[\w-]{20,64}$/u;

const ok = (body, status = 200) => ({ status, body });
const fail = (status, error) => ({ status, body: { error } });
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const oauthMethods = {
  initOAuth() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, redirects TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_requests (
        id TEXT PRIMARY KEY, client TEXT NOT NULL, redirect TEXT NOT NULL, challenge TEXT NOT NULL, state TEXT,
        resource TEXT, created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_codes (
        hash TEXT PRIMARY KEY, client TEXT NOT NULL, redirect TEXT NOT NULL, challenge TEXT NOT NULL, resource TEXT,
        name TEXT NOT NULL, repo TEXT NOT NULL, agent TEXT NOT NULL, created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_connections (
        id TEXT PRIMARY KEY, client TEXT NOT NULL, name TEXT NOT NULL, repo TEXT NOT NULL, agent TEXT NOT NULL,
        created INTEGER NOT NULL, used INTEGER
      );
      CREATE TABLE IF NOT EXISTS oauth_tokens (hash TEXT PRIMARY KEY, connection TEXT NOT NULL, kind TEXT NOT NULL, expires INTEGER);
    `);
  },

  /** Forgets what has run out: waiting authorizations, unused codes, and clients that came to nothing. */
  oauthPrune(now = Date.now()) {
    this.sql.exec('DELETE FROM oauth_requests WHERE created < ?', now - REQUEST_MS);
    this.sql.exec('DELETE FROM oauth_codes WHERE created < ?', now - CODE_MS);
    this.sql.exec('DELETE FROM oauth_tokens WHERE expires IS NOT NULL AND expires < ?', now);
    this.sql.exec(
      `DELETE FROM oauth_clients WHERE created < ? AND id NOT IN (SELECT client FROM oauth_connections)
         AND id NOT IN (SELECT client FROM oauth_requests) AND id NOT IN (SELECT client FROM oauth_codes)`,
      now - CLIENT_DAYS * 86_400_000,
    );
  },

  /** POST /oauth/register, checked by the Worker: a public client with its name and redirect addresses. */
  oauthRegister({ id, name, redirects }) {
    this.oauthPrune();
    const idle = this.sql
      .exec('SELECT COUNT(*) AS n FROM oauth_clients WHERE id NOT IN (SELECT client FROM oauth_connections)')
      .one().n;
    if (idle >= MAX_IDLE_CLIENTS) return { ok: false };
    const created = Date.now();
    this.sql.exec(
      'INSERT INTO oauth_clients (id, name, redirects, created) VALUES (?, ?, ?, ?)',
      id,
      name,
      JSON.stringify(redirects),
      created,
    );
    return { ok: true, created };
  },

  /** A registered client, or null. */
  oauthClient(id) {
    const row = this.sql.exec('SELECT id, name, redirects FROM oauth_clients WHERE id = ?', String(id)).toArray()[0];
    return row ? { id: row.id, name: row.name, redirects: JSON.parse(row.redirects) } : null;
  },

  /** An authorization the Worker checked, kept for the owner's consent page. False when too many are waiting. */
  oauthRequestAdd({ id, client, redirect, challenge, state, resource }) {
    this.oauthPrune();
    if (this.sql.exec('SELECT COUNT(*) AS n FROM oauth_requests').one().n >= MAX_REQUESTS) return false;
    this.sql.exec(
      'INSERT INTO oauth_requests (id, client, redirect, challenge, state, resource, created) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      client,
      redirect,
      challenge,
      state ?? null,
      resource ?? null,
      Date.now(),
    );
    return true;
  },

  oauthRequestRow(id) {
    if (!ID.test(String(id))) return null;
    const row = this.sql.exec('SELECT * FROM oauth_requests WHERE id = ?', String(id)).toArray()[0];
    return row && row.created >= Date.now() - REQUEST_MS ? row : null;
  },

  /** GET /api/oauth/requests/<id> (the signed-in board): what the consent page shows, and the repositories to pick. */
  oauthRequestApi(id) {
    return this.run(() => {
      const row = this.oauthRequestRow(id);
      if (!row) return fail(404, 'this sign-in has run out or was already answered: start it again from the app');
      const client = this.oauthClient(row.client);
      return ok({
        request: {
          id: row.id,
          client: client?.name ?? 'An MCP client',
          redirectHost: new URL(row.redirect).host,
          expires: iso(row.created + REQUEST_MS),
        },
        repos: this.repos().map((r) => ({ slug: r.slug, name: r.name, github: r.github })),
        default: this.repos().find((r) => r.isDefault)?.slug ?? null,
      });
    });
  },

  /**
   * POST /api/oauth/requests/<id>/approve (the signed-in board): the owner's name for the connection, its repository,
   * and its agent name. The code's hash is the Worker's, which sends the browser back with the code itself.
   */
  oauthApproveApi(id, body, codeHash) {
    return this.run(() => {
      const row = this.oauthRequestRow(id);
      if (!row) return fail(404, 'this sign-in has run out or was already answered: start it again from the app');
      const name = String(body?.name ?? '').trim();
      if (!name) throw new InputError('name the connection, so you know it when you revoke it');
      if (name.length > MAX_NAME) throw new InputError(`a connection’s name is up to ${MAX_NAME} characters`);
      const repo = String(body?.repo ?? '')
        .trim()
        .toLowerCase();
      if (!this.repoBySlug(repo))
        throw new InputError(
          `pick a repository on the board: ${
            this.repos()
              .map((r) => r.slug)
              .join(', ') || 'none yet'
          }`,
        );
      const agent = String(body?.agent ?? '').trim();
      if (!AGENT.test(agent))
        throw new InputError('the agent name is up to 64 letters, digits, and . @ : / - _, like claude-app');
      if (RESERVED.test(agent))
        throw new InputError(`"${agent}" is the board’s or the owner’s: pick the agent’s own name, like claude-app`);
      this.sql.exec('DELETE FROM oauth_requests WHERE id = ?', row.id);
      this.sql.exec(
        `INSERT INTO oauth_codes (hash, client, redirect, challenge, resource, name, repo, agent, created)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        codeHash,
        row.client,
        row.redirect,
        row.challenge,
        row.resource,
        name,
        repo,
        agent,
        Date.now(),
      );
      return ok({ redirect: row.redirect, state: row.state });
    });
  },

  /** POST /api/oauth/requests/<id>/deny (the signed-in board): the client hears access_denied. */
  oauthDenyApi(id) {
    return this.run(() => {
      const row = this.oauthRequestRow(id);
      if (!row) return fail(404, 'this sign-in has run out or was already answered');
      this.sql.exec('DELETE FROM oauth_requests WHERE id = ?', row.id);
      return ok({ redirect: row.redirect, state: row.state });
    });
  },

  /**
   * POST /oauth/token's code: checked against the client, the redirect address, and PKCE (the Worker sends the
   * verifier's S256), then used up, making the connection and its first tokens (by hash). Null when it fits; else the
   * OAuth error. A code that doesn't fit stays until it runs out, so a wrong guess can't spend the client's.
   */
  oauthRedeem(codeHash, { client, redirect, challenge }, { id, accessHash, refreshHash }) {
    const row = this.sql.exec('SELECT * FROM oauth_codes WHERE hash = ?', String(codeHash)).toArray()[0];
    if (!row || row.created < Date.now() - CODE_MS) return 'the code is wrong, used, or ran out: sign in again';
    if (row.client !== client) return 'the code is another client’s';
    if (row.redirect !== redirect) return 'redirect_uri must be the one the sign-in started with';
    if (row.challenge !== challenge) return 'code_verifier doesn’t fit the sign-in’s code_challenge';
    this.sql.exec('DELETE FROM oauth_codes WHERE hash = ?', row.hash);
    this.sql.exec(
      'INSERT INTO oauth_connections (id, client, name, repo, agent, created, used) VALUES (?, ?, ?, ?, ?, ?, NULL)',
      id,
      row.client,
      row.name,
      row.repo,
      row.agent,
      Date.now(),
    );
    this.oauthIssue(id, { accessHash, refreshHash });
    return null;
  },

  /** A connection's one live pair of tokens: issuing a pair ends the one before it. */
  oauthIssue(connection, { accessHash, refreshHash }) {
    this.sql.exec('DELETE FROM oauth_tokens WHERE connection = ?', connection);
    this.sql.exec(
      'INSERT INTO oauth_tokens (hash, connection, kind, expires) VALUES (?, ?, ?, ?)',
      accessHash,
      connection,
      'access',
      Date.now() + ACCESS_SECONDS * 1000,
    );
    this.sql.exec(
      'INSERT INTO oauth_tokens (hash, connection, kind, expires) VALUES (?, ?, ?, NULL)',
      refreshHash,
      connection,
      'refresh',
    );
  },

  /** POST /oauth/token's refresh: a new pair for the refresh token's connection, or false when it isn't one. */
  oauthRefresh(refreshHash, client, { accessHash, refreshHash: next }) {
    const row = this.sql
      .exec(
        `SELECT t.connection FROM oauth_tokens t JOIN oauth_connections c ON c.id = t.connection
         WHERE t.hash = ? AND t.kind = 'refresh' AND c.client = ?`,
        String(refreshHash),
        String(client),
      )
      .toArray()[0];
    if (!row) return false;
    this.oauthIssue(row.connection, { accessHash, refreshHash: next });
    return true;
  },

  /** /mcp's check: the connection an access token belongs to, or null. */
  oauthAccess(accessHash) {
    const now = Date.now();
    const row = this.sql
      .exec(
        `SELECT c.id, c.name, c.repo, c.agent, c.used, t.expires FROM oauth_tokens t
         JOIN oauth_connections c ON c.id = t.connection WHERE t.hash = ? AND t.kind = 'access'`,
        String(accessHash),
      )
      .toArray()[0];
    if (!row || row.expires < now) return null;
    if (!row.used || row.used < now - USED_EVERY_MS)
      this.sql.exec('UPDATE oauth_connections SET used = ? WHERE id = ?', now, row.id);
    return { id: row.id, name: row.name, repo: row.repo, agent: row.agent };
  },

  /** GET /api/oauth/connections (the signed-in board): every sign-in, newest first, never a token. */
  oauthConnectionsApi() {
    return this.run(() => {
      const rows = this.sql
        .exec(
          `SELECT c.id, c.name, c.repo, c.agent, c.created, c.used, k.name AS client FROM oauth_connections c
           LEFT JOIN oauth_clients k ON k.id = c.client ORDER BY c.created DESC`,
        )
        .toArray();
      return ok({
        connections: rows.map((r) => ({
          id: r.id,
          name: r.name,
          client: r.client ?? 'An MCP client',
          repo: r.repo,
          agent: r.agent,
          created: iso(r.created),
          used: iso(r.used),
        })),
      });
    });
  },

  /** DELETE /api/oauth/connections/<id> (the signed-in board): the connection and its tokens, at once. */
  oauthRevokeApi(id) {
    return this.run(() => {
      const found = this.sql.exec('SELECT id FROM oauth_connections WHERE id = ?', String(id)).toArray()[0];
      if (!found) return fail(404, 'no such connection: it may have been revoked already');
      this.sql.exec('DELETE FROM oauth_tokens WHERE connection = ?', found.id);
      this.sql.exec('DELETE FROM oauth_connections WHERE id = ?', found.id);
      return ok({ ok: true });
    });
  },
};
