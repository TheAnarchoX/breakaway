/**
 * TaskStore's owner (BRK-328, docs/specs/BRK-299-people-and-roles.md, points 1 and 2): the owner's display name, their
 * profile (BRK-329), and the owner's own passkeys.
 *
 * The owner is still the board's token, with no row in `people`: these only add a way in and a name. The owner's
 * passkeys sit in `passkeys` under the handle `owner`, which no person can have, so nothing a person does reaches
 * them. A passkey only ever signs the owner in the way the token does (src/people.js makes the token's own cookie),
 * so rotating the token still signs every owner session out, and the token always signs in, whatever passkeys there
 * are or aren't. Adding, renaming, and removing one is the owner's press; the Worker checks that.
 */
import { PasskeyError, verifyAssertion, verifyRegistration } from './webauthn.js';
import { OWNER } from './permissions.js';
import { randomToken } from './store-people.js';

const MAX_NAME = 80;
const MAX_PASSKEYS = 20;

const ok = (body, status = 200) => ({ status, body });
const fail = (status, error) => ({ status, body: { error } });
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

/** A display name or a passkey's name: trimmed, one line. Empty is allowed only where `empty` says so. */
function cleanName(value, what, empty = false) {
  const name = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  if (!name) return empty && (value === null || typeof value === 'string') ? { name: null } : { error: `give ${what}` };
  if (name.length > MAX_NAME) return { error: `${what} is at most ${MAX_NAME} characters` };
  if (/[\u0000-\u001f\u007f]/u.test(name)) return { error: `${what} can’t hold control characters` };
  return { name };
}

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const ownerMethods = {
  /** The owner's display name, or null: unset, the board says "the owner" (and "you" to the owner). */
  ownerName() {
    return this.meta('owner_name');
  },

  /** How people see the owner: "<name> (owner)", or "the owner" until a name is set. The handle stays `owner`. */
  ownerLabel() {
    const name = this.ownerName();
    return name ? `${name} (owner)` : 'the owner';
  },

  /**
   * The owner's profile (BRK-329): their work, their own words for Other, and their notes for agents, kept with the
   * board's settings like their name. Only the owner sets it (store-people.js, profileSet).
   * @returns {import('./profile.js').Profile}
   */
  ownerProfile() {
    return {
      work: this.meta('owner_work'),
      other: this.meta('owner_work_other'),
      notes: this.meta('owner_agent_notes'),
    };
  },

  /** @param {import('./profile.js').Profile} profile a checked one (src/profile.js, profileChange) */
  ownerProfileSet({ work, other, notes }) {
    this.setMeta('owner_work', work);
    this.setMeta('owner_work_other', other);
    this.setMeta('owner_agent_notes', notes);
  },

  /** The owner's avatar seed (WEB-134): what they shuffled to, kept with the board's settings, or their handle. */
  ownerAvatar() {
    return this.meta('owner_avatar') ?? OWNER;
  },

  /** @param {string} seed a new one, from Shuffle (store-people.js, avatarShuffle) */
  ownerAvatarSet(seed) {
    this.setMeta('owner_avatar', seed);
  },

  /** The owner as people-facing answers name them: the fixed handle, the display name, and the label. */
  ownerView() {
    return { handle: OWNER, name: this.ownerName(), label: this.ownerLabel() };
  },

  /** The owner's WebAuthn user ID, made once: a passkey manager groups the owner's passkeys by it. */
  ownerWebauthnId() {
    let id = this.meta('owner_webauthn_id');
    if (!id) {
      id = randomToken(16);
      this.setMeta('owner_webauthn_id', id);
    }
    return id;
  },

  /** Whether the owner has a passkey: Set up the board's optional step. */
  ownerHasPasskey() {
    return this.sql.exec('SELECT COUNT(*) AS n FROM passkeys WHERE handle = ?', OWNER).one().n > 0;
  },

  /** GET /api/me, for the owner: their name and passkeys. The owner has no personal tokens or sessions here. */
  ownerMe() {
    return ok({
      person: { ...this.ownerView(), owner: true },
      passkeys: this.sql
        .exec('SELECT id, name, created, used FROM passkeys WHERE handle = ? ORDER BY created', OWNER)
        .toArray()
        .map((p) => ({ id: p.id, name: p.name, created: iso(p.created), used: iso(p.used) })),
    });
  },

  /** PATCH /api/me, for the owner: `{ name }`; null or empty clears it. The handle never changes. */
  ownerRename(body) {
    const named = cleanName(body?.name, 'your name', true);
    if (named.error) return fail(400, named.error);
    this.setMeta('owner_name', named.name);
    return this.ownerMe();
  },

  /** POST /api/me/passkeys/options, for the owner → creation options for a passkey of their own. */
  ownerPasskeyOptions(rp) {
    const exclude = this.sql
      .exec('SELECT id FROM passkeys WHERE handle = ?', OWNER)
      .toArray()
      .map((r) => r.id);
    if (exclude.length >= MAX_PASSKEYS) return fail(409, `you have ${MAX_PASSKEYS} passkeys: remove one first`);
    const challenge = this.challengeMake('owner-add', OWNER);
    if (!challenge) return fail(429, 'too many sign-ins are waiting: try again in a few minutes');
    const person = { handle: OWNER, name: this.ownerName() ?? 'The owner', webauthnId: this.ownerWebauthnId() };
    return ok({
      challengeId: challenge.id,
      publicKey: this.creationOptions(challenge.challenge, rp, person, exclude),
    });
  },

  /** POST /api/me/passkeys, for the owner: `{ challengeId, credential, name? }`. */
  async ownerPasskeyAdd(body, rp) {
    const taken = this.challengeTake(body?.challengeId, 'owner-add', OWNER);
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
    if (this.sql.exec('SELECT 1 FROM passkeys WHERE id = ?', checked.credentialId).toArray().length)
      return fail(409, 'that passkey is already on this board');
    this.passkeyInsert(OWNER, checked, named.name);
    return ok({ id: checked.credentialId, name: named.name }, 201);
  },

  /**
   * The rest of POST /api/signin when the passkey is the owner's (peopleSignin took the challenge): checks it, and
   * answers `{ owner: true }` with no session, since the owner's cookie is the token's (src/people.js makes it).
   */
  async ownerSignin(body, rp, passkey, taken) {
    const userHandle = body.credential.response?.userHandle;
    if (userHandle && userHandle !== this.meta('owner_webauthn_id'))
      return fail(401, 'this passkey belongs to someone else');
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
    // Removed meanwhile: it no longer signs anyone in.
    if (!this.sql.exec('SELECT 1 FROM passkeys WHERE id = ? AND handle = ?', passkey.id, OWNER).toArray().length)
      return fail(401, 'this passkey isn’t on this board: sign in with the board’s token');
    this.sql.exec(
      'UPDATE passkeys SET sign_count = ?, used = ? WHERE id = ?',
      checked.signCount,
      Date.now(),
      passkey.id,
    );
    return ok({ owner: true, person: { handle: OWNER, name: this.ownerName() } });
  },

  /** PATCH /api/me/passkeys/:id, for the owner: `{ name }`. */
  ownerPasskeyRename(id, body) {
    return this.personPasskeyRename(OWNER, id, body);
  },

  /**
   * DELETE /api/me/passkeys/:id, for the owner: any of them, the last one too. The board's token always signs the
   * owner in, so removing a passkey can't lock the owner out.
   */
  ownerPasskeyRemove(id) {
    const found = this.sql.exec('SELECT 1 FROM passkeys WHERE id = ? AND handle = ?', String(id), OWNER).toArray();
    if (!found.length) return fail(404, 'no such passkey');
    this.sql.exec('DELETE FROM passkeys WHERE id = ?', String(id));
    return ok({ removed: String(id) });
  },
};
