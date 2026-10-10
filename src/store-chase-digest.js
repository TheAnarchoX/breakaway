/**
 * TaskStore's chase digests (BRK-277, docs/specs/BRK-277-chase-digest.md): once an hour while a chase runs, and once
 * when it stops or ends, the board writes a digest of it for the owner: what merged, what waits for them, what's
 * stuck, what starts next, and the road captain's lines. The inbox shows the newest one per chase, the feature lists
 * them, and each has a page. A push goes out only when the owner turned it on for the chase, at most one an hour, and
 * only for a digest with something in it.
 */
import { AgentError } from './store-agents.js';
import { InputError } from './model.js';
import { install } from './install.js';
import { looksLikeSecret } from './ping.js';
import {
  DIGEST_NOTE_MAX,
  buildDigest,
  digestCounts,
  digestHeadline,
  digestKind,
  digestMessage,
  digestQuiet,
} from './chase-digest.js';

/** How often a running chase gets a digest. */
export const DIGEST_EVERY_MS = 3_600_000;
/** The least time between two digest pushes, across every chase. */
const PUSH_GAP_MS = 3_600_000;
const DIGESTS_KEPT_MS = 30 * 86_400_000;
/** How many of a chase's digests its feature lists. */
const LISTED = 48;

const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const chaseDigestMethods = {
  initChaseDigest() {
    const columns = this.sql
      .exec('PRAGMA table_info(features)')
      .toArray()
      .map((c) => c.name);
    // Off by default: a digest only shows in the inbox until the owner asks for a push.
    if (!columns.includes('chase_digest_push'))
      this.sql.exec('ALTER TABLE features ADD COLUMN chase_digest_push INTEGER NOT NULL DEFAULT 0');
    // The road captain's lines for the next digest.
    if (!columns.includes('chase_digest_note')) this.sql.exec('ALTER TABLE features ADD COLUMN chase_digest_note TEXT');
    if (!columns.includes('chase_digest_note_by'))
      this.sql.exec('ALTER TABLE features ADD COLUMN chase_digest_note_by TEXT');
    if (!columns.includes('chase_digest_note_at'))
      this.sql.exec('ALTER TABLE features ADD COLUMN chase_digest_note_at INTEGER');
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS chase_digests (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL,
        data TEXT NOT NULL, dismissed INTEGER NOT NULL DEFAULT 0, pushed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS chase_digests_slug ON chase_digests (slug, id);
    `);
  },

  /** The chase's latest digest row since it started, or null. */
  chaseDigestLast(row) {
    return (
      this.sql
        .exec(
          'SELECT id, at FROM chase_digests WHERE slug = ? AND at >= ? ORDER BY id DESC LIMIT 1',
          row.slug,
          Number(row.chase_started ?? 0),
        )
        .toArray()[0] ?? null
    );
  },

  /**
   * The chase's pull requests merged from `from` to `to`: the ones that close a task in it, with the screenshots
   * their descriptions carry.
   */
  chaseDigestMerged(row, views, from, to) {
    const tasks = this.chaseMembers(row, views)
      .map(({ t }) => t)
      .filter((t) => t.wid && !t.tags.includes('captain'));
    if (!tasks.length) return [];
    const byWid = new Map(tasks.map((t) => [`${t.repo}:${t.wid}`, t]));
    const repos = [...new Set(tasks.map((t) => t.repo))];
    const merged = [];
    for (const repo of repos) {
      for (const { data } of this.sql
        .exec("SELECT data FROM gh_pulls WHERE repo = ? AND state = 'merged'", repo)
        .toArray()) {
        const pr = JSON.parse(data);
        const at = Date.parse(pr.mergedAt ?? '');
        if (!(at > from && at <= to)) continue;
        for (const wid of pr.closes ?? []) {
          const t = byWid.get(`${repo}:${wid}`);
          if (!t) continue;
          merged.push({
            wid: t.wid,
            description: t.description,
            repo,
            pr: pr.number,
            title: pr.title,
            url: pr.url ?? null,
            mergedAt: pr.mergedAt,
            screenshots: pr.images ?? [],
          });
          break;
        }
      }
    }
    return merged;
  },

  /**
   * Writes the chase's digest for the stretch since its last one (or since it started), from `plan` (its chaseQueue),
   * and pushes it when the owner asked and it has something in it. `ended` says why it's the last. Returns its id.
   */
  async chaseDigestWrite(row, plan, { kind = 'hourly', ended = null } = {}) {
    const now = Date.now();
    this.sql.exec('DELETE FROM chase_digests WHERE at < ?', now - DIGESTS_KEPT_MS);
    const last = this.chaseDigestLast(row);
    const from = last ? Number(last.at) : Number(row.chase_started ?? now);
    const views = this.views();
    const priority = new Map(views.map((t) => [t.uuid, t.priority || null]));
    const noteAt = Number(row.chase_digest_note_at ?? 0);
    const digest = buildDigest({
      feature: { slug: row.slug, title: row.title },
      kind,
      from,
      to: now,
      summary: this.chaseLine(plan.line),
      merged: this.chaseDigestMerged(row, views, from, now),
      needsYou: plan.needsYou.map((x) => ({ ...x, priority: priority.get(x.uuid) ?? null })),
      stuck: plan.stuck,
      queue: plan.queue,
      // The captain's lines written since the last digest; older ones were in it already.
      captain:
        row.chase_digest_note && noteAt > from
          ? { agent: row.chase_digest_note_by, text: row.chase_digest_note, at: iso(noteAt) }
          : null,
      ended,
    });
    const { id } = this.sql
      .exec(
        'INSERT INTO chase_digests (slug, at, kind, data) VALUES (?, ?, ?, ?) RETURNING id',
        row.slug,
        now,
        kind,
        JSON.stringify(digest),
      )
      .one();
    // An older digest of this chase is superseded in the inbox: the newest says where it stands.
    this.sql.exec('UPDATE chase_digests SET dismissed = 1 WHERE slug = ? AND id < ?', row.slug, id);
    if (row.chase_digest_push && !digestQuiet(digest)) {
      const lastPush = this.sql.exec('SELECT MAX(at) AS at FROM chase_digests WHERE pushed = 1').one().at;
      if (!lastPush || now - Number(lastPush) >= PUSH_GAP_MS) {
        this.sql.exec('UPDATE chase_digests SET pushed = 1 WHERE id = ?', id);
        // A push is a convenience: pushToOwner never throws, and the digest is the record.
        await this.pushToOwner(digestMessage({ ...digest, id }, install(this.env).name));
      }
    }
    return id;
  },

  /**
   * On the tick, for a chase that's still on: a digest when an hour has gone by since the last one, from the chase as
   * it stands after the tick's starts.
   */
  async chaseDigestTick(row, connected) {
    if (row.chase !== 'on') return null;
    const last = this.chaseDigestLast(row);
    const since = last ? Number(last.at) : Number(row.chase_started ?? 0);
    if (Date.now() - since < DIGEST_EVERY_MS) return null;
    return await this.chaseDigestWrite(row, this.chaseQueue(row, this.views(), connected));
  },

  /** A digest as its page shows it, with its id and when it was written. */
  digestView(r) {
    const d = JSON.parse(r.data);
    // One stored before BRK-330 names its waiting kinds by the tags who replaced.
    const waiting = d.waiting?.map((x) => ({ ...x, kind: digestKind(x.kind) }));
    return { id: r.id, at: iso(r.at), kind: r.kind, pushed: Boolean(r.pushed), ...d, ...(waiting ? { waiting } : {}) };
  },

  /** The chase's digests on its feature: the push setting and the latest digests, newest first, without their content. */
  chaseDigestList(row) {
    const list = this.sql
      .exec('SELECT * FROM chase_digests WHERE slug = ? ORDER BY id DESC LIMIT ?', row.slug, LISTED)
      .toArray()
      .map((r) => {
        const d = this.digestView(r);
        return { id: d.id, at: d.at, kind: d.kind, headline: digestHeadline(d), counts: digestCounts(d) };
      });
    return { push: Boolean(row.chase_digest_push), list };
  },

  /** The newest digest of each chase that the owner hasn't dismissed: the inbox's, never more than one per chase. */
  chaseDigestNotes() {
    return this.sql
      .exec(
        `SELECT d.* FROM chase_digests d WHERE d.dismissed = 0 AND d.at > ? AND d.id = (SELECT MAX(id) FROM chase_digests WHERE slug = d.slug) ORDER BY d.id DESC LIMIT 50`,
        Date.now() - DIGESTS_KEPT_MS,
      )
      .toArray()
      .map((r) => {
        const d = this.digestView(r);
        return {
          id: d.id,
          feature: d.feature,
          title: d.title,
          at: d.at,
          kind: d.kind,
          headline: digestHeadline(d),
          counts: digestCounts(d),
          waiting: d.waiting.slice(0, 3).map((x) => ({ wid: x.wid, description: x.description, why: x.why })),
        };
      });
  },

  /** Clears the chase's digests from the inbox: the next one shows again. */
  chaseDigestDismiss(slug) {
    this.sql.exec('UPDATE chase_digests SET dismissed = 1 WHERE slug = ?', slug);
  },

  /** Turns the push of a chase's digests on or off: the owner's, on the chase. */
  chaseDigestPush(slug, on) {
    if (typeof on !== 'boolean') throw new InputError('digestPush is true or false: whether a digest pushes');
    this.sql.exec('UPDATE features SET chase_digest_push = ? WHERE slug = ?', on ? 1 : 0, slug);
  },

  /** GET /api/features/<slug>/digests/<id>: one digest, in full. */
  chaseDigestApi(slug, id) {
    return this.run(() => {
      const row = this.featureRow(slug);
      const r = /^\d{1,15}$/u.test(String(id))
        ? this.sql.exec('SELECT * FROM chase_digests WHERE slug = ? AND id = ?', row.slug, Number(id)).toArray()[0]
        : null;
      if (!r)
        throw new AgentError(`no digest ${String(id).slice(0, 20)} for ${row.title}: it may be over 30 days old`, 404);
      return { status: 200, body: { digest: this.digestView(r) } };
    });
  },

  /**
   * The road captain's lines for the next digest (POST /api/features/<slug>/captain with `digest`): a few lines of
   * what it thinks the owner should know. Only the agent holding the chase's captain task may; a new note replaces
   * one the next digest hasn't carried yet.
   */
  captainDigestNote(row, t, text) {
    const note = String(text ?? '').trim();
    if (!note) throw new InputError('write the lines for the owner’s next digest: what they should know, briefly');
    if (note.length > DIGEST_NOTE_MAX)
      throw new InputError(
        `a captain’s lines in a digest are up to ${DIGEST_NOTE_MAX} characters, and this is ${note.length}`,
      );
    if (looksLikeSecret(note)) throw new InputError('that looks like a token or key: a digest never holds one');
    const at = Date.now();
    this.sql.exec(
      'UPDATE features SET chase_digest_note = ?, chase_digest_note_by = ?, chase_digest_note_at = ? WHERE slug = ?',
      note,
      t.claim,
      at,
      row.slug,
    );
    const last = this.chaseDigestLast(row);
    const since = last ? Number(last.at) : Number(row.chase_started ?? at);
    return { text: note, at: iso(at), nextAt: iso(since + DIGEST_EVERY_MS) };
  },
};
