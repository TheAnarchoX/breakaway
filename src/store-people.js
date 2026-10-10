/**
 * TaskStore's people (BRK-300, docs/specs/BRK-299-people-and-roles.md, points 1, 2, and 9): the people the owner
 * invites, their grants, invites, passkeys, personal tokens, and web sessions.
 *
 * The owner isn't here: the owner is the board's token, has no row, and nothing in this file can change that. Every
 * secret (an invite's code, a personal token, a session's secret) is kept only as its SHA-256, so the store never holds
 * one it could give back; each is shown once, when it's made.
 *
 * Beyond signing in and their own passkeys, tokens, and sessions, what a person may do is their role's (BRK-301,
 * `src/permissions.js`), and what they see is their grants' (BRK-323, `src/reads.js`).
 */
import { PasskeyError, toBase64url, verifyAssertion, verifyRegistration } from './webauthn.js';
import { OWNER, refusal } from './permissions.js';
import { WORKS, forLine, profileChange } from './profile.js';
import { unseal } from './crypto.js';
import { decodeSegment } from './ops.js';
import { repoSlugOf } from './repos.js';

/** What a grant may give, per repository (point 3). `*` is every repository, including ones added later. */
export const ROLES = ['maintainer', 'member', 'viewer'];
export const EVERY_REPO = '*';
const MAX_GRANTS = 50;

/** An invite lasts 7 days unless whoever makes it picks 1 to 30 (point 2). */
export const INVITE_DAYS = 7;
const MAX_INVITE_DAYS = 30;
const MAX_OPEN_INVITES = 100;
/** A person's web session: 30 days, renewed on use (point 2). */
export const SESSION_DAYS = 30;
/** How long a passkey challenge stays good, and how many sign-in challenges may wait at once (anyone can ask for one). */
export const CHALLENGE_MS = 5 * 60_000;
const MAX_CHALLENGES = 200;
/** How often "last seen" and "last used" move, so a busy client doesn't write on every call. */
const SEEN_EVERY_MS = 60_000;
const MAX_NAME = 80;
const MAX_TOKENS = 50;
const MAX_PASSKEYS = 20;

/** A handle: lowercase, at most 32 characters, never one an agent or the board uses (point 1). */
const HANDLE = /^[a-z][a-z0-9-]{0,31}$/u;
const RESERVED_HANDLE = /^(owner|board|routine|claude-.*|codex-.*)$/u;
const ID = /^[\w-]{8,64}$/u;

export const TOKEN_PREFIX = 'bkp_';

const DAY = 86_400_000;
const encoder = new TextEncoder();
const ok = (body, status = 200) => ({ status, body });
const fail = (status, error, extra = {}) => ({ status, body: { error, ...extra } });
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

/** 256 random bits, as 43 URL-safe characters; `bytes` for shorter IDs. */
export const randomToken = (bytes = 32) => toBase64url(crypto.getRandomValues(new Uint8Array(bytes)));

/** A secret's SHA-256, as hex: all the store keeps of it. */
export async function hashOf(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(value)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Equal hex strings, in time that doesn't depend on where they differ. */
function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** A display name or a passkey's or token's name: trimmed, one line, not empty. */
function cleanName(value, what) {
  const name = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  if (!name) return { error: `give ${what}` };
  if (name.length > MAX_NAME) return { error: `${what} is at most ${MAX_NAME} characters` };
  if (/[\u0000-\u001f\u007f]/u.test(name)) return { error: `${what} can’t hold control characters` };
  return { name };
}

/** Why a handle can't be used, or null when it can (it may still be taken). */
export function handleProblem(handle) {
  if (typeof handle !== 'string' || !HANDLE.test(handle))
    return 'a handle is 1 to 32 lowercase letters, digits, and dashes, starting with a letter';
  if (RESERVED_HANDLE.test(handle)) return `“${handle}” is kept for the board and its agents: pick another handle`;
  return null;
}

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const peopleMethods = {
  initPeople() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS people (
        handle TEXT PRIMARY KEY, name TEXT NOT NULL, webauthn_id TEXT NOT NULL UNIQUE, invited_by TEXT NOT NULL,
        created INTEGER NOT NULL, seen INTEGER, removed INTEGER
      );
      CREATE TABLE IF NOT EXISTS grants (handle TEXT NOT NULL, repo TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (handle, repo));
      CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, grants TEXT NOT NULL, person TEXT, invited_by TEXT NOT NULL,
        created INTEGER NOT NULL, expires INTEGER NOT NULL, used INTEGER, revoked INTEGER
      );
      CREATE TABLE IF NOT EXISTS passkeys (
        id TEXT PRIMARY KEY, handle TEXT NOT NULL, name TEXT NOT NULL, alg INTEGER NOT NULL, jwk TEXT NOT NULL,
        sign_count INTEGER NOT NULL, created INTEGER NOT NULL, used INTEGER
      );
      CREATE TABLE IF NOT EXISTS person_tokens (
        id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, handle TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL,
        used INTEGER
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, hash TEXT NOT NULL, handle TEXT NOT NULL, device TEXT NOT NULL, created INTEGER NOT NULL,
        seen INTEGER NOT NULL, expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS passkey_challenges (
        id TEXT PRIMARY KEY, challenge TEXT NOT NULL, purpose TEXT NOT NULL, subject TEXT, data TEXT, created INTEGER NOT NULL
      );
    `);
    // A person's profile (BRK-329): their work, their own words for Other, and their notes for agents. People from
    // before have none.
    const columns = this.sql
      .exec('PRAGMA table_info(people)')
      .toArray()
      .map((c) => c.name);
    // Their avatar's seed (WEB-134, docs/specs/ID-9-avatars.md): null until they press Shuffle, and their handle is it.
    // The repositories a removed person held a grant in (WEB-138), as JSON: null for everyone else, and for someone
    // removed before it was kept, until removedPersonRepos() works it out.
    for (const column of ['work', 'work_other', 'agent_notes', 'avatar', 'removed_repos'])
      if (!columns.includes(column)) this.sql.exec(`ALTER TABLE people ADD COLUMN ${column} TEXT`);
  },

  // ---- Reading -------------------------------------------------------------------------------

  /** A person who hasn't been removed, or null. */
  personRow(handle) {
    return (
      this.sql.exec('SELECT * FROM people WHERE handle = ? AND removed IS NULL', String(handle)).toArray()[0] ?? null
    );
  },

  personGrants(handle) {
    return this.sql
      .exec('SELECT repo, role FROM grants WHERE handle = ? ORDER BY repo', handle)
      .toArray()
      .map((g) => ({ repository: g.repo, role: g.role }));
  },

  /** Whether anyone has been invited: the sign-in page shows passkeys only once someone has one (point 2). */
  peopleAny() {
    return this.sql.exec('SELECT COUNT(*) AS n FROM passkeys').one().n > 0;
  },

  /** The repositories a grant may name: every registered one, the default, and `*`. */
  grantableRepos() {
    return new Set([EVERY_REPO, this.defaultRepoSlug(), ...this.repos().map((r) => r.slug)]);
  },

  /** `[{ repository, role }]` → the same, checked, or `{ error }`. */
  checkGrants(value) {
    if (!Array.isArray(value) || value.length === 0)
      return { error: 'give at least one grant: a repository and a role' };
    if (value.length > MAX_GRANTS) return { error: `at most ${MAX_GRANTS} grants` };
    const known = this.grantableRepos();
    const seen = new Set();
    const grants = [];
    for (const g of value) {
      const repository = typeof g?.repository === 'string' ? g.repository.trim() : '';
      if (!known.has(repository)) return { error: `no repository “${repository}” on this board` };
      if (!ROLES.includes(g?.role)) return { error: `a role is ${ROLES.join(', ')}` };
      if (seen.has(repository)) return { error: `one role per repository: ${repository} is given twice` };
      seen.add(repository);
      grants.push({ repository, role: g.role });
    }
    return { grants };
  },

  /**
   * A person's display name, checked: never one that passes for the owner, so nobody poses as the owner in People or
   * on an invite's page (BRK-328): not ending in "(owner)", and not the owner's own name.
   */
  personName(value) {
    const named = cleanName(value, 'your name');
    if (named.error) return named;
    const owner = this.ownerName();
    if (/\(\s*owner\s*\)$/iu.test(named.name) || (owner && named.name.toLowerCase() === owner.toLowerCase()))
      return { error: 'that name is the owner’s: pick another' };
    return named;
  },

  /** A person as the owner's People list shows them: no secret, ever. */
  personView(p) {
    const count = (table) => this.sql.exec(`SELECT COUNT(*) AS n FROM ${table} WHERE handle = ?`, p.handle).one().n;
    return {
      handle: p.handle,
      name: p.name,
      avatar: p.avatar ?? p.handle,
      grants: this.personGrants(p.handle),
      invitedBy: p.invited_by,
      created: iso(p.created),
      seen: iso(p.seen),
      removed: iso(p.removed),
      passkeys: count('passkeys'),
      tokens: count('person_tokens'),
      sessions: this.sql
        .exec('SELECT COUNT(*) AS n FROM sessions WHERE handle = ? AND expires > ?', p.handle, Date.now())
        .one().n,
    };
  },

  inviteState(row, now = Date.now()) {
    if (row.revoked) return 'revoked';
    if (row.used) return 'used';
    if (row.expires <= now) return 'expired';
    return 'open';
  },

  inviteView(row) {
    return {
      id: row.id,
      grants: JSON.parse(row.grants),
      person: row.person,
      invitedBy: row.invited_by,
      created: iso(row.created),
      expires: iso(row.expires),
      state: this.inviteState(row),
    };
  },

  /** GET /api/people (the owner's): everyone, and the invites from the last 30 days. */
  peopleList() {
    const people = this.sql.exec('SELECT * FROM people ORDER BY removed IS NOT NULL, created').toArray();
    const invites = this.sql
      .exec('SELECT * FROM invites WHERE created > ? ORDER BY created DESC', Date.now() - MAX_INVITE_DAYS * DAY)
      .toArray();
    return ok({ people: people.map((p) => this.personView(p)), invites: invites.map((i) => this.inviteView(i)) });
  },

  /**
   * GET /api/people for a person (BRK-323): the people who share a repository with them, themselves included, and the
   * invites they made. How many passkeys, tokens, and sessions someone has shows only to whoever may Reset them. The
   * Worker's scrub takes out the grants in repositories they can't read.
   * @param {string} handle
   */
  peopleListFor(handle) {
    const { readable } = this.hiddenFrom({ person: handle });
    const shares = (grants) => grants.some((g) => g.repository === EVERY_REPO || readable(g.repository));
    const people = this.sql
      .exec('SELECT * FROM people WHERE removed IS NULL ORDER BY created')
      .toArray()
      .filter((p) => p.handle === handle || shares(this.personGrants(p.handle)))
      .map((p) => {
        const view = this.personView(p);
        if (p.handle === handle || !this.personReach(handle, p)) return view;
        const { passkeys: _p, tokens: _t, sessions: _s, ...rest } = view;
        return rest;
      });
    // Removed people whose work they can see draw as people (WEB-138): their handle, already on that work, and their
    // seed, never their name or grants.
    const removed = this.sql
      .exec('SELECT handle, avatar, removed_repos FROM people WHERE removed IS NOT NULL ORDER BY created')
      .toArray()
      .filter((p) => this.removedPersonRepos(p).some((repository) => repository === EVERY_REPO || readable(repository)))
      .map((p) => ({ handle: p.handle, avatar: p.avatar ?? p.handle }));
    const invites = this.sql
      .exec(
        'SELECT * FROM invites WHERE invited_by = ? AND created > ? ORDER BY created DESC',
        handle,
        Date.now() - MAX_INVITE_DAYS * DAY,
      )
      .toArray();
    return ok({ people, removed, invites: invites.map((i) => this.inviteView(i)) });
  },

  /**
   * The repositories a removed person (a people row) held a grant in, kept when they were removed (WEB-138). Someone
   * removed before that has none kept: the repositories of the tasks their writes touched (BRK-303's versions) stand
   * in, worked out once and kept.
   * @param {{ handle: string, removed_repos: string | null }} p
   * @returns {string[]}
   */
  removedPersonRepos(p) {
    if (p.removed_repos != null) return JSON.parse(p.removed_repos);
    if (!this.key || !this.tasks) return [];
    const fallback = this.defaultRepoSlug();
    const repos = new Set();
    const rows = this.sql
      .exec('SELECT parent_version_id, segment FROM versions WHERE person = ? OR for_person = ?', p.handle, p.handle)
      .toArray();
    for (const row of rows) {
      let ops;
      try {
        ops = decodeSegment(unseal(this.key, row.parent_version_id, new Uint8Array(row.segment)));
      } catch {
        continue;
      }
      for (const op of ops) {
        const map = this.tasks.get(op.uuid);
        if (map) repos.add(repoSlugOf(map, fallback));
      }
    }
    const kept = [...repos];
    this.sql.exec('UPDATE people SET removed_repos = ? WHERE handle = ?', JSON.stringify(kept), p.handle);
    return kept;
  },

  // ---- Managing people: the owner's, and a maintainer's within their repositories ---------------

  /**
   * Why `by` (a person's handle; null is the owner, who reaches everyone) can't give or touch `grants`, or null when
   * they can. A maintainer gives members and viewers, on repositories they maintain, and nothing else: never a
   * maintainer, and never `*` (BRK-301, the spec's point 3, "Managing people").
   * @param {string | null} by
   * @param {{ repository: string, role: string }[]} grants
   */
  peopleReach(by, grants) {
    if (by === null) return null;
    const own = this.personGrants(by);
    for (const g of grants) {
      if (g.repository === EVERY_REPO) return 'only the owner gives the grant on every repository';
      if (g.role === 'maintainer') return 'only the owner makes someone a maintainer';
      const no = refusal({ person: by, grants: own }, 'people.manage', g.repository);
      if (no) return no.message;
    }
    return null;
  },

  /**
   * Why `by` can't change who `person` is on the board (their grants, a Reset, removing them), or null: a maintainer
   * only when every grant the person holds is in their reach, so they never take over another repository's people or
   * lock out a peer.
   */
  personReach(by, person) {
    if (by === null) return null;
    if (person.handle === by) return 'ask someone else to change your own place on the board';
    const grants = this.personGrants(person.handle);
    if (grants.some((g) => g.role === 'maintainer')) return 'only the owner changes, resets, or removes a maintainer';
    return this.peopleReach(by, grants);
  },

  /** A new invite's code and its hash; the code is shown once and never kept. */
  async inviteSecret() {
    const code = randomToken();
    return { code, hash: await hashOf(code) };
  },

  /** Saves an invite (synchronously, after inviteSecret) and gives it back with its code. `person` is a Reset's. */
  inviteInsert({ code, hash }, grants, { days = INVITE_DAYS, person = null, by = 'owner' } = {}) {
    const id = randomToken(12);
    const now = Date.now();
    this.sql.exec(
      'INSERT INTO invites (id, hash, grants, person, invited_by, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      hash,
      JSON.stringify(grants),
      person,
      by,
      now,
      now + days * DAY,
    );
    return { ...this.inviteView(this.sql.exec('SELECT * FROM invites WHERE id = ?', id).one()), code };
  },

  /** POST /api/people/invites: `{ grants: [{ repository, role }], days? }`, by the owner or a maintainer (`by`). */
  async peopleInviteCreate(body, by = null) {
    const checked = this.checkGrants(body?.grants);
    if (checked.error) return fail(400, checked.error);
    const reach = this.peopleReach(by, checked.grants);
    if (reach) return fail(403, reach);
    const days = body?.days ?? INVITE_DAYS;
    if (!Number.isInteger(days) || days < 1 || days > MAX_INVITE_DAYS)
      return fail(400, `an invite lasts 1 to ${MAX_INVITE_DAYS} days`);
    const open = this.sql
      .exec('SELECT COUNT(*) AS n FROM invites WHERE used IS NULL AND revoked IS NULL AND expires > ?', Date.now())
      .one().n;
    if (open >= MAX_OPEN_INVITES)
      return fail(429, `there are ${open} open invites: revoke some before you make another`);
    const secret = await this.inviteSecret();
    // Reachable again after the await: the maintainer's own grants may have changed meanwhile.
    const still = this.peopleReach(by, checked.grants);
    if (still) return fail(403, still);
    return ok({ invite: this.inviteInsert(secret, checked.grants, { days, by: by ?? 'owner' }) }, 201);
  },

  /** DELETE /api/people/invites/:id. */
  peopleInviteRevoke(id, by = null) {
    const row = this.sql.exec('SELECT * FROM invites WHERE id = ?', String(id)).toArray()[0];
    if (!row) return fail(404, 'no such invite');
    const reach = this.peopleReach(by, JSON.parse(row.grants));
    if (reach) return fail(403, reach);
    if (this.inviteState(row) !== 'open') return fail(409, `that invite is already ${this.inviteState(row)}`);
    this.sql.exec('UPDATE invites SET revoked = ? WHERE id = ?', Date.now(), row.id);
    return ok({ invite: this.inviteView({ ...row, revoked: Date.now() }) });
  },

  /** PATCH /api/people/:handle: `{ grants }` replaces them. */
  peopleGrantsSet(handle, body, by = null) {
    const person = this.personRow(handle);
    if (!person) return fail(404, `no person “${handle}”`);
    const checked = this.checkGrants(body?.grants);
    if (checked.error) return fail(400, checked.error);
    const reach = this.personReach(by, person) ?? this.peopleReach(by, checked.grants);
    if (reach) return fail(403, reach);
    this.sql.exec('DELETE FROM grants WHERE handle = ?', person.handle);
    for (const g of checked.grants)
      this.sql.exec('INSERT INTO grants (handle, repo, role) VALUES (?, ?, ?)', person.handle, g.repository, g.role);
    return ok({ person: this.personView(person) });
  },

  /** Ends every way a person has in: passkeys, personal tokens, sessions, and their open invites. */
  revokeAccess(handle) {
    for (const table of ['passkeys', 'person_tokens', 'sessions'])
      this.sql.exec(`DELETE FROM ${table} WHERE handle = ?`, handle);
    this.sql.exec(
      'UPDATE invites SET revoked = ? WHERE person = ? AND used IS NULL AND revoked IS NULL',
      Date.now(),
      handle,
    );
    this.sql.exec("DELETE FROM passkey_challenges WHERE purpose = 'add' AND subject = ?", handle);
  },

  /**
   * POST /api/people/:handle/reset (the owner's 8 Oct decision): revokes the person's passkeys, personal tokens, and
   * sessions, and makes a new one-time invite with the same grants to share by hand.
   */
  async peopleReset(handle, by = null) {
    const secret = await this.inviteSecret();
    // After the await, in one step: the person is cut off, and only the new link brings them back.
    const person = this.personRow(handle);
    if (!person) return fail(404, `no person “${handle}”`);
    const reach = this.personReach(by, person);
    if (reach) return fail(403, reach);
    this.revokeAccess(person.handle);
    const invite = this.inviteInsert(secret, this.personGrants(person.handle), {
      person: person.handle,
      by: by ?? 'owner',
    });
    return ok({ person: this.personView(person), invite });
  },

  /** DELETE /api/people/:handle: their handle stays on what they did, and can't be given to anyone else. */
  peopleRemove(handle, by = null) {
    const person = this.personRow(handle);
    if (!person) return fail(404, `no person “${handle}”`);
    const reach = this.personReach(by, person);
    if (reach) return fail(403, reach);
    this.revokeAccess(person.handle);
    // Their own Claude routines go too (BRK-302): nothing starts on them again.
    this.dropPersonClaude(person.handle);
    // Where they had a grant is kept, so whoever sees their work there still draws them as a person (WEB-138).
    const repos = this.personGrants(person.handle).map((g) => g.repository);
    this.sql.exec('DELETE FROM grants WHERE handle = ?', person.handle);
    // Their name stays on what they did; their profile was for their agents, and goes with them (BRK-329).
    this.sql.exec(
      'UPDATE people SET removed = ?, removed_repos = ?, work = NULL, work_other = NULL, agent_notes = NULL WHERE handle = ?',
      Date.now(),
      JSON.stringify(repos),
      person.handle,
    );
    return ok({ removed: person.handle });
  },

  // ---- Passkey challenges -------------------------------------------------------------------

  challengePrune(now = Date.now()) {
    this.sql.exec('DELETE FROM passkey_challenges WHERE created < ?', now - CHALLENGE_MS);
  },

  challengeMake(purpose, subject = null, data = null) {
    this.challengePrune();
    const waiting = this.sql.exec('SELECT COUNT(*) AS n FROM passkey_challenges').one().n;
    if (waiting >= MAX_CHALLENGES) return null;
    const id = randomToken(16);
    const challenge = randomToken();
    this.sql.exec(
      'INSERT INTO passkey_challenges (id, challenge, purpose, subject, data, created) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      challenge,
      purpose,
      subject,
      data === null ? null : JSON.stringify(data),
      Date.now(),
    );
    return { id, challenge };
  },

  /** Takes a challenge for one use: it's gone whether the passkey's answer checks out or not. */
  challengeTake(id, purpose, subject = null) {
    this.challengePrune();
    if (typeof id !== 'string' || !ID.test(id)) return null;
    const row = this.sql.exec('SELECT * FROM passkey_challenges WHERE id = ?', id).toArray()[0];
    if (!row) return null;
    this.sql.exec('DELETE FROM passkey_challenges WHERE id = ?', id);
    if (row.purpose !== purpose || (subject !== null && row.subject !== subject)) return null;
    return { ...row, data: row.data ? JSON.parse(row.data) : null };
  },

  /** What navigator.credentials.create needs, for a person's new passkey. */
  creationOptions(challenge, rp, person, exclude = []) {
    return {
      challenge,
      rp: { id: rp.id, name: rp.name },
      user: { id: person.webauthnId, name: person.handle, displayName: person.name },
      pubKeyCredParams: [-7, -8, -257].map((alg) => ({ type: 'public-key', alg })),
      timeout: CHALLENGE_MS,
      attestation: 'none',
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      excludeCredentials: exclude.map((id) => ({ type: 'public-key', id })),
    };
  },

  /** Saves a passkey that verifyRegistration checked. */
  passkeyInsert(handle, checked, name) {
    const now = Date.now();
    this.sql.exec(
      'INSERT INTO passkeys (id, handle, name, alg, jwk, sign_count, created) VALUES (?, ?, ?, ?, ?, ?, ?)',
      checked.credentialId,
      handle,
      name,
      checked.alg,
      JSON.stringify(checked.jwk),
      checked.signCount,
      now,
    );
  },

  /** A new session for a person; gives back the cookie's value, once. */
  async sessionMake(handle, device) {
    const id = randomToken(16);
    const secret = randomToken();
    const hash = await hashOf(secret);
    return {
      id,
      value: `p${id}.${secret}`,
      hash,
      handle,
      device: String(device ?? '').slice(0, MAX_NAME) || 'a browser',
    };
  },

  sessionInsert(made) {
    const now = Date.now();
    this.sql.exec(
      'INSERT INTO sessions (id, hash, handle, device, created, seen, expires) VALUES (?, ?, ?, ?, ?, ?, ?)',
      made.id,
      made.hash,
      made.handle,
      made.device,
      now,
      now,
      now + SESSION_DAYS * DAY,
    );
  },

  // ---- Joining by invite (public: the code is the credential) ---------------------------------

  /** The invite a code opens, or a failure that says why it doesn't. */
  async inviteByCode(code) {
    if (typeof code !== 'string' || !/^[\w-]{20,64}$/u.test(code))
      return { failure: fail(404, 'this invite link isn’t right: ask whoever invited you for a new one') };
    const row = this.sql.exec('SELECT * FROM invites WHERE hash = ?', await hashOf(code)).toArray()[0];
    if (!row) return { failure: fail(404, 'this invite link isn’t right: ask whoever invited you for a new one') };
    const state = this.inviteState(row);
    if (state !== 'open')
      return { failure: fail(410, `this invite was ${state}: ask whoever invited you for a new one`, { state }) };
    if (row.person && !this.personRow(row.person))
      return {
        failure: fail(410, 'this invite was revoked: ask whoever invited you for a new one', { state: 'revoked' }),
      };
    return { row };
  },

  /** GET /api/join/:code: who invited you, with what role, and until when. */
  async peopleJoinInfo(code) {
    const { row, failure } = await this.inviteByCode(code);
    if (failure) return failure;
    const person = row.person ? this.personRow(row.person) : null;
    const inviter =
      row.invited_by === OWNER
        ? null
        : this.sql.exec('SELECT name FROM people WHERE handle = ?', row.invited_by).toArray()[0];
    return ok({
      invitedBy: row.invited_by,
      // Who to show: the owner as "<name> (owner)" once they've named themselves (BRK-328), a maintainer by name.
      inviter: row.invited_by === OWNER ? this.ownerLabel() : (inviter?.name ?? row.invited_by),
      grants: JSON.parse(row.grants),
      expires: iso(row.expires),
      person: person ? { handle: person.handle, name: person.name } : null,
    });
  },

  /** POST /api/join/:code/options: `{ name, handle }` (a Reset's invite keeps the person's) → creation options. */
  async peopleJoinOptions(code, body, rp) {
    const { row, failure } = await this.inviteByCode(code);
    if (failure) return failure;
    let person;
    if (row.person) {
      const p = this.personRow(row.person);
      person = { handle: p.handle, name: p.name, webauthnId: p.webauthn_id };
    } else {
      const named = this.personName(body?.name);
      if (named.error) return fail(400, named.error);
      const handle = typeof body?.handle === 'string' ? body.handle.trim() : '';
      const problem = handleProblem(handle);
      if (problem) return fail(400, problem);
      if (this.sql.exec('SELECT 1 FROM people WHERE handle = ?', handle).toArray().length)
        return fail(409, `the handle “${handle}” is taken: pick another`);
      person = { handle, name: named.name, webauthnId: randomToken(16) };
    }
    const challenge = this.challengeMake('join', row.id, person);
    if (!challenge) return fail(429, 'too many sign-ins are waiting: try again in a few minutes');
    return ok({ challengeId: challenge.id, publicKey: this.creationOptions(challenge.challenge, rp, person) });
  },

  /**
   * POST /api/join/:code: `{ challengeId, credential, passkeyName? }`. Checks the new passkey, then, in one step,
   * uses the invite up, adds the person (or, for a Reset, gives them their passkey back), and signs them in.
   */
  async peopleJoin(code, body, rp, device) {
    const { row, failure } = await this.inviteByCode(code);
    if (failure) return failure;
    const taken = this.challengeTake(body?.challengeId, 'join', row.id);
    if (!taken) return fail(400, 'that passkey request ran out or was used: start again');
    const passkeyName = body?.passkeyName ? cleanName(body.passkeyName, 'the passkey’s name') : { name: 'Passkey' };
    if (passkeyName.error) return fail(400, passkeyName.error);
    let checked;
    try {
      checked = await verifyRegistration(body?.credential?.response, {
        challenge: taken.challenge,
        origin: rp.origin,
        rpId: rp.id,
      });
    } catch (error) {
      if (error instanceof PasskeyError) return fail(400, error.message);
      throw error;
    }
    const made = await this.sessionMake(taken.data.handle, device);
    // After the last await: everything below runs in one step, so an invite is used once.
    const fresh = this.sql.exec('SELECT * FROM invites WHERE id = ?', row.id).one();
    if (this.inviteState(fresh) !== 'open')
      return fail(410, `this invite was ${this.inviteState(fresh)}: ask whoever invited you for a new one`, {
        state: this.inviteState(fresh),
      });
    if (this.sql.exec('SELECT 1 FROM passkeys WHERE id = ?', checked.credentialId).toArray().length)
      return fail(409, 'that passkey is already on this board');
    const { handle, name, webauthnId } = taken.data;
    if (row.person) {
      if (!this.personRow(handle)) return fail(410, 'this invite was revoked: ask whoever invited you for a new one');
    } else {
      if (this.sql.exec('SELECT 1 FROM people WHERE handle = ?', handle).toArray().length)
        return fail(409, `the handle “${handle}” is taken: pick another`);
      this.sql.exec(
        'INSERT INTO people (handle, name, webauthn_id, invited_by, created, seen) VALUES (?, ?, ?, ?, ?, ?)',
        handle,
        name,
        webauthnId,
        row.invited_by,
        Date.now(),
        Date.now(),
      );
      for (const g of JSON.parse(row.grants))
        this.sql.exec('INSERT INTO grants (handle, repo, role) VALUES (?, ?, ?)', handle, g.repository, g.role);
    }
    this.passkeyInsert(handle, checked, passkeyName.name);
    this.sql.exec('UPDATE invites SET used = ? WHERE id = ?', Date.now(), row.id);
    this.sessionInsert(made);
    return ok(
      { person: { handle, name: this.personRow(handle).name }, session: made.value, maxAge: SESSION_DAYS * 86400 },
      201,
    );
  },

  // ---- Signing in with a passkey (public) ----------------------------------------------------

  /** POST /api/signin/options → request options for a passkey the browser picks (a discoverable credential). */
  peopleSigninOptions(rp) {
    const challenge = this.challengeMake('signin');
    if (!challenge) return fail(429, 'too many sign-ins are waiting: try again in a few minutes');
    return ok({
      challengeId: challenge.id,
      publicKey: { challenge: challenge.challenge, rpId: rp.id, timeout: CHALLENGE_MS, userVerification: 'required' },
    });
  },

  /** POST /api/signin: `{ challengeId, credential }` → a session for the passkey's person. */
  async peopleSignin(body, rp, device) {
    const taken = this.challengeTake(body?.challengeId, 'signin');
    if (!taken) return fail(400, 'that sign-in ran out or was used: start again');
    const id = body?.credential?.id;
    const passkey =
      typeof id === 'string' ? this.sql.exec('SELECT * FROM passkeys WHERE id = ?', id).toArray()[0] : null;
    // The owner's own passkey (BRK-328): it signs the owner in as the token does, and the Worker makes the token's cookie.
    if (passkey?.handle === OWNER) return this.ownerSignin(body, rp, passkey, taken);
    const person = passkey ? this.personRow(passkey.handle) : null;
    if (!passkey || !person) return fail(401, 'this passkey isn’t on this board: ask whoever invited you to Reset you');
    const userHandle = body.credential.response?.userHandle;
    if (userHandle && userHandle !== person.webauthn_id) return fail(401, 'this passkey belongs to someone else');
    let checked;
    try {
      checked = await verifyAssertion(body.credential.response, {
        challenge: taken.challenge,
        origin: rp.origin,
        rpId: rp.id,
        alg: passkey.alg,
        jwk: JSON.parse(passkey.jwk),
        signCount: passkey.sign_count,
      });
    } catch (error) {
      if (error instanceof PasskeyError) return fail(401, error.message);
      throw error;
    }
    const made = await this.sessionMake(person.handle, device);
    // A Reset or a removal meanwhile wins.
    if (
      !this.sql.exec('SELECT 1 FROM passkeys WHERE id = ?', passkey.id).toArray().length ||
      !this.personRow(person.handle)
    )
      return fail(401, 'this passkey isn’t on this board: ask whoever invited you to Reset you');
    const now = Date.now();
    this.sql.exec('UPDATE passkeys SET sign_count = ?, used = ? WHERE id = ?', checked.signCount, now, passkey.id);
    this.sql.exec('UPDATE people SET seen = ? WHERE handle = ?', now, person.handle);
    this.sessionInsert(made);
    return ok({
      person: { handle: person.handle, name: person.name },
      session: made.value,
      maxAge: SESSION_DAYS * 86400,
    });
  },

  // ---- Who a credential is -------------------------------------------------------------------

  /** A personal token's person (by the token's SHA-256), or null. */
  personOfToken(hash) {
    const row = this.sql.exec('SELECT * FROM person_tokens WHERE hash = ?', String(hash)).toArray()[0];
    const person = row ? this.personRow(row.handle) : null;
    if (!person) return null;
    const now = Date.now();
    if (!row.used || now - row.used > SEEN_EVERY_MS)
      this.sql.exec('UPDATE person_tokens SET used = ? WHERE id = ?', now, row.id);
    this.personSeen(person, now);
    return { handle: person.handle, name: person.name, token: row.id };
  },

  /** A session cookie's person, or null; a session that's used is renewed. */
  personOfSession(id, hash) {
    const row = this.sql.exec('SELECT * FROM sessions WHERE id = ?', String(id)).toArray()[0];
    const now = Date.now();
    if (!row || row.expires <= now || !sameHex(row.hash, String(hash))) return null;
    const person = this.personRow(row.handle);
    if (!person) return null;
    if (now - row.seen > SEEN_EVERY_MS)
      this.sql.exec('UPDATE sessions SET seen = ?, expires = ? WHERE id = ?', now, now + SESSION_DAYS * DAY, row.id);
    this.personSeen(person, now);
    return { handle: person.handle, name: person.name, session: row.id };
  },

  personSeen(person, now) {
    if (!person.seen || now - person.seen > SEEN_EVERY_MS)
      this.sql.exec('UPDATE people SET seen = ? WHERE handle = ?', now, person.handle);
  },

  // ---- A person's own: their name, passkeys, tokens, and sessions ----------------------------

  /** GET /api/me: who you are, your grants, and your passkeys, tokens, and sessions (never a secret). */
  personMe(handle, session = null) {
    const person = this.personRow(handle);
    if (!person) return fail(401, 'sign in again');
    return ok({
      person: { handle: person.handle, name: person.name, created: iso(person.created) },
      // The board's owner, as people see them: the handle stays `owner`, and the name is theirs to set (BRK-328).
      owner: this.ownerView(),
      grants: this.personGrants(person.handle),
      passkeys: this.sql
        .exec('SELECT id, name, created, used FROM passkeys WHERE handle = ? ORDER BY created', handle)
        .toArray()
        .map((p) => ({ id: p.id, name: p.name, created: iso(p.created), used: iso(p.used) })),
      tokens: this.sql
        .exec('SELECT id, name, created, used FROM person_tokens WHERE handle = ? ORDER BY created', handle)
        .toArray()
        .map((t) => ({ id: t.id, name: t.name, created: iso(t.created), used: iso(t.used) })),
      sessions: this.sql
        .exec(
          'SELECT id, device, created, seen, expires FROM sessions WHERE handle = ? AND expires > ? ORDER BY seen DESC',
          handle,
          Date.now(),
        )
        .toArray()
        .map((s) => ({
          id: s.id,
          device: s.device,
          created: iso(s.created),
          seen: iso(s.seen),
          expires: iso(s.expires),
          current: s.id === session,
        })),
    });
  },

  /** PATCH /api/me: `{ name }`. The handle never changes. */
  personRename(handle, body) {
    const named = this.personName(body?.name);
    if (named.error) return fail(400, named.error);
    if (!this.personRow(handle)) return fail(401, 'sign in again');
    this.sql.exec('UPDATE people SET name = ? WHERE handle = ?', named.name, handle);
    return this.personMe(handle);
  },

  // ---- Profiles (BRK-329): what someone does, and a line for the agents they start --------------

  /**
   * A profile: a person's from their row, the owner's from the board's settings. Null for nobody the board knows.
   * @returns {import('./profile.js').Profile | null}
   */
  profileOf(handle) {
    if (handle === OWNER) return this.ownerProfile();
    const p = this.personRow(handle);
    return p ? { work: p.work ?? null, other: p.work_other ?? null, notes: p.agent_notes ?? null } : null;
  },

  /**
   * The run payload's `For:` line for the person a run is for: their name, work, and notes, and `claude`, whose Claude
   * the run is on (BRK-302), or null when there's none of these (or they're no longer on the board).
   */
  forLineOf(handle, claude = null) {
    const profile = this.profileOf(handle);
    if (!profile) return null;
    const name = handle === OWNER ? (this.ownerName() ?? 'the owner') : this.personRow(handle).name;
    return forLine(name, profile, claude);
  },

  /** GET /api/me/profile, for a person or the owner: their profile, and the kinds of work to pick from. */
  profileMe(handle) {
    const profile = this.profileOf(handle);
    if (!profile) return fail(401, 'sign in again');
    return ok({ profile, works: WORKS });
  },

  /**
   * PATCH /api/me/profile: `{ work?, other?, notes? }` (src/profile.js says what each takes). Only the person, or the
   * owner, sets their own: the route passes the caller's handle, never one from the request.
   */
  profileSet(handle, body) {
    const current = this.profileOf(handle);
    if (!current) return fail(401, 'sign in again');
    // `actor` is the Worker's, added to the owner's requests (src/worker.js): who's asking, never part of the profile.
    const given = body && typeof body === 'object' && !Array.isArray(body) ? { ...body } : body;
    if (given && typeof given === 'object') delete given.actor;
    const changed = profileChange(given, current);
    if ('error' in changed) return fail(400, changed.error);
    const { work, other, notes } = changed.profile;
    if (handle === OWNER) this.ownerProfileSet(changed.profile);
    else
      this.sql.exec(
        'UPDATE people SET work = ?, work_other = ?, agent_notes = ? WHERE handle = ?',
        work,
        other,
        notes,
        handle,
      );
    return this.profileMe(handle);
  },

  // ---- Avatars (WEB-134, docs/specs/ID-9-avatars.md): the seed a person's pattern is drawn from ---------------

  /** Someone's avatar seed: what they shuffled to, or their handle until they do. Null for nobody the board knows. */
  avatarOf(handle) {
    if (handle === OWNER) return this.ownerAvatar();
    const p = this.personRow(handle);
    return p ? (p.avatar ?? p.handle) : null;
  },

  /**
   * GET /api/me/avatar, for a person or the owner: `{ avatar, owner }`, their seed and the owner's, whom everyone sees.
   * Other people's seeds come with the people list (personView).
   */
  avatarMe(handle) {
    const avatar = this.avatarOf(handle);
    return avatar ? ok({ avatar, owner: this.ownerAvatar() }) : fail(401, 'sign in again');
  },

  /**
   * POST /api/me/avatar: Shuffle. A new random seed, kept until they shuffle again. Only the person, or the owner,
   * shuffles their own: the route passes the caller's handle, never one from the request.
   */
  avatarShuffle(handle) {
    if (!this.avatarOf(handle)) return fail(401, 'sign in again');
    const avatar = randomToken(9);
    if (handle === OWNER) this.ownerAvatarSet(avatar);
    else this.sql.exec('UPDATE people SET avatar = ? WHERE handle = ?', avatar, handle);
    return this.avatarMe(handle);
  },

  /** POST /api/me/tokens: `{ name }` → the token, shown this once. */
  async personTokenCreate(handle, body) {
    const named = cleanName(body?.name, 'the token’s name');
    if (named.error) return fail(400, named.error);
    const token = `${TOKEN_PREFIX}${randomToken()}`;
    const hash = await hashOf(token);
    if (!this.personRow(handle)) return fail(401, 'sign in again');
    if (this.sql.exec('SELECT COUNT(*) AS n FROM person_tokens WHERE handle = ?', handle).one().n >= MAX_TOKENS)
      return fail(409, `you have ${MAX_TOKENS} tokens: revoke one first`);
    const id = randomToken(12);
    this.sql.exec(
      'INSERT INTO person_tokens (id, hash, handle, name, created) VALUES (?, ?, ?, ?, ?)',
      id,
      hash,
      handle,
      named.name,
      Date.now(),
    );
    return ok({ id, name: named.name, token }, 201);
  },

  /** DELETE /api/me/tokens/:id. */
  personTokenRevoke(handle, id) {
    const found = this.sql
      .exec('SELECT 1 FROM person_tokens WHERE id = ? AND handle = ?', String(id), handle)
      .toArray();
    if (!found.length) return fail(404, 'no such token');
    this.sql.exec('DELETE FROM person_tokens WHERE id = ?', String(id));
    return ok({ revoked: String(id) });
  },

  /** POST /api/me/passkeys/options → creation options for another passkey. */
  personPasskeyOptions(handle, rp) {
    const p = this.personRow(handle);
    if (!p) return fail(401, 'sign in again');
    const exclude = this.sql
      .exec('SELECT id FROM passkeys WHERE handle = ?', handle)
      .toArray()
      .map((r) => r.id);
    if (exclude.length >= MAX_PASSKEYS) return fail(409, `you have ${MAX_PASSKEYS} passkeys: remove one first`);
    const challenge = this.challengeMake('add', handle);
    if (!challenge) return fail(429, 'too many sign-ins are waiting: try again in a few minutes');
    return ok({
      challengeId: challenge.id,
      publicKey: this.creationOptions(
        challenge.challenge,
        rp,
        { handle: p.handle, name: p.name, webauthnId: p.webauthn_id },
        exclude,
      ),
    });
  },

  /** POST /api/me/passkeys: `{ challengeId, credential, name? }`. */
  async personPasskeyAdd(handle, body, rp) {
    const taken = this.challengeTake(body?.challengeId, 'add', handle);
    if (!taken) return fail(400, 'that passkey request ran out or was used: start again');
    const named = body?.name ? cleanName(body.name, 'the passkey’s name') : { name: 'Passkey' };
    if (named.error) return fail(400, named.error);
    let checked;
    try {
      checked = await verifyRegistration(body?.credential?.response, {
        challenge: taken.challenge,
        origin: rp.origin,
        rpId: rp.id,
      });
    } catch (error) {
      if (error instanceof PasskeyError) return fail(400, error.message);
      throw error;
    }
    if (!this.personRow(handle)) return fail(401, 'sign in again');
    if (this.sql.exec('SELECT 1 FROM passkeys WHERE id = ?', checked.credentialId).toArray().length)
      return fail(409, 'that passkey is already on this board');
    this.passkeyInsert(handle, checked, named.name);
    return ok({ id: checked.credentialId, name: named.name }, 201);
  },

  /** PATCH /api/me/passkeys/:id: `{ name }`. */
  personPasskeyRename(handle, id, body) {
    const named = cleanName(body?.name, 'the passkey’s name');
    if (named.error) return fail(400, named.error);
    const found = this.sql.exec('SELECT 1 FROM passkeys WHERE id = ? AND handle = ?', String(id), handle).toArray();
    if (!found.length) return fail(404, 'no such passkey');
    this.sql.exec('UPDATE passkeys SET name = ? WHERE id = ?', named.name, String(id));
    return ok({ id: String(id), name: named.name });
  },

  /** DELETE /api/me/passkeys/:id: any but the last, so a person can't lock themselves out. */
  personPasskeyRemove(handle, id) {
    const found = this.sql.exec('SELECT 1 FROM passkeys WHERE id = ? AND handle = ?', String(id), handle).toArray();
    if (!found.length) return fail(404, 'no such passkey');
    if (this.sql.exec('SELECT COUNT(*) AS n FROM passkeys WHERE handle = ?', handle).one().n <= 1)
      return fail(409, 'this is your last passkey: add another before you remove it');
    this.sql.exec('DELETE FROM passkeys WHERE id = ?', String(id));
    return ok({ removed: String(id) });
  },

  /** DELETE /api/me/sessions/:id: signs one browser out. */
  personSessionEnd(handle, id) {
    const found = this.sql.exec('SELECT 1 FROM sessions WHERE id = ? AND handle = ?', String(id), handle).toArray();
    if (!found.length) return fail(404, 'no such session');
    this.sql.exec('DELETE FROM sessions WHERE id = ?', String(id));
    return ok({ ended: String(id) });
  },

  /** DELETE /api/me/sessions: Sign out everywhere, this browser included. */
  personSessionsEndAll(handle) {
    const n = this.sql.exec('SELECT COUNT(*) AS n FROM sessions WHERE handle = ?', handle).one().n;
    this.sql.exec('DELETE FROM sessions WHERE handle = ?', handle);
    return ok({ ended: n });
  },

  /** /logout with a person's cookie: that session ends on the board, not only in the browser. */
  async personSignOut(id, secret) {
    const hash = await hashOf(secret);
    const row = this.sql.exec('SELECT hash FROM sessions WHERE id = ?', String(id)).toArray()[0];
    if (row && sameHex(row.hash, hash)) this.sql.exec('DELETE FROM sessions WHERE id = ?', String(id));
    return ok({});
  },
};
