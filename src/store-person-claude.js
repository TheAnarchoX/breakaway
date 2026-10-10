/**
 * TaskStore's side of bringing your own Claude (BRK-302, docs/specs/BRK-299-people-and-roles.md, point 5): each
 * person's routine per repository, sealed like the routines kept on the board (src/routine-keep.js) and never given
 * back; the Claude plan they picked and the caps it gives them (src/person-claude.js); the owner's limits on a
 * person; and the routine the owner lends in a repository to people with none of their own there.
 *
 * A lent routine is a second routine of the owner's for the repository (BRK-324, the owner's BRK-345): its cloud
 * environment adds no board token, so the run key each lent start hands its agent (src/store-run-keys.js) is the
 * agent's only way in, and caps it to its person by credential. Lending is on exactly while one is connected.
 *
 * Nothing here changes an install with nobody invited: the owner's routines, plan, and caps are where they were.
 */
import { AgentError } from './store-agents.js';
import { OWNER, refusal } from './permissions.js';
import { checkRoutine, openJson, sealJson, routineKey } from './routine-keep.js';
import { LENT_HOLDER, checkLimit, holdKeyOf, lentCaps, personCaps, personCeilings } from './person-claude.js';
import { PLANS, isPlan, planChoices } from './plans.js';

/** What a person's routine is sealed to: their handle and the repository, so it opens for nobody else's. */
const boundOf = (handle, slug) => `person:${handle}:${slug}`;
/** What a repository's lent routine is sealed to: the repository, apart from its own routine's. */
const lentBoundOf = (slug) => `lent:${slug}`;
/** Where an install from before BRK-324 noted a repository's routine as lent: Lend waits on a lent routine there. */
const legacyLentKey = (slug) => `routine_lent:${slug}`;

/** Why a repository lent before BRK-324 doesn't lend now. */
export const LEND_WAITS =
  'lending now runs on a routine of its own, whose environment doesn’t add the board’s token: connect one to lend again';

/** The words a person sees when they start where they have no routine and none is lent. */
export const noRoutineWords = (slug) =>
  `you have no Claude routine for ${slug}: connect yours in your settings, or ask the owner to lend you the repository’s routine`;

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const personClaudeMethods = {
  initPersonClaude() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS person_claude (
        handle TEXT PRIMARY KEY, plan TEXT NOT NULL, max INTEGER, hourly INTEGER, owner_max INTEGER,
        owner_hourly INTEGER, edited INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS person_routines (
        handle TEXT NOT NULL, repo TEXT NOT NULL, sealed TEXT NOT NULL, created INTEGER NOT NULL,
        edited INTEGER NOT NULL, PRIMARY KEY (handle, repo)
      );
      CREATE TABLE IF NOT EXISTS lent_routines (
        repo TEXT PRIMARY KEY, sealed TEXT NOT NULL, created INTEGER NOT NULL, edited INTEGER NOT NULL,
        token_seen INTEGER
      );
    `);
  },

  // ---- Reading -------------------------------------------------------------------------------

  /** A person's plan and limits, or null before they pick a plan. */
  personClaudeRow(handle) {
    return this.sql.exec('SELECT * FROM person_claude WHERE handle = ?', String(handle)).toArray()[0] ?? null;
  },

  /** The repositories a person has a routine of their own for. */
  personRoutineRepos(handle) {
    return this.sql
      .exec('SELECT repo FROM person_routines WHERE handle = ? ORDER BY repo', String(handle))
      .toArray()
      .map((r) => r.repo);
  },

  /** A person's own routine for repository `slug`: its URL and token, `{ broken: true }`, or null. */
  async personRoutine(handle, slug) {
    const row = this.sql
      .exec('SELECT sealed FROM person_routines WHERE handle = ? AND repo = ?', String(handle), String(slug))
      .toArray()[0];
    if (!row) return null;
    try {
      const routine = await openJson(await this.keptRoutineKey(), boundOf(handle, slug), row.sealed, 'routine');
      if (typeof routine?.url !== 'string' || typeof routine?.token !== 'string') return { broken: true };
      return { url: routine.url, token: routine.token };
    } catch {
      return { broken: true };
    }
  },

  /**
   * Whether the owner lends a routine in repository `slug` to people with none of their own there: a lent routine is
   * connected (BRK-324). One that can't be opened still counts: a start says to connect it again.
   */
  routineLent(slug) {
    return this.sql.exec('SELECT 1 FROM lent_routines WHERE repo = ?', String(slug)).toArray().length > 0;
  },

  /** Repository `slug`'s lent routine: its URL and token, `{ broken: true }`, or null. */
  async lentRoutine(slug) {
    const row = this.sql.exec('SELECT sealed FROM lent_routines WHERE repo = ?', String(slug)).toArray()[0];
    if (!row) return null;
    try {
      const routine = await openJson(await this.keptRoutineKey(), lentBoundOf(slug), row.sealed, 'routine');
      if (typeof routine?.url !== 'string' || typeof routine?.token !== 'string') return { broken: true };
      return { url: routine.url, token: routine.token };
    } catch {
      return { broken: true };
    }
  },

  /**
   * What the repository's page may know about lending there (never a URL or token): whether it lends, whether its lent
   * routine can be read, when it was connected, when a lent agent last came with the board's token too (its
   * environment adds it, and the owner takes it out), and, for a repository lent before lending needed a routine of its
   * own, why it doesn't lend now.
   */
  async lendState(slug) {
    const row = this.sql
      .exec('SELECT created, edited, token_seen FROM lent_routines WHERE repo = ?', String(slug))
      .toArray()[0];
    const routine = row ? await this.lentRoutine(slug) : null;
    return {
      lent: Boolean(row),
      broken: Boolean(routine && 'broken' in routine),
      connectedAt: iso(row?.edited ?? row?.created),
      tokenSeenAt: iso(row?.token_seen),
      waits: !row && this.meta(legacyLentKey(slug)) === 'on' ? LEND_WAITS : null,
    };
  },

  /** A lent agent's request came with the board's token too: its routine's environment adds it (BRK-324). */
  lentTokenSeen(slug) {
    this.sql.exec('UPDATE lent_routines SET token_seen = ? WHERE repo = ?', Date.now(), String(slug));
  },

  /**
   * A person's caps: `own` on their own routines (null before they pick a plan), `lent` on a routine the owner lends,
   * `ceilings` the most they may set on their plan, and the owner's limits on them.
   */
  personCapsOf(handle) {
    const row = this.personClaudeRow(handle);
    // A row the owner's limits made before the person picked a plan has none yet ('').
    const plan = row?.plan || null;
    const routines = this.personRoutineRepos(handle).length;
    const owner = { max: row?.owner_max ?? null, hourly: row?.owner_hourly ?? null };
    return {
      plan,
      own: personCaps({
        plan,
        routines,
        own: { max: row?.max ?? null, hourly: row?.hourly ?? null },
        owner,
      }),
      lent: lentCaps(owner),
      ceilings: plan ? personCeilings(plan, routines) : null,
      owner,
    };
  },

  /** A person's runs: running now and started in the last hour, on their own routines or on lent ones. */
  personRunCounts(handle, running = null) {
    const live = running ?? this.runningAgents(this.views());
    const since = Date.now() - 3_600_000;
    const counted = "for_person = ? AND started > ? AND status IN ('started', 'starting', 'failed')";
    const own = this.sql
      .exec(`SELECT COUNT(*) AS n FROM agent_runs WHERE ${counted} AND routine_of = ?`, handle, since, handle)
      .one().n;
    const lent = this.sql
      .exec(`SELECT COUNT(*) AS n FROM agent_runs WHERE ${counted} AND routine_of = ?`, handle, since, OWNER)
      .one().n;
    const mine = live.filter(({ run }) => run.for_person === handle);
    return {
      own: { running: mine.filter(({ run }) => run.routine_of === handle).length, started: own },
      lent: { running: mine.filter(({ run }) => run.routine_of === OWNER).length, started: lent },
    };
  },

  /**
   * Why person `handle` can't start another agent now under their own caps, or null: on their own routines, their
   * plan's; on a lent one, 1 at once and 5 an hour. Force start never skips these: they're the person's, and a lent
   * routine spends the owner's plan.
   */
  personRoomBlocker(handle, lent, running) {
    const caps = this.personCapsOf(handle);
    const counts = this.personRunCounts(handle, running)[lent ? 'lent' : 'own'];
    const limit = lent ? caps.lent : caps.own;
    const where = lent ? ' on the routine the owner lends you' : '';
    if (!limit) return new AgentError(`pick your Claude plan in your settings before you start agents`, 409);
    if (counts.running >= limit.max)
      return new AgentError(
        `${counts.running} of your agents ${counts.running === 1 ? 'is' : 'are'} already running${where} (your limit is ${limit.max})`,
        409,
      );
    if (counts.started >= limit.hourly)
      return new AgentError(`you started ${limit.hourly} agents${where} in the last hour, your limit`, 429);
    return null;
  },

  /**
   * The routine a start in repository `slug` fires for person `forPerson`: the owner's starts and the board's go to the
   * repository's routine, as always; a person's to their own, else the repository's when the owner lends it. Throws
   * the AgentError a start answers when there's none.
   * @returns {Promise<{ credentials: { url: string, token: string }, routineOf: string, lent: boolean }>}
   */
  async routineForStart(slug, forPerson) {
    if (forPerson === OWNER) return { credentials: await this.checkRoutineReady(slug), routineOf: OWNER, lent: false };
    // Asked again on every start, not only at the press (BRK-348): a chase's ticks and captain, and a start that
    // waited for room, run later, and a person removed or demoted since starts nothing more.
    const role = this.personRoleRefusal(forPerson, slug);
    if (role) throw new AgentError(role, 403);
    const own = await this.personRoutine(forPerson, slug);
    if (own && 'broken' in own)
      throw new AgentError(
        `your Claude routine for ${slug} can’t be read any more (the board’s sync key changed): connect it again in your settings`,
      );
    if (own) {
      const unfilled = await this.promptBlocker(slug);
      if (unfilled) throw new AgentError(unfilled, 409);
      return { credentials: own, routineOf: forPerson, lent: false };
    }
    if (!this.routineLent(slug)) throw new AgentError(noRoutineWords(slug), 403);
    // A lent start fires the lent routine, never the repository's own: its agent's only credential is its run key.
    const lent = await this.lentRoutine(slug);
    if (!lent || 'broken' in lent)
      throw new AgentError(
        `the routine the owner lends in ${slug} can’t be read any more (the board’s sync key changed): the owner connects it again on the repository’s page`,
      );
    const unfilled = await this.promptBlocker(slug);
    if (unfilled) throw new AgentError(unfilled, 409);
    return { credentials: lent, routineOf: OWNER, lent: true };
  },

  /**
   * Why person `handle` may not start agents in repository `slug` now, or null (BRK-348): they're off the board, or
   * they aren't a member or more there any more.
   * @returns {string | null}
   */
  personRoleRefusal(handle, slug) {
    if (!this.personRow(handle)) return `${handle} isn’t on the board any more, so nothing starts for them`;
    const role = refusal({ person: handle, grants: this.personGrants(handle) }, 'agent.start', slug);
    return role ? `${role.message}, so nothing starts there for them` : null;
  },

  /**
   * Why person `handle` can't start agents in repository `slug` now, or null, without opening their routine: their
   * role there, then a routine of their own or one the owner lends. A broken routine of their own is the start's to
   * say.
   * @returns {string | null}
   */
  personStartWhy(handle, slug) {
    return (
      this.personRoleRefusal(handle, slug) ??
      (this.personRoutineRepos(handle).includes(slug) || this.routineLent(slug) ? null : noRoutineWords(slug))
    );
  },

  /**
   * What holds the routine a start in repository `slug` for `forPerson` would fire (BRK-144, BRK-302): the person's
   * own routine there, and the lent one (BRK-324), are each held apart; the owner's starts wait on the repository's.
   */
  startHold(slug, forPerson = OWNER) {
    return this.routineHold(slug, this.startHolder(slug, forPerson));
  },

  /** Whose hold a start in repository `slug` for `forPerson` waits on: null for the repository's own routine. */
  startHolder(slug, forPerson = OWNER) {
    if (forPerson === OWNER) return null;
    return this.personRoutineRepos(forPerson).includes(slug) ? forPerson : LENT_HOLDER;
  },

  /** What a person may know about their own Claude: never a routine's URL or token. */
  async personClaudeView(handle) {
    const caps = this.personCapsOf(handle);
    const grants = this.personGrants(handle);
    const kept = new Set(this.personRoutineRepos(handle));
    const routines = [];
    for (const repo of this.repos()) {
      // The repositories they could start agents in: where they're a member or more.
      if (refusal({ person: handle, grants }, 'agent.start', repo.slug)) continue;
      const routine = kept.has(repo.slug) ? await this.personRoutine(handle, repo.slug) : null;
      const row = kept.has(repo.slug)
        ? this.sql
            .exec('SELECT created, edited FROM person_routines WHERE handle = ? AND repo = ?', handle, repo.slug)
            .one()
        : null;
      routines.push({
        repo: repo.slug,
        connected: Boolean(routine && !('broken' in routine)),
        broken: Boolean(routine && 'broken' in routine),
        lent: this.routineLent(repo.slug),
        connectedAt: iso(row?.created),
        editedAt: iso(row?.edited),
      });
    }
    return {
      plan: caps.plan,
      plans: planChoices(),
      caps: caps.own,
      lentCaps: caps.lent,
      ceilings: caps.ceilings,
      ownerLimits: caps.owner,
      routines,
      runs: this.personRunCounts(handle),
    };
  },

  /**
   * Who an agent a request starts is for (BRK-302): the person behind the credential, or, when the request names an
   * agent the board started for someone, that someone. The owner's token with no agent's name is the owner.
   * @param {any} input `{ actor?, by? }`
   */
  startsFor(input) {
    const actor = this.actorIn(input);
    return actor.for?.person ?? actor.person;
  },

  /**
   * People's plans, caps, and runs, for the Agents view (never a secret): everyone's for the owner (`viewer`), only
   * their own for a person. Nobody invited, nobody listed.
   */
  peopleClaudeOverview(running, viewer = OWNER) {
    return this.sql
      .exec('SELECT handle FROM people WHERE removed IS NULL ORDER BY handle')
      .toArray()
      .filter(({ handle }) => viewer === OWNER || handle === viewer)
      .map(({ handle }) => {
        const caps = this.personCapsOf(handle);
        return {
          handle,
          plan: caps.plan,
          caps: caps.own,
          lentCaps: caps.lent,
          routines: this.personRoutineRepos(handle),
          runs: this.personRunCounts(handle, running),
        };
      });
  },

  // ---- A person's own: their routines and their plan -----------------------------------------

  /** GET /api/me/claude. */
  personClaudeApi(handle) {
    return this.run(async () => {
      if (!this.personRow(handle)) throw new AgentError('sign in again', 401);
      return { status: 200, body: { claude: await this.personClaudeView(handle) } };
    });
  },

  /**
   * PUT /api/me/routines/:repo, `{ url, token, plan }`: connects or replaces the person's own routine for a repository
   * they may start agents in, checked the way the owner's is, sealed, and never given back. Connecting asks for the
   * plan the routine's Claude account is on, the first time and whenever they send one; it sets their caps.
   */
  personRoutineConnectApi(handle, slug, body) {
    return this.run(async () => {
      const person = this.personRow(handle);
      if (!person) throw new AgentError('sign in again', 401);
      const repo = this.repoBySlug(String(slug).toLowerCase());
      if (!repo) throw new AgentError(`no repository "${String(slug).slice(0, 40)}"`, 404);
      const no = refusal({ person: handle, grants: this.personGrants(handle) }, 'agent.start', repo.slug);
      if (no) throw new AgentError(no.message, 403);
      const plan = body?.plan ?? (this.personClaudeRow(handle)?.plan || null);
      if (!plan) throw new AgentError(`say which Claude plan the routine runs on: ${planWords()}`, 400);
      if (!isPlan(plan)) throw new AgentError(`the plan is one of ${planWords()}`, 400);
      const checked = checkRoutine(body ?? {});
      if ('error' in checked) throw new AgentError(`${checked.error}. Nothing was stored.`, 400);
      const sealed = await sealJson(await this.keptRoutineKey(), boundOf(handle, repo.slug), checked);
      const now = Date.now();
      const replaced =
        this.sql.exec('SELECT 1 FROM person_routines WHERE handle = ? AND repo = ?', handle, repo.slug).toArray()
          .length > 0;
      this.writable();
      this.sql.exec(
        'INSERT INTO person_routines (handle, repo, sealed, created, edited) VALUES (?, ?, ?, ?, ?) ON CONFLICT (handle, repo) DO UPDATE SET sealed = excluded.sealed, edited = excluded.edited',
        handle,
        repo.slug,
        sealed,
        now,
        now,
      );
      if (body?.plan !== undefined || !this.personClaudeRow(handle)?.plan) this.setPersonPlan(handle, plan);
      // A routine connected again starts afresh: whatever Claude held the last one for was for other credentials.
      this.setMeta(holdKeyOf(repo.slug, handle), null);
      return {
        status: replaced ? 200 : 201,
        body: { ok: true, ...(replaced ? { replaced: true } : {}), claude: await this.personClaudeView(handle) },
      };
    });
  },

  /** DELETE /api/me/routines/:repo: forgets the person's own routine for a repository. */
  personRoutineForgetApi(handle, slug) {
    return this.run(async () => {
      if (!this.personRow(handle)) throw new AgentError('sign in again', 401);
      const name = String(slug).toLowerCase();
      this.writable();
      const had = this.sql
        .exec('DELETE FROM person_routines WHERE handle = ? AND repo = ? RETURNING repo', handle, name)
        .toArray().length;
      if (!had) throw new AgentError(`you have no Claude routine for ${name.slice(0, 40)}`, 404);
      this.setMeta(holdKeyOf(name, handle), null);
      return { status: 200, body: { ok: true, claude: await this.personClaudeView(handle) } };
    });
  },

  /** A person's plan: a new plan sets their caps back to its defaults, as the owner's plan does for the board. */
  setPersonPlan(handle, plan) {
    const now = Date.now();
    this.sql.exec(
      'INSERT INTO person_claude (handle, plan, edited) VALUES (?, ?, ?) ON CONFLICT (handle) DO UPDATE SET plan = excluded.plan, max = CASE WHEN person_claude.plan = excluded.plan THEN person_claude.max END, hourly = CASE WHEN person_claude.plan = excluded.plan THEN person_claude.hourly END, edited = excluded.edited',
      handle,
      plan,
      now,
    );
  },

  /**
   * PATCH /api/me/claude, `{ plan?, max?, hourly? }`: the person's plan, and their own agents at once and starts an
   * hour within its ceilings (null goes back to the plan's default). The plan comes first, so the caps in the same
   * request are checked against it. The owner's limits still hold on top.
   */
  personClaudeSetApi(handle, body) {
    return this.run(async () => {
      if (!this.personRow(handle)) throw new AgentError('sign in again', 401);
      // A plan is for starting agents: only someone who may start them somewhere picks one.
      const grants = this.personGrants(handle);
      if (!this.repos().some((repo) => !refusal({ person: handle, grants }, 'agent.start', repo.slug)))
        throw new AgentError(
          'only a member of a repository can start agents, so only a member picks a Claude plan',
          403,
        );
      this.writable();
      if (body?.plan !== undefined) {
        if (!isPlan(body.plan)) throw new AgentError(`the plan is one of ${planWords()}`, 400);
        this.setPersonPlan(handle, body.plan);
      }
      const picked = this.personClaudeRow(handle)?.plan || null;
      if ((body?.max !== undefined || body?.hourly !== undefined) && !picked)
        throw new AgentError('connect your Claude routine and pick its plan first', 409);
      if (picked) {
        const most = personCeilings(picked, this.personRoutineRepos(handle).length);
        const plan = PLANS[picked].name;
        const set = {};
        if (body?.max !== undefined) {
          const max = checkLimit(body.max, { least: 1, most: most.max, what: `agents at once on ${plan}` });
          if ('error' in max) throw new AgentError(max.error, 400);
          set.max = max.value;
        }
        if (body?.hourly !== undefined) {
          const hourly = checkLimit(body.hourly, {
            least: 1,
            most: most.hourly,
            what: 'starts an hour for your routines',
          });
          if ('error' in hourly) throw new AgentError(hourly.error, 400);
          set.hourly = hourly.value;
        }
        for (const [column, value] of Object.entries(set))
          this.sql.exec(
            `UPDATE person_claude SET ${column} = ?, edited = ? WHERE handle = ?`,
            value,
            Date.now(),
            handle,
          );
      }
      return { status: 200, body: { claude: await this.personClaudeView(handle) } };
    });
  },

  // ---- The owner's: a person's limits, and lending a repository's routine --------------------

  /** GET /api/people/:handle/claude: a person's plan, caps, routines (never a secret), and runs, for the owner. */
  personClaudeOwnerApi(handle, input) {
    return this.run(async () => {
      this.allow(input, 'agent.settings', null);
      if (!this.personRow(handle)) throw new AgentError(`no person “${String(handle).slice(0, 40)}”`, 404);
      return { status: 200, body: { person: handle, claude: await this.personClaudeView(handle) } };
    });
  },

  /**
   * PATCH /api/people/:handle/claude, `{ max?, hourly? }`: the owner lowers a person's agents at once and starts an
   * hour, on their own routines and on lent ones alike; null lifts the limit. Only the owner (BRK-299 point 5).
   */
  personLimitsApi(handle, body) {
    return this.run(async () => {
      this.allow(body, 'agent.settings', null);
      if (!this.personRow(handle)) throw new AgentError(`no person “${String(handle).slice(0, 40)}”`, 404);
      const set = {};
      if (body?.max !== undefined) {
        const max = checkLimit(body.max, { least: 0, most: 1000, what: 'their agents at once' });
        if ('error' in max) throw new AgentError(max.error, 400);
        set.owner_max = max.value;
      }
      if (body?.hourly !== undefined) {
        const hourly = checkLimit(body.hourly, { least: 0, most: 1000, what: 'their starts an hour' });
        if ('error' in hourly) throw new AgentError(hourly.error, 400);
        set.owner_hourly = hourly.value;
      }
      this.writable();
      const now = Date.now();
      // A person who hasn't picked a plan yet still has caps on lent routines: the row keeps the owner's limits.
      if (!this.personClaudeRow(handle))
        this.sql.exec("INSERT INTO person_claude (handle, plan, edited) VALUES (?, '', ?)", handle, now);
      for (const [column, value] of Object.entries(set))
        this.sql.exec(`UPDATE person_claude SET ${column} = ?, edited = ? WHERE handle = ?`, value, now, handle);
      return { status: 200, body: { person: handle, claude: await this.personClaudeView(handle) } };
    });
  },

  /**
   * PUT /api/repos/:slug/routine/lend, `{ url, token }`: the owner lends a routine in repository `slug` to the people
   * who may start agents there and have no routine of their own (BRK-324): a second routine of theirs for the
   * repository, whose cloud environment adds no board token, checked the way the repository's is, sealed, and never
   * given back. Without a URL and token it answers how lending stands, and refuses while none is connected. Off by
   * default: it spends the owner's plan. Only the owner (BRK-299 point 5).
   */
  repoRoutineLendApi(slug, body) {
    return this.run(async () => {
      this.allow(body, 'repo.routine', null, 'only the owner lends a repository’s routine');
      const repo = this.repoBySlug(String(slug).toLowerCase());
      if (!repo) throw new AgentError(`no repository "${String(slug).slice(0, 40)}"`, 404);
      if (!body?.url && !body?.token) {
        if (!this.routineLent(repo.slug))
          throw new AgentError(
            `connect a routine to lend in ${repo.slug} first: a second routine of yours for it, whose cloud environment doesn’t add the board’s token`,
            409,
          );
        return { status: 200, body: { ok: true, repo: repo.slug, ...(await this.lendState(repo.slug)) } };
      }
      const checked = checkRoutine(body ?? {});
      if ('error' in checked) throw new AgentError(`${checked.error}. Nothing was stored.`, 400);
      // The repository's own routine runs where the board's token is: lending it would hand that token to the agents.
      const own = await this.repoRoutine(repo.slug);
      if (own && !('broken' in own) && own.url === checked.url)
        throw new AgentError(
          `that’s ${repo.slug}’s own routine, whose environment adds the board’s token: lend a second routine, in an environment without it. Nothing was stored.`,
          400,
        );
      const sealed = await sealJson(await this.keptRoutineKey(), lentBoundOf(repo.slug), checked);
      const now = Date.now();
      const replaced = this.routineLent(repo.slug);
      this.writable();
      this.sql.exec(
        'INSERT INTO lent_routines (repo, sealed, created, edited) VALUES (?, ?, ?, ?) ON CONFLICT (repo) DO UPDATE SET sealed = excluded.sealed, edited = excluded.edited, token_seen = NULL',
        repo.slug,
        sealed,
        now,
        now,
      );
      // Connected again starts afresh: whatever Claude held the last one for was for other credentials.
      this.setMeta(holdKeyOf(repo.slug, LENT_HOLDER), null);
      this.setMeta(legacyLentKey(repo.slug), null);
      return {
        status: replaced ? 200 : 201,
        body: {
          ok: true,
          repo: repo.slug,
          ...(replaced ? { replaced: true } : {}),
          ...(await this.lendState(repo.slug)),
        },
      };
    });
  },

  /**
   * DELETE /api/repos/:slug/routine/lend: the owner stops lending in repository `slug`, and the board forgets the lent
   * routine. Agents already running on it go on until their run ends; nothing new starts there.
   */
  repoRoutineUnlendApi(slug, body) {
    return this.run(async () => {
      this.allow(body, 'repo.routine', null, 'only the owner lends a repository’s routine');
      const repo = this.repoBySlug(String(slug).toLowerCase());
      if (!repo) throw new AgentError(`no repository "${String(slug).slice(0, 40)}"`, 404);
      this.writable();
      this.sql.exec('DELETE FROM lent_routines WHERE repo = ?', repo.slug);
      this.setMeta(holdKeyOf(repo.slug, LENT_HOLDER), null);
      this.setMeta(legacyLentKey(repo.slug), null);
      return { status: 200, body: { ok: true, repo: repo.slug, ...(await this.lendState(repo.slug)) } };
    });
  },

  // ---- Removal and rotation --------------------------------------------------------------------

  /**
   * Forgets a removed person's routines and holds; their plan and limits go with them. What they started that runs
   * later goes too (BRK-348): their chases stop, as Stop would stop them, and their starts waiting for room drop out.
   */
  dropPersonClaude(handle) {
    for (const repo of this.personRoutineRepos(handle)) this.setMeta(holdKeyOf(repo, handle), null);
    this.dropRunKeys(handle);
    this.sql.exec('DELETE FROM person_routines WHERE handle = ?', handle);
    this.sql.exec('DELETE FROM person_claude WHERE handle = ?', handle);
    for (const row of this.sql.exec('SELECT * FROM features WHERE chase_by = ?', handle).toArray()) {
      if (row.chase === 'on' || row.chase === 'done') this.chaseStopFor(row, `${handle} left the board`);
      this.sql.exec('UPDATE features SET chase_by = NULL WHERE slug = ?', row.slug);
    }
    for (const { key } of this.sql
      .exec("SELECT key FROM meta WHERE key LIKE 'start_for:%' AND value = ?", handle)
      .toArray())
      this.dropQueuedStart(key.slice('start_for:'.length), `${handle} left the board`);
  },

  /**
   * People's routines sealed again under `newSyncKey`, for a rotation to write in its transaction. One that can't be
   * opened stays as it is: it was broken already, and its person's settings say to connect it again.
   * @returns {Promise<{ handle: string, repo: string, sealed: string }[]>}
   */
  async resealedPersonRoutines(newSyncKey) {
    const rows = this.sql.exec('SELECT handle, repo, sealed FROM person_routines').toArray();
    if (!rows.length) return [];
    const [from, to] = await Promise.all([this.keptRoutineKey(), routineKey(newSyncKey)]);
    const out = [];
    for (const row of rows) {
      const bound = boundOf(row.handle, row.repo);
      try {
        out.push({
          handle: row.handle,
          repo: row.repo,
          sealed: await sealJson(to, bound, await openJson(from, bound, row.sealed, 'routine')),
        });
      } catch {
        // Can't be opened with the key in use either.
      }
    }
    return out;
  },

  /** Lent routines sealed again under `newSyncKey`, as people's are (BRK-324). */
  async resealedLentRoutines(newSyncKey) {
    const rows = this.sql.exec('SELECT repo, sealed FROM lent_routines').toArray();
    if (!rows.length) return [];
    const [from, to] = await Promise.all([this.keptRoutineKey(), routineKey(newSyncKey)]);
    const out = [];
    for (const row of rows) {
      const bound = lentBoundOf(row.repo);
      try {
        out.push({
          repo: row.repo,
          sealed: await sealJson(to, bound, await openJson(from, bound, row.sealed, 'routine')),
        });
      } catch {
        // Can't be opened with the key in use either: a lent start says to connect it again.
      }
    }
    return out;
  },
};

/** The plans, as a refusal names them. */
const planWords = () =>
  Object.entries(PLANS)
    .map(([id, p]) => `${id} (${p.name})`)
    .join(', ');
