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
 * A chase can have a road captain (BRK-275, docs/specs/BRK-275-road-captain.md): one agent the board starts with it
 * on a task of its own, which keeps the plan and runs the peloton, writes a captain's log, and hands over to a fresh
 * captain after its watch.
 * A chase waits for its owner (BRK-276): at its review cap, the pull requests it opened that wait on the owner, it
 * starts nothing new but fixes, and it resumes as the owner merges or closes them.
 */
import { prVerdict } from './github.js';
import { AgentError } from './store-agents.js';
import { noRoutineWords } from './store-person-claude.js';
import { NO_FILES } from './store-collision.js';
import { InputError, rank } from './model.js';
import { OWNER, refusal } from './permissions.js';
import { looksLikeSecret } from './ping.js';

const DEFAULT_PARALLEL = 3;
/** How many of a chase's pull requests may wait on the owner before it starts nothing new (BRK-276). */
const DEFAULT_REVIEW_CAP = 5;
const REVIEW_CAP_MAX = 50;
/** Verdicts of an open pull request that waits on the owner: its checks are done and an agent has nothing to fix. */
const WAITS_ON_OWNER = new Set(['ready', 'review', 'behind', 'unknown']);
/** Refusals (failed starts, or an agent that let go without a pull request) before a task is Stuck. */
const STUCK_AFTER = 2;
const NOTES_KEPT_MS = 30 * 86_400_000;
const STATES = ['off', 'on', 'stopped', 'done'];
/** How long a chase's pull request that conflicts or fails waits for its own agent before the chase starts a fix. */
const FIX_GRACE_MS = 3 * 60_000;
/** The problems a chase fixes on its pull requests, in the words its view uses. */
const PROBLEMS = { conflicts: 'conflicts with its base branch', failing: 'has failing checks' };
/** A chase of more than this many tasks starts with a road captain unless the owner says otherwise (BRK-275). */
export const CAPTAIN_OVER = 10;
/** A road captain's watch, in hours, before it hands over to a fresh one; the owner sets 1 to CAPTAIN_HOURS_MAX. */
const CAPTAIN_HOURS = 12;
const CAPTAIN_HOURS_MAX = 72;
/** How long a captain whose watch is over has to write its log before the board hands over for it. */
const CAPTAIN_GRACE_MS = 30 * 60_000;
/** The least time between two starts of a chase's captain when the last one let go or failed to start. */
const CAPTAIN_RETRY_MS = 15 * 60_000;
const CAPTAIN_LOG_MAX = 8000;
const CAPTAIN_LOGS_KEPT = 50;

const label = (t) => t.wid ?? t.short;
const inReview = (t) => Boolean(t.github?.some((p) => p.closes && p.state === 'open'));
const openPull = (t) => t.github?.find((p) => p.closes && p.state === 'open') ?? null;
const areaOf = (t) => `${t.repo}:${t.project}`;
const agents = (n) => `${n} ${n === 1 ? 'agent is' : 'agents are'}`;
const pulls = (n) => `${n} ${n === 1 ? 'pull request waits' : 'pull requests wait'}`;
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

/** Who a chase's starts are for (BRK-334): the person who pressed Chase, or the owner. */
const chaseFor = (row) => row.chase_by || OWNER;

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
    if (!columns.includes('chase_review_cap'))
      this.sql.exec(`ALTER TABLE features ADD COLUMN chase_review_cap INTEGER NOT NULL DEFAULT ${DEFAULT_REVIEW_CAP}`);
    if (!columns.includes('chase_stalled')) this.sql.exec('ALTER TABLE features ADD COLUMN chase_stalled INTEGER');
    if (!columns.includes('chase_ended')) this.sql.exec('ALTER TABLE features ADD COLUMN chase_ended INTEGER');
    // The road captain (BRK-275): whether the chase has one, its watch in hours, and when the board asked it to hand over.
    if (!columns.includes('chase_captain'))
      this.sql.exec('ALTER TABLE features ADD COLUMN chase_captain INTEGER NOT NULL DEFAULT 0');
    if (!columns.includes('chase_captain_hours'))
      this.sql.exec(`ALTER TABLE features ADD COLUMN chase_captain_hours INTEGER NOT NULL DEFAULT ${CAPTAIN_HOURS}`);
    if (!columns.includes('chase_captain_asked'))
      this.sql.exec('ALTER TABLE features ADD COLUMN chase_captain_asked INTEGER');
    // Who started the chase (BRK-334): its agents and its captain start on that person's Claude. Null is the owner.
    if (!columns.includes('chase_by')) this.sql.exec('ALTER TABLE features ADD COLUMN chase_by TEXT');
    // Chase started, stopped, stalled, and ended, and the owner's changes of plan (WEB-104), for Activity; an ended
    // chase's row is also its inbox note.
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
      CREATE TABLE IF NOT EXISTS captain_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, at INTEGER NOT NULL, agent TEXT NOT NULL,
        text TEXT NOT NULL, handover INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS captain_logs_slug ON captain_logs (slug, id);
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

  /**
   * The chase's record as the API shows it; with `review` (from chaseReview), how many of its pull requests wait on
   * the owner. `partial` is a person's read of a chase that spans a repository they can't see (BRK-323): the captain's
   * log and the digests are free text about all of it, so they're left out.
   */
  chaseState(row, review = null, partial = false) {
    const state = STATES.includes(row.chase) ? row.chase : 'off';
    return {
      state,
      on: state === 'on',
      startedAt: iso(row.chase_started),
      parallel: Number(row.chase_parallel ?? DEFAULT_PARALLEL),
      reviewCap: Number(row.chase_review_cap ?? DEFAULT_REVIEW_CAP),
      ...(review ? { review } : {}),
      stalledPingAt: iso(row.chase_stalled),
      endedAt: iso(row.chase_ended),
      captain: partial ? { ...this.captainView(row), log: [] } : this.captainView(row),
      // Its digests (BRK-277): whether they push, and the latest, for the feature's list.
      digest: partial ? { push: Boolean(row.chase_digest_push), list: [] } : this.chaseDigestList(row),
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
   * Whether task `t`'s open pull request `pr` merges without the owner: GitHub's auto-merge is on (Merge when
   * green turns it on), and no review asks for changes.
   */
  chasePullMergesItself(t, pr) {
    const row = this.sql
      .exec('SELECT data FROM gh_pulls WHERE repo = ? AND number = ?', pr.repo ?? t.repo, pr.number)
      .toArray()[0];
    if (!row) return false;
    const data = JSON.parse(row.data);
    return Boolean(data.autoMerge) && !data.draft && data.review?.decision !== 'changes_requested';
  },

  /**
   * The chase's pull requests that wait on the owner (BRK-276): open, closing one of its tasks, checks done, nothing
   * for an agent to fix (no conflict, no failing check, not a draft), and not set to merge by itself. `set` is
   * chaseMembers'. At `cap` of them, the chase is `full`: it starts nothing new but fixes.
   */
  chaseReview(row, set) {
    const cap = Number(row.chase_review_cap ?? DEFAULT_REVIEW_CAP);
    const waiting = [];
    for (const { t } of set) {
      if (t.status !== 'pending' || t.tags.includes('captain') || !inReview(t)) continue;
      const pr = openPull(t);
      if (WAITS_ON_OWNER.has(pr.verdict) && !this.chasePullMergesItself(t, pr)) waiting.push(pr.number);
    }
    waiting.sort((a, b) => a - b);
    return { waiting: waiting.length, cap, full: waiting.length >= cap, pulls: waiting };
  },

  /**
   * Who a chase on feature `row` starts now and why each other task in it waits (section 3): its tasks and
   * their blockers, sorted into done, in review, running, waiting, Needs you, Stuck, and the queue. `views`
   * and `connected` are the board's now. The queue counts what auto-start starts first (security fixes,
   * general agents, and Start-when-ready tasks), then keeps to the shared slots and budget, each repository's
   * caps, `parallel` agents per area (counting every agent that changes code there), and collision (IDEA-55 section
   * 3): a task waits when its footprint overlaps what runs beside it, or, when either footprint is unknown, when
   * it's related to a task an agent works on in its area. At its review cap (chaseReview) it starts only fixes.
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
    // What runs beside the chase's starts (IDEA-55 section 3): every agent running, its open pull requests nobody runs,
    // and what auto-start and the chase start this tick. Refine and review agents change no code: they don't count.
    const book = this.footprintBook();
    const beside = [
      ...this.besideNow(views, runningList),
      ...ahead.map((t) => ({ task: t, agent: null, kind: 'build', starting: true })),
    ];
    const inArea = new Map();
    for (const b of beside) {
      if (b.review || NO_FILES.has(b.kind) || !b.task.project) continue;
      inArea.set(areaOf(b.task), (inArea.get(areaOf(b.task)) ?? 0) + 1);
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
    const review = this.chaseReview(row, set);

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
      // The road captain rides the chase but isn't its work (BRK-275): the tick starts it on its own.
      if (t.tags.includes('captain')) continue;
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
        if (!fix && this.chasePullMergesItself(t, pr))
          // Set to merge when its checks pass (Merge when green, BRK-219): it frees what waits by itself.
          add('in-review', `its pull request #${pr.number} merges by itself once its checks pass`, { until: true });
        else if (!fix || (busy && !agentOn)) {
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
      else if (t.who === 'decision' || (t.decision && !t.decisionAnswers)) {
        const why = 'it waits on your decision';
        add('needs-you', why);
        needsYou.push({ ...item, kind: 'decision', why });
      } else if (t.who !== 'agent') {
        const person = t.who === 'person';
        const whose = !t.assignee || t.assignee === 'owner' ? 'you' : t.assignee;
        const why = person
          ? `it’s a step for ${whose}${t.doneWhen ? `: done when ${t.doneWhen}` : ''}`
          : 'nobody said who does it, so it’s yours to do or to give to an agent';
        add('needs-you', why);
        needsYou.push({ ...item, kind: person ? 'person' : 'nobody', why });
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
        } else if (connected && this.routineHold(t.repo)?.kind === 'paused') {
          // Claude refused the routine (BRK-144): connecting it again is the owner's.
          const why = this.holdReason(t.repo, this.routineHold(t.repo));
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
      let hit = null;
      const area = areaOf(t);
      const name = this.areaName(t.repo, t.project);
      const hold = connected ? this.routineHold(t.repo) : null;
      if (autoNow.has(t.uuid)) reason = 'auto-start starts it now';
      else if (hold) reason = this.holdReason(t.repo, hold);
      else if (!fix && review.full) {
        // Only the owner frees it, so it isn't capacity: a chase held only by its cap pings like any stall.
        reason = `${review.waiting} of the chase’s pull requests wait for you, the most it lets wait: it starts more as you merge or close them`;
        capacity = false;
      } else if ((hit = this.collision(t, beside, { chase: true, book })))
        reason =
          hit.why === 'files'
            ? hit.reason
            : `it’s related to ${hit.task}, which an agent is working on in ${name}: never two at once`;
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
        if (t.project) inArea.set(area, (inArea.get(area) ?? 0) + 1);
        beside.push({ task: t, agent: null, kind: fix ? 'fix-pr' : 'build', starting: true });
        start.push(fix ? { ...t, fix: item.fix } : t);
      }
      queue.push({
        ...item,
        ready: !reason,
        reason: reason ?? 'starting now',
        capacity: capacity && Boolean(reason),
        ...(hit?.why === 'files' ? { footprint: { task: hit.task, agent: hit.agent, path: hit.path } } : {}),
      });
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
      review: review.waiting,
      reviewCap: review.cap,
    };
    const order = new Map(set.map((e, i) => [e.t.uuid, i]));
    tasks.sort((a, b) => order.get(a.uuid) - order.get(b.uuid));
    return { tasks, needsYou, stuck, queue, start, line, watch, review };
  },

  /** "3 running, 2 ready, 1 waiting for you": the chase's live line (section 3.9). */
  chaseLine(line) {
    const parts = [`${line.running} running`, `${line.ready} ready`];
    if (line.waiting) parts.push(`${line.waiting} waiting on other tasks`);
    if (line.needsYou) parts.push(`${line.needsYou} waiting for you`);
    if (line.stuck) parts.push(`${line.stuck} stuck`);
    const live = parts.join(', ');
    // At its review cap (BRK-276), what it waits for comes first.
    if (line.reviewCap && line.review >= line.reviewCap)
      return `${pulls(line.review)} for you: the chase starts nothing new until you merge or close one. ${live[0].toUpperCase()}${live.slice(1)}`;
    return live;
  },

  /** The feature's chase as its page shows it: the record, and with `plan`, who starts next and what holds the rest. */
  chaseView(row, plan = null, partial = false) {
    const held = row.chase === 'on' ? (this.githubHold() ?? this.claudeHold()) : null;
    return {
      ...this.chaseState(row, plan?.review ?? null, partial),
      ...(held ? { held } : {}),
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
  async featureWithChase(slug, seen = null) {
    const detail = this.featureDetail(slug, seen);
    const row = this.featureRow(slug);
    const plan = this.chaseQueue(row, this.views(seen ?? undefined), await this.connectedRepos());
    // A person's queue counts only what they see, against the install's caps: a picture of their part, not a promise.
    const partial = Boolean(seen) && this.featureMembership(seen).partial.has(row.slug);
    return { ...detail, chase: this.chaseView(row, plan, partial) };
  },

  /**
   * POST /api/features/<slug>/chase: `on` starts or stops it, `parallel` sets the per-area limit and `reviewCap` how
   * many of its pull requests may wait on the owner (a running chase follows either on the next tick), `dryRun` shows
   * what would start now without starting or changing anything, and `dismiss` clears its ended note from the inbox.
   * `digestPush` turns the push of its digests on or off, and `dismissDigests` clears them from the inbox (BRK-277).
   * The owner's alone: agents never start a chase.
   */
  async chaseFeature(
    slug,
    {
      on,
      parallel,
      reviewCap,
      captain,
      captainHours,
      digestPush,
      dryRun = false,
      dismiss = false,
      dismissDigests = false,
      by,
      actor,
    } = {},
  ) {
    await this.ready();
    // A chase is a maintainer's in every repository the feature's tasks are in (BRK-301), and never an agent's.
    if (this.actorIn({ actor, by }).agent)
      this.allow({ actor, by }, 'chase', null, 'only the owner can start or stop a chase');
    const row = this.featureRow(slug);
    for (const repo of this.targetRepos({ feature: row.slug })) this.allow({ actor, by }, 'chase', repo);
    if (on !== undefined && typeof on !== 'boolean') throw new InputError('on is true or false');
    if (captain !== undefined && captain !== null && typeof captain !== 'boolean')
      throw new InputError('captain is true or false: whether the chase has a road captain');
    let hours;
    if (captainHours !== undefined && captainHours !== null) {
      hours = Number(captainHours);
      if (!Number.isInteger(hours) || hours < 1 || hours > CAPTAIN_HOURS_MAX)
        throw new InputError(
          `captainHours is a road captain's watch before it hands over: whole hours from 1 to ${CAPTAIN_HOURS_MAX}`,
        );
    }
    let limit;
    if (parallel !== undefined && parallel !== null) {
      limit = Number(parallel);
      const most = this.repoCapCeilings().max;
      if (!Number.isInteger(limit) || limit < 1 || limit > most)
        throw new InputError(`parallel is how many agents at once in one area: a number from 1 to ${most}`);
    }
    let cap;
    if (reviewCap !== undefined && reviewCap !== null) {
      cap = Number(reviewCap);
      if (typeof reviewCap === 'boolean' || !Number.isInteger(cap) || cap < 1 || cap > REVIEW_CAP_MAX)
        throw new InputError(
          `reviewCap is how many of the chase’s pull requests may wait for you before it starts nothing new: a number from 1 to ${REVIEW_CAP_MAX}`,
        );
    }
    const connected = await this.connectedRepos();
    if (dryRun) {
      const plan = this.chaseQueue(
        {
          ...row,
          chase: on === false ? row.chase : 'on',
          chase_parallel: limit ?? row.chase_parallel,
          chase_review_cap: cap ?? row.chase_review_cap,
        },
        this.views(),
        connected,
      );
      return {
        dryRun: true,
        chase: this.chaseView(row, plan),
        started: [],
        wouldStart: plan.start.map(label),
        // Whether Chase would start a road captain with it (BRK-275): the owner's choice, else the chase's size.
        captain: captain ?? (row.chase === 'on' ? Boolean(row.chase_captain) : plan.tasks.length > CAPTAIN_OVER),
      };
    }
    this.writable();
    if (dismiss)
      this.sql.exec("UPDATE chase_events SET dismissed = 1 WHERE slug = ? AND kind = 'chase_ended'", row.slug);
    // The chase's digests (BRK-277): clearing them from the inbox, and whether each pushes.
    if (dismissDigests) this.chaseDigestDismiss(row.slug);
    if (digestPush !== undefined && digestPush !== null) this.chaseDigestPush(row.slug, digestPush);
    if (limit !== undefined) this.sql.exec('UPDATE features SET chase_parallel = ? WHERE slug = ?', limit, row.slug);
    if (cap !== undefined) this.sql.exec('UPDATE features SET chase_review_cap = ? WHERE slug = ?', cap, row.slug);
    if (hours !== undefined)
      this.sql.exec('UPDATE features SET chase_captain_hours = ? WHERE slug = ?', hours, row.slug);
    let started = [];
    if (on === true && row.chase !== 'on') {
      const plan = this.chaseQueue(this.featureRow(row.slug), this.views(), connected);
      if (!plan.tasks.length) throw new AgentError(`${row.title} has no tasks to chase: tag some with ${row.slug}`);
      if (plan.tasks.every((x) => x.state === 'done'))
        throw new AgentError(`every task in ${row.title} is done: there’s nothing to chase`);
      const withCaptain = captain ?? plan.tasks.length > CAPTAIN_OVER;
      // Whoever presses Chase is who its agents run for (BRK-334): the owner's routine, or theirs. A person with no
      // routine in any of the chase's repositories, and none lent, could start nothing: refused, not left stalled.
      const starter = this.startsFor({ actor, by });
      if (starter !== OWNER) {
        const startable = await this.personStartable(starter);
        const repos = [...new Set(plan.tasks.map((x) => x.repo))];
        if (!repos.some((r) => startable.has(r))) throw new AgentError(noRoutineWords(repos[0]), 403);
      }
      this.sql.exec(
        "UPDATE features SET chase = 'on', chase_started = ?, chase_stalled = NULL, chase_ended = NULL, chase_captain = ?, chase_captain_asked = NULL, chase_by = ? WHERE slug = ?",
        Date.now(),
        withCaptain ? 1 : 0,
        starter === OWNER ? null : starter,
        row.slug,
      );
      this.sql.exec("UPDATE chase_events SET dismissed = 1 WHERE slug = ? AND kind = 'chase_ended'", row.slug);
      this.chaseEvent(row.slug, 'chase_started', `${row.title}, ${limit ?? row.chase_parallel} at once in an area`);
      // Its peloton opens with it (IDEA-32): the agents it starts check in there.
      this.pelotonLine(row.slug, 'open', `The chase on ${row.title} started. Agents on its tasks check in here.`);
      // Pressing Chase starts what's ready now; the alarm and the cron take it from there.
      started = await this.chaseTick({ only: row.slug });
    } else if (on === false && row.chase === 'on') {
      await this.stopChase(row, connected);
    } else if (
      row.chase === 'on' &&
      captain !== undefined &&
      captain !== null &&
      captain !== Boolean(row.chase_captain)
    ) {
      // Turning the road captain on or off on a running chase: on starts one now, off stands it down.
      this.sql.exec(
        'UPDATE features SET chase_captain = ?, chase_captain_asked = NULL WHERE slug = ?',
        captain ? 1 : 0,
        row.slug,
      );
      if (captain) await this.captainTick(this.featureRow(row.slug));
      else this.captainStandDown(row, 'The owner turned the road captain off: it stands down.');
    } else if ((limit !== undefined || cap !== undefined) && row.chase === 'on') this.scheduleAgentsCheck();
    // A chase that isn't on keeps the owner's choice for the next Chase.
    if (row.chase !== 'on' && on !== true && captain !== undefined && captain !== null)
      this.sql.exec('UPDATE features SET chase_captain = ? WHERE slug = ?', captain ? 1 : 0, row.slug);
    const fresh = this.featureRow(row.slug);
    const plan = this.chaseQueue(fresh, this.views(), connected);
    return { dryRun: false, chase: this.chaseView(fresh, plan), started };
  },

  /**
   * Stops a chase: it starts nothing new, and running agents finish and open their pull requests (section 3.7). `why`,
   * when the board stopped it rather than a press, says so in Activity and on the peloton.
   * @param {any} row
   * @param {Set<string>} connected
   * @param {string | null} [why]
   */
  async stopChase(row, connected, why = null) {
    this.sql.exec("UPDATE features SET chase = 'stopped', chase_ended = ? WHERE slug = ?", Date.now(), row.slug);
    this.chaseEvent(row.slug, 'chase_stopped', why ? `${row.title}: ${why}` : row.title);
    // Its last digest (BRK-277), written before the captain stands down.
    await this.chaseDigestWrite(this.featureRow(row.slug), this.chaseQueue(row, this.views(), connected), {
      kind: 'final',
      ended: why ? `The board stopped the chase: ${why}.` : 'The chase stopped.',
    });
    this.captainStandDown(row, 'The chase stopped: its road captain stands down.');
    this.pelotonLine(
      row.slug,
      'close',
      `The chase on ${row.title} stopped${why ? ` (${why})` : ''}. This peloton takes no new posts and goes in a day.`,
    );
  },

  /**
   * Why the person who started chase `row` may not run it now (BRK-334), or null: off the board, or without a
   * maintainer's role in one of its repositories. The owner's chases always may.
   */
  chaseStarterRefusal(row) {
    if (!row.chase_by) return null;
    if (!this.personRow(row.chase_by)) return `${row.chase_by} isn’t on the board any more`;
    const grants = this.personGrants(row.chase_by);
    for (const repo of this.targetRepos({ feature: row.slug })) {
      const no = refusal({ person: row.chase_by, grants }, 'chase', repo);
      if (no) return `${row.chase_by} started it and can’t chase it now (${no.message})`;
    }
    return null;
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
    // While GitHub is down (BRK-217), nothing starts: agents couldn't push, and checks wouldn't run on a fix. While
    // Claude is down (BRK-315), sessions wouldn't start, or would die mid-work.
    if (this.githubOutage() || this.claudeOutage()) return [];
    const connected = await this.connectedRepos();
    const started = [];
    for (const row of rows) {
      // A chase runs for whoever started it, only while they still may (BRK-334): else the board stops it.
      const lost = row.chase === 'on' ? this.chaseStarterRefusal(row) : null;
      if (lost) {
        await this.stopChase(row, connected, lost);
        continue;
      }
      const on = row.chase === 'on';
      // A person's chase starts where they have a routine of their own, or the owner lends one (BRK-334).
      const plan = this.chaseQueue(
        row,
        this.views(),
        row.chase_by ? await this.personStartable(row.chase_by) : connected,
      );
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
        // A start refused earlier this tick may hold the routine (BRK-144): a person's own, for their chase.
        if (this.routineHold(t.repo) || (row.chase_by && this.routineHold(t.repo, row.chase_by))) continue;
        try {
          if (t.fix) await this.chaseFix(row, t);
          else await this.startAgent(t.uuid, { trigger: 'chase', forPerson: chaseFor(row) });
          started.push(label(t));
          startedHere += 1;
        } catch {
          // It stays in the queue; a failed fire counts toward Stuck, and the next tick tries again.
        }
      }
      if (on) {
        await this.captainTick(this.featureRow(row.slug));
        await this.chaseSettle(this.featureRow(row.slug), startedHere ? null : plan);
        // The hourly digest (BRK-277), for a chase still on: one that ended wrote its last in chaseSettle.
        await this.chaseDigestTick(this.featureRow(row.slug), connected);
      }
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
        forPerson: chaseFor(row),
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
      await this.chaseDigestWrite(this.featureRow(row.slug), plan, { kind: 'final', ended: detail });
      this.captainStandDown(row, 'The chase ended: its road captain stands down.');
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
   * The road captain's task for the chase on feature `slug` (BRK-137, BRK-275): its repository is the one most of
   * the feature's own tasks are in, and its brief is the board's: what a captain does, then the chase as it stands
   * (the live line, the open pull requests and what's wrong with each, what's Stuck or needs the owner, and the
   * plan). The owner's `note`, if any, goes in each captain's payload, not here.
   */
  roadCaptain(slug, views, connected) {
    const row = this.featureRow(slug);
    if (row.chase === 'off')
      throw new AgentError(`${row.title} has no chase yet: press Chase first, then start its road captain`, 409);
    const set = this.chaseMembers(row, views).filter(({ t }) => !t.tags.includes('captain'));
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
    const kept = this.planOf({ kind: 'chase', name: `chase:${row.slug}` });
    const brief = [
      `You're the road captain of the chase on ${row.title} (+${row.slug}), in ${repo}: the board started you with the chase, and starts a fresh captain after each watch of ${Number(row.chase_captain_hours ?? CAPTAIN_HOURS)} hours. "Captaining a chase" in the core says what you do: keep the plan, line the agents up, answer the peloton, look over risky pull requests, turn the owner's feedback into tasks, and hand over with a log.`,
      '',
      `\`npx breakaway chase ${row.slug} --dry-run\` shows the chase as it is when you read it, \`npx breakaway github\` the pull requests' checks, and \`npx breakaway captain ${row.slug}\` the captain's log.`,
      '',
      `## The chase when the board made this task`,
      '',
      `${this.chaseLine(plan.line)} (state ${row.chase}).`,
      ...(pulls.length ? ['', 'Its open pull requests:', ...pulls] : []),
      ...(held.length ? ['', 'What holds the rest:', ...held] : []),
      '',
      kept ? `## The chase’s plan (version ${kept.version})` : '## The chase’s plan',
      '',
      kept ? kept.text : 'It has no plan yet: write one first, so the agents it starts line up.',
      '',
      'While you run, you keep the plan and run the room: only you and the owner revise the plan (the other agents propose changes on the peloton), and you call and close huddles.',
    ].join('\n');
    return { slug: row.slug, feature: row.title, repo, brief, title: `Road captain for ${row.title}`.slice(0, 200) };
  },

  /** The chase's open road captain task (BRK-275), as its view, or null. */
  captainTask(slug) {
    return (
      this.views((t) => t.status === 'pending' && t.tags.includes('captain') && t.tags.includes(slug))
        .filter((t) => !t.tags.includes('general'))
        .sort((a, b) => a.uuid.localeCompare(b.uuid))[0] ?? null
    );
  },

  /** The latest run on the captain's task, or null. */
  captainRun(uuid) {
    return (
      this.sql
        .exec("SELECT * FROM agent_runs WHERE task = ? AND kind = 'captain' ORDER BY id DESC LIMIT 1", uuid)
        .toArray()[0] ?? null
    );
  },

  /** The chase's road captain as the feature's page shows it: the setting, who holds the role and since when, and the log. */
  captainView(row) {
    const on = Boolean(row.chase_captain);
    const hours = Number(row.chase_captain_hours ?? CAPTAIN_HOURS);
    const t = row.chase === 'off' ? null : this.captainTask(row.slug);
    const run = t ? this.captainRun(t.uuid) : null;
    const holding = Boolean(t?.claim && run && run.agent === t.claim && run.status !== 'failed');
    const log = this.sql
      .exec('SELECT * FROM captain_logs WHERE slug = ? ORDER BY id DESC LIMIT 20', row.slug)
      .toArray()
      .map((r) => ({ id: r.id, at: iso(r.at), agent: r.agent, text: r.text, handover: Boolean(r.handover) }));
    return {
      on,
      hours,
      task: t ? { uuid: t.uuid, short: t.short } : null,
      agent: holding ? t.claim : null,
      since: holding ? iso(run.started) : null,
      watchEndsAt: holding ? iso(Number(run.started) + hours * 3_600_000) : null,
      askedAt: holding ? iso(row.chase_captain_asked) : null,
      log,
    };
  },

  /**
   * Starts the chase's road captain (BRK-275): turns its setting on, makes its task the first time, and starts a fresh
   * captain on it, force started. The owner's Start a road captain and the tick both come here; `note` is the
   * owner's, for this captain's payload. Refused while a captain holds the task.
   */
  async startCaptain(slug, { note = null } = {}) {
    await this.ready();
    const row = this.featureRow(slug);
    if (row.chase !== 'on')
      throw new AgentError(
        row.chase === 'off'
          ? `${row.title} has no chase yet: press Chase first, then start its road captain`
          : `the chase on ${row.title} isn’t running: chase it again to start its road captain`,
        409,
      );
    this.writable();
    const open = this.captainTask(row.slug);
    if (open?.claim)
      throw new AgentError(`${open.claim} is the road captain of ${row.title}: message it on its task instead`, 409);
    if (!row.chase_captain) this.sql.exec('UPDATE features SET chase_captain = 1 WHERE slug = ?', row.slug);
    let uuid = open?.uuid;
    if (!uuid) {
      const made = this.roadCaptain(row.slug, this.views(), await this.connectedRepos());
      const res = await this.create([
        {
          description: made.title,
          horizon: 'now',
          who: 'agent',
          tags: ['captain', row.slug],
          brief: made.brief,
          ...(made.repo === this.defaultRepoSlug() ? {} : { repo: made.repo }),
          by: 'board',
        },
      ]);
      if (res.status !== 201)
        throw new AgentError(res.body.error ?? 'couldn’t make the road captain’s task', res.status);
      uuid = res.body.tasks[0].uuid;
    }
    this.sql.exec('UPDATE features SET chase_captain_asked = NULL WHERE slug = ?', row.slug);
    // Activity shows the start as the agent run it is (trigger road-captain).
    // The captain runs for whoever started the chase (BRK-334), on their routine and within their caps.
    return await this.startAgent(uuid, {
      trigger: 'road-captain',
      kind: 'captain',
      note,
      force: true,
      forPerson: chaseFor(row),
    });
  },

  /**
   * The road captain on the tick, for a chase that's on: starts one when the chase should have one and none holds its
   * task (at most once every CAPTAIN_RETRY_MS); when one has run its watch, asks it once on the peloton to write its
   * log and hand over, and after CAPTAIN_GRACE_MS hands over for it.
   */
  async captainTick(row) {
    if (row.chase !== 'on' || !row.chase_captain) return;
    const t = this.captainTask(row.slug);
    const run = t ? this.captainRun(t.uuid) : null;
    const now = Date.now();
    if (!t?.claim) {
      if (run && now - Number(run.started) < CAPTAIN_RETRY_MS) return;
      try {
        await this.startCaptain(row.slug);
      } catch {
        // Its run says why; the next tick past CAPTAIN_RETRY_MS tries again.
      }
      return;
    }
    if (!run || run.agent !== t.claim) return;
    const hours = Number(row.chase_captain_hours ?? CAPTAIN_HOURS);
    if (now - Number(run.started) < hours * 3_600_000) return;
    if (!row.chase_captain_asked) {
      this.sql.exec('UPDATE features SET chase_captain_asked = ? WHERE slug = ?', now, row.slug);
      this.addPost(`chase:${row.slug}`, {
        agent: 'board',
        kind: 'note',
        text: `@${t.claim} your ${hours}-hour watch as road captain is over: write your log and the plan, then hand over (npx breakaway captain ${row.slug} log --file <path> --handover). In ${CAPTAIN_GRACE_MS / 60_000} minutes the board hands over for you.`,
        mentions: [t.claim],
      });
      return;
    }
    if (now - Number(row.chase_captain_asked) < CAPTAIN_GRACE_MS) return;
    this.captainLogEntry(
      row.slug,
      'board',
      `${t.claim} didn’t hand over within ${CAPTAIN_GRACE_MS / 60_000} minutes of the end of its watch, so the board did. Read the peloton and the plan for where it got to.`,
      true,
    );
    await this.captainHandOver(row, t, 'board');
  },

  /** Takes the captain's task back from `t.claim` and starts the next captain on it. */
  async captainHandOver(row, t, by) {
    const from = t.claim;
    this.change(
      t.uuid,
      {
        claim: null,
        start: false,
        annotate: by === 'board' ? `The board handed over from ${from}.` : `${from} handed over.`,
        by: 'board',
      },
      new Date(),
      'agents',
    );
    this.chaseEvent(row.slug, 'captain_handover', by === 'board' ? `the board, for ${from}` : from);
    try {
      return await this.startCaptain(row.slug);
    } catch (error) {
      if (!(error instanceof AgentError)) throw error;
      // The next tick tries again.
      return { task: this.detail(t.uuid), run: null, waiting: error.message };
    }
  },

  captainLogEntry(slug, agent, text, handover) {
    const row = this.sql
      .exec(
        'INSERT INTO captain_logs (slug, at, agent, text, handover) VALUES (?, ?, ?, ?, ?) RETURNING *',
        slug,
        Date.now(),
        agent,
        text,
        handover ? 1 : 0,
      )
      .one();
    this.sql.exec(
      'DELETE FROM captain_logs WHERE slug = ? AND id NOT IN (SELECT id FROM captain_logs WHERE slug = ? ORDER BY id DESC LIMIT ?)',
      slug,
      slug,
      CAPTAIN_LOGS_KEPT,
    );
    return { id: row.id, at: iso(row.at), agent: row.agent, text: row.text, handover: Boolean(row.handover) };
  },

  /**
   * POST /api/features/<slug>/captain (BRK-275): the road captain writes its log, and with `handover` hands over:
   * the board takes its task back and starts the next captain, which reads the log first. Only the agent holding the
   * chase's captain task may.
   */
  async captainLog(slug, { log, digest, handover = false, by } = {}) {
    await this.ready();
    const row = this.featureRow(slug);
    const t = row.chase === 'on' ? this.captainTask(row.slug) : null;
    if (!t?.claim || String(by ?? '') !== t.claim)
      throw new AgentError(
        t?.claim
          ? `only the road captain writes its log, and that’s ${t.claim}`
          : `the chase on ${row.title} has no road captain running`,
        403,
      );
    if (typeof handover !== 'boolean') throw new InputError('handover is true or false');
    // The captain's lines for the owner's next digest (BRK-277), instead of its log.
    if (digest !== undefined && digest !== null) {
      if (log !== undefined && log !== null) throw new InputError('send the log or the digest’s lines, one at a time');
      this.writable();
      return { digest: this.captainDigestNote(row, t, digest) };
    }
    const text = String(log ?? '').trim();
    if (!text) throw new InputError('write the log: where the chase stands, what you decided, and what comes next');
    if (text.length > CAPTAIN_LOG_MAX)
      throw new InputError(`a captain’s log is up to ${CAPTAIN_LOG_MAX} characters, and this is ${text.length}`);
    if (looksLikeSecret(text)) throw new InputError('that looks like a token or key: a captain’s log never holds one');
    this.writable();
    const entry = this.captainLogEntry(row.slug, t.claim, text, handover);
    if (!handover) return { log: entry, successor: null };
    const next = await this.captainHandOver(row, t, t.claim);
    return {
      log: entry,
      successor: next.run ? { agent: next.run.agent, task: next.task.uuid } : null,
      waiting: next.waiting ?? null,
    };
  },

  /** When the chase stops or ends, or the owner turns its captain off: the board finishes the captain's task. */
  captainStandDown(row, why) {
    const t = this.captainTask(row.slug);
    if (!t) return;
    this.change(t.uuid, { status: 'completed', claim: null, annotate: why, by: 'board' }, new Date(), 'agents');
  },

  /** For a captain task's view `t`: its chase's slug, and which captain the next start is (1 for the first). */
  captainOfTask(t) {
    const slugs = new Set(this.featureRows().map((r) => r.slug));
    const slug = t.tags.filter((tag) => slugs.has(tag)).sort()[0];
    if (!slug) throw new AgentError('a road captain’s task carries its feature’s tag', 400);
    const names = this.sql
      .exec(
        "SELECT agent FROM agent_runs WHERE kind = 'captain' AND status != 'failed' AND agent LIKE ?",
        `claude-captain-${slug}-%`,
      )
      .toArray()
      .map((r) => Number(r.agent.slice(`claude-captain-${slug}-`.length)))
      .filter(Number.isInteger);
    return { slug, n: Math.max(0, ...names) + 1 };
  },

  /** The latest log entry for the chase, for the next captain's payload. */
  captainLastLog(slug) {
    const r = this.sql.exec('SELECT * FROM captain_logs WHERE slug = ? ORDER BY id DESC LIMIT 1', slug).toArray()[0];
    return r ? { agent: r.agent, at: iso(r.at), text: r.text } : null;
  },

  /** The stall ping (section 3.6): a `blocked` ping on the task that frees the most, as the board, which pushes. */
  async chasePing(row, item) {
    const what = {
      decision: 'waits on your decision',
      person: 'is a step for you',
      nobody: 'has nobody to do it: do it, or say an agent does',
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
    this.sql.exec('UPDATE features SET chase_stalled = ? WHERE slug = ?', Date.now(), row.slug);
    this.chaseEvent(row.slug, 'chase_stalled', message);
    await this.boardPing(item.uuid, 'blocked', message);
  },
};
