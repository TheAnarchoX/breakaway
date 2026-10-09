/**
 * TaskStore's pings (docs/specs/IDEA-12-agent-pings.md): an agent's message to the owner, with an optional
 * proposal (tasks to add, dependencies to change, tasks to finish) the owner applies later. A ping is also
 * written as a normal comment, so the thread is complete; the row here is how the inbox finds it.
 * Only the agent that holds the task can ping about it, and only a few times a day.
 */
import { AgentError } from './store-agents.js';
import { InputError, diffOps, nextWid, resolveRef, withChanges } from './model.js';
import { areasOf, prefixFor, repoSlugOf } from './repos.js';
import {
  BOARD_PING_KINDS,
  PINGS_PER_AGENT_PER_DAY,
  PUSH_KINDS,
  checkPing,
  summarizeProposal,
  validateProposal,
} from './ping.js';

const DAY_MS = 86_400_000;
const AGENT = /^[\w.@:/-]{1,64}$/u;

const view = (row, wid) => ({
  id: row.id,
  task: wid ?? null,
  taskUuid: row.task,
  kind: row.kind,
  message: row.message,
  proposal: row.proposal ? JSON.parse(row.proposal) : null,
  warnings: row.warnings ? JSON.parse(row.warnings) : [],
  by: row.agent,
  at: new Date(row.created).toISOString(),
  push: !row.quiet && (PUSH_KINDS.includes(row.kind) || BOARD_PING_KINDS.includes(row.kind)),
  // Who resolved it (BRK-303): the owner, or a person by handle; older pings were the owner's, or the board's.
  resolved: row.resolved
    ? { at: new Date(row.resolved).toISOString(), how: row.resolution, by: row.resolved_by ?? null }
    : null,
});

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const pingsMethods = {
  initPings() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pings (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL,
        proposal TEXT, warnings TEXT, agent TEXT NOT NULL, created INTEGER NOT NULL, resolved INTEGER, resolution TEXT
      );
      CREATE INDEX IF NOT EXISTS pings_task ON pings (task, id);
      CREATE INDEX IF NOT EXISTS pings_open ON pings (resolved, id);
    `);
    // A board ping that only shows in the inbox (BRK-197: an incident outside production). Older pings pushed.
    const columns = this.sql
      .exec('PRAGMA table_info(pings)')
      .toArray()
      .map((c) => c.name);
    if (!columns.includes('quiet')) this.sql.exec('ALTER TABLE pings ADD COLUMN quiet INTEGER NOT NULL DEFAULT 0');
    if (!columns.includes('resolved_by')) this.sql.exec('ALTER TABLE pings ADD COLUMN resolved_by TEXT');
  },

  /**
   * A ping from the board itself (a chase that stalled, a silent session, repeated fixes): a comment on task `uuid`
   * and an inbox row, pushed unless it's `quiet` (an incident outside production). It skips the agents' caps.
   * Returns the ping's id.
   */
  async boardPing(uuid, kind, message, { quiet = false } = {}) {
    this.change(uuid, { annotate: `Ping (${kind}): ${String(message).slice(0, 500)}`, by: 'board' });
    const ping = this.sql
      .exec(
        "INSERT INTO pings (task, kind, message, agent, created, quiet) VALUES (?, ?, ?, 'board', ?, ?) RETURNING id",
        uuid,
        kind,
        String(message).slice(0, 500),
        Date.now(),
        quiet ? 1 : 0,
      )
      .one();
    // A push is a convenience: it never throws, and the ping and its comment are the record.
    if (!quiet) await this.pushPing(ping.id);
    return ping.id;
  },

  /** A task that's finished or gone resolves its pings by itself. */
  resolveFinishedPings() {
    const open = this.sql.exec('SELECT DISTINCT task FROM pings WHERE resolved IS NULL').toArray();
    for (const { task } of open) {
      if (this.tasks.get(task)?.status === 'pending') continue;
      this.sql.exec(
        "UPDATE pings SET resolved = ?, resolution = 'task-finished' WHERE task = ? AND resolved IS NULL",
        Date.now(),
        task,
      );
    }
  },

  /** A task's pings, newest first (for `show` and the inbox row). */
  pingsFor(uuid) {
    this.resolveFinishedPings();
    const wid = this.tasks.get(uuid)?.wid;
    return this.sql
      .exec('SELECT * FROM pings WHERE task = ? ORDER BY id DESC LIMIT 10', uuid)
      .toArray()
      .map((row) => view(row, wid));
  },

  /** Every open ping, newest first. */
  /**
   * The inbox. `reader`, a person, gets their repositories' pings (the Worker's scrub), the notes of chases they see
   * every part of, and the connections' notes only with the `*` grant (BRK-323).
   */
  pingsApi(reader = null) {
    return this.run(() => {
      this.resolveFinishedPings();
      const rows = this.sql.exec('SELECT * FROM pings WHERE resolved IS NULL ORDER BY id DESC LIMIT 200').toArray();
      const fallback = this.defaultRepoSlug();
      const pings = rows.map((row) => {
        const map = this.tasks.get(row.task);
        // The task's repository (IDEA-14 section 6), so the inbox follows the board's switcher.
        return {
          ...view(row, map?.wid),
          taskTitle: map?.description ?? '(deleted task)',
          repo: map ? repoSlugOf(map, fallback) : null,
        };
      });
      // The inbox's notes about connections (CLD-121) come with them: fyi, no task, no push.
      // And an ended chase's note (IDEA-28 section 3.7) comes with them too: no push.
      // And each chase's newest digest (BRK-277): one per chase, the newest replacing the last.
      const seen = this.seenBy(reader);
      let whole = (/** @type {string} */ _slug) => true;
      if (seen) {
        const { partial, members } = this.featureMembership(seen);
        whole = (slug) => !partial.has(slug) && (members.get(slug)?.length ?? 0) > 0;
      }
      const everything = !reader || this.hiddenFrom(reader).readable(null);
      return {
        status: 200,
        body: {
          pings,
          notices: everything ? this.connectionNotices() : [],
          chases: this.chaseNotes().filter((n) => whole(n.feature)),
          digests: this.chaseDigestNotes().filter((d) => whole(d.feature)),
        },
      };
    });
  },

  /**
   * POST /api/tasks/<ref>/pings. `by` is the agent's name and must hold the task. A repeat of the same
   * kind and message within a day is dropped (200, `dropped`); past the caps it's a 429.
   */
  pingCreate(ref, body) {
    return this.run(() => {
      this.writable();
      const by = String(body?.by ?? '').trim();
      if (!AGENT.test(by) || by === 'owner' || by === 'board')
        throw new InputError('say who is pinging: your agent name (--as, or BREAKAWAY_AGENT)');
      const uuid = this.resolve(ref);
      const map = this.tasks.get(uuid);
      if (map.status !== 'pending')
        throw new AgentError(`${map.wid ?? ref} is ${map.status}; there is nothing to ping about`, 409);
      if (map.claim !== by)
        throw new AgentError(
          `only the agent that holds ${map.wid ?? ref} can ping about it (${map.claim ? `claimed by ${map.claim}` : 'nobody holds it: claim it first'})`,
          403,
        );
      const { kind, message } = checkPing(body ?? {});

      const since = Date.now() - DAY_MS;
      const twin = this.sql
        .exec(
          'SELECT * FROM pings WHERE task = ? AND kind = ? AND message = ? AND created > ? ORDER BY id DESC LIMIT 1',
          uuid,
          kind,
          message,
          since,
        )
        .toArray()[0];
      if (twin) return { status: 200, body: { ping: view(twin, map.wid), dropped: 'duplicate' } };
      const byAgent = this.sql
        .exec('SELECT COUNT(*) AS n FROM pings WHERE agent = ? AND created > ?', by, since)
        .one().n;
      if (byAgent >= PINGS_PER_AGENT_PER_DAY)
        throw new AgentError(
          `${by} has sent ${PINGS_PER_AGENT_PER_DAY} pings in a day, which looks like a loop; stop and add a comment instead`,
          429,
        );

      let proposal = null;
      let warnings = [];
      if (body.proposal !== undefined && body.proposal !== null) {
        const inReview = (id) =>
          Boolean(this.views((t) => t.uuid === id)[0]?.github?.some((p) => p.closes && p.state === 'open'));
        ({ changes: proposal, warnings } = validateProposal(body.proposal, {
          tasks: this.tasks,
          resolve: (r) => resolveRef(r, this.tasks),
          pinged: uuid,
          by,
          inReview,
          areas: areasOf(this.repoOfTask(map)),
        }));
      }

      const suffix = proposal
        ? `\n\nProposal: ${summarizeProposal(proposal)}. The owner can apply it from the inbox.`
        : '';
      this.change(uuid, { annotate: `Ping (${kind}): ${message}${suffix}`, by });
      const row = this.sql
        .exec(
          'INSERT INTO pings (task, kind, message, proposal, warnings, agent, created) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *',
          uuid,
          kind,
          message,
          proposal ? JSON.stringify(proposal) : null,
          warnings.length ? JSON.stringify(warnings) : null,
          by,
          Date.now(),
        )
        .one();
      return { status: 201, body: { ping: view(row, map.wid), task: this.detail(uuid) } };
    });
  },

  /** Pings created in a stretch of time, for the Activity feed. */
  pingEvents(after, upTo) {
    return this.sql
      .exec(
        'SELECT id, task, kind, message, agent, created AS at FROM pings WHERE created > ? AND created <= ? ORDER BY created DESC',
        after,
        upTo,
      )
      .toArray();
  },

  /** Dismissed and handled pings in a stretch of time, for the Activity feed (an apply shows as its own changes). */
  pingResolutions(after, upTo) {
    return this.sql
      .exec(
        "SELECT id, task, kind, resolution AS how, resolved AS at, resolved_by AS person FROM pings WHERE resolution IN ('dismissed', 'handled') AND resolved > ? AND resolved <= ? ORDER BY resolved DESC",
        after,
        upTo,
      )
      .toArray();
  },

  /** The open ping `id`, or a 404 / 409 that says why not. */
  openPing(id) {
    const row = /^\d+$/u.test(String(id))
      ? this.sql.exec('SELECT * FROM pings WHERE id = ?', Number(id)).toArray()[0]
      : null;
    if (!row) throw new AgentError(`no ping ${id}`, 404);
    this.resolveFinishedPings();
    const fresh = this.sql.exec('SELECT * FROM pings WHERE id = ?', row.id).one();
    if (fresh.resolved) throw new AgentError(`that ping is already resolved (${fresh.resolution})`, 409);
    return fresh;
  },

  /** Resolves a ping `how`, by `person` when someone pressed (BRK-303): the owner, or a person's handle. */
  resolvePing(row, how, person = null) {
    this.sql.exec(
      'UPDATE pings SET resolved = ?, resolution = ?, resolved_by = ? WHERE id = ? AND resolved IS NULL',
      Date.now(),
      how,
      person,
      row.id,
    );
    return view(this.sql.exec('SELECT * FROM pings WHERE id = ?', row.id).one(), this.tasks.get(row.task)?.wid);
  },

  /** POST /api/pings/<id>/dismiss: resolves a ping without applying anything. Owner only (the route checks the cookie). */
  pingDismiss(id, body = {}) {
    return this.run(() => {
      this.writable();
      return {
        status: 200,
        body: { ping: this.resolvePing(this.openPing(id), 'dismissed', this.actorIn(body).person) },
      };
    });
  },

  /** POST /api/pings/<id>/handled: resolves a ping that has no proposal to apply. */
  pingHandled(id, body = {}) {
    return this.run(() => {
      this.writable();
      const row = this.openPing(id);
      if (row.proposal) throw new InputError('that ping has a proposal; apply it or dismiss it');
      return { status: 200, body: { ping: this.resolvePing(row, 'handled', this.actorIn(body).person) } };
    });
  },

  /**
   * POST /api/pings/<id>/apply: the owner applies some or all of a ping's proposal in one version, or
   * none of it. `chosen` lists the change numbers (from 0; default all) and `edits` maps a change number
   * to fields of an `add` the owner edited. Every chosen change is checked again against the board as it
   * is now; if any no longer holds, nothing is applied (409, with the reason).
   */
  pingApply(id, body) {
    return this.run(() => {
      this.writable();
      const row = this.openPing(id);
      // Who applied it (BRK-303): what it adds and says is theirs, the owner's or a person's by handle.
      const who = this.actorIn(body).person;
      if (!row.proposal) throw new InputError('that ping has no proposal to apply; mark it handled or dismiss it');
      const proposal = JSON.parse(row.proposal);
      const chosen = body?.chosen === undefined ? proposal.map((_, i) => i) : body.chosen;
      if (
        !Array.isArray(chosen) ||
        !chosen.length ||
        chosen.some((i) => !Number.isInteger(i) || i < 0 || i >= proposal.length) ||
        new Set(chosen).size !== chosen.length
      ) {
        throw new InputError(`chosen is a list of change numbers from 0 to ${proposal.length - 1}, each once`);
      }
      const edits = body?.edits ?? {};
      if (!edits || typeof edits !== 'object' || Array.isArray(edits))
        throw new InputError('edits maps a change number to the fields you changed');
      const picked = [...chosen]
        .sort((a, b) => a - b)
        .map((i) => {
          const edit = edits[i];
          if (edit === undefined) return proposal[i];
          if (proposal[i].type !== 'add' || !edit || typeof edit !== 'object' || Array.isArray(edit))
            throw new InputError(`only a new task can be edited; change ${i} isn't one`);
          return { ...proposal[i], ...edit, type: 'add', ref: proposal[i].ref };
        });

      const uuid = row.task;
      const inReview = (t) =>
        Boolean(this.views((v) => v.uuid === t)[0]?.github?.some((p) => p.closes && p.state === 'open'));
      let changes;
      try {
        ({ changes } = validateProposal(picked, {
          tasks: this.tasks,
          resolve: (r) => resolveRef(r, this.tasks),
          pinged: uuid,
          by: row.agent,
          inReview,
          areas: areasOf(this.repoOfTask(this.tasks.get(uuid))),
        }));
      } catch (error) {
        if (error instanceof InputError) throw new AgentError(`nothing was applied: ${error.message}`, 409);
        throw error;
      }

      // An assignee holds a role in the task's repository (BRK-330): checked against the board as it is now.
      for (const c of changes.filter((x) => x.assignee)) {
        const target = c.type === 'add' ? uuid : resolveRef(c.task, this.tasks);
        const slug = this.repoOfTask(this.tasks.get(target))?.slug ?? this.defaultRepoSlug();
        try {
          this.checkAssignee(c.assignee, slug);
        } catch (error) {
          if (error instanceof InputError) throw new AgentError(`nothing was applied: ${error.message}`, 409);
          throw error;
        }
      }

      const now = new Date();
      const working = new Map([...this.tasks].map(([u, map]) => [u, { ...map }]));
      const created = new Map();
      const touched = new Set();
      const at = (token) => created.get(token)?.uuid ?? resolveRef(token, working);
      const lines = [];
      const edit = (u, what) => {
        working.set(u, withChanges(working.get(u), what, now));
        touched.add(u);
      };
      for (const c of changes.filter((x) => x.type === 'add')) {
        const made = crypto.randomUUID();
        // In the pinged task's repository, with that repository's prefix for the area.
        const repo = this.repoOfTask(this.tasks.get(uuid));
        const wid = nextWid(prefixFor(repo, c.project), working);
        working.set(
          made,
          withChanges(
            null,
            {
              description: c.title,
              project: c.project,
              wid,
              repo: repo ? this.storedRepo(repo.slug) : null,
              horizon: c.horizon,
              ...(c.priority ? { priority: c.priority } : {}),
              brief: c.brief,
              done_when: c.done_when,
              by: who,
              ...(c.who ? { who: c.who } : {}),
              ...(c.assignee ? { assignee: c.assignee } : {}),
              addTags: c.tags,
            },
            now,
          ),
        );
        created.set(c.ref, { uuid: made, wid });
      }
      const name = (u) => working.get(u)?.wid ?? u.slice(0, 8);
      const added = [...created.values()];
      if (added.length) lines.push(`added ${added.map((a) => a.wid).join(', ')}`);
      for (const c of changes) {
        if (c.type === 'add') {
          const made = created.get(c.ref).uuid;
          if (c.depends.length)
            working.set(made, withChanges(working.get(made), { addDepends: c.depends.map(at) }, now));
        } else if (c.type === 'depend') {
          const from = at(c.task);
          edit(from, { addDepends: c.add.map(at), removeDepends: c.remove.map(at) });
          for (const d of c.add) lines.push(`${name(from)} now waits for ${name(at(d))}`);
          for (const d of c.remove) lines.push(`${name(from)} no longer waits for ${name(at(d))}`);
        } else if (c.type === 'modify') {
          const target = at(c.task);
          edit(target, {
            ...(c.horizon ? { horizon: c.horizon } : {}),
            ...(c.who ? { who: c.who } : {}),
            ...(c.assignee ? { assignee: c.assignee } : {}),
            ...(c.addTags ? { addTags: c.addTags } : {}),
            ...(c.removeTags ? { removeTags: c.removeTags } : {}),
            ...(c.brief ? { brief: c.brief, by: who } : {}),
            ...(c.done_when ? { done_when: c.done_when } : {}),
          });
          lines.push(`edited ${name(target)}`);
        } else if (c.type === 'done') {
          const target = at(c.task);
          edit(target, { status: 'completed', ...(c.note ? { annotate: c.note, by: who } : {}) });
          lines.push(`finished ${name(target)}`);
        } else if (c.type === 'delete') {
          const target = at(c.task);
          edit(target, { status: 'deleted', ...(c.note ? { annotate: c.note, by: who } : {}) });
          lines.push(`deleted ${name(target)}`);
        } else if (c.type === 'release') {
          const target = at(c.task);
          edit(target, { claim: null, start: false });
          lines.push(`released ${name(target)}`);
        }
      }
      // The follow-up on the ping's own task, in the same version.
      edit(uuid, { annotate: `Applied: ${lines.join('; ')}.`, by: 'board' });

      const timestamp = now.toISOString();
      const ops = [
        ...added.flatMap(({ uuid: made }) => diffOps(made, null, working.get(made), timestamp)),
        ...[...touched].flatMap((u) => diffOps(u, this.tasks.get(u), working.get(u), timestamp)),
      ];
      this.as(body, () =>
        this.atomically(() => {
          this.commit(ops);
          this.resolvePing(row, 'applied', who);
        }),
      );
      return {
        status: 200,
        body: {
          ping: view(this.sql.exec('SELECT * FROM pings WHERE id = ?', row.id).one(), this.tasks.get(uuid)?.wid),
          created: added.map((a) => a.wid),
          task: this.detail(uuid),
        },
      };
    });
  },
};
