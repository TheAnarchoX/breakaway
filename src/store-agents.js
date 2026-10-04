/**
 * TaskStore's cloud agents (docs/specs/CLD-35-cloud-agents.md): start a Claude Code cloud session
 * on a task through a routine's /fire endpoint, pick the next few tasks that won't collide, start
 * tasks by themselves when they become ready, keep to the limits, and hold each session's live
 * output for the board to show (for watching only: capped, pruned, never in a version).
 */
import { secret } from './secrets.js';
import { refinePrompt } from './decision.js';
import { prVerdict } from './github.js';
import { AREA_NAMES, dependsOf, rank, relatedOf } from './model.js';
import { routineCaps } from './repos.js';
import { CLAUDE_LIMITS, DEFAULT_PLAN, hourlyCeiling, isPlan, planChoices, planLimits, planOf, PLANS } from './plans.js';

const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'error']);

const RUNNING_HOURS = 12; // after this, a claimed task no longer counts as a running agent
const LIVE_MS = 120_000; // output within the last 2 minutes: the session is live
const STARTING_MS = 600_000; // a session the board started and that hasn't said anything yet is still starting for 10 minutes
const LOG_KEEP = 1000; // entries per task
const LOG_DAYS = 14;
const KINDS = new Set(['tool', 'message', 'start', 'prompt']);
/** "high" means high and critical; "all" includes low. */
const SEVERITY = { off: 0, critical: 4, high: 3, medium: 2, moderate: 2, low: 1, all: 1 };

export class AgentError extends Error {
  /** `forceable`: only the board's own limits refuse the start, so Force start (the owner's) could skip it. */
  constructor(message, status = 409, { forceable = false } = {}) {
    super(message);
    this.status = status;
    this.forceable = forceable;
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
    throw new AgentError('couldn’t reach Claude to start the session; try again', 502);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message ?? res.statusText;
    if (res.status === 429)
      throw new AgentError(
        `Claude’s hourly limit for starting sessions is reached (try again after ${res.headers.get('Retry-After') ?? 'a while'} seconds)`,
        429,
      );
    if (res.status === 401)
      throw new AgentError(
        `the ${slug ? `${slug} ` : ''}routine’s token was refused: connect the routine again (${connectCommand(slug)})`,
        502,
      );
    if (res.status === 400 && /paused/iu.test(message))
      throw new AgentError(`the ${slug ? `${slug} ` : ''}routine is paused on claude.ai`, 409);
    throw new AgentError(`Claude couldn’t start the session (${res.status}: ${message})`, 502);
  }
  if (!data.claude_code_session_url) throw new AgentError('Claude started something but sent no session link', 502);
  return { id: data.claude_code_session_id ?? null, url: data.claude_code_session_url };
}

const TRIGGER_TEXT = {
  alert: 'for a GitHub security alert, from the board',
  manual: 'by hand, from the board',
  review: 'by “Safe to merge?” on a Dependabot pull request, from the board',
  next: 'as one of the next few ready tasks, from the board',
  auto: 'by itself, because the task became ready and is marked Start when ready',
  pr: 'to fix a pull request, from the board',
  routine: 'by a routine, from the board',
  schedule: 'by a routine’s schedule, from the board',
  github: 'by a routine’s GitHub event, from the board',
  webhook: 'by a routine’s webhook or API trigger, from the board',
  cloudflare: 'by a Cloudflare alert, from the board',
  general: 'by a prompt from the owner, from the board',
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
    ...(kind === 'routine' ? ['Mode: routine', `Routine: ${routine}`] : []),
    ...(kind === 'general' ? ['Mode: general'] : []),
    // Only a count: the images stay on the board, and the agent fetches them by task ID.
    ...(attachments > 0 ? [`Attachments: ${attachments}`] : []),
    ...(note
      ? [
          '',
          kind === 'refine' ? 'Refinement request:' : kind === 'fix-pr' ? 'What is wrong:' : 'Note from the owner:',
          String(note).slice(0, 4000),
        ]
      : []),
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
  },

  // ---- routines per repository ----------------------------------------------------------------

  /** The routine that starts agents in repository `slug`, or null while it isn't connected. */
  routineFor(slug) {
    return routineCredentials(this.env, slug === this.defaultRepoSlug() ? null : slug);
  },

  /** The registered repositories whose routine is connected. */
  async connectedRepos() {
    const fallback = this.defaultRepoSlug();
    const [own, others] = await Promise.all([routineCredentials(this.env), otherRoutines(this.env)]);
    const connected = new Set();
    for (const repo of this.repos()) if (repo.slug === fallback ? own : others[repo.slug]) connected.add(repo.slug);
    return connected;
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
   * from that decision is open, it returns that one with `already` instead of starting another.
   */
  async startGeneral({ prompt, repo = null, force = false, decision = null, note = null } = {}) {
    await this.ready();
    let text = String(prompt ?? '').trim();
    let title = null;
    let from = null;
    if (decision !== null && decision !== undefined && decision !== '') {
      if (text) throw new AgentError('the board writes the prompt from the decision: send a note instead', 400);
      from = this.resolve(decision);
      const d = this.detail(from);
      const ref = d.wid ?? d.short;
      if (!d.decision) throw new AgentError(`${ref} has no decision`, 400);
      if (d.status !== 'completed' || !d.decisionAnswers)
        throw new AgentError(`${ref}’s decision isn’t answered yet: the owner answers it on the board first`, 409);
      if (repo && String(repo).trim().toLowerCase() !== d.repo)
        throw new AgentError(`${ref} is ${d.repo}’s: its agent runs in ${d.repo}`, 400);
      repo = d.repo;
      const open = [...this.tasks].find(
        ([, map]) => map.status === 'pending' && map.tag_general && relatedOf(map).includes(from),
      );
      if (open) {
        const task = this.detail(open[0]);
        return {
          task,
          run: null,
          waiting: null,
          already: task.claim ? `${task.claim} is on it` : 'it’s waiting to start',
        };
      }
      const waiting = this.views((t) => t.status === 'pending' && dependsOf(this.tasks.get(t.uuid)).includes(from)).map(
        (t) => ({ ref: t.wid ?? t.short, description: t.description, tags: t.tags, spec: t.spec }),
      );
      const written = refinePrompt(
        {
          ref,
          description: d.description,
          spec: d.spec,
          questions: d.decision,
          answers: d.decisionAnswers.answers,
        },
        waiting,
        note,
      );
      text = written.brief;
      title = written.title;
    }
    if (!text) throw new AgentError('write what the agent should do first', 400);
    if (!repo && this.repos().length > 1)
      throw new AgentError(
        `say which repository this is for: ${this.repos()
          .map((r) => r.slug)
          .join(', ')}`,
        400,
      );
    const slug = this.checkRepoSlug(repo);
    await this.checkRoutineReady(slug);
    const res = await this.create([
      {
        description: title ?? (text.split('\n').find((line) => line.trim()) ?? text).trim().slice(0, 200),
        horizon: 'now',
        tags: ['agent', 'general'],
        autostart: 'yes',
        brief: text,
        ...(from ? { related: [from] } : {}),
        ...(slug === this.defaultRepoSlug() ? {} : { repo: slug }),
        by: 'owner',
      },
    ]);
    if (res.status !== 201) throw new AgentError(res.body.error ?? 'couldn’t make a task for the agent', res.status);
    const uuid = res.body.tasks[0].uuid;
    try {
      return { ...(await this.startAgent(uuid, { trigger: 'general', kind: 'general', force })), waiting: null };
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
    if (!/^dependabot(\[bot\])?$/iu.test(pr.author ?? ''))
      throw new AgentError(`#${pr.number} isn’t a Dependabot pull request`, 400);
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
   * The agent never merges: it pushes a fix or leaves a note.
   */
  async fixPr(number, { problem = null, note = null, repo = null, force = false } = {}) {
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
    const reviewOpen = pr.review?.decision === 'changes_requested' || pr.review?.comments > 0;
    const applies = { conflicts: verdict === 'conflicts', failing: verdict === 'failing', review: reviewOpen };
    const chosen = problem ?? (['conflicts', 'failing'].includes(verdict) ? verdict : reviewOpen ? 'review' : null);
    if (!chosen || !(chosen in applies))
      throw new AgentError(
        problem ? 'problem is conflicts, failing, or review' : `#${number} has nothing for an agent to fix`,
        problem ? 400 : 409,
      );
    if (!applies[chosen]) throw new AgentError(`#${number} doesn’t have that problem now`);

    const failing = (pr.checks?.runs ?? []).filter((r) => FAILED.has(r.state)).map((r) => r.name);
    const what = {
      conflicts: `It conflicts with ${this.repoBySlug(slug)?.defaultBranch ?? 'main'} (merge state: ${pr.mergeableState ?? 'unknown'}). Merge ${this.repoBySlug(slug)?.defaultBranch ?? 'main'} into the branch and resolve the conflicts.`,
      failing: `Checks are failing: ${failing.join(', ') || 'see the pull request'}. Find the cause, fix it, and push.`,
      review: `It has review comments to address${pr.review?.decision === 'changes_requested' ? ' (changes were requested)' : ''}. Read each open thread and address it or reply.`,
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
    const text = [what, note ? `Owner's note: ${String(note).slice(0, 2000)}` : null].filter(Boolean).join('\n');
    return {
      ...(await this.startAgent(uuid, { trigger: 'pr', note: text, kind: 'fix-pr', pr: pr.number, force })),
      already: null,
    };
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
      if (!['review', 'fix-pr'].includes(run.kind) && t.github?.some((p) => p.closes && p.state === 'open')) continue;
      running.push({ run, task: t });
    }
    return running;
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
    if (kind === 'refine' && !String(note ?? '').trim())
      throw new AgentError('say what it should look at or change', 400);
    const map = this.tasks.get(uuid);
    const repo = map ? this.repoOfTask(map) : this.githubRepo();
    if (!repo) throw new AgentError(`${map.wid ?? 'This task'} is in ${map.repo}, which isn’t a registered repository`);
    const isDefault = repo.slug === this.defaultRepoSlug();
    const credentials = await this.checkRoutineReady(repo.slug);

    // Everything from here to the claim is synchronous: two starts can't both pass.
    const views = this.views();
    const task = views.find((t) => t.uuid === uuid);
    const onPr = kind === 'review' || kind === 'fix-pr';
    const blocker =
      kind === 'refine' ? this.refineBlocker(task) : onPr ? this.prAgentBlocker(task, kind) : this.agentBlocker(task);
    if (blocker)
      throw new AgentError(
        `${task?.wid ?? 'This task'} can’t ${kind === 'refine' ? 'be refined' : onPr ? 'take an agent on its pull request' : 'start an agent'}: ${blocker}`,
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

    // A build is `claude-<id>`, a refinement `claude-refine-<id>`, a fix `claude-<id>-fix`, a Dependabot check `claude-<id>-check`.
    const id = (kind === 'general' ? task.short : (task.wid ?? task.short)).toLowerCase();
    const agent =
      kind === 'refine'
        ? `claude-refine-${id}`
        : kind === 'fix-pr'
          ? `claude-${id}-fix`
          : kind === 'review'
            ? `claude-${id}-check`
            : `claude-${id}`;
    this.writable();
    const taken = onPr && task.claim ? task.claim : null;
    this.change(
      uuid,
      {
        claim: agent,
        start: true,
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
      const session = await fireRoutine(
        credentials,
        firePayload(task, agent, trigger, note, kind, pr, routine, attachments, repo),
        isDefault ? null : repo.slug,
      );
      this.sql.exec(
        "UPDATE agent_runs SET status = 'started', session_id = ?, url = ? WHERE id = ?",
        session.id,
        session.url,
        runId,
      );
      if (this.tasks.get(uuid)?.claim === agent) this.change(uuid, { session: session.url }, new Date(), 'agents');
      return { run: this.agentRun(runId), task: this.detail(uuid) };
    } catch (error) {
      this.sql.exec("UPDATE agent_runs SET status = 'failed', error = ? WHERE id = ?", error.message, runId);
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
    // Security fixes first, then general agents (the owner asked for them now), then the rest.
    const order = (t) => (t.alert ? 0 : t.tags.includes('general') ? 1 : 2);
    const waiting = views.filter((v) => v.autostart && v.status === 'pending' && !v.claim);
    for (const t of waiting.sort((a, b) => order(a) - order(b) || rank(a, b))) {
      const blocker = this.agentBlocker(t);
      let reason = blocker;
      // A general agent has no area until it picks one, and the owner pressed Start: only room holds it back.
      const general = t.tags.includes('general');
      // Force start (BRK-105) skips the board's own limits only: not a blocked task, an unconnected routine, or Claude's limit.
      let forceable = false;
      if (!repoRoom.has(t.repo)) repoRoom.set(t.repo, this.repoRoom(t.repo, running));
      if (!reason && !autostart && !general) {
        reason = 'auto-start is off';
        forceable = true;
      }
      if (!reason && connected && !connected.has(t.repo)) reason = `${t.repo}’s agent routine isn’t connected`;
      // A security fix doesn't wait for its area to be free.
      if (!reason && busy.has(area(t)) && !t.alert && !general) {
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
        if (!general) busy.set(area(t), t.wid);
      }
      queue.push({
        uuid: t.uuid,
        wid: t.wid,
        description: t.description,
        project: t.project,
        repo: t.repo,
        general,
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
      try {
        await this.startAgent(item.uuid, item.general ? { trigger: 'general', kind: 'general' } : { trigger: 'auto' });
        started.push(item.wid ?? item.uuid);
      } catch {
        // It stays in the queue; the next tick tries again.
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
    if (!this.hasAutostart()) return;
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
    const runRow = this.sql
      .exec('SELECT id FROM agent_runs WHERE task = ? ORDER BY id DESC LIMIT 1', uuid)
      .toArray()[0];
    return {
      entries,
      lastAt: last ? new Date(last).toISOString() : null,
      live: Boolean(last && Date.now() - last < LIVE_MS),
      run: runRow ? this.agentRun(runRow.id) : null,
    };
  },

  pruneAgentLogs() {
    this.sql.exec('DELETE FROM agent_logs WHERE at < ?', Date.now() - LOG_DAYS * 86_400_000);
    this.sql.exec('DELETE FROM agent_runs WHERE started < ?', Date.now() - 30 * 86_400_000);
    this.pruneMessages();
  },

  /** Per task: its latest run and when its session last said something (for cards). */
  agentLinks() {
    const runs = new Map();
    for (const r of this.sql
      .exec(
        'SELECT task, agent, url, started, trigger FROM agent_runs WHERE id IN (SELECT MAX(id) FROM agent_runs GROUP BY task)',
      )
      .toArray())
      runs.set(r.task, r);
    const logs = new Map(
      this.sql
        .exec('SELECT task, MAX(at) AS at FROM agent_logs GROUP BY task')
        .toArray()
        .map((r) => [r.task, r.at]),
    );
    return { runs, logs };
  },

  agentFor(uuid, map, links) {
    const run = links.runs.get(uuid);
    const lastAt = links.logs.get(uuid) ?? null;
    if (!run && !lastAt) return null;
    return {
      agent: run?.agent ?? map.claim ?? null,
      url: run?.url ?? map.session ?? null,
      trigger: run?.trigger ?? null,
      startedAt: run ? new Date(run.started).toISOString() : null,
      lastAt: lastAt ? new Date(lastAt).toISOString() : null,
      live: Boolean(lastAt && Date.now() - lastAt < LIVE_MS),
    };
  },

  async agentsOverview() {
    await this.ready();
    const connected = await this.connectedRepos();
    const views = this.views();
    const live = this.runningAgents(views);
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
        lastAt: last ? new Date(last.at).toISOString() : null,
        live: Boolean(last && Date.now() - last.at < LIVE_MS),
        lastLine,
      };
    });
    const recent = this.sql
      .exec('SELECT id FROM agent_runs ORDER BY id DESC LIMIT 15')
      .toArray()
      .map((r) => {
        const run = this.agentRun(r.id);
        const map = this.tasks.get(this.sql.exec('SELECT task FROM agent_runs WHERE id = ?', r.id).one().task);
        return {
          ...run,
          wid: map?.wid ?? null,
          description: map?.description ?? '(deleted task)',
          taskStatus: map?.status ?? 'gone',
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
