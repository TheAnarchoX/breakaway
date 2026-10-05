/**
 * TaskStore's chase (docs/specs/IDEA-28-features-and-chase.md, section 3 and 4): the owner presses Chase on a
 * feature, and on every tick the board starts an agent on each ready task in it and in what blocks it, through
 * each task's own repository's routine, within the shared slots and budget, each repository's caps, and the
 * chase's per-area limit (`parallel`). It never starts, answers, or merges what only the owner can do: those are
 * Needs you. A task refused twice is Stuck. When nothing can run and only the owner can help, it pings once; when
 * every task is done or in review, it ends. Stopping starts nothing new and leaves running agents alone.
 * A chase also fixes its own pull requests (BRK-137): when one conflicts or its checks fail and no agent
 * picks it up within FIX_GRACE_MS, it starts a fix agent on it, and a chase that ended by itself keeps
 * doing that for its open pull requests.
 */
import { prVerdict } from './github.js';
import { AgentError } from './store-agents.js';
import { InputError, rank } from './model.js';

const DEFAULT_PARALLEL = 3;
/** Refusals (failed starts, or an agent that let go without a pull request) before a task is Stuck. */
const STUCK_AFTER = 2;
const NOTES_KEPT_MS = 30 * 86_400_000;
const STATES = ['off', 'on', 'stopped', 'done'];
/** How long a chase's pull request that conflicts or fails waits for its own agent before the chase starts a fix. */
const FIX_GRACE_MS = 3 * 60_000;
/** The problems a chase fixes on its pull requests, in the words its view uses. */
const PROBLEMS = { conflicts: 'conflicts with its base branch', failing: 'has failing checks' };

const label = (t) => t.wid ?? t.short;
const inReview = (t) => Boolean(t.github?.some((p) => p.closes && p.state === 'open'));
const openPull = (t) => t.github?.find((p) => p.closes && p.state === 'open') ?? null;
const areaOf = (t) => `${t.repo}:${t.project}`;
const agents = (n) => `${n} ${n === 1 ? 'agent is' : 'agents are'}`;
const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);

/** The chase's tasks: the feature's own, then every open task that blocks one of them, from anywhere on the board. */
function chaseSet(members, byUuid) {
  const set = new Map(members.map((t) => [t.uuid, { t, blocks: [] }]));
  const stack = members.filter((t) => t.status === 'pending');
  while (stack.length) {
    const t = stack.pop();
    for (const dep of t.blockedBy) {
      const d = byUuid.get(dep);
      if (d?.status !== 'pending') continue;
      const entry = set.get(dep);
      if (entry) {
        if (!entry.member && !entry.blocks.includes(label(t))) entry.blocks.push(label(t));
        continue;
      }
      set.set(dep, { t: d, blocks: [label(t)] });
      stack.push(d);
    }
  }
  for (const t of members) set.get(t.uuid).member = true;
  return [...set.values()];
}

/** How many open chase tasks wait on `uuid`, directly or through others. */
function unblocks(uuid, waiters) {
  const seen = new Set();
  const stack = [uuid];
  while (stack.length) for (const w of waiters.get(stack.pop()) ?? []) if (!seen.has(w)) seen.add(w) && stack.push(w);
  return seen.size;
}

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const chaseMethods = {
  initChase() {
    const columns = this.sql
      .exec('PRAGMA table_info(features)')
      .toArray()
      .map((c) => c.name);
    // The chase state is the feature's own (section 4): nothing on a fresh install, nothing on a task.
    if (!columns.includes('chase')) this.sql.exec("ALTER TABLE features ADD COLUMN chase TEXT NOT NULL DEFAULT 'off'");
    if (!columns.includes('chase_started')) this.sql.exec('ALTER TABLE features ADD COLUMN chase_started INTEGER');
    if (!columns.includes('chase_parallel'))
      this.sql.exec(`ALTER TABLE features ADD COLUMN chase_parallel INTEGER NOT NULL DEFAULT ${DEFAULT_PARALLEL}`);
    if (!columns.includes('chase_stalled')) this.sql.exec('ALTER TABLE features ADD COLUMN chase_stalled INTEGER');
    if (!columns.includes('chase_ended')) this.sql.exec('ALTER TABLE features ADD COLUMN chase_ended INTEGER');
    // Chase started, stopped, stalled, and ended, for Activity; an ended chase's row is also its inbox note.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS chase_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL,
        detail TEXT, dismissed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS chase_events_at ON chase_events (at);
      CREATE TABLE IF NOT EXISTS chase_fixes (
        task TEXT NOT NULL, pr INTEGER NOT NULL, head TEXT NOT NULL, problem TEXT NOT NULL, slug TEXT NOT NULL,
        seen INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (task, pr, head, problem)
      );
    `);
  },

  chaseEvent(slug, kind, detail = null) {
    this.sql.exec(
      'INSERT INTO chase_events (slug, at, kind, detail) VALUES (?, ?, ?, ?)',
      slug,
      Date.now(),
      kind,
      detail ? String(detail).slice(0, 500) : null,
    );
  },

  chaseEvents(after, upTo) {
    return this.sql.exec('SELECT * FROM chase_events WHERE at > ? AND at <= ? ORDER BY at DESC', after, upTo).toArray();
  },

  /** Ended chases the owner hasn't dismissed: the inbox's note, one per end, never a push. */
  chaseNotes() {
    const since = Date.now() - NOTES_KEPT_MS;
    return this.sql
      .exec(
        "SELECT e.*, f.title FROM chase_events e LEFT JOIN features f ON f.slug = e.slug WHERE e.kind = 'chase_ended' AND e.dismissed = 0 AND e.at > ? ORDER BY e.id DESC LIMIT 50",
        since,
      )
      .toArray()
      .map((r) => ({ id: r.id, feature: r.slug, title: r.title ?? r.slug, detail: r.detail, at: iso(r.at) }));
  },

  /** Whether any chase is on: the alarm then runs after anything that could unblock a task. */
  chasing() {
    return this.sql.exec("SELECT 1 FROM features WHERE chase = 'on' LIMIT 1").toArray().length > 0;
  },

  /** The chase's record as the API shows it. */
  chaseState(row) {
    const state = STATES.includes(row.chase) ? row.chase : 'off';
    return {
      state,
      on: state === 'on',
      startedAt: iso(row.chase_started),
      parallel: Number(row.chase_parallel ?? DEFAULT_PARALLEL),
      stalledPingAt: iso(row.chase_stalled),
      endedAt: iso(row.chase_ended),
    };
  },

  /** Refusals since the chase started: failed starts, and agents that let a task go without a pull request. */
  chaseRefusals(t, since, running) {
    const runs = this.sql
      .exec(
        "SELECT agent, status, error FROM agent_runs WHERE task = ? AND started >= ? AND status IN ('failed', 'started') ORDER BY id",
        t.uuid,
        since ?? 0,
      )
      .toArray();
    let count = 0;
    let last = null;
    for (const run of runs) {
      if (run.status === 'failed') {
        count += 1;
        last = run.error;
      } else if (!running.has(t.uuid) && t.claim !== run.agent && !inReview(t)) {
        count += 1;
        last = null;
      }
    }
    return { count, last: last ?? t.comments.at(-1)?.text ?? null };
  },

  /**
   * What's wrong with an in-review chase task's pull request that an agent can fix (conflicts or failing
   * checks), or null: the problem on its current head, when the chase first saw it, and the fixes it started.
   */
  chasePullProblem(t, pr) {
    const row = this.sql
      .exec('SELECT data FROM gh_pulls WHERE repo = ? AND number = ?', pr.repo ?? t.repo, pr.number)
      .toArray()[0];
    if (!row) return null;
    const data = JSON.parse(row.data);
    const problem = prVerdict(data);
    if (!(problem in PROBLEMS)) return null;
    const head = data.headSha ?? '';
    const fix = this.sql
      .exec(
        'SELECT seen, tries FROM chase_fixes WHERE task = ? AND pr = ? AND head = ? AND problem = ?',
        t.uuid,
        pr.number,
        head,
        problem,
      )
      .toArray()[0];
    return { pr: pr.number, head, problem, words: PROBLEMS[problem], seen: fix?.seen ?? null, tries: fix?.tries ?? 0 };
  },

  /**
   * Who a chase on feature `row` starts now and why each other task in it waits (section 3): its tasks and
   * their blockers, sorted into done, in review, running, waiting, Needs you, Stuck, and the queue. `views`
   * and `connected` are the board's now. The queue counts what auto-start starts first (security fixes,
   * general agents, and Start-when-ready tasks), then keeps to the shared slots and budget, each repository's
   * caps, `parallel` agents per area (counting every agent running there), and never two agents on related
   * tasks in one area.
   */
  /** The chase's tasks, as `{ t, blocks, member }`: the feature's own, then what blocks them (its peloton's too). */
  chaseMembers(row, views) {
    const byUuid = new Map(views.map((t) => [t.uuid, t]));
    const members = views.filter((t) => t.status !== 'deleted' && t.tags.includes(row.slug));
    // A task in two features counts toward the first alphabetically (section 1).
    const slugs = new Set(this.featureRows().map((r) => r.slug));
    const mine = members.filter((t) => t.tags.filter((tag) => slugs.has(tag)).sort()[0] === row.slug);
    return chaseSet(mine, byUuid);
  },

  chaseQueue(row, views, connected) {
    const parallel = Number(row.chase_parallel ?? DEFAULT_PARALLEL);
    const byUuid = new Map(views.map((t) => [t.uuid, t]));
    const set = this.chaseMembers(row, views);
    const inChase = new Set(set.map((e) => e.t.uuid));
    const waiters = new Map();
    for (const { t } of set)
      if (t.status === 'pending')
        for (const dep of t.blockedBy) if (inChase.has(dep)) waiters.set(dep, [...(waiters.get(dep) ?? []), t.uuid]);

    const { max, hourly } = this.agentSettings();
    const runningList = this.runningAgents(views);
    const running = new Set(runningList.map(({ task }) => task.uuid));
    // Auto-start goes first (BRK-82 decision 4): what it starts this tick takes its slots and areas.
    const ahead = this.autostartQueue(views, connected)
      .filter((q) => q.ready)
      .map((q) => byUuid.get(q.uuid))
      .filter(Boolean);
    const inArea = new Map();
    const workingIn = new Map();
    for (const t of [...runningList.map(({ task }) => task), ...ahead]) {
      if (!t.project) continue;
      inArea.set(areaOf(t), (inArea.get(areaOf(t)) ?? 0) + 1);
      workingIn.set(areaOf(t), [...(workingIn.get(areaOf(t)) ?? []), t]);
    }
    let free = max - runningList.length - ahead.length;
    let budget = hourly - this.startsThisHour() - ahead.length;
    const room = new Map();
    const roomOf = (repo) => {
      if (!room.has(repo))
        room.set(repo, this.repoRoom(repo, runningList) - ahead.filter((t) => t.repo === repo).length);
      return room.get(repo);
    };
    const autoNow = new Set(ahead.map((t) => t.uuid));

    const brief = ({ t, blocks, member }) => ({
      uuid: t.uuid,
      wid: t.wid,
      description: t.description,
      repo: t.repo,
      project: t.project,
      // A pulled-in blocker says why it's here (section 3.1).
      ...(member ? {} : { blocks }),
      unblocks: unblocks(t.uuid, waiters),
    });
    const tasks = [];
    const needsYou = [];
    const stuck = [];
    const candidates = [];
    // Pull requests that conflict or fail, for the tick to note when it first saw them.
    const watch = [];
    for (const entry of set) {
      const { t } = entry;
      const item = brief(entry);
      const add = (state, why, extra = {}) => tasks.push({ ...item, state, why, ...extra });
      if (t.status === 'completed') add('done', null);
      else if (t.status !== 'pending') add('done', `it’s ${t.status}`);
      else if (inReview(t)) {
        const pr = openPull(t);
        const fix = this.chasePullProblem(t, pr);
        const busy = fix && this.claimBlocker(t);
        const agentOn = busy && /^(claude|codex)-/u.test(t.claim);
        if (fix) watch.push({ uuid: t.uuid, ...fix });
        if (!fix || (busy && !agentOn)) {
          const why = `its pull request #${pr.number} is open: merging is yours`;
          add('in-review', why);
          needsYou.push({ ...item, kind: 'merge', why, pr: pr.number });
        } else if (agentOn) add('running', `${t.claim} is on its pull request #${pr.number}, which ${fix.words}`);
        else if (fix.tries >= STUCK_AFTER) {
          const why = `its pull request #${pr.number} still ${fix.words} after ${fix.tries} agents tried to fix it`;
          add('stuck', why);
          stuck.push({ ...item, why, last: t.comments.at(-1)?.text ?? null, pr: pr.number });
        } else if (fix.seen === null || Date.now() - fix.seen < FIX_GRACE_MS)
          add(
            'waiting',
            `its pull request #${pr.number} ${fix.words}: if no agent picks it up within ${FIX_GRACE_MS / 60_000} minutes, the chase starts one to fix it`,
            { until: true },
          );
        else candidates.push({ t, item: { ...item, fix: { pr: pr.number, problem: fix.problem } }, fix });
      } else if (t.claim || running.has(t.uuid)) add('running', `${t.claim} has it`);
      else if (t.blocked)
        add(
          'waiting',
          `it waits for ${t.blockedBy.map((u) => label(byUuid.get(u) ?? { short: u.slice(0, 8) })).join(', ')}`,
        );
      else if (t.waiting) add('waiting', `it waits until ${t.wait?.slice(0, 10)}`, { until: true });
      else if (t.tags.includes('decide') || (t.decision && !t.decisionAnswers)) {
        const why = 'it waits on your decision';
        add('needs-you', why);
        needsYou.push({ ...item, kind: 'decide', why });
      } else if (!t.tags.includes('agent')) {
        const owner = t.tags.includes('owner');
        const why = owner
          ? `it’s a step for you (+owner)${t.doneWhen ? `: done when ${t.doneWhen}` : ''}`
          : 'it isn’t tagged +agent, so it’s yours to do or to tag';
        add('needs-you', why);
        needsYou.push({ ...item, kind: owner ? 'owner' : 'untagged', why });
      } else {
        const refused = this.chaseRefusals(t, row.chase_started, running);
        if (refused.count >= STUCK_AFTER) {
          const why = `it was refused ${refused.count} times`;
          add('stuck', why);
          stuck.push({ ...item, why, last: refused.last });
        } else if (connected && !connected.has(t.repo)) {
          const why = `${t.repo}’s agent routine isn’t connected: connect ${t.repo}`;
          add('needs-you', why);
          needsYou.push({ ...item, kind: 'connect', why });
        } else candidates.push({ t, item });
      }
    }

    // Fixes first, since their tasks are nearly done; then nearest to unblocking the most work first: the
    // ranking startNext uses, then what each unblocks.
    candidates.sort((a, b) => Number(!a.fix) - Number(!b.fix) || rank(a.t, b.t) || b.item.unblocks - a.item.unblocks);
    const queue = [];
    const start = [];
    for (const { t, item, fix } of candidates) {
      let reason = null;
      let capacity = true;
      const area = areaOf(t);
      const name = this.areaName(t.repo, t.project);
      const near = t.project ? (workingIn.get(area) ?? []) : [];
      const related = near.find((o) => o.uuid !== t.uuid && (t.related.includes(o.uuid) || o.related.includes(t.uuid)));
      if (autoNow.has(t.uuid)) reason = 'auto-start starts it now';
      else if (related)
        reason = `it’s related to ${label(related)}, which an agent is working on in ${name}: never two at once`;
      else if (t.project && (inArea.get(area) ?? 0) >= parallel)
        reason = `${agents(inArea.get(area))} already working in ${name}, the most this chase allows`;
      else if (free <= 0) reason = `no free slot (${runningList.length} of ${max} running)`;
      else if (budget <= 0) reason = `${hourly} agents were started in the last hour, the most the board starts`;
      else if (roomOf(t.repo) <= 0) reason = this.repoCapBlocker(t.repo, runningList) ?? `${t.repo} is at its cap`;
      else capacity = false;
      if (!reason) {
        free -= 1;
        budget -= 1;
        room.set(t.repo, roomOf(t.repo) - 1);
        if (t.project) {
          inArea.set(area, (inArea.get(area) ?? 0) + 1);
          workingIn.set(area, [...near, t]);
        }
        start.push(fix ? { ...t, fix: item.fix } : t);
      }
      queue.push({ ...item, ready: !reason, reason: reason ?? 'starting now', capacity: capacity && Boolean(reason) });
      tasks.push({ ...item, state: 'ready', why: reason });
    }

    const count = (state) => tasks.filter((x) => x.state === state).length;
    const line = {
      running: count('running'),
      ready: candidates.length,
      waiting: count('waiting'),
      needsYou: needsYou.length,
      stuck: stuck.length,
      inReview: count('in-review'),
      done: count('done'),
      total: tasks.length,
    };
    const order = new Map(set.map((e, i) => [e.t.uuid, i]));
    tasks.sort((a, b) => order.get(a.uuid) - order.get(b.uuid));
    return { tasks, needsYou, stuck, queue, start, line, watch };
  },

  /** "3 running, 2 ready, 1 waiting for you": the chase's live line (section 3.9). */
  chaseLine(line) {
    const parts = [`${line.running} running`, `${line.ready} ready`];
    if (line.waiting) parts.push(`${line.waiting} waiting on other tasks`);
    if (line.needsYou) parts.push(`${line.needsYou} waiting for you`);
    if (line.stuck) parts.push(`${line.stuck} stuck`);
    return parts.join(', ');
  },

  /** The feature's chase as its page shows it: the record, and with `plan`, who starts next and what holds the rest. */
  chaseView(row, plan = null) {
    return {
      ...this.chaseState(row),
      ...(plan
        ? {
            line: plan.line,
            summary: this.chaseLine(plan.line),
            tasks: plan.tasks,
            needsYou: plan.needsYou,
            stuck: plan.stuck,
            queue: plan.queue,
          }
        : {}),
    };
  },

  /** The chases that are on, oldest first, each worked out against `views`: the Agents view's (section 3.9). */
  chasesOn(views, connected) {
    return this.sql
      .exec("SELECT * FROM features WHERE chase = 'on' ORDER BY chase_started, slug")
      .toArray()
      .map((row) => ({
        slug: row.slug,
        title: row.title,
        ...this.chaseView(row, this.chaseQueue(row, views, connected)),
      }));
  },

  /** GET /api/features/<slug>: the feature with its chase worked out, connections included. */
  async featureWithChase(slug) {
    const detail = this.featureDetail(slug);
    const row = this.featureRow(slug);
    const plan = this.chaseQueue(row, this.views(), await this.connectedRepos());
    return { ...detail, chase: this.chaseView(row, plan) };
  },

  /**
   * POST /api/features/<slug>/chase: `on` starts or stops it, `parallel` sets the per-area limit (a running chase
   * follows it on the next tick), `dryRun` shows what would start now without starting or changing anything, and
   * `dismiss` clears its ended note from the inbox. The owner's alone: agents never start a chase.
   */
  async chaseFeature(slug, { on, parallel, dryRun = false, dismiss = false, by } = {}) {
    await this.ready();
    if (by !== undefined && by !== null && by !== '' && by !== 'owner')
      throw new AgentError('only the owner can start or stop a chase', 403);
    const row = this.featureRow(slug);
    if (on !== undefined && typeof on !== 'boolean') throw new InputError('on is true or false');
    let limit;
    if (parallel !== undefined && parallel !== null) {
      limit = Number(parallel);
      const most = this.repoCapCeilings().max;
      if (!Number.isInteger(limit) || limit < 1 || limit > most)
        throw new InputError(`parallel is how many agents at once in one area: a number from 1 to ${most}`);
    }
    const connected = await this.connectedRepos();
    if (dryRun) {
      const plan = this.chaseQueue(
        { ...row, chase: on === false ? row.chase : 'on', chase_parallel: limit ?? row.chase_parallel },
        this.views(),
        connected,
      );
      return { dryRun: true, chase: this.chaseView(row, plan), started: [], wouldStart: plan.start.map(label) };
    }
    this.writable();
    if (dismiss)
      this.sql.exec("UPDATE chase_events SET dismissed = 1 WHERE slug = ? AND kind = 'chase_ended'", row.slug);
    if (limit !== undefined) this.sql.exec('UPDATE features SET chase_parallel = ? WHERE slug = ?', limit, row.slug);
    let started = [];
    if (on === true && row.chase !== 'on') {
      const plan = this.chaseQueue(row, this.views(), connected);
      if (!plan.tasks.length) throw new AgentError(`${row.title} has no tasks to chase: tag some with ${row.slug}`);
      if (plan.tasks.every((x) => x.state === 'done'))
        throw new AgentError(`every task in ${row.title} is done: there’s nothing to chase`);
      this.sql.exec(
        "UPDATE features SET chase = 'on', chase_started = ?, chase_stalled = NULL, chase_ended = NULL WHERE slug = ?",
        Date.now(),
        row.slug,
      );
      this.sql.exec("UPDATE chase_events SET dismissed = 1 WHERE slug = ? AND kind = 'chase_ended'", row.slug);
      this.chaseEvent(row.slug, 'chase_started', `${row.title}, ${limit ?? row.chase_parallel} at once in an area`);
      // Its peloton opens with it (IDEA-32): the agents it starts check in there.
      this.pelotonLine(row.slug, 'open', `The chase on ${row.title} started. Agents on its tasks check in here.`);
      // Pressing Chase starts what's ready now; the alarm and the cron take it from there.
      started = await this.chaseTick({ only: row.slug });
    } else if (on === false && row.chase === 'on') {
      // Stopping starts nothing new; running agents finish and open their pull requests (section 3.7).
      this.sql.exec("UPDATE features SET chase = 'stopped', chase_ended = ? WHERE slug = ?", Date.now(), row.slug);
      this.chaseEvent(row.slug, 'chase_stopped', row.title);
      this.pelotonLine(
        row.slug,
        'close',
        `The chase on ${row.title} stopped. This peloton takes no new posts and goes in a day.`,
      );
    } else if (limit !== undefined && row.chase === 'on') this.scheduleAgentsCheck();
    const fresh = this.featureRow(row.slug);
    const plan = this.chaseQueue(fresh, this.views(), connected);
    return { dryRun: false, chase: this.chaseView(fresh, plan), started };
  },

  /**
   * Starts every ready task in every chase that's on, after auto-start (the alarm and the cron call it), then
   * ends a chase with nothing left to do and pings once about one that can't move without the owner.
   * A chase that ended by itself in the last 30 days only fixes its open pull requests: it starts nothing else.
   * Returns the work IDs it started.
   */
  async chaseTick({ only = null } = {}) {
    await this.ready();
    const now = Date.now();
    this.sql.exec('DELETE FROM chase_fixes WHERE seen < ?', now - NOTES_KEPT_MS);
    const rows = this.sql
      .exec(
        "SELECT * FROM features WHERE chase = 'on' OR (chase = 'done' AND chase_ended > ?) ORDER BY chase_started, slug",
        now - NOTES_KEPT_MS,
      )
      .toArray()
      .filter((r) => !only || r.slug === only);
    if (!rows.length) return [];
    const connected = await this.connectedRepos();
    const started = [];
    for (const row of rows) {
      const on = row.chase === 'on';
      const plan = this.chaseQueue(row, this.views(), connected);
      for (const w of plan.watch)
        this.sql.exec(
          'INSERT OR IGNORE INTO chase_fixes (task, pr, head, problem, slug, seen) VALUES (?, ?, ?, ?, ?, ?)',
          w.uuid,
          w.pr,
          w.head,
          w.problem,
          row.slug,
          now,
        );
      let startedHere = 0;
      for (const t of plan.start) {
        if (!on && !t.fix) continue;
        try {
          if (t.fix) await this.chaseFix(row, t);
          else await this.startAgent(t.uuid, { trigger: 'chase' });
          started.push(label(t));
          startedHere += 1;
        } catch {
          // It stays in the queue; a failed fire counts toward Stuck, and the next tick tries again.
        }
      }
      if (on) await this.chaseSettle(this.featureRow(row.slug), startedHere ? null : plan);
    }
    return started;
  },

  /**
   * Starts a fix agent on chase task `t`'s pull request (`t.fix`), through Fix with an agent, telling it it's
   * one of the chase's agents. Each try counts, started or refused, so a pull request two fixes couldn't
   * mend on the same head is Stuck.
   */
  async chaseFix(row, t) {
    const { pr, problem } = t.fix;
    const fix = this.chasePullProblem(t, { number: pr, repo: t.repo });
    if (fix?.problem !== problem) throw new AgentError(`#${pr} changed since the chase looked`, 409);
    const tried = () =>
      this.sql.exec(
        'UPDATE chase_fixes SET tries = tries + 1 WHERE task = ? AND pr = ? AND head = ? AND problem = ?',
        t.uuid,
        pr,
        fix.head,
        problem,
      );
    let res;
    try {
      res = await this.fixPr(pr, {
        problem,
        repo: t.repo,
        chase: { slug: row.slug, title: row.title },
        trigger: 'chase-fix',
      });
    } catch (error) {
      tried();
      throw error;
    }
    if (res.already) throw new AgentError(res.already, 409);
    tried();
  },

  /**
   * After a tick: a chase whose tasks are all done or in review ends (one inbox note, no push); one where nothing
   * runs, nothing can start, and only the owner can free the rest pings once, naming the thing that frees the most.
   * Capacity is never a stall. `plan` is null when this tick started something.
   */
  async chaseSettle(row, plan) {
    if (!plan) {
      if (row.chase_stalled) this.sql.exec('UPDATE features SET chase_stalled = NULL WHERE slug = ?', row.slug);
      return;
    }
    const { tasks, needsYou, stuck, queue } = plan;
    if (tasks.every((x) => x.state === 'done' || x.state === 'in-review')) {
      const review = tasks.filter((x) => x.state === 'in-review').length;
      const detail = `Every task in ${row.title} is done${review ? ` or in review (${review} to merge)` : ''}.`;
      this.sql.exec(
        "UPDATE features SET chase = 'done', chase_ended = ?, chase_stalled = NULL WHERE slug = ?",
        Date.now(),
        row.slug,
      );
      this.chaseEvent(row.slug, 'chase_ended', detail);
      this.pelotonLine(
        row.slug,
        'close',
        `${detail} The chase ended: this peloton takes no new posts and goes in a day.`,
      );
      return;
    }
    const moving = tasks.some((x) => x.state === 'running' || x.until) || queue.some((q) => q.ready || q.capacity);
    if (moving) {
      if (row.chase_stalled) this.sql.exec('UPDATE features SET chase_stalled = NULL WHERE slug = ?', row.slug);
      return;
    }
    if (row.chase_stalled) return; // One ping per stall: it stays on and starts again when the owner acts.
    const held = [...needsYou, ...stuck.map((s) => ({ ...s, kind: 'stuck' }))];
    if (!held.length) return;
    const top = held.sort((a, b) => b.unblocks - a.unblocks)[0];
    await this.chasePing(row, top);
  },

  /**
   * A road captain for the chase on feature `slug` (BRK-137): an agent the owner starts with their own prompt to
   * help the chase along. Its repository is the one most of the feature's own tasks are in; its brief is the
   * owner's prompt with the chase as it stands under it: the live line, the open pull requests and what's wrong
   * with each, and what's Stuck or needs the owner.
   */
  roadCaptain(slug, prompt, views, connected) {
    const row = this.featureRow(slug);
    if (row.chase === 'off')
      throw new AgentError(`${row.title} has no chase yet: press Chase first, then start its road captain`, 409);
    const set = this.chaseMembers(row, views);
    const counts = new Map();
    for (const { t, member } of set) if (member) counts.set(t.repo, (counts.get(t.repo) ?? 0) + 1);
    const repo = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? this.defaultRepoSlug();
    const plan = this.chaseQueue(row, views, connected);
    const pulls = [];
    for (const { t } of set) {
      if (t.status !== 'pending' || !inReview(t)) continue;
      const pr = openPull(t);
      const fix = this.chasePullProblem(t, pr);
      pulls.push(`- #${pr.number} closes ${label(t)} (${t.repo}): ${fix ? fix.words : `it’s ${pr.verdict ?? 'open'}`}`);
    }
    const held = [
      ...plan.stuck.map((x) => `- ${x.wid ?? x.description}: stuck, ${x.why}`),
      ...plan.needsYou.map((x) => `- ${x.wid ?? x.description}: ${x.why}`),
    ];
    const first = (prompt.split('\n').find((line) => line.trim()) ?? prompt).trim();
    const brief = [
      prompt,
      '',
      `## The chase on ${row.title} (+${row.slug})`,
      '',
      `You're its road captain: the owner started you to help this chase along, in ${repo}. Your task carries the +${row.slug} tag, so you ride the chase's peloton too: read it, and answer its agents. \`npx breakaway chase ${row.slug} --dry-run\` shows it as it is when you read it, and \`npx breakaway github\` the pull requests' checks.`,
      '',
      `When the owner pressed it: ${this.chaseLine(plan.line)} (state ${row.chase}).`,
      ...(pulls.length ? ['', 'Its open pull requests:', ...pulls] : []),
      ...(held.length ? ['', 'What holds the rest:', ...held] : []),
    ].join('\n');
    return {
      slug: row.slug,
      feature: row.title,
      repo,
      brief,
      title: `Road captain for ${row.title}: ${first}`.slice(0, 200),
    };
  },

  /** The stall ping (section 3.6): a `blocked` ping on the task that frees the most, as the board, which pushes. */
  async chasePing(row, item) {
    const what = {
      decide: 'waits on your decision',
      owner: 'is a step for you (+owner)',
      untagged: 'isn’t tagged +agent: do it or tag it',
      merge: `has pull request #${item.pr} open: merging is yours`,
      connect: `is in ${item.repo}, whose agent routine isn’t connected: connect it`,
      stuck: 'was refused twice: look at its last comment',
    }[item.kind];
    const more = item.unblocks
      ? `, and ${item.unblocks} more ${item.unblocks === 1 ? 'task waits' : 'tasks wait'} for it`
      : '';
    const message =
      `The chase on ${row.title} can’t start anything: ${item.wid ?? item.description} ${what}${more}. The chase stays on and carries on when it’s done.`.slice(
        0,
        500,
      );
    const now = Date.now();
    this.sql.exec('UPDATE features SET chase_stalled = ? WHERE slug = ?', now, row.slug);
    this.chaseEvent(row.slug, 'chase_stalled', message);
    this.change(item.uuid, { annotate: `Ping (blocked): ${message}`, by: 'board' });
    const ping = this.sql
      .exec(
        "INSERT INTO pings (task, kind, message, agent, created) VALUES (?, 'blocked', ?, 'board', ?) RETURNING id",
        item.uuid,
        message,
        now,
      )
      .one();
    // A push is a convenience: it never throws, and the ping and its comment are the record.
    await this.pushPing(ping.id);
  },
};
