/**
 * TaskStore's cloud agents (docs/specs/CLD-35-cloud-agents.md): start a Claude Code cloud session
 * on a task through a routine's /fire endpoint, pick the next few tasks that won't collide, start
 * tasks by themselves when they become ready, keep to the limits, and hold each session's live
 * output for the board to show (for watching only: capped, pruned, never in a version).
 */
import { secret } from './secrets.js';
import { shortHash } from './session-report.js';
import { refinePrompt } from './decision.js';
import { isKickoffIdea } from './kickoff.js';
import { FAILED_CHECK, prVerdict } from './github.js';
import { holdsTask, runState } from './run-state.js';
import { AREA_NAMES, dependsOf, rank, relatedOf, tagsOf } from './model.js';
import { nextChoices, nextVersionPrompt, NEXT_STEPS, versionBase } from './next-version.js';
import { repoSlugOf, routineCaps } from './repos.js';
import { specPrompt } from './spec-prompt.js';
import { REFINE_FEATURE_TITLE, featurePrompt } from './feature-prompt.js';
import { normalPath } from './specs.js';
import { CLAUDE_LIMITS, DEFAULT_PLAN, hourlyCeiling, isPlan, planChoices, planLimits, planOf, PLANS } from './plans.js';

const RUNNING_HOURS = 12; // after this, a claimed task no longer counts as a running agent
const LIVE_MS = 120_000; // output within the last 2 minutes: the session is live
const STARTING_MS = 600_000; // a session the board started and that hasn't said anything yet is still starting for 10 minutes
const SILENT_MS = 30 * 60_000; // nothing from a started session for 30 minutes: it's Silent, and the owner hears once (BRK-145)
const FIX_TRIES = 2; // fix agents on one pull request that didn't get it green before a third is Needs you (BRK-145)
/** The problems Fix with an agent mends, in the words a ping uses. */
const FIX_WORDS = {
  conflicts: 'conflicts with its base branch',
  failing: 'has failing checks',
  review: 'has review comments to answer',
};
const LOG_KEEP = 1000; // entries per task
const LOG_DAYS = 14;
const KINDS = new Set(['tool', 'message', 'start', 'prompt']);
/** "high" means high and critical; "all" includes low. */
const SEVERITY = { off: 0, critical: 4, high: 3, medium: 2, moderate: 2, low: 1, all: 1 };
/** An agent's verdict on a pull request (BRK-111), and how the board says it. */
export const REVIEW_VERDICTS = {
  ready: 'Looks ready',
  'follow-up': 'Ready with a follow-up',
  changes: 'Needs changes',
};
const REVIEW_NOTE_MAX = 10_000;

/** A work ID's number for sorting, tasks without one last. */
const widNumber = (wid) => (wid ? Number(String(wid).split('-')[1]) : Number.MAX_SAFE_INTEGER);

export class AgentError extends Error {
  /**
   * `forceable`: only the board's own limits refuse the start, so Force start (the owner's) could skip it.
   * `path`: the button that fits instead, for a pull request an agent can't review as it stands (`update` or `fix`).
   * `hold`: how Claude's refusal holds the routine's next starts (BRK-144): `paused` (401, 403, 404), `limit` (429,
   * until `until`), or `backoff` (anything else Claude or the network answered, for a few minutes).
   */
  constructor(message, status = 409, { forceable = false, path = null, hold = null, until = null } = {}) {
    super(message);
    this.status = status;
    this.forceable = forceable;
    this.path = path;
    this.hold = hold;
    this.until = until;
  }
}

/** A secret's value, or null while it's missing or `unset`. */
async function readSecret(env, name) {
  try {
    const value = (await secret(env, name)).trim();
    return value && value !== 'unset' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Every other repository's routine (IDEA-14 section 4): one Secrets Store secret, `TASKS_ROUTINES`, holding
 * JSON keyed by slug, `{ "<slug>": { "url": "…", "token": "…" } }`, written by `agents-connect --repo`.
 * Adding a repository needs no new binding. A malformed value or entry reads as not connected.
 */
export async function otherRoutines(env) {
  const raw = await readSecret(env, 'TASKS_ROUTINES');
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const routines = {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return routines;
  for (const [slug, entry] of Object.entries(parsed)) {
    if (typeof entry?.url === 'string' && typeof entry?.token === 'string' && entry.url.trim() && entry.token.trim()) {
      routines[slug] = { url: entry.url.trim(), token: entry.token.trim() };
    }
  }
  return routines;
}

/**
 * A routine's /fire URL and token, or null while they're `unset`. Without `slug`, the default repository's:
 * its two secrets are the ones the board always had. Any other repository's comes from `TASKS_ROUTINES`.
 */
export async function routineCredentials(env, slug = null) {
  if (slug) return (await otherRoutines(env))[slug] ?? null;
  const [url, token] = await Promise.all([
    readSecret(env, 'TASKS_ROUTINE_URL'),
    readSecret(env, 'TASKS_ROUTINE_TOKEN'),
  ]);
  return url && token ? { url, token } : null;
}

/** The command that connects a repository's routine: plain for the default, `--repo` for the others. */
export const connectCommand = (slug = null) => `npx breakaway agents-connect${slug ? ` --repo ${slug}` : ''}`;

/**
 * Starts one session of the routine. Returns { id, url }; throws AgentError on failure. `slug` is the
 * repository when it isn't the default, so a refused token says which routine to connect again.
 */
export async function fireRoutine({ url, token }, text, slug = null) {
  const routine = `the ${slug ? `${slug} ` : ''}routine`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });
  } catch {
    throw new AgentError('couldn’t reach Claude to start the session; try again', 502, { hold: 'backoff' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message ?? res.statusText;
    if (res.status === 429) {
      const until = retryAt(res.headers.get('Retry-After'));
      throw new AgentError(
        `Claude’s hourly limit for starting sessions is reached (try again after ${Math.round((until - Date.now()) / 1000)} seconds, at ${clock(until)})`,
        429,
        { hold: 'limit', until },
      );
    }
    if (res.status === 401)
      throw new AgentError(`${routine}’s token was refused: connect the routine again (${connectCommand(slug)})`, 502, {
        hold: 'paused',
      });
    if (res.status === 403)
      throw new AgentError(
        `${routine}’s token has no access to it: make a new token on the routine and connect it again (${connectCommand(slug)})`,
        502,
        { hold: 'paused' },
      );
    if (res.status === 404)
      throw new AgentError(
        `${routine} is gone on claude.ai: make it again, or copy its API trigger’s URL, and connect it again (${connectCommand(slug)})`,
        502,
        { hold: 'paused' },
      );
    if (res.status === 400 && /paused/iu.test(message))
      throw new AgentError(`${routine} is paused on claude.ai`, 409, { hold: 'backoff' });
    throw new AgentError(`Claude couldn’t start the session (${res.status}: ${message})`, 502, { hold: 'backoff' });
  }
  if (!data.claude_code_session_url) throw new AgentError('Claude started something but sent no session link', 502);
  return { id: data.claude_code_session_id ?? null, url: data.claude_code_session_url };
}

/** How long auto-start and chase wait after a 429 without a Retry-After, and after any other refused start. */
const LIMIT_WAIT_MS = 15 * 60_000;
export const BACKOFF_MS = 10 * 60_000;

/** When a 429's `Retry-After` (seconds, or an HTTP date) says to try again; 15 minutes when it says nothing usable. */
export function retryAt(header, now = Date.now()) {
  const text = String(header ?? '').trim();
  if (/^\d+$/u.test(text)) return now + Number(text) * 1000;
  const date = text ? Date.parse(text) : Number.NaN;
  return Number.isFinite(date) && date > now ? date : now + LIMIT_WAIT_MS;
}

/** A time as the board says it in a message: `14:05 UTC`. */
const clock = (ms) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

/** The tag on a routine maker's task (docs/specs/BRK-220-routines-with-an-agent.md, section 2). */
export const ROUTINE_MAKER_TAG = 'routine-maker';

/**
 * Whether a task (a view or a stored map) is a routine maker's: a general agent's task the owner started with
 * Make with an agent. Its agent starts in `Mode: routines`, and holding it is what lets the agent write routines.
 */
export function isRoutineMaker(task) {
  if (!task) return false;
  const tags = Array.isArray(task.tags) ? task.tags : [];
  const general = tags.includes('general') || Boolean(task.tag_general);
  return general && (tags.includes(ROUTINE_MAKER_TAG) || Boolean(task[`tag_${ROUTINE_MAKER_TAG}`]));
}

const TRIGGER_TEXT = {
  alert: 'for a GitHub security alert, from the board',
  manual: 'by hand, from the board',
  review: 'by “Safe to merge?” on a Dependabot pull request, from the board',
  'pr-review': 'by “Review with an agent” on a pull request, from the board',
  next: 'as one of the next few ready tasks, from the board',
  auto: 'by itself, because the task became ready and is marked Start when ready',
  pr: 'to fix a pull request, from the board',
  routine: 'by a routine, from the board',
  schedule: 'by a routine’s schedule, from the board',
  github: 'by a routine’s GitHub event, from the board',
  webhook: 'by a routine’s webhook or API trigger, from the board',
  cloudflare: 'by a Cloudflare alert, from the board',
  general: 'by a prompt from the owner, from the board',
  chase: 'by the owner’s chase of a feature, because the task became ready',
  'chase-fix': 'by the owner’s chase of a feature, to fix a pull request its agent left',
  'road-captain': 'by the owner, as the road captain of a chase',
  kickoff: 'by “Send answers and carry on” on a kickoff’s decision, from the board',
  routines: 'by “Make with an agent” on the Routines view, from the board',
  'routines-carry-on': 'by “Send answers and carry on” on a routine maker’s decision, from the board',
  move: 'by “Move to breakaway’s deploy flow” on the GitHub page, from the board',
};

/**
 * What the routine gets: the work ID it acts on, and context it may read. `repo` is the task's registered
 * repository: the agent checks its checkout is that one before it claims (IDEA-14 section 4).
 */
export function firePayload(
  task,
  agent,
  trigger,
  note,
  kind = 'build',
  pr = null,
  routine = null,
  attachments = 0,
  repo = null,
  plan = null,
) {
  return [
    `Task: ${task.wid ?? task.uuid}`,
    `Title: ${task.description}`,
    `Agent name: ${agent}`,
    `Started: ${TRIGGER_TEXT[trigger] ?? trigger}`,
    // After the lines the routine has always had, so a prompt that predates it reads the payload as before.
    ...(repo ? [`Repository: ${repo.slug} (${repo.github})`] : []),
    // A payload without a Mode line is a build, so the routine keeps working until its prompt knows refining.
    ...(kind === 'refine' ? ['Mode: refine'] : []),
    ...(kind === 'review' ? ['Mode: review', `Pull request: #${task.pr}`] : []),
    ...(kind === 'fix-pr' ? ['Mode: fix-pr', `Pull request: #${pr}`] : []),
    ...(kind === 'pr-review' ? ['Mode: pr-review', `Pull request: #${pr}`] : []),
    ...(kind === 'routine' ? ['Mode: routine', `Routine: ${routine}`] : []),
    ...(kind === 'general' ? ['Mode: general'] : []),
    ...(kind === 'kickoff' ? ['Mode: kickoff'] : []),
    ...(kind === 'routines' ? ['Mode: routines'] : []),
    // Only a count: the images stay on the board, and the agent fetches them by task ID.
    ...(attachments > 0 ? [`Attachments: ${attachments}`] : []),
    ...(note
      ? [
          '',
          kind === 'refine' ? 'Refinement request:' : kind === 'fix-pr' ? 'What is wrong:' : 'Note from the owner:',
          String(note).slice(0, 4000),
        ]
      : []),
    // The chase's plan (IDEA-36 section 5), for an agent the chase starts: it starts lined up with the rest.
    ...(plan ? ['', `The chase’s plan (${plan.peloton}, version ${plan.version}):`, plan.text] : []),
  ].join('\n');
}

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const agentsMethods = {
  initAgents() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, agent TEXT NOT NULL, trigger TEXT NOT NULL,
        status TEXT NOT NULL, session_id TEXT, url TEXT, note TEXT, error TEXT, started INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_logs_task ON agent_logs (task, id);
    `);
    // Runs made before refining have no kind: they're builds.
    const columns = this.sql
      .exec('PRAGMA table_info(agent_runs)')
      .toArray()
      .map((c) => c.name);
    if (!columns.includes('kind'))
      this.sql.exec("ALTER TABLE agent_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'build'");
    // The repository a run started in (IDEA-14 section 4). Runs from before have none: the default repository's.
    if (!columns.includes('repo')) this.sql.exec('ALTER TABLE agent_runs ADD COLUMN repo TEXT');
    // Started with Force start (BRK-105). Runs from before weren't.
    if (!columns.includes('forced'))
      this.sql.exec('ALTER TABLE agent_runs ADD COLUMN forced INTEGER NOT NULL DEFAULT 0');
    // Silent (BRK-145): since when a running session has said nothing, and the one ping the run sent about it.
    if (!columns.includes('silent')) this.sql.exec('ALTER TABLE agent_runs ADD COLUMN silent INTEGER');
    if (!columns.includes('silent_ping')) this.sql.exec('ALTER TABLE agent_runs ADD COLUMN silent_ping INTEGER');
    // How Claude's refusal held the routine after this run failed, and until when (WEB-41): Retrying or Paused.
    if (!columns.includes('hold')) this.sql.exec('ALTER TABLE agent_runs ADD COLUMN hold TEXT');
    if (!columns.includes('hold_until')) this.sql.exec('ALTER TABLE agent_runs ADD COLUMN hold_until INTEGER');
    // Fix agents started on each pull request since it was last green, and when a third became Needs you (BRK-145).
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pr_fixes (
        repo TEXT NOT NULL, number INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, needs_you INTEGER,
        PRIMARY KEY (repo, number)
      );
    `);
    // An agent's review of a pull request (BRK-111): the latest one shows on its page; each is a task comment too.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, number INTEGER NOT NULL, task TEXT NOT NULL,
        verdict TEXT NOT NULL, note TEXT NOT NULL, agent TEXT NOT NULL, sha TEXT, at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_reviews_pr ON agent_reviews (repo, number, id);
    `);
  },

  // ---- routines per repository ----------------------------------------------------------------

  /**
   * The routine that starts agents in repository `slug`, or null while it isn't connected: the Secrets Store's, else
   * the one kept on the board (BRK-133). A kept one that can't be opened comes back as `{ broken: true }`.
   */
  routineFor(slug) {
    return this.repoRoutine(slug);
  },

  /** The registered repositories whose routine is connected (a kept one that can't be opened isn't). */
  async connectedRepos() {
    const fallback = this.defaultRepoSlug();
    const [own, others] = await Promise.all([routineCredentials(this.env), otherRoutines(this.env)]);
    const kept = new Set(
      this.sql
        .exec('SELECT slug FROM kept_routines')
        .toArray()
        .map((r) => r.slug),
    );
    const connected = new Set();
    for (const repo of this.repos()) {
      if (repo.slug === fallback ? own : others[repo.slug]) connected.add(repo.slug);
      else if (kept.has(repo.slug)) {
        const routine = await this.keptRoutine(repo.slug);
        if (routine && !('broken' in routine)) connected.add(repo.slug);
      }
    }
    for (const slug of connected) await this.dropStaleHold(slug);
    return connected;
  },

  /**
   * What holds repository `slug`'s routine after Claude refused a start (BRK-144), or null: `paused` after a 401,
   * 403, or 404, until the routine is connected again (its URL or token changes), a start through it works, or a
   * session it started verifies it; `limit` after a 429, until its Retry-After; `backoff` after any other failure,
   * for a few minutes. Auto-start and chase start nothing there while it holds; Claude's limit holds every start.
   */
  routineHold(slug) {
    const hold = JSON.parse(this.meta(`routine_hold:${slug}`) ?? 'null');
    if (!hold) return null;
    if (hold.kind !== 'paused') return hold.until > Date.now() ? hold : null;
    const verified = JSON.parse(this.meta(`routine_verified:${slug}`) ?? 'null');
    return verified && verified.at > hold.at ? null : hold;
  },

  /** Why auto-start and chase wait on repository `slug`'s routine, from its hold. */
  holdReason(slug, hold) {
    if (hold.kind === 'paused')
      return `${slug}’s agent routine is paused because Claude refused it (${hold.error}); auto-start and chase start nothing there until it’s connected again`;
    if (hold.kind === 'limit')
      return `Claude’s limit for starting sessions: starts in ${slug} wait until ${clock(hold.until)}`;
    return `the last start in ${slug} failed (${hold.error}); auto-start and chase try again at ${clock(hold.until)}`;
  },

  /** Holds repository `slug`'s routine after `error`, a refused start, against the credentials it was fired with. */
  async holdRoutine(slug, error, credentials) {
    this.setMeta(
      `routine_hold:${slug}`,
      JSON.stringify({
        kind: error.hold,
        status: error.status,
        error: error.message,
        at: Date.now(),
        until: error.hold === 'limit' ? error.until : error.hold === 'backoff' ? Date.now() + BACKOFF_MS : null,
        routine: await shortHash(`${credentials.url}\n${credentials.token}`),
      }),
    );
  },

  /** Lets repository `slug`'s routine go once it's connected again: the hold was for other credentials. */
  async dropStaleHold(slug) {
    const key = `routine_hold:${slug}`;
    const hold = JSON.parse(this.meta(key) ?? 'null');
    if (!hold) return;
    const credentials = await this.repoRoutine(slug);
    if (
      !credentials ||
      'broken' in credentials ||
      hold.routine !== (await shortHash(`${credentials.url}\n${credentials.token}`))
    )
      this.setMeta(key, null);
  },

  /**
   * Why repository `slug` can't take another agent under its own caps right now, or null. Global limits are
   * checked apart. Claude's limit for one routine (30 starts an hour) is every repository's cap, since each
   * starts through its own routine, so a board-wide budget above 30 never runs one routine into it.
   * `force` (the owner's Force start) skips the repository's own caps, never Claude's limit.
   */
  repoCapBlocker(slug, running, { force = false } = {}) {
    const caps = routineCaps(this.repoBySlug(slug));
    const here = running.filter(({ task }) => task.repo === slug).length;
    if (!force && caps.max && here >= caps.max)
      return `${here} ${here === 1 ? 'agent is' : 'agents are'} already running in ${slug} (its cap is ${caps.max})`;
    const started = this.startsThisHour(slug);
    if (!force && caps.hourly && started >= caps.hourly)
      return `${caps.hourly} agents were started in ${slug} in the last hour, its cap`;
    if (started >= CLAUDE_LIMITS.routineHourly)
      return `${started} agents were started in ${slug} in the last hour, Claude’s limit for its routine`;
    return null;
  },

  /** How many more agents repository `slug` may start now under its own caps and its routine's hourly limit. */
  repoRoom(slug, running) {
    const caps = routineCaps(this.repoBySlug(slug));
    const here = running.filter(({ task }) => task.repo === slug).length;
    const hourly = Math.min(caps.hourly ?? Infinity, CLAUDE_LIMITS.routineHourly);
    return Math.max(0, Math.min(caps.max ? caps.max - here : Infinity, hourly - this.startsThisHour(slug)));
  },

  /**
   * The routine of repository `slug`, or an AgentError when it can't start an agent: not connected, or a prompt
   * with a <…> left in it (CLD-196), which waits whatever started the agent; auto-start tries again next tick.
   */
  async checkRoutineReady(slug) {
    const credentials = await this.routineFor(slug);
    if (credentials && 'broken' in credentials)
      throw new AgentError(
        `${slug}’s agent routine, connected from the board, can’t be read any more (the sync key changed): connect it again from the board, or run ${connectCommand(slug === this.defaultRepoSlug() ? null : slug)}`,
      );
    if (!credentials) {
      throw new AgentError(
        slug === this.defaultRepoSlug()
          ? 'the agent routine isn’t connected yet (docs/tasks.md#cloud-agents-from-the-board)'
          : `${slug}’s agent routine isn’t connected yet: run ${connectCommand(slug)} (docs/tasks.md#cloud-agents-from-the-board)`,
      );
    }
    const unfilled = await this.promptBlocker(slug);
    if (unfilled) throw new AgentError(unfilled, 409);
    return credentials;
  },

  /**
   * A general agent (docs/specs/IDEA-30-new-agent.md): the owner's prompt becomes a task in repository `repo`
   * with no area, and so no work ID until its agent picks one, and an agent starts on it. With no room it
   * waits at the front of the auto-start queue, whatever the auto-start switch says. Refuses before making the
   * task when the repository's routine can't start anything.
   *
   * With `decision` (section 8, Refine from the answers), the board writes the prompt from that answered decision,
   * with the owner's `note` under it, in the decision's repository, and relates the task to the decision. While one
   * from that decision is open, it returns that one with `already` instead of starting another. With `next` (minor
   * or major, BRK-100), the board writes the prompt that sets repository `repo`'s package.json to the next minor or
   * major after the version its pre-releases work toward (refused when `version`, what the owner saw, isn't that
   * any more), and tags the task +version; while one is open in that repository it returns that one instead. With
   * `spec` (a path in repository `repo`'s specs directory, IDEA-31 section 4), the board reads the spec from GitHub
   * and writes the prompt from it, the tasks that link it, and the owner's `note` (what should change, required),
   * and sets the task's `spec` to the path; while one on that spec is open it returns that one instead. With
   * `dryRun` it makes nothing and returns the prompt it would write (without the note), the open one if any, and
   * why the repository's routine can't start one, for the web's dialog to show first.
   *
   * With `chase` (a feature's slug, BRK-137), the agent is that chase's road captain: the owner's prompt, with the
   * chase as it stands now under it, in the chase's repository, tagged with the feature so it rides the chase's
   * peloton. A road captain is always force started: the owner pressed for it while the chase holds the slots.
   *
   * With `feature` (a feature's slug, BRK-150), the board writes the prompt from the feature and its tasks, with the
   * owner's `note` (what to refine, required) under it, in the repository most of its tasks are in (or `repo` when it
   * has none), and tags the task with the feature; while one refining it is open it returns that one instead.
   *
   * With `maker` (BRK-220 section 2, Make with an agent on the Routines view), the agent is a routine maker: the
   * owner's prompt says what the routines should do, the task is tagged +routine-maker, and its agent starts in
   * `Mode: routines`, which lets it write routines in that repository while it holds the task (store-routines.js).
   */
  async startGeneral({
    prompt,
    repo = null,
    force = false,
    decision = null,
    next = null,
    version = null,
    spec = null,
    note = null,
    dryRun = false,
    chase = null,
    feature = null,
    maker = false,
  } = {}) {
    await this.ready();
    let text = String(prompt ?? '').trim();
    let title = null;
    let from = null;
    let tags = ['agent', 'general'];
    let specPath = null;
    const given = (value) => value !== null && value !== undefined && value !== '';
    if (maker && [decision, next, spec, chase, feature].some(given))
      throw new AgentError('a routine maker starts from the owner’s prompt only', 400);
    if (maker) tags = ['agent', 'general', ROUTINE_MAKER_TAG];
    if ([decision, next, spec, chase, feature].filter(given).length > 1)
      throw new AgentError(
        'start one from a decision, from a spec, from a feature, for the next version, or for a chase: only one of them',
        400,
      );
    if (given(chase)) {
      if (dryRun) throw new AgentError('a road captain has no dry run: write what it should do', 400);
      if (!text) throw new AgentError('write what the road captain should do first', 400);
      const captain = this.roadCaptain(String(chase), text, this.views(), await this.connectedRepos());
      if (repo && String(repo).trim().toLowerCase() !== captain.repo)
        throw new AgentError(`the chase on ${captain.feature} runs in ${captain.repo}: its road captain does too`, 400);
      repo = captain.repo;
      text = captain.brief;
      title = captain.title;
      tags = ['agent', 'general', captain.slug];
      force = true;
    }
    /** @type {{ repo: string, open: [string, any] | undefined, write: (note: string | null) => { title: string, brief: string }, extra?: Record<string, any> } | null} */
    let source = null;
    if (given(decision)) {
      if (text) throw new AgentError('the board writes the prompt from the decision: send a note instead', 400);
      from = this.resolve(decision);
      const d = this.detail(from);
      const ref = d.wid ?? d.short;
      if (!d.decision) throw new AgentError(`${ref} has no decision`, 400);
      if (d.status !== 'completed' || !d.decisionAnswers)
        throw new AgentError(`${ref}’s decision isn’t answered yet: the owner answers it on the board first`, 409);
      if (repo && String(repo).trim().toLowerCase() !== d.repo)
        throw new AgentError(`${ref} is ${d.repo}’s: its agent runs in ${d.repo}`, 400);
      const uuid = from;
      source = {
        repo: d.repo,
        open: [...this.tasks].find(
          ([, map]) => map.status === 'pending' && map.tag_general && relatedOf(map).includes(uuid),
        ),
        write: (n) => this.refineFrom(uuid, d, n),
      };
    } else if (given(next)) {
      // Prepare the next version (BRK-100): the board writes the prompt from the repository's release tags.
      if (text) throw new AgentError('the board writes the prompt for the next version: send a note instead', 400);
      if (!NEXT_STEPS.includes(String(next))) throw new AgentError('next is minor or major', 400);
      const slug = this.generalRepo(repo);
      const offer = this.nextVersionOffer(slug);
      if (!offer)
        throw new AgentError(
          `${slug} has no pre-release like v1.2.3-main.4 on the board, so it can’t tell the next version: sync GitHub, or set package.json by hand`,
          409,
        );
      const choice = offer.choices.find((c) => c.next === next);
      if (given(version) && String(version) !== choice.version)
        throw new AgentError(`${slug}’s next ${next} is ${choice.version} now, not ${version}: look again`, 409);
      tags = ['agent', 'general', 'version'];
      source = {
        repo: slug,
        open: offer.preparing ? [offer.preparing.uuid, this.tasks.get(offer.preparing.uuid)] : undefined,
        write: (n) =>
          nextVersionPrompt(
            { name: this.repoBySlug(slug)?.name ?? slug, base: offer.base, latest: offer.latest, ...choice },
            n,
          ),
        extra: { base: offer.base, latest: offer.latest, choices: offer.choices, version: choice.version },
      };
    } else if (given(spec)) {
      // Refine a spec (IDEA-31 section 4): the board reads it from GitHub and writes the prompt from it.
      if (text)
        throw new AgentError('the board writes the prompt from the spec: send what should change as a note', 400);
      const slug = this.generalRepo(repo);
      const read = await this.specApi(slug, spec);
      // A file that isn't there is the request's mistake, like a path outside the directory.
      if (read.status !== 200) throw new AgentError(read.body.error, read.status === 404 ? 400 : read.status);
      const { path, title: specTitle } = read.body;
      if (!dryRun && !String(note ?? '').trim())
        throw new AgentError('say what should change in the spec: the note is the agent’s request', 400);
      const fallback = this.defaultRepoSlug();
      const linked = [...this.tasks]
        .filter(
          ([, map]) =>
            map.spec && map.status !== 'deleted' && normalPath(map.spec) === path && repoSlugOf(map, fallback) === slug,
        )
        .sort(([a, x], [b, y]) => widNumber(x.wid) - widNumber(y.wid) || a.localeCompare(b));
      specPath = path;
      source = {
        repo: slug,
        open: linked.find(([, map]) => map.status === 'pending' && map.tag_general),
        write: (n) =>
          specPrompt(
            { path, title: specTitle },
            linked
              .filter(([, map]) => !map.tag_general)
              .map(([uuid, map]) => ({
                ref: map.wid ?? uuid.slice(0, 8),
                description: map.description ?? '',
                status: map.status,
                claimed: Boolean(map.claim),
                tags: tagsOf(map),
              })),
            n,
          ),
      };
    } else if (given(feature)) {
      // Refine a feature (BRK-150): the board writes the prompt from the feature and its tasks.
      if (text)
        throw new AgentError('the board writes the prompt from the feature: send what to refine as a note', 400);
      if (!dryRun && !String(note ?? '').trim())
        throw new AgentError('say what to refine in the feature: the note is the agent’s request', 400);
      const row = this.featureRow(String(feature));
      const members = (this.featureMembership().members.get(row.slug) ?? []).map((m) => m.task);
      const work = members.filter((t) => !t.tags.includes('general'));
      const counts = new Map();
      for (const t of work) counts.set(t.repo, (counts.get(t.repo) ?? 0) + 1);
      const slug = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? this.generalRepo(repo);
      const open = members.find(
        (t) => t.status === 'pending' && t.tags.includes('general') && t.description.startsWith(REFINE_FEATURE_TITLE),
      );
      tags = ['agent', 'general', row.slug];
      source = {
        repo: slug,
        open: open ? [open.uuid, this.tasks.get(open.uuid)] : undefined,
        write: (n) =>
          featurePrompt(
            row,
            work.map((t) => ({
              ref: t.wid ?? t.short,
              description: t.description,
              status: t.status,
              repo: t.repo,
              claimed: Boolean(t.claim),
            })),
            slug,
            n,
          ),
      };
    }
    if (source) {
      repo = source.repo;
      const already = (task) => (task.claim ? `${task.claim} is on it` : 'it’s waiting to start');
      if (dryRun) {
        const task = source.open ? this.detail(source.open[0]) : null;
        const written = source.write(null);
        let refusal = null;
        try {
          await this.checkRoutineReady(source.repo);
        } catch (error) {
          if (!(error instanceof AgentError)) throw error;
          refusal = error.message;
        }
        return {
          dryRun: true,
          title: written.title,
          prompt: written.brief,
          task,
          already: task ? already(task) : null,
          refusal,
          ...(source.extra ?? {}),
        };
      }
      if (source.open) {
        const task = this.detail(source.open[0]);
        return {
          task,
          run: null,
          waiting: null,
          already: already(task),
        };
      }
      const written = source.write(note);
      text = written.brief;
      title = written.title;
    }
    if (dryRun)
      throw new AgentError(
        'a dry run shows the prompt the board writes from a decision, from a spec, from a feature, or for the next version',
        400,
      );
    if (!text) throw new AgentError('write what the agent should do first', 400);
    const slug = this.generalRepo(repo);
    await this.checkRoutineReady(slug);
    const res = await this.create([
      {
        description: title ?? (text.split('\n').find((line) => line.trim()) ?? text).trim().slice(0, 200),
        horizon: 'now',
        tags,
        autostart: 'yes',
        brief: text,
        ...(from ? { related: [from] } : {}),
        ...(specPath ? { spec: specPath } : {}),
        ...(slug === this.defaultRepoSlug() ? {} : { repo: slug }),
        by: 'owner',
      },
    ]);
    if (res.status !== 201) throw new AgentError(res.body.error ?? 'couldn’t make a task for the agent', res.status);
    const uuid = res.body.tasks[0].uuid;
    try {
      return {
        ...(await this.startAgent(uuid, {
          trigger: given(chase) ? 'road-captain' : maker ? 'routines' : 'general',
          kind: maker ? 'routines' : 'general',
          force,
        })),
        waiting: null,
      };
    } catch (error) {
      // Over the board's limits, or Claude's hourly one: the task stays and starts when there's room.
      const queued = error instanceof AgentError && (error.forceable || error.status === 429);
      if (!queued) {
        this.change(uuid, { status: 'deleted' }, new Date(), 'agents');
        throw error;
      }
      this.scheduleAgentsCheck();
      return { task: this.detail(uuid), run: null, waiting: error.message, forceable: error.forceable };
    }
  },

  /** The repository a general agent runs in: `repo`, which it needs when the board runs more than one. */
  generalRepo(repo) {
    if (!repo && this.repos().length > 1)
      throw new AgentError(
        `say which repository this is for: ${this.repos()
          .map((r) => r.slug)
          .join(', ')}`,
        400,
      );
    return this.checkRepoSlug(repo);
  },

  /**
   * Prepare the next version (BRK-100) for repository `slug`: the version its pre-releases work toward, from the
   * release tags the last GitHub sync kept, the next minor and major after it, and the general task already
   * preparing one, if any. Null when it has no `vX.Y.Z-main.N` pre-release, so the board can't tell.
   */
  nextVersionOffer(slug) {
    const releases = JSON.parse(this.ghMeta('gh_releases', slug) ?? '[]');
    const tags = JSON.parse(this.ghMeta('gh_tags', slug) ?? '[]');
    const found = versionBase([...releases.filter((r) => !r.draft).map((r) => r.tag), ...tags.map((t) => t.name)]);
    if (!found) return null;
    return { ...found, choices: nextChoices(found.base), preparing: this.preparingVersion(slug) };
  },

  /**
   * The open +version task preparing repository `slug`'s next minor or major (BRK-100), if any, with the version its
   * title names while it still names one (its agent may retitle it).
   */
  preparingVersion(slug) {
    const fallback = this.defaultRepoSlug();
    const open = [...this.tasks].find(
      ([, map]) => map.status === 'pending' && map.tag_general && map.tag_version && repoSlugOf(map, fallback) === slug,
    );
    if (!open) return null;
    const task = this.detail(open[0]);
    return {
      uuid: task.uuid,
      wid: task.wid,
      short: task.short,
      description: task.description,
      claim: task.claim,
      version: /\b(\d+\.\d+\.\d+)\b/u.exec(task.description ?? '')?.[1] ?? null,
    };
  },

  /** Refine from the answers' prompt for answered decision `uuid` (its detail `d`), with the owner's `note` under it. */
  refineFrom(uuid, d, note) {
    const waiting = this.views((t) => t.status === 'pending' && dependsOf(this.tasks.get(t.uuid)).includes(uuid)).map(
      (t) => ({ ref: t.wid ?? t.short, description: t.description, tags: t.tags, spec: t.spec }),
    );
    return refinePrompt(
      {
        ref: d.wid ?? d.short,
        description: d.description,
        spec: d.spec,
        questions: d.decision,
        answers: d.decisionAnswers.answers,
      },
      waiting,
      note,
    );
  },

  /** The area a task the board makes for a repository goes in: Tech debt where it has it, else its first area. */
  boardArea(slug) {
    const areas = this.repoBySlug(slug)?.areas ?? [];
    return areas.some((a) => a.project === 'debt') ? 'debt' : (areas[0]?.project ?? 'debt');
  },

  /** An area's name for messages: the name its repository gave it, else the board's usual one. */
  areaName(slug, project) {
    const named = this.repoBySlug(slug)?.areas.find((a) => a.project === project)?.name;
    return named && named !== project ? named : (AREA_NAMES[project] ?? project);
  },

  /** The owner's Claude plan (CLD-198), which sets the ceilings and defaults below. */
  claudePlan() {
    const id = this.meta('claude_plan');
    return isPlan(id) ? id : DEFAULT_PLAN;
  },

  /** The most a repository's own caps can be: the plan's agents at once, and Claude's starts an hour for its routine. */
  repoCapCeilings() {
    return { max: planOf(this.claudePlan()).agents.most, hourly: CLAUDE_LIMITS.routineHourly };
  },

  /**
   * The shared limits: what the owner set, else the plan's defaults, never above the plan's ceiling. The
   * hourly default stays under Claude's limit for the registered repositories' routines (30 each).
   */
  agentSettings() {
    const plan = this.claudePlan();
    const { agents, hourly } = planOf(plan);
    const max = Number(this.meta('agents_max') ?? agents.default);
    return {
      plan,
      max: Math.min(max, agents.most),
      hourly: Number(this.meta('agents_hourly') ?? Math.min(hourly.default, hourlyCeiling(this.repos().length))),
      autostart: this.meta('agents_autostart') !== 'off',
      // New security alerts at or above this severity become tasks that start their own agent.
      alerts: this.meta('agents_alerts') ?? 'off',
    };
  },

  // ---- security alerts -----------------------------------------------------------------------

  /** The open task made from this alert, if there is one. */
  taskForAlert(alert) {
    for (const [uuid, map] of this.tasks) if (map.alert === alert.url && map.status === 'pending') return uuid;
    return null;
  },

  /** A task for a Dependabot alert: what, how bad, where, and what fixes it. */
  async createAlertTask(alert, { autostart = false, repo = null } = {}) {
    const existing = this.taskForAlert(alert);
    if (existing) return existing;
    const severity = String(alert.severity ?? 'unknown').toLowerCase();
    const brief = [
      `GitHub security alert #${alert.number} (${severity}): ${alert.summary}`,
      `Package: ${alert.package}${alert.ecosystem ? ` (${alert.ecosystem})` : ''}${alert.manifest ? `, in ${alert.manifest}` : ''}.`,
      alert.fixedIn
        ? `Fixed in ${alert.package} ${alert.fixedIn}.`
        : 'No fixed version yet: find a safe workaround or say so on the task.',
      `Advisory: ${alert.ghsa ? `https://github.com/advisories/${alert.ghsa}` : alert.url}`,
    ].join('\n');
    const doneWhen = [
      'The alert is gone because the fix is in, with pnpm test, pnpm build, and pnpm tasks:interop passing. If it is a transitive dependency, update what pulls it in, or use a pnpm override with a comment saying why and when to remove it. Close it through the PR ("Closes <ID>."); the alert closes on GitHub when the fix merges.',
    ].join('\n');
    const res = await this.create([
      {
        description: `Fix the ${severity} security alert in ${alert.package}`,
        project: this.boardArea(repo ?? this.defaultRepoSlug()),
        ...(repo ? { repo } : {}),
        horizon: 'now',
        priority: ['critical', 'high'].includes(severity) ? 'H' : 'M',
        tags: ['agent', 'security'],
        alert: alert.url,
        ...(autostart ? { autostart: 'yes' } : {}),
        brief,
        done_when: doneWhen,
        by: 'board',
      },
    ]);
    if (res.status !== 201) throw new AgentError(res.body.error ?? 'couldn’t make a task for the alert', res.status);
    return res.body.tasks[0].uuid;
  },

  /** "Fix with an agent" on an alert in repository `repo` (the default when none): its task (made if needed), and an agent on it. */
  async fixAlert(number, { note = null, repo = null, force = false } = {}) {
    await this.ready();
    const slug = this.checkRepoSlug(repo);
    const row = this.sql
      .exec("SELECT data FROM gh_dependabot WHERE repo = ? AND number = ? AND state = 'open'", slug, Number(number))
      .toArray()[0];
    if (!row) throw new AgentError(`there's no open security alert #${number}`, 404);
    const uuid = await this.createAlertTask(JSON.parse(row.data), { repo: slug });
    const map = this.tasks.get(uuid);
    if (map.claim) return { task: this.detail(uuid), run: null, already: `${map.claim} is on it` };
    return { ...(await this.startAgent(uuid, { trigger: 'alert', note, force })), already: null };
  },

  /**
   * "Safe to merge?" on a Dependabot pull request: its task (made if needed, linked by its `pr` field, so
   * merging finishes it) and an agent in review mode, which tests the update and answers as a note and
   * a PR comment. The owner still merges.
   */
  async reviewPull(number, { note = null, repo = null, force = false } = {}) {
    await this.ready();
    const slug = this.checkRepoSlug(repo);
    const row = this.sql
      .exec('SELECT data FROM gh_pulls WHERE repo = ? AND number = ?', slug, Number(number))
      .toArray()[0];
    if (!row) throw new AgentError(`there's no pull request #${number} on the board`, 404);
    // The pull request's repository decides its task's, and which routine starts the agent.
    const pr = { ...JSON.parse(row.data), repo: slug };
    if (pr.state !== 'open') throw new AgentError(`#${pr.number} isn’t open`, 409);
    if (!/^dependabot(\[bot\])?$/iu.test(pr.author ?? '')) return this.reviewWithAgent(pr, { note, force });
    let uuid = this.closingTasks(pr).find((u) => this.tasks.get(u)?.status === 'pending');
    if (!uuid) {
      const res = await this.create([
        {
          description: `Is Dependabot's #${pr.number} safe to merge? ${pr.title}`.slice(0, 200),
          project: this.boardArea(slug),
          repo: slug,
          horizon: 'now',
          tags: ['agent'],
          pr: String(pr.number),
          by: 'board',
          brief: [`Dependabot pull request #${pr.number}: ${pr.title}`, pr.url].join('\n'),
          done_when: [
            'The update is tested (pnpm install --frozen-lockfile, pnpm test, pnpm build, pnpm brand:check, and pnpm tasks:interop when tools/tasks changed), its release notes are read for breaking changes, and the answer, safe or not with the test output, is a comment here and a comment on the pull request. The owner merges.',
          ].join('\n'),
        },
      ]);
      if (res.status !== 201)
        throw new AgentError(res.body.error ?? 'couldn’t make a task for the pull request', res.status);
      uuid = res.body.tasks[0].uuid;
    }
    const map = this.tasks.get(uuid);
    const busy = this.claimBlocker({ ...map, uuid });
    if (busy) return { task: this.detail(uuid), run: null, already: busy };
    return { ...(await this.startAgent(uuid, { trigger: 'review', note, kind: 'review', force })), already: null };
  },

  /**
   * "Review with an agent" on any other open pull request (IDEA-30 section 9): only one that can merge as it stands,
   * checked against GitHub now rather than the last sync, and only on the open task it closes. Anything else is
   * refused with the button that fits it (`path`). The agent reviews and answers with `review <ID>`; it never
   * pushes or merges.
   */
  async reviewWithAgent(stored, { note = null, force = false } = {}) {
    const pr = { ...stored, ...(await this.livePull(stored.repo, stored.number)) };
    const n = `#${pr.number}`;
    const base = pr.base ?? this.repoBySlug(pr.repo)?.defaultBranch ?? 'main';
    if (pr.state !== 'open') throw new AgentError(`${n} isn’t open`);
    if (pr.draft) throw new AgentError(`${n} is a draft: mark it ready for review first`);
    const verdict = prVerdict(pr);
    if (verdict === 'behind')
      throw new AgentError(`${n} is behind ${base}: Update branch, then ask for a review`, 409, { path: 'update' });
    if (verdict === 'conflicts')
      throw new AgentError(`${n} conflicts with ${base}: Fix with an agent resolves that first`, 409, { path: 'fix' });
    if (verdict === 'failing')
      throw new AgentError(`${n}’s checks are failing: Fix with an agent finds the cause first`, 409, { path: 'fix' });
    if (verdict === 'review' && pr.review?.decision === 'changes_requested')
      throw new AgentError(`${n} has changes requested on GitHub: Fix with an agent addresses them first`, 409, {
        path: 'fix',
      });
    if (!['ready', 'running'].includes(verdict) || pr.mergeable !== true)
      throw new AgentError(
        verdict === 'review'
          ? `${n} can’t merge as it stands: GitHub says it waits on a required review`
          : `GitHub hasn’t worked out whether ${n} can merge yet; try again in a minute`,
      );
    const uuid = this.prTask(pr);
    if (!uuid)
      throw new AgentError(
        `${n} closes no open task in ${pr.repo}: an agent reviews a pull request against the task it closes`,
      );
    const map = this.tasks.get(uuid);
    const busy = this.claimBlocker({ ...map, uuid });
    if (busy) return { task: this.detail(uuid), run: null, already: busy };
    return {
      ...(await this.startAgent(uuid, { trigger: 'pr-review', note, kind: 'pr-review', pr: pr.number, force })),
      already: null,
    };
  },

  /**
   * An agent's answer on a pull request (`review <ID> --verdict …`, BRK-111): a comment on the task, as every agent's
   * answer is, and kept for the pull request with the head commit it reviewed. Only the agent holding the task leaves
   * one, on an open pull request that closes it (`pr` picks one when it has several). Safe to merge? answers this way too.
   */
  recordAgentReview(ref, { verdict, note, by, pr = null } = {}) {
    if (!REVIEW_VERDICTS[verdict]) throw new AgentError('verdict is ready, follow-up, or changes', 400);
    const text = String(note ?? '').trim();
    if (!text) throw new AgentError('say what you found: the note is the review', 400);
    if (text.length > REVIEW_NOTE_MAX) throw new AgentError(`keep the note under ${REVIEW_NOTE_MAX} characters`, 400);
    const agent = String(by ?? '').trim();
    if (!agent) throw new AgentError('say who reviewed: the agent holding the task', 400);
    const uuid = this.resolve(ref);
    const map = this.tasks.get(uuid);
    const id = map.wid ?? uuid.slice(0, 8);
    if (map.status !== 'pending') throw new AgentError(`${id} isn’t open`);
    if (map.claim !== agent)
      throw new AgentError(`${id} is ${map.claim ? `${map.claim}’s` : 'unclaimed'}: claim it first`);
    const slug = this.repoOfTask(map)?.slug ?? this.defaultRepoSlug();
    const open = this.sql
      .exec('SELECT data FROM gh_pulls WHERE repo = ?', slug)
      .toArray()
      .map((r) => ({ ...JSON.parse(r.data), repo: slug }))
      .filter((p) => p.state === 'open' && this.closingTasks(p).includes(uuid))
      .sort((a, b) => a.number - b.number);
    const wanted = pr === null || pr === undefined || pr === '' ? null : Number(String(pr).replace(/^#/u, ''));
    const target = wanted ? open.find((p) => p.number === wanted) : open.length === 1 ? open[0] : null;
    if (!target)
      throw new AgentError(
        wanted
          ? `#${wanted} isn’t an open pull request that closes ${id}`
          : open.length
            ? `${id} has several open pull requests (${open.map((p) => `#${p.number}`).join(', ')}): say which with --pr`
            : `${id} has no open pull request to review`,
      );
    this.writable();
    const sha = target.headSha ?? null;
    const at = Date.now();
    const rowId = this.sql
      .exec(
        'INSERT INTO agent_reviews (repo, number, task, verdict, note, agent, sha, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
        slug,
        target.number,
        uuid,
        verdict,
        text,
        agent,
        sha,
        at,
      )
      .one().id;
    this.change(
      uuid,
      {
        annotate: `Agent review of #${target.number}${sha ? ` at ${sha.slice(0, 7)}` : ''}: ${REVIEW_VERDICTS[verdict]}\n\n${text}`,
        by: agent,
      },
      new Date(at),
      'agents',
    );
    return { review: this.agentReviewRow(rowId, sha), task: this.detail(uuid) };
  },

  /** The latest agent's review of pull request `number`, marked `moved` when its branch has a newer head, or null. */
  agentReviewOf(slug, number, headSha = null) {
    const row = this.sql
      .exec('SELECT id FROM agent_reviews WHERE repo = ? AND number = ? ORDER BY id DESC LIMIT 1', slug, Number(number))
      .toArray()[0];
    return row ? this.agentReviewRow(row.id, headSha) : null;
  },

  agentReviewRow(id, headSha) {
    const r = this.sql.exec('SELECT * FROM agent_reviews WHERE id = ?', id).one();
    return {
      pr: r.number,
      task: this.tasks.get(r.task)?.wid ?? null,
      verdict: r.verdict,
      label: REVIEW_VERDICTS[r.verdict],
      note: r.note,
      agent: r.agent,
      sha: r.sha,
      at: new Date(r.at).toISOString(),
      moved: Boolean(headSha && r.sha && headSha !== r.sha),
    };
  },

  /** After a sync: new alerts at or above the chosen severity become Start-when-ready tasks. */
  async tasksForNewAlerts(numbers) {
    const threshold = SEVERITY[this.agentSettings().alerts] ?? 0;
    if (!threshold || !numbers?.length) return [];
    const made = [];
    for (const number of numbers) {
      const row = this.sql
        .exec(
          "SELECT data FROM gh_dependabot WHERE repo = ? AND number = ? AND state = 'open'",
          this.defaultRepoSlug(),
          number,
        )
        .toArray()[0];
      const alert = row && JSON.parse(row.data);
      if (!alert || (SEVERITY[String(alert.severity).toLowerCase()] ?? 0) < threshold) continue;
      made.push(await this.createAlertTask(alert, { autostart: true }));
    }
    return made;
  },

  /**
   * "Fix with an agent" on an open pull request: its task (made from the PR if it has none), and an
   * agent on the PR. `problem` is conflicts, failing, or review; it must be true of the PR now.
   * The agent never merges: it pushes a fix or leaves a note. A chase passes `chase` (its feature's slug and
   * title) and its own `trigger`, so the agent knows it fixes the pull request as one of the chase's agents.
   */
  async fixPr(number, { problem = null, note = null, repo = null, force = false, chase = null, trigger = 'pr' } = {}) {
    await this.ready();
    const slug = this.checkRepoSlug(repo);
    const row = this.sql
      .exec('SELECT data FROM gh_pulls WHERE repo = ? AND number = ?', slug, Number(number))
      .toArray()[0];
    const pr = row && { ...JSON.parse(row.data), repo: slug };
    if (!pr) throw new AgentError(`there's no pull request #${number} on the board yet`, 404);
    if (pr.state !== 'open') throw new AgentError(`#${number} isn’t open`);
    if (pr.draft) throw new AgentError(`#${number} is a draft`);
    const verdict = prVerdict(pr);
    // An agent's review that needs changes, of the branch as it is now, counts as review comments (BRK-111).
    const agentReview = this.agentReviewOf(slug, pr.number, pr.headSha ?? null);
    const agentChanges = agentReview?.verdict === 'changes' && !agentReview.moved ? agentReview : null;
    const reviewOpen = pr.review?.decision === 'changes_requested' || pr.review?.comments > 0 || Boolean(agentChanges);
    const applies = { conflicts: verdict === 'conflicts', failing: verdict === 'failing', review: reviewOpen };
    const chosen = problem ?? (['conflicts', 'failing'].includes(verdict) ? verdict : reviewOpen ? 'review' : null);
    if (!chosen || !(chosen in applies))
      throw new AgentError(
        problem ? 'problem is conflicts, failing, or review' : `#${number} has nothing for an agent to fix`,
        problem ? 400 : 409,
      );
    if (!applies[chosen]) throw new AgentError(`#${number} doesn’t have that problem now`);

    const failing = (pr.checks?.runs ?? []).filter((r) => FAILED_CHECK.has(r.state)).map((r) => r.name);
    const what = {
      conflicts: `It conflicts with ${this.repoBySlug(slug)?.defaultBranch ?? 'main'} (merge state: ${pr.mergeableState ?? 'unknown'}). Merge ${this.repoBySlug(slug)?.defaultBranch ?? 'main'} into the branch and resolve the conflicts.`,
      failing: `Checks are failing: ${failing.join(', ') || 'see the pull request'}. Find the cause, fix it, and push.`,
      review: [
        agentChanges
          ? `An agent’s review of ${agentChanges.sha ? agentChanges.sha.slice(0, 7) : 'the branch'} (${agentChanges.agent}) needs changes:\n${agentChanges.note}`
          : null,
        pr.review?.decision === 'changes_requested' || pr.review?.comments > 0 || !agentChanges
          ? `It has review comments to address${pr.review?.decision === 'changes_requested' ? ' (changes were requested)' : ''}. Read each open thread and address it or reply.`
          : null,
      ]
        .filter(Boolean)
        .join('\n'),
    }[chosen];

    let uuid = this.prTask(pr);
    if (!uuid) {
      const res = await this.create([
        {
          description: `Fix pull request #${pr.number}: ${String(pr.title).slice(0, 120)}`,
          project: this.boardArea(slug),
          repo: slug,
          horizon: 'now',
          tags: ['agent'],
          pr: String(pr.number),
          by: 'board',
          brief: `Started from the board's pull request page. ${pr.url}\n${what}`,
          done_when:
            'The pull request is mergeable with its checks passing and its review comments answered. The owner merges it.',
        },
      ]);
      if (res.status !== 201)
        throw new AgentError(res.body.error ?? 'couldn’t make a task for the pull request', res.status);
      uuid = res.body.tasks[0].uuid;
    }
    const map = this.tasks.get(uuid);
    const busy = this.claimBlocker({ ...map, uuid });
    if (busy) return { task: this.detail(uuid), run: null, already: busy };
    const text = [
      what,
      chase
        ? `This pull request is part of the chase on ${chase.title} (+${chase.slug}), and the agent that opened it has stopped. Fix it as one of the chase's agents: check in on the chase's peloton too while it's open.`
        : null,
      note ? `Owner's note: ${String(note).slice(0, 2000)}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    // Two fix agents that didn't get it green are enough (BRK-145): a third is the owner's call, not the board's.
    // A chase counts its own fixes on each head and goes Stuck, so only Fix with an agent is refused here.
    const fixes = this.prFixes(slug, pr.number);
    if (!chase && !force && fixes.tries >= FIX_TRIES) {
      await this.fixNeedsYou(slug, pr, uuid, FIX_WORDS[chosen], fixes.tries);
      throw new AgentError(
        `Needs you: ${fixes.tries} fix agents on #${pr.number} didn’t get it green, so the board won’t start another. Read what they tried on ${this.tasks.get(uuid)?.wid ?? 'its task'}, then fix it yourself or force start one more`,
        409,
        { forceable: true },
      );
    }
    const started = await this.startAgent(uuid, { trigger, note: text, kind: 'fix-pr', pr: pr.number, force });
    this.sql.exec(
      'INSERT INTO pr_fixes (repo, number, tries) VALUES (?, ?, 1) ON CONFLICT (repo, number) DO UPDATE SET tries = tries + 1',
      slug,
      pr.number,
    );
    return { ...started, already: null };
  },

  /** Fix agents started on pull request `number` of repository `slug` since it was last green, and since when that's Needs you. */
  prFixes(slug, number) {
    const row = this.sql
      .exec('SELECT tries, needs_you FROM pr_fixes WHERE repo = ? AND number = ?', slug, Number(number))
      .toArray()[0];
    return { tries: row?.tries ?? 0, needsYou: row?.needs_you ? new Date(row.needs_you).toISOString() : null };
  },

  /** Marks pull request `pr` Needs you, and pings the owner once about it on task `uuid`, until it's green again. */
  async fixNeedsYou(slug, pr, uuid, words, tries) {
    const marked = this.sql
      .exec(
        'UPDATE pr_fixes SET needs_you = ? WHERE repo = ? AND number = ? AND needs_you IS NULL RETURNING number',
        Date.now(),
        slug,
        pr.number,
      )
      .toArray();
    if (!marked.length) return;
    const wid = this.tasks.get(uuid)?.wid ?? 'its task';
    await this.boardPing(
      uuid,
      'blocked',
      `#${pr.number} still ${words} after ${tries} fix agents tried, so the board won’t start another. Read what they tried on ${wid}, then fix it yourself or force start one more fix.`,
    );
  },

  /**
   * After a tick: a pull request that's green again, closed, or gone starts counting its fixes from nothing.
   * Running checks, an unknown merge state, and requested changes aren't green.
   */
  fixesTick() {
    for (const { repo, number } of this.sql.exec('SELECT repo, number FROM pr_fixes').toArray()) {
      const row = this.sql
        .exec('SELECT state, data FROM gh_pulls WHERE repo = ? AND number = ?', repo, number)
        .toArray()[0];
      const pr = row && JSON.parse(row.data);
      const green =
        pr &&
        ['ready', 'review'].includes(prVerdict(pr)) &&
        pr.checks?.state !== 'failure' &&
        pr.review?.decision !== 'changes_requested';
      if (row?.state !== 'open' || green)
        this.sql.exec('DELETE FROM pr_fixes WHERE repo = ? AND number = ?', repo, number);
    }
  },

  /** Pull requests whose fixes are Needs you, for the Agents view (BRK-145). */
  fixesNeedingYou() {
    return this.sql
      .exec('SELECT repo, number, tries, needs_you FROM pr_fixes WHERE needs_you IS NOT NULL ORDER BY needs_you')
      .toArray()
      .map((r) => {
        const row = this.sql
          .exec('SELECT data FROM gh_pulls WHERE repo = ? AND number = ?', r.repo, r.number)
          .toArray()[0];
        const uuid = row ? this.prTask({ ...JSON.parse(row.data), repo: r.repo }) : null;
        return {
          repo: r.repo,
          pr: r.number,
          wid: (uuid && this.tasks.get(uuid)?.wid) ?? null,
          tries: r.tries,
          since: new Date(r.needs_you).toISOString(),
        };
      });
  },

  /** Why a task can't start an agent right now, or null if it can. */
  agentBlocker(t, { inReview = false } = {}) {
    if (t?.status !== 'pending') return 'it isn’t open';
    if (t.tags.includes('decide')) return 'it waits on a decision (+decide)';
    if (!t.tags.includes('agent')) return 'it isn’t tagged +agent';
    if (!inReview && t.github?.some((p) => p.closes && p.state === 'open')) return 'it’s already in review';
    if (t.claim) return `${t.claim} has it`;
    if (t.blocked) {
      const names = t.blockedBy.map((u) => this.tasks.get(u)?.wid ?? u.slice(0, 8));
      return `it waits for ${names.join(', ')}`;
    }
    if (t.waiting) return `it waits until ${t.wait?.slice(0, 10)}`;
    return null;
  },

  /** Why a task can't be refined right now, or null. Unlike a build, +decide, +owner, and untagged tasks are fine. */
  refineBlocker(t) {
    if (t?.status !== 'pending') return 'it isn’t open';
    if (t.github?.some((p) => p.closes && p.state === 'open'))
      return 'it’s in review: ask for changes on its pull request instead';
    if (t.claim) return `${t.claim} has it`;
    return null;
  },

  /**
   * Why an agent can't take over a task's claim right now, or null. An agent working on a pull request
   * (fix or check) takes the claim over from an agent that stopped: the build agent that opened the
   * pull request keeps the claim after it goes quiet. It never takes one from a person, from an
   * agent that produced output in the last two minutes, or from one the board started that hasn't
   * said anything yet (WEB-6: its session takes a while to come up, and a second press would start another).
   */
  claimBlocker(t) {
    if (!t.claim) return null;
    if (!/^(claude|codex)-/u.test(t.claim)) return `${t.claim} has it`;
    const last = this.sql.exec('SELECT MAX(at) AS at FROM agent_logs WHERE task = ?', t.uuid).one().at;
    if (last && Date.now() - last < LIVE_MS) return `${t.claim} is working on it right now`;
    const started = this.sql
      .exec(
        "SELECT MAX(started) AS at FROM agent_runs WHERE task = ? AND agent = ? AND status IN ('starting', 'started')",
        t.uuid,
        t.claim,
      )
      .one().at;
    if (started && Date.now() - started < STARTING_MS && !(last >= started)) return `${t.claim} is starting`;
    return null;
  },

  /** The open task an agent on pull request `pr` works on: the first of the tasks it closes that's still pending. */
  prTask(pr) {
    return this.closingTasks(pr).find((u) => this.tasks.get(u)?.status === 'pending') ?? null;
  },

  /** Who's on pull request `pr`'s task right now, for its page (WEB-6), or null when Fix with an agent can start one. */
  prAgent(pr) {
    const uuid = this.prTask(pr);
    const map = uuid && this.tasks.get(uuid);
    const busy = map && this.claimBlocker({ ...map, uuid });
    return busy ? { wid: map.wid, agent: map.claim, session: map.session ?? null, busy } : null;
  },

  /** Why a task can't take an agent on its pull request: it may be in review or claimed by a quiet agent, but must be open. */
  prAgentBlocker(t) {
    if (t?.status !== 'pending') return 'it isn’t open';
    return this.claimBlocker(t);
  },

  /** Agents working right now: a recent run whose task is still open, claimed by it, and not in review. */
  runningAgents(views) {
    const byUuid = new Map(views.map((t) => [t.uuid, t]));
    const since = Date.now() - RUNNING_HOURS * 3_600_000;
    const runs = this.sql
      .exec("SELECT * FROM agent_runs WHERE status = 'started' AND started > ? ORDER BY id DESC", since)
      .toArray();
    const seen = new Set();
    const running = [];
    for (const run of runs) {
      if (seen.has(run.task)) continue;
      seen.add(run.task);
      const t = byUuid.get(run.task);
      if (t?.status !== 'pending' || t.claim !== run.agent) continue;
      // Agents on a pull request work on a task whose pull request is open, so that doesn't end their run.
      if (
        !['review', 'fix-pr', 'pr-review'].includes(run.kind) &&
        t.github?.some((p) => p.closes && p.state === 'open')
      )
        continue;
      running.push({ run, task: t });
    }
    return running;
  },

  /**
   * After a tick (BRK-145): a running session that has said nothing for 30 minutes is Silent, and its run pings
   * the owner once. It keeps its claim and its slot: the owner opens the session and decides. A run on a pull
   * request whose checks are running is waiting for them, not silent. A run that stopped running isn't Silent.
   * While GitHub reports trouble (BRK-217) nobody is Silent yet: a session waiting on a push or on checks would
   * ping about GitHub's outage, not about itself (BRK-219). It's counted again once GitHub works.
   */
  async silentTick() {
    const now = Date.now();
    const githubDown = Boolean(this.githubOutage());
    const running = this.runningAgents(this.views());
    const ids = new Set(running.map(({ run }) => run.id));
    for (const r of this.sql.exec('SELECT id FROM agent_runs WHERE silent IS NOT NULL').toArray())
      if (!ids.has(r.id)) this.clearSilent(r.id, 'agent-stopped');
    for (const { run, task } of running) {
      const last = this.sql.exec('SELECT MAX(at) AS at FROM agent_logs WHERE task = ?', task.uuid).one().at;
      const since = Math.max(run.started, last ?? 0);
      if (run.silent || githubDown || now - since < SILENT_MS) continue;
      const pr = task.github?.find((p) => p.closes && p.state === 'open');
      if (['review', 'fix-pr', 'pr-review'].includes(run.kind) && pr && this.pullChecksRunning(task.repo, pr.number))
        continue;
      this.sql.exec('UPDATE agent_runs SET silent = ? WHERE id = ?', since, run.id);
      if (run.silent_ping) continue; // One ping a run: going Silent again after it spoke tells nobody.
      const id = await this.boardPing(
        task.uuid,
        'blocked',
        `${run.agent} has said nothing for over 30 minutes on ${task.wid ?? task.short}. It keeps its claim and its slot: open its session${run.url ? ` (${run.url})` : ''} and decide whether it carries on, or stop it and release the task.`,
      );
      this.sql.exec('UPDATE agent_runs SET silent_ping = ? WHERE id = ?', id, run.id);
    }
  },

  /** Whether pull request `number`'s checks are running, as the board last saw them. */
  pullChecksRunning(slug, number) {
    const row = this.sql
      .exec('SELECT data FROM gh_pulls WHERE repo = ? AND number = ?', slug, Number(number))
      .toArray()[0];
    return Boolean(row) && JSON.parse(row.data).checks?.state === 'pending';
  },

  /** Run `id` isn't Silent any more: its ping, if still open, resolves as `how` (agent-resumed or agent-stopped). */
  clearSilent(id, how) {
    const run = this.sql.exec('SELECT silent_ping FROM agent_runs WHERE id = ?', id).toArray()[0];
    this.sql.exec('UPDATE agent_runs SET silent = NULL WHERE id = ?', id);
    if (run?.silent_ping)
      this.sql.exec(
        'UPDATE pings SET resolved = ?, resolution = ? WHERE id = ? AND resolved IS NULL',
        Date.now(),
        how,
        run.silent_ping,
      );
  },

  /** Starts in the last hour: all of them (the shared budget), or one repository's. */
  startsThisHour(slug = null) {
    const since = Date.now() - 3_600_000;
    const counted = "started > ? AND status IN ('started', 'starting', 'failed')";
    if (!slug) return this.sql.exec(`SELECT COUNT(*) AS n FROM agent_runs WHERE ${counted}`, since).one().n;
    return this.sql
      .exec(
        `SELECT COUNT(*) AS n FROM agent_runs WHERE ${counted} AND COALESCE(repo, ?) = ?`,
        since,
        this.defaultRepoSlug(),
        slug,
      )
      .one().n;
  },

  /**
   * Starts one agent, through the routine of the task's repository. `trigger`: manual | next | auto.
   * Throws AgentError when it can't. The concurrent and hourly limits are the whole board's, whichever
   * repository the task is in, and a repository's own caps (its `routine`) apply on top.
   * One start never checks areas or the auto-start switch; only batches and the auto-starter keep agents apart.
   * `force` is the owner's Force start: it skips the board's own limits (agents at once, starts an hour, a
   * repository's caps) and nothing else. Claude's limits and everything that makes a start wrong still refuse
   * it, and a refusal only the board's limits caused says so (`forceable`). The run records `forced`.
   */
  async startAgent(
    uuid,
    { trigger = 'manual', note = null, kind = 'build', pr = null, routine = null, force = false } = {},
  ) {
    await this.ready();
    if (kind === 'routine' && !routine) throw new AgentError('a routine run needs its routine', 400);
    if (kind === 'general' && !this.tasks.get(uuid)?.tag_general)
      throw new AgentError('that task isn’t a general agent’s', 400);
    // A routine maker's task always starts its agent in the routines mode, and only it does (BRK-220 section 2).
    if (kind === 'general' && isRoutineMaker(this.tasks.get(uuid))) kind = 'routines';
    if (kind === 'routines' && !isRoutineMaker(this.tasks.get(uuid)))
      throw new AgentError('that task isn’t a routine maker’s', 400);
    if (kind === 'refine' && !String(note ?? '').trim())
      throw new AgentError('say what it should look at or change', 400);
    const map = this.tasks.get(uuid);
    // A kickoff's IDEA is interviewed and planned, not shaped from its words alone (BRK-134): any start on it is
    // the kickoff mode, whichever button or tick asked.
    if (kind === 'build' && isKickoffIdea(map)) kind = 'kickoff';
    if (kind === 'kickoff' && !isKickoffIdea(map)) throw new AgentError('that task isn’t a kickoff’s idea', 400);
    const repo = map ? this.repoOfTask(map) : this.githubRepo();
    if (!repo) throw new AgentError(`${map.wid ?? 'This task'} is in ${map.repo}, which isn’t a registered repository`);
    const isDefault = repo.slug === this.defaultRepoSlug();
    const credentials = await this.checkRoutineReady(repo.slug);

    // Everything from here to the claim is synchronous: two starts can't both pass.
    const views = this.views();
    const task = views.find((t) => t.uuid === uuid);
    const onPr = kind === 'review' || kind === 'fix-pr' || kind === 'pr-review';
    const blocker =
      kind === 'refine' ? this.refineBlocker(task) : onPr ? this.prAgentBlocker(task, kind) : this.agentBlocker(task);
    if (blocker)
      throw new AgentError(
        `${task?.wid ?? 'This task'} can’t ${kind === 'refine' ? 'be refined' : onPr ? 'take an agent on its pull request' : 'start an agent'}: ${blocker}`,
      );
    // Claude said when to try again after its 429 (BRK-144): no start fires before then, forced or not.
    const hold = this.routineHold(repo.slug);
    if (hold?.kind === 'limit')
      throw new AgentError(
        `Claude’s hourly limit for starting sessions is reached (try again after ${Math.max(1, Math.round((hold.until - Date.now()) / 1000))} seconds, at ${clock(hold.until)})`,
        429,
      );
    const { max, hourly } = this.agentSettings();
    const running = this.runningAgents(views);
    if (!force && running.length >= max)
      throw new AgentError(`${running.length} agents are already running (the limit is ${max})`, 409, {
        forceable: true,
      });
    if (!force && this.startsThisHour() >= hourly)
      throw new AgentError(`${hourly} agents were started in the last hour, the most the board starts`, 429, {
        forceable: true,
      });
    // Claude's own limit for the whole account (100 an hour) holds for a forced start too.
    if (this.startsThisHour() >= CLAUDE_LIMITS.accountHourly)
      throw new AgentError(
        `${this.startsThisHour()} agents were started in the last hour, Claude’s limit for the account`,
        429,
      );
    const capped = this.repoCapBlocker(repo.slug, running, { force });
    if (capped) {
      const claude = /Claude’s limit/u.test(capped);
      throw new AgentError(capped, /last hour/u.test(capped) ? 429 : 409, { forceable: !claude });
    }

    // A build is `claude-<id>`, a refinement `claude-refine-<id>`, a fix `claude-<id>-fix`, a Dependabot check
    // `claude-<id>-check`, and a review of a pull request `claude-<id>-review`.
    const id = (kind === 'general' || kind === 'routines' ? task.short : (task.wid ?? task.short)).toLowerCase();
    const agent =
      kind === 'refine'
        ? `claude-refine-${id}`
        : kind === 'fix-pr'
          ? `claude-${id}-fix`
          : kind === 'review'
            ? `claude-${id}-check`
            : kind === 'pr-review'
              ? `claude-${id}-review`
              : `claude-${id}`;
    this.writable();
    const taken = onPr && task.claim ? task.claim : null;
    this.change(
      uuid,
      {
        claim: agent,
        start: true,
        // A kickoff's or a routine maker's run that waited for room (Send answers and carry on) starts once, not
        // again after it.
        ...((kind === 'kickoff' || kind === 'routines') && map?.autostart ? { autostart: null } : {}),
        ...(taken ? { annotate: `${agent} took over the claim from ${taken}.`, by: 'board' } : {}),
      },
      new Date(),
      'agents',
    );
    const runId = this.sql
      .exec(
        "INSERT INTO agent_runs (task, agent, trigger, kind, status, note, started, repo, forced) VALUES (?, ?, ?, ?, 'starting', ?, ?, ?, ?) RETURNING id",
        uuid,
        agent,
        trigger,
        kind,
        note ? String(note).slice(0, 4000) : null,
        Date.now(),
        repo.slug,
        force ? 1 : 0,
      )
      .one().id;

    try {
      const attachments = this.sql.exec('SELECT COUNT(*) AS n FROM attachments WHERE task = ?', uuid).one().n;
      const plan = trigger === 'chase' || trigger === 'chase-fix' ? this.planForTask(uuid) : null;
      const session = await fireRoutine(
        credentials,
        firePayload(task, agent, trigger, note, kind, pr, routine, attachments, repo, plan),
        isDefault ? null : repo.slug,
      );
      this.sql.exec(
        "UPDATE agent_runs SET status = 'started', session_id = ?, url = ? WHERE id = ?",
        session.id,
        session.url,
        runId,
      );
      if (this.tasks.get(uuid)?.claim === agent) this.change(uuid, { session: session.url }, new Date(), 'agents');
      // Claude took it, so whatever held the routine is over.
      if (hold) this.setMeta(`routine_hold:${repo.slug}`, null);
      return { run: this.agentRun(runId), task: this.detail(uuid) };
    } catch (error) {
      const held = error instanceof AgentError ? error.hold : null;
      this.sql.exec(
        "UPDATE agent_runs SET status = 'failed', error = ?, hold = ?, hold_until = ? WHERE id = ?",
        error.message,
        held,
        held === 'limit' ? error.until : held === 'backoff' ? Date.now() + BACKOFF_MS : null,
        runId,
      );
      if (held) await this.holdRoutine(repo.slug, error, credentials);
      if (this.tasks.get(uuid)?.claim === agent) this.change(uuid, { claim: null, start: false }, new Date(), 'agents');
      throw error instanceof AgentError ? error : new AgentError(error.message, 502);
    }
  },

  agentRun(id) {
    const r = this.sql.exec('SELECT * FROM agent_runs WHERE id = ?', id).toArray()[0];
    return r
      ? {
          id: r.id,
          agent: r.agent,
          trigger: r.trigger,
          kind: r.kind,
          repo: r.repo ?? this.defaultRepoSlug(),
          forced: Boolean(r.forced),
          status: r.status,
          url: r.url,
          error: r.error,
          note: r.note,
          startedAt: new Date(r.started).toISOString(),
          // Silent since (BRK-145): the session has said nothing from then; null while it's working or done.
          silentSince: r.silent ? new Date(r.silent).toISOString() : null,
        }
      : null;
  },

  /**
   * The best ready tasks for agents that won't collide: at most one per area of a repository, none in an
   * area where an agent is already working, horizon `now` first, only where the repository's routine is
   * connected, within the shared slots and budget and each repository's caps. Starts them unless `dryRun`.
   */
  async startNext({ count = 3, horizon = null, repo = null, dryRun = false } = {}) {
    await this.ready();
    const connected = await this.connectedRepos();
    const only = repo ? this.checkRepoSlug(repo) : null;
    const views = this.views();
    const { max, hourly } = this.agentSettings();
    const running = this.runningAgents(views);
    const area = (t) => `${t.repo}:${t.project}`;
    const busy = new Map(running.map(({ task }) => [area(task), task.wid]));
    const room = Math.max(0, Math.min(Number(count) || 0, max - running.length, hourly - this.startsThisHour()));
    const repoRoom = new Map();
    const candidates = views
      .filter(
        (t) =>
          !t.tags.includes('general') &&
          !this.agentBlocker(t) &&
          (!horizon || t.horizon === horizon) &&
          (!only || t.repo === only),
      )
      .sort(rank);
    const picked = [];
    const skipped = [];
    const taken = new Set();
    for (const t of candidates) {
      const brief = { uuid: t.uuid, wid: t.wid, description: t.description, project: t.project, repo: t.repo };
      const name = this.areaName(t.repo, t.project);
      if (!repoRoom.has(t.repo)) repoRoom.set(t.repo, this.repoRoom(t.repo, running));
      if (!connected.has(t.repo)) skipped.push({ ...brief, reason: `${t.repo}’s agent routine isn’t connected` });
      else if (busy.has(area(t)))
        skipped.push({ ...brief, reason: `an agent is already working in ${name} (${busy.get(area(t))})` });
      else if (taken.has(area(t)))
        skipped.push({ ...brief, reason: `one ${name} task at a time, to keep agents out of each other’s files` });
      else if (picked.length >= room)
        skipped.push({
          ...brief,
          reason:
            running.length >= max ? `no free slot (${running.length} of ${max} running)` : 'enough for this round',
        });
      else if (repoRoom.get(t.repo) <= 0)
        skipped.push({ ...brief, reason: this.repoCapBlocker(t.repo, running) ?? `${t.repo} is at its cap` });
      else {
        picked.push(brief);
        taken.add(area(t));
        repoRoom.set(t.repo, repoRoom.get(t.repo) - 1);
      }
    }
    if (dryRun) return { dryRun: true, started: picked, skipped, running: running.length, max };
    const started = [];
    for (const t of picked) {
      try {
        const { run } = await this.startAgent(t.uuid, { trigger: 'next' });
        started.push({ ...t, url: run.url });
      } catch (error) {
        skipped.unshift({ ...t, reason: error.message });
      }
    }
    return { dryRun: false, started, skipped, running: running.length + started.length, max };
  },

  /**
   * Why each Start-when-ready task is still waiting, in the order they'd start. `connected` is the set of
   * repositories whose routine is connected; without it, connections aren't checked.
   */
  /** @this {any} */
  autostartQueue(views = this.views(), connected = null) {
    const { max, autostart } = this.agentSettings();
    const running = this.runningAgents(views);
    const area = (t) => `${t.repo}:${t.project}`;
    const busy = new Map(running.map(({ task }) => [area(task), task.wid]));
    const repoRoom = new Map();
    let free = max - running.length;
    const queue = [];
    // A kickoff's next run waiting for room was the owner's press too (Send answers and carry on).
    const pressed = (t) => t.tags.includes('general') || isKickoffIdea(t);
    // Security fixes first, then what the owner asked for now (general agents, a kickoff's next run), then the rest.
    const order = (t) => (t.alert ? 0 : pressed(t) ? 1 : 2);
    const waiting = views.filter((v) => v.autostart && v.status === 'pending' && !v.claim);
    for (const t of waiting.sort((a, b) => order(a) - order(b) || rank(a, b))) {
      const blocker = this.agentBlocker(t);
      let reason = blocker;
      // A general agent has no area until it picks one, and the owner pressed Start: only room holds it back. So does
      // a kickoff's next run, which the owner's Send answers and carry on queued.
      const general = t.tags.includes('general');
      // Force start (BRK-105) skips the board's own limits only: not a blocked task, an unconnected routine, or Claude's limit.
      let forceable = false;
      if (!repoRoom.has(t.repo)) repoRoom.set(t.repo, this.repoRoom(t.repo, running));
      const kickoff = !general && isKickoffIdea(t);
      if (!reason && !autostart && !general && !kickoff) {
        reason = 'auto-start is off';
        forceable = true;
      }
      if (!reason && connected && !connected.has(t.repo)) reason = `${t.repo}’s agent routine isn’t connected`;
      // A routine Claude refused waits (BRK-144), so it doesn't fire every tick.
      const hold = !reason && connected ? this.routineHold(t.repo) : null;
      if (hold) reason = this.holdReason(t.repo, hold);
      // A security fix doesn't wait for its area to be free.
      if (!reason && busy.has(area(t)) && !t.alert && !general && !kickoff) {
        reason = `an agent is already working in ${this.areaName(t.repo, t.project)} (${busy.get(area(t))})`;
        forceable = true;
      }
      if (!reason && free <= 0) {
        reason = `no free slot (${running.length} of ${max} running)`;
        forceable = true;
      }
      if (!reason && repoRoom.get(t.repo) <= 0) {
        reason = this.repoCapBlocker(t.repo, running) ?? `${t.repo} is at its cap`;
        forceable = !/Claude’s limit/u.test(reason);
      }
      if (!reason) {
        free -= 1;
        repoRoom.set(t.repo, repoRoom.get(t.repo) - 1);
        if (!general && !kickoff) busy.set(area(t), t.wid);
      }
      queue.push({
        uuid: t.uuid,
        wid: t.wid,
        description: t.description,
        project: t.project,
        repo: t.repo,
        general,
        maker: isRoutineMaker(t),
        kickoff,
        reason: reason ?? 'starting now',
        ready: !reason,
        forceable: Boolean(reason) && forceable,
      });
    }
    return queue;
  },

  /** Starts every Start-when-ready task that may start now. Runs from the alarm and the cron. */
  async autostartTick() {
    await this.ready();
    // With the switch off the queue still holds general agents: the owner started them by hand.
    const connected = await this.connectedRepos();
    if (!connected.size) return [];
    const started = [];
    for (const item of this.autostartQueue(this.views(), connected).filter((q) => q.ready)) {
      // An earlier start this tick may have been refused, holding its routine.
      if (this.routineHold(item.repo)) continue;
      try {
        await this.startAgent(
          item.uuid,
          item.maker
            ? { trigger: 'routines', kind: 'routines' }
            : item.general
              ? { trigger: 'general', kind: 'general' }
              : item.kickoff
                ? { trigger: 'kickoff', kind: 'kickoff' }
                : { trigger: 'auto' },
        );
        started.push(item.wid ?? item.uuid);
      } catch {
        // It stays in the queue; the next tick tries again, unless Claude's refusal holds the routine.
      }
    }
    return started;
  },

  hasAutostart() {
    for (const map of this.tasks?.values() ?? [])
      if (map.autostart === 'yes' && map.status === 'pending' && !map.claim) return true;
    return false;
  },

  /** After a change that may unblock a task, check the auto-starter a moment later. */
  scheduleAgentsCheck() {
    if (!this.hasAutostart() && !this.chasing()) return;
    this.ctx.storage.getAlarm().then((at) => {
      if (!at || at > Date.now() + 3000) this.ctx.storage.setAlarm(Date.now() + 2000);
    });
  },

  // ---- live output ---------------------------------------------------------------------------

  appendSessionLog(uuid, { agent, entries }) {
    if (!Array.isArray(entries) || !entries.length) return 0;
    const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
    let added = 0;
    for (const e of entries.slice(0, 20)) {
      if (!e || !KINDS.has(e.kind)) continue;
      const entry = {
        kind: e.kind,
        agent: clip(agent, 64) ?? null,
        tool: clip(e.tool, 64),
        title: clip(e.title, 200),
        detail: clip(e.detail, 300),
        output: clip(e.output, 600),
        text: clip(e.text, 4000),
        failed: e.failed === true || undefined,
      };
      const at = Number.isFinite(e.at) && Math.abs(e.at - Date.now()) < 3_600_000 ? e.at : Date.now();
      this.sql.exec('INSERT INTO agent_logs (task, at, data) VALUES (?, ?, ?)', uuid, at, JSON.stringify(entry));
      added += 1;
    }
    // Output clears Silent (BRK-145).
    if (added)
      for (const r of this.sql.exec('SELECT id FROM agent_runs WHERE task = ? AND silent IS NOT NULL', uuid).toArray())
        this.clearSilent(r.id, 'agent-resumed');
    this.sql.exec(
      'DELETE FROM agent_logs WHERE task = ? AND id NOT IN (SELECT id FROM agent_logs WHERE task = ? ORDER BY id DESC LIMIT ?)',
      uuid,
      uuid,
      LOG_KEEP,
    );
    return added;
  },

  sessionLog(uuid, after = 0) {
    const entries = this.sql
      .exec(
        'SELECT id, at, data FROM agent_logs WHERE task = ? AND id > ? ORDER BY id LIMIT 300',
        uuid,
        Number(after) || 0,
      )
      .toArray()
      .map((r) => ({ id: r.id, at: new Date(r.at).toISOString(), ...JSON.parse(r.data) }));
    const last = this.sql.exec('SELECT MAX(at) AS at FROM agent_logs WHERE task = ?', uuid).one().at;
    const runRow = this.sql.exec('SELECT * FROM agent_runs WHERE task = ? ORDER BY id DESC LIMIT 1', uuid).toArray()[0];
    const map = this.tasks.get(uuid);
    const task = map && { ...map, uuid, github: this.githubFor(map, this.githubLinks()) };
    return {
      entries,
      lastAt: last ? new Date(last).toISOString() : null,
      live: Boolean(last && Date.now() - last < LIVE_MS),
      run: runRow
        ? { ...this.agentRun(runRow.id), state: this.stateOf(runRow, task, last ?? null, this.runFacts()) }
        : null,
    };
  },

  pruneAgentLogs() {
    this.sql.exec('DELETE FROM agent_logs WHERE at < ?', Date.now() - LOG_DAYS * 86_400_000);
    this.sql.exec('DELETE FROM agent_runs WHERE started < ?', Date.now() - 30 * 86_400_000);
    this.pruneMessages();
    this.prunePeloton();
    this.foldInfraSignals();
  },

  /** Per task: its latest run and when its session last said something (for cards). */
  agentLinks() {
    const runs = new Map();
    for (const r of this.sql
      .exec('SELECT * FROM agent_runs WHERE id IN (SELECT MAX(id) FROM agent_runs GROUP BY task)')
      .toArray())
      runs.set(r.task, r);
    const logs = new Map(
      this.sql
        .exec('SELECT task, MAX(at) AS at FROM agent_logs GROUP BY task')
        .toArray()
        .map((r) => [r.task, r.at]),
    );
    return { runs, logs, facts: this.runFacts() };
  },

  /**
   * What a run's state needs beyond the run itself (WEB-41): each task's latest open ping (a silent run's own
   * ping is its Silent state, not a ping), the pull requests two fix agents didn't get green, and which
   * repositories' routines are paused.
   */
  runFacts() {
    const pings = new Map();
    for (const p of this.sql
      .exec(
        'SELECT id, task, message, created FROM pings WHERE resolved IS NULL AND id NOT IN (SELECT silent_ping FROM agent_runs WHERE silent_ping IS NOT NULL) ORDER BY id',
      )
      .toArray())
      pings.set(p.task, p);
    const fixes = new Map(
      this.sql
        .exec('SELECT repo, number, tries, needs_you FROM pr_fixes WHERE needs_you IS NOT NULL')
        .toArray()
        .map((r) => [`${r.repo}#${r.number}`, r]),
    );
    const paused = new Map();
    const isPaused = (slug) => {
      if (!paused.has(slug)) paused.set(slug, this.routineHold(slug)?.kind === 'paused');
      return paused.get(slug);
    };
    return { pings, fixes, isPaused };
  },

  /**
   * The state of run row `run` (WEB-41, src/run-state.js) on task `task` (its map with `uuid` and `github`), whose
   * session last said something at `lastAt`. Only a task's latest run (`latest`) can be Needs you.
   */
  stateOf(run, task, lastAt, facts, latest = true) {
    const repo = run.repo ?? task?.repo ?? this.defaultRepoSlug();
    let needsYou = null;
    if (latest && task) {
      const pr = task.github?.find((p) => p.closes && p.state === 'open');
      const fix = pr ? facts.fixes.get(`${pr.repo ?? repo}#${pr.number}`) : null;
      const ping = facts.pings.get(task.uuid);
      if (fix) needsYou = { kind: 'fix', pr: fix.number, tries: fix.tries, at: fix.needs_you };
      else if (ping) needsYou = { kind: 'ping', id: ping.id, message: ping.message, at: ping.created };
    }
    return runState({
      run: { ...run, holdUntil: run.hold_until ?? null },
      holding: Boolean(task) && run.status === 'started' && holdsTask(run, task),
      lastAt,
      paused: run.hold === 'paused' && facts.isPaused(repo),
      autostart: Boolean(task?.autostart),
      needsYou,
    });
  },

  agentFor(uuid, map, links, github = []) {
    const run = links.runs.get(uuid);
    const lastAt = links.logs.get(uuid) ?? null;
    if (!run && !lastAt) return null;
    return {
      agent: run?.agent ?? map.claim ?? null,
      url: run?.url ?? map.session ?? null,
      trigger: run?.trigger ?? null,
      kind: run?.kind ?? null,
      // starting, started, or failed (Claude wouldn't start the session, and `error` says why).
      status: run?.status ?? null,
      error: run?.error ?? null,
      startedAt: run ? new Date(run.started).toISOString() : null,
      silentSince: run?.silent ? new Date(run.silent).toISOString() : null,
      lastAt: lastAt ? new Date(lastAt).toISOString() : null,
      live: Boolean(lastAt && Date.now() - lastAt < LIVE_MS),
      // What it's doing, what happens next, and what to do (WEB-41); null for output with no run behind it.
      state: run ? this.stateOf(run, { ...map, uuid, github }, lastAt, links.facts) : null,
    };
  },

  async agentsOverview() {
    await this.ready();
    const connected = await this.connectedRepos();
    const views = this.views();
    const live = this.runningAgents(views);
    const facts = this.runFacts();
    const running = live.map(({ run, task }) => {
      const last = this.sql
        .exec('SELECT at, data FROM agent_logs WHERE task = ? ORDER BY id DESC LIMIT 1', task.uuid)
        .toArray()[0];
      const entry = last ? JSON.parse(last.data) : null;
      const lastLine = entry
        ? (entry.kind === 'tool' ? `${entry.tool}: ${entry.title ?? entry.detail ?? ''}` : (entry.text ?? ''))
            .split('\n')[0]
            .slice(0, 200)
        : null;
      return {
        uuid: task.uuid,
        wid: task.wid,
        description: task.description,
        project: task.project,
        repo: task.repo,
        agent: run.agent,
        trigger: run.trigger,
        forced: Boolean(run.forced),
        url: run.url,
        startedAt: new Date(run.started).toISOString(),
        silentSince: run.silent ? new Date(run.silent).toISOString() : null,
        lastAt: last ? new Date(last.at).toISOString() : null,
        live: Boolean(last && Date.now() - last.at < LIVE_MS),
        lastLine,
        state: this.stateOf(run, task, last?.at ?? null, facts),
      };
    });
    const byUuid = new Map(views.map((t) => [t.uuid, t]));
    const recent = this.sql
      .exec(
        'SELECT r.*, (SELECT MAX(id) FROM agent_runs WHERE task = r.task) AS latest, (SELECT MAX(at) FROM agent_logs WHERE task = r.task) AS last_at FROM agent_runs r ORDER BY r.id DESC LIMIT 15',
      )
      .toArray()
      .map((row) => {
        const map = this.tasks.get(row.task);
        return {
          ...this.agentRun(row.id),
          uuid: row.task,
          latest: row.latest === row.id,
          wid: map?.wid ?? null,
          description: map?.description ?? '(deleted task)',
          taskStatus: map?.status ?? 'gone',
          state: this.stateOf(row, byUuid.get(row.task) ?? null, row.last_at ?? null, facts, row.latest === row.id),
        };
      });
    // Each repository's share of the board's slots and budget, and its own caps (IDEA-14 section 4).
    const repos = this.repos().map((r) => ({
      slug: r.slug,
      name: r.name,
      github: r.github,
      isDefault: r.isDefault,
      connected: connected.has(r.slug),
      running: live.filter(({ task }) => task.repo === r.slug).length,
      used: this.startsThisHour(r.slug),
      caps: routineCaps(r),
    }));
    return {
      status: 200,
      body: {
        // Any repository's routine: the default one's alone decides nothing once there are several.
        connected: connected.size > 0,
        settings: this.agentSettings(),
        budget: { used: this.startsThisHour(), limit: this.agentSettings().hourly },
        // The plan picker (CLD-198): what each plan allows, and the ceilings for the plan picked.
        plans: planChoices(),
        limits: planLimits(this.claudePlan(), connected.size),
        repos,
        running,
        queue: this.autostartQueue(views, connected),
        // The chases that are on, with their live line, Needs you, Stuck, and queue (IDEA-28 section 3.9).
        chases: this.chasesOn(views, connected),
        // Pull requests two fix agents didn't get green: no third starts without the owner (BRK-145).
        needsYou: this.fixesNeedingYou(),
        recent,
      },
    };
  },

  /**
   * Switches the board to Claude plan `plan`: the shared limits and the routines' daily cap go back to its
   * defaults (by forgetting what was set), and a routine's daily cap or a repository's cap on agents at once
   * above its ceilings comes down to them. Starts an hour needs no clamp: Claude's limits are every plan's.
   */
  applyPlan(plan) {
    const { agents, routineDaily } = PLANS[plan];
    this.setMeta('claude_plan', plan);
    for (const key of ['agents_max', 'agents_hourly', 'routines_daily_cap']) this.setMeta(key, null);
    this.sql.exec('UPDATE routines SET daily_cap = ? WHERE daily_cap > ?', routineDaily.most, routineDaily.most);
    for (const repo of this.repos()) {
      if (!(repo.routine?.max > agents.most)) continue;
      this.sql.exec(
        'UPDATE repos SET routine = ? WHERE slug = ?',
        JSON.stringify({ ...repo.routine, max: agents.most }),
        repo.slug,
      );
      this.repoCache = null;
    }
  },

  /**
   * Changes the shared limits. `plan` comes first: picking one sets agents at once, starts an hour, and the
   * routines' daily cap to its defaults, and brings every cap above its ceilings down to them, so `max` and
   * `hourly` in the same request are checked against the new plan. Only the owner picks the plan (`by`).
   */
  async updateAgentSettings({ plan, max, hourly, autostart, alerts, by }) {
    await this.ready();
    if (plan !== undefined) {
      if (by !== undefined && by !== null && by !== '' && by !== 'owner')
        throw new AgentError('only the owner picks the Claude plan', 403);
      if (!isPlan(plan)) throw new AgentError(`the plan is one of ${Object.keys(PLANS).join(', ')}`, 400);
      this.writable();
      this.applyPlan(plan);
    }
    const ceilings = planLimits(this.claudePlan(), (await this.connectedRepos()).size);
    if (max !== undefined) {
      const n = Number(max);
      if (!Number.isInteger(n) || n < 1 || n > ceilings.agents)
        throw new AgentError(
          `agents at once is a number from 1 to ${ceilings.agents} on ${planOf(this.claudePlan()).name}`,
          400,
        );
      this.setMeta('agents_max', n);
    }
    if (hourly !== undefined) {
      const n = Number(hourly);
      if (!Number.isInteger(n) || n < 1 || n > ceilings.hourly)
        throw new AgentError(
          `starts an hour is a number from 1 to ${ceilings.hourly} (Claude allows ${CLAUDE_LIMITS.routineHourly} for each connected routine, ${CLAUDE_LIMITS.accountHourly} in all)`,
          400,
        );
      this.setMeta('agents_hourly', n);
    }
    if (autostart !== undefined) this.setMeta('agents_autostart', autostart ? 'on' : 'off');
    if (alerts !== undefined) {
      if (!['off', 'critical', 'high', 'medium', 'all'].includes(alerts))
        throw new AgentError('alerts is off, critical, high, medium, or all', 400);
      this.setMeta('agents_alerts', alerts);
    }
    if (autostart) this.scheduleAgentsCheck();
    return this.agentSettings();
  },

  /** Agent runs between two times (ms), for the activity feed. */
  agentEvents(after, upTo) {
    return this.sql
      .exec('SELECT * FROM agent_runs WHERE started > ? AND started <= ? ORDER BY started DESC', after, upTo)
      .toArray()
      .map((r) => ({
        id: r.id,
        at: r.started,
        task: r.task,
        kind: r.status === 'failed' ? 'agent_failed' : 'agent_started',
        trigger: r.trigger,
        forced: Boolean(r.forced),
        url: r.url,
        error: r.error,
        agent: r.agent,
      }));
  },

  async alarm() {
    await this.tick();
  },

  /**
   * What the alarm and the 5-minute cron do: catch up with GitHub, start ready agents, prune. The cron's
   * run (`source` 'cron') is recorded for the Connections view, which it also re-checks once an hour.
   */
  async tick(source = 'alarm') {
    const errors = [];
    try {
      // The alarm reconciles the repositories webhooks named; the cron, every one of them.
      const result = await this.reconcileGitHub({ only: source === 'cron' ? null : this.takeDirtyRepos() });
      if (result?.error) errors.push(result.error);
    } catch (error) {
      errors.push(error.message); /* recorded in gh_error */
    }
    try {
      await this.autostartTick();
    } catch (error) {
      errors.push(error.message); /* tries again next time */
    }
    // GitHub's status page (BRK-217), before the chase: while GitHub is down, a chase starts nothing new.
    await this.githubStatusCheck();
    // A chase starts after auto-start, so security fixes, general agents, and Start-when-ready tasks go first.
    try {
      await this.chaseTick();
    } catch (error) {
      errors.push(error.message); /* tries again next time */
    }
    // Silent sessions and pull requests green again (BRK-145), after the reconcile saw GitHub.
    try {
      this.fixesTick();
      await this.silentTick();
    } catch (error) {
      errors.push(error.message); /* tries again next time */
    }
    try {
      await this.scheduleTick();
    } catch (error) {
      errors.push(error.message); /* the next slot tries again */
    }
    // An install that follows a channel (BRK-10): the cron looks for a release; the alarm, after breakaway's release webhook.
    await this.updatesAutoCheck(source);
    // A self-update waiting on its health check (BRK-53): the new code answers, or the previous version comes back.
    await this.selfUpdateTick();
    // Before the prune: agent runs and GitHub's rows live on in the dashboard's log (store-stats.js).
    this.archiveStats();
    this.pruneAgentLogs();
    if (source === 'cron') {
      this.connectionsCronRan(errors);
      await this.connectionsAutoCheck();
    }
  },
};
