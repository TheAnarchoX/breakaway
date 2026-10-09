/**
 * TaskStore's risky-path review (docs/specs/BRK-280-risky-path-review.md). A repository lists its risky paths in
 * `.github/breakaway-infra/risky-paths.json`, read from its default branch so a pull request can't take its own paths
 * off the list. During a sync, each open pull request whose head moved is looked at once: when it touches a listed
 * path, the board starts a reviewer, a separate agent session that isn't the author's, on the task the pull request
 * closes, and posts one check on the head commit. The reviewer answers with `risk-review`; a finding it marks
 * blocking holds Merge when green until the author answers it with `risk-answer`. Merging stays the owner's: the
 * owner's own Merge press is never held.
 *
 * The reviewer's run is kept here, not in agent_runs: it never holds the task's claim, so it must not look like the
 * task's agent. Its start still counts toward the board's and the repository's starts an hour (startsThisHour).
 */
import { appCredentials, GitHubError } from './github.js';
import { AgentError } from './store-agents.js';
import {
  areasLine,
  ANSWER_MAX,
  checkReport,
  checkRiskyPaths,
  MAX_REVIEWS_PER_PULL,
  MAX_RISK_PULLS_PER_SYNC,
  RISK_CHECK_NAME,
  riskConclusion,
  riskHold,
  RISKY_PATHS_FILE,
  RISKY_PATHS_MAX_BYTES,
  riskSummary,
  riskTitle,
  riskyAreasIn,
  unanswered,
} from './risky-paths.js';

/** A pull request's files are read up to this many pages of 100. */
const FILE_PAGES = 3;
/** A closed pull request's review is kept this long, for its page. */
const KEEP_CLOSED_MS = 30 * 24 * 60 * 60_000;
/** A reviewer that hasn't answered in this long no longer counts as running. */
const REVIEWER_RUNNING_MS = 6 * 60 * 60_000;

const decode = (b64) =>
  new TextDecoder().decode(Uint8Array.from(atob(String(b64 ?? '').replace(/\s+/gu, '')), (c) => c.charCodeAt(0)));

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const riskyReviewMethods = {
  initRiskyReview() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS risk_reviews (
        repo TEXT NOT NULL, number INTEGER NOT NULL, sha TEXT NOT NULL, checked_at INTEGER NOT NULL,
        state TEXT NOT NULL, task TEXT, areas TEXT, reviews INTEGER NOT NULL DEFAULT 0,
        agent TEXT, session_url TEXT, started INTEGER, summary TEXT, findings TEXT, answers TEXT, reported_at INTEGER,
        check_id INTEGER, check_url TEXT, check_sha TEXT, error TEXT,
        PRIMARY KEY (repo, number)
      );
    `);
  },

  /** Reviewers the board started this hour, for startsThisHour: all of them, or one repository's. */
  riskStartsThisHour(slug = null) {
    const since = Date.now() - 3_600_000;
    return slug
      ? this.sql.exec('SELECT COUNT(*) AS n FROM risk_reviews WHERE started > ? AND repo = ?', since, slug).one().n
      : this.sql.exec('SELECT COUNT(*) AS n FROM risk_reviews WHERE started > ?', since).one().n;
  },

  /** Reviewers still reading: started, not answered, and not given up on. */
  riskReviewersRunning() {
    return this.sql
      .exec(
        "SELECT COUNT(*) AS n FROM risk_reviews WHERE state = 'reviewing' AND started > ?",
        Date.now() - REVIEWER_RUNNING_MS,
      )
      .one().n;
  },

  /**
   * During a sync, from the listing of the desired-state folder on the default branch (readDesiredStates, which
   * reads it once per new commit there): the repository's list, kept in meta as `{ list }`, `{ error }` when it
   * doesn't check, or `{}` when the repository has none, so a repository without one costs no call.
   * @param {any} client
   * @param {{ slug: string, defaultBranch?: string }} repo
   * @param {string | null} sha the default branch's newest commit
   * @param {any[]} entries the folder's listing
   */
  async readRiskyPaths(client, repo, sha, entries) {
    const entry = entries.find((e) => e?.type === 'file' && e.name === RISKY_PATHS_FILE.split('/').at(-1));
    let got = {};
    if (entry && Number(entry.size ?? 0) > RISKY_PATHS_MAX_BYTES)
      got = { error: `${RISKY_PATHS_FILE} is over ${RISKY_PATHS_MAX_BYTES / 1024} KB` };
    else if (entry) {
      const ref = encodeURIComponent(repo.defaultBranch || 'main');
      let file = null;
      try {
        file = await client.get(
          `/contents/${RISKY_PATHS_FILE.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`,
        );
      } catch (error) {
        if (!(error instanceof GitHubError) || error.status !== 404) throw error;
      }
      if (file && !Array.isArray(file) && file.type === 'file') got = checkRiskyPaths(decode(file.content));
    }
    this.setMeta(`risky_list:${repo.slug}`, JSON.stringify({ sha, got }));
  },

  /**
   * During a sync: look at the open pull requests whose head moved since they were last looked at (and the ones
   * waiting for room to start a reviewer, or published since they were drafts), up to MAX_RISK_PULLS_PER_SYNC.
   * The list is the one readRiskyPaths kept from the default branch. Returns its problem, if it has one, for the
   * sync's errors.
   * @param {any} client the repository's GitHub client
   * @param {{ slug: string }} repo
   * @param {any[]} pulls GitHub's list, newest update first
   */
  async checkRiskyPulls(client, repo, pulls) {
    const open = (pulls ?? []).filter((p) => p.state === 'open' && p.head?.sha);
    this.sql.exec(
      'DELETE FROM risk_reviews WHERE repo = ? AND checked_at < ? AND number NOT IN (SELECT value FROM json_each(?))',
      repo.slug,
      Date.now() - KEEP_CLOSED_MS,
      JSON.stringify(open.map((p) => p.number)),
    );
    const got = JSON.parse(this.meta(`risky_list:${repo.slug}`) ?? 'null')?.got ?? {};
    if ('error' in got) return `risky paths: ${got.error}`;
    if (!got.list) return null;
    const rows = new Map(
      this.sql
        .exec('SELECT number, sha, state FROM risk_reviews WHERE repo = ?', repo.slug)
        .toArray()
        .map((r) => [Number(r.number), r]),
    );
    const due = open
      .filter((p) => {
        const row = rows.get(p.number);
        if (!row || row.sha !== p.head.sha) return true;
        if (row.state === 'waiting') return true;
        return row.state === 'draft' && !p.draft;
      })
      .slice(0, MAX_RISK_PULLS_PER_SYNC);
    for (const pull of due) await this.checkRiskyPull(client, repo, pull, got.list);
    return null;
  },

  /** One pull request at its head: which risky areas it touches, the reviewer, and the check. */
  async checkRiskyPull(client, repo, pull, list) {
    const sha = pull.head.sha;
    const before = this.riskRow(repo.slug, pull.number);
    const same = before && before.sha === sha;
    // A draft waits until it's published: no files read, nothing posted.
    if (pull.draft) {
      this.keepRiskRow(repo.slug, pull.number, {
        ...(same ? before : { reviews: before?.reviews ?? 0 }),
        sha,
        state: 'draft',
      });
      return;
    }
    let areas = same && before.state === 'waiting' ? before.areas : null;
    if (!areas) {
      const files = [];
      for (let page = 1; page <= FILE_PAGES; page += 1) {
        let batch;
        try {
          batch = await client.get(`/pulls/${pull.number}/files?per_page=100&page=${page}`);
        } catch (error) {
          if (!(error instanceof GitHubError) || error.status !== 404) throw error;
          batch = [];
        }
        files.push(...(batch ?? []));
        if ((batch ?? []).length < 100) break;
      }
      areas = riskyAreasIn(list, files);
    }
    const reviews = before?.reviews ?? 0;
    if (!areas.length) {
      this.keepRiskRow(repo.slug, pull.number, { sha, state: 'clear', reviews });
      return;
    }
    const named = (side) => String(side?.repo?.full_name ?? '').toLowerCase();
    const outside = !named(pull.head) || named(pull.head) !== named(pull.base);
    const stored = this.sql
      .exec('SELECT data FROM gh_pulls WHERE repo = ? AND number = ?', repo.slug, pull.number)
      .toArray()[0];
    const task = stored ? this.prTask({ ...JSON.parse(stored.data), repo: repo.slug }) : null;
    /** @type {Record<string, any>} */
    const row = { sha, areas, reviews, task, state: 'reviewing', check: same ? before.check : null };
    if (outside) row.state = 'outside';
    else if (!task) row.state = 'no-task';
    else if (reviews >= MAX_REVIEWS_PER_PULL) row.state = 'capped';
    else {
      try {
        const started = await this.startRiskReviewer(task, { pr: pull.number, areas });
        Object.assign(row, { reviews: reviews + 1, agent: started.agent, session: started.url, started: Date.now() });
      } catch (error) {
        if (!error?.message) throw error;
        // The board's own room (agents at once, starts an hour) frees up: try again next sync, and hold meanwhile.
        // Anything else (no routine, Claude's refusal) won't, so nothing holds the pull request.
        row.state = error.forceable || error.status === 429 ? 'waiting' : 'unstarted';
        row.error = String(error.message).slice(0, 300);
      }
    }
    this.keepRiskRow(repo.slug, pull.number, row);
    await this.postRiskCheck(client, repo, pull.number);
    // GitHub's auto-merge, already on, would merge it on green before the review is in.
    if (pull.auto_merge && riskHold(this.riskRow(repo.slug, pull.number)))
      await this.stopRiskyAutoMerge(client, repo, pull.number);
  },

  /**
   * Starts the reviewer on task `uuid` for pull request `pr`: a separate session through the repository's routine,
   * named `claude-<id>-risk`, that never takes the task's claim. The board's limits hold as for any start.
   * @returns {Promise<{ agent: string, url: string | null }>}
   */
  async startRiskReviewer(uuid, { pr, areas }) {
    const map = this.tasks.get(uuid);
    const repo = this.repoOfTask(map);
    if (!repo) throw new AgentError(`${map.wid ?? 'the task'} is in a repository that isn’t registered`);
    const credentials = await this.checkRoutineReady(repo.slug);
    const views = this.views();
    const task = views.find((t) => t.uuid === uuid);
    const room = this.agentRoomBlocker(repo.slug, views);
    if (room) throw room;
    const agent = `claude-${(task.wid ?? task.short).toLowerCase()}-risk`;
    if (task.claim === agent) throw new AgentError(`${agent} holds ${task.wid}: it can’t review its own work`);
    const session = await this.fireRiskReviewer(credentials, repo, task, agent, { pr, risky: areasLine(areas) });
    return { agent, url: session.url ?? null };
  },

  /** Posts the check for pull request `number`, or updates the one already on its head commit. */
  async postRiskCheck(client, repo, number) {
    const row = this.riskRow(repo.slug, number);
    if (!row || ['clear', 'draft'].includes(row.state)) return;
    const { status, conclusion } = riskConclusion(row);
    const home = this.homeUrl();
    const page = home ? `${home}/#/github?pr=${repo.slug}:${number}` : null;
    const body = {
      name: RISK_CHECK_NAME,
      head_sha: row.sha,
      status,
      ...(conclusion ? { conclusion, completed_at: new Date().toISOString() } : {}),
      ...(page ? { details_url: page } : {}),
      output: { title: riskTitle(row), summary: riskSummary(row, { page }) },
    };
    let check = row.check;
    let error = null;
    try {
      const run =
        check?.id && check.sha === row.sha
          ? await client.send('PATCH', `/check-runs/${check.id}`, body)
          : await client.send('POST', '/check-runs', body);
      check = { id: run?.id ?? check?.id ?? null, url: run?.html_url ?? check?.url ?? null, sha: row.sha };
    } catch (e) {
      // Without the App's Checks write permission the board still holds Merge when green and shows the review.
      if (!(e instanceof GitHubError) || e.status !== 403) throw e;
      error =
        'GitHub refused the check: give the GitHub App the Checks permission (read and write) and accept it on GitHub';
    }
    this.sql.exec(
      'UPDATE risk_reviews SET check_id = ?, check_url = ?, check_sha = ?, error = COALESCE(?, error) WHERE repo = ? AND number = ?',
      check?.id ?? null,
      check?.url ?? null,
      check?.sha ?? null,
      error,
      repo.slug,
      number,
    );
  },

  /** A new review of a pull request at a commit, or a change to the one kept, replacing what was there. */
  keepRiskRow(slug, number, r) {
    this.sql.exec(
      `INSERT INTO risk_reviews (repo, number, sha, checked_at, state, task, areas, reviews, agent, session_url, started,
         summary, findings, answers, reported_at, check_id, check_url, check_sha, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo, number) DO UPDATE SET sha = excluded.sha, checked_at = excluded.checked_at,
         state = excluded.state, task = excluded.task, areas = excluded.areas, reviews = excluded.reviews,
         agent = excluded.agent, session_url = excluded.session_url, started = excluded.started,
         summary = excluded.summary, findings = excluded.findings, answers = excluded.answers,
         reported_at = excluded.reported_at, check_id = excluded.check_id, check_url = excluded.check_url,
         check_sha = excluded.check_sha, error = excluded.error`,
      slug,
      Number(number),
      r.sha,
      Date.now(),
      r.state,
      r.task ?? null,
      r.areas ? JSON.stringify(r.areas) : null,
      r.reviews ?? 0,
      r.agent ?? null,
      r.session ?? null,
      r.started ?? null,
      r.summary ?? null,
      r.findings ? JSON.stringify(r.findings) : null,
      r.answers ? JSON.stringify(r.answers) : null,
      r.reportedAt ?? null,
      r.check?.id ?? null,
      r.check?.url ?? null,
      r.check?.sha ?? null,
      r.error ?? null,
    );
  },

  /** The kept review of a pull request, or null. */
  riskRow(slug, number) {
    const r = this.sql
      .exec('SELECT * FROM risk_reviews WHERE repo = ? AND number = ?', slug, Number(number))
      .toArray()[0];
    if (!r) return null;
    return {
      repo: r.repo,
      number: Number(r.number),
      sha: r.sha,
      state: r.state,
      task: r.task ?? null,
      areas: JSON.parse(r.areas ?? '[]'),
      reviews: Number(r.reviews),
      agent: r.agent ?? null,
      session: r.session_url ?? null,
      started: r.started ?? null,
      summary: r.summary ?? null,
      findings: JSON.parse(r.findings ?? '[]'),
      answers: JSON.parse(r.answers ?? '[]'),
      reportedAt: r.reported_at ?? null,
      check: r.check_id || r.check_url ? { id: r.check_id ?? null, url: r.check_url ?? null, sha: r.check_sha } : null,
      checkedAt: r.checked_at,
      error: r.error ?? null,
    };
  },

  /**
   * A pull request's risky-path review as its page shows it, or null when it touches nothing listed. `hold` says
   * why Merge when green waits, or is null.
   */
  riskReviewOut(slug, number) {
    const r = this.riskRow(slug, number);
    if (!r || ['clear', 'draft'].includes(r.state)) return null;
    const task = r.task ? this.tasks.get(r.task) : null;
    return {
      name: RISK_CHECK_NAME,
      sha: r.sha,
      state: r.state,
      task: task ? (task.wid ?? r.task.slice(0, 8)) : null,
      areas: r.areas,
      agent: r.agent,
      session: r.session,
      summary: r.summary,
      findings: r.findings,
      answers: r.answers,
      reportedAt: r.reportedAt ? new Date(r.reportedAt).toISOString() : null,
      check: r.check ? { id: r.check.id, url: r.check.url } : null,
      error: r.error,
      hold: riskHold(r),
    };
  },

  /** Why Merge when green waits on pull request `number`'s review, or null. */
  riskHoldOf(slug, number) {
    const r = this.riskRow(slug, number);
    return r ? riskHold(r) : null;
  },

  /** The review on one of task `uuid`'s pull requests that `match` picks, or a AgentError naming why none. */
  riskRowForTask(uuid, pr, match, none) {
    const rows = this.sql
      .exec('SELECT repo, number FROM risk_reviews WHERE task = ? ORDER BY number', uuid)
      .toArray()
      .map((r) => this.riskRow(r.repo, r.number))
      .filter(match);
    const wanted = pr === null || pr === undefined || pr === '' ? null : Number(String(pr).replace(/^#/u, ''));
    const row = wanted ? rows.find((r) => r.number === wanted) : rows.length === 1 ? rows[0] : null;
    if (row) return row;
    if (!wanted && rows.length > 1)
      throw new AgentError(
        `several pull requests match (${rows.map((r) => `#${r.number}`).join(', ')}): say which with --pr`,
      );
    throw new AgentError(none(wanted));
  },

  /** Updates the check on GitHub after a report or an answer, and turns Merge when green off while it holds. */
  async afterRiskChange(row) {
    const repo = this.repoBySlug(row.repo);
    const credentials = await appCredentials(this.env);
    if (!repo || !credentials) return;
    const client = this.githubClient(credentials, repo);
    try {
      await this.postRiskCheck(client, repo, row.number);
      const now = this.riskRow(row.repo, row.number);
      if (riskHold(now)) await this.stopRiskyAutoMerge(client, repo, row.number);
    } catch (error) {
      // The review is kept either way; the next sync posts the check again.
      if (!(error instanceof GitHubError)) throw error;
    }
  },

  /** Turns GitHub's auto-merge off on a held pull request, so it can't merge on green before the author answers. */
  async stopRiskyAutoMerge(client, repo, number) {
    const p = await client.get(`/pulls/${number}`);
    if (!p?.auto_merge || p.state !== 'open') return;
    await client.graphql(
      'mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }',
      { id: p.node_id },
    );
    this.sql.exec(
      'INSERT INTO gh_events (at, data, repo) VALUES (?, ?, ?)',
      Date.now(),
      JSON.stringify({
        kind: 'pr_auto_merge_off',
        number: p.number,
        title: p.title,
        url: p.html_url,
        wids: this.linksOf(p, repo.slug).closes,
        held: 'risky-path review',
      }),
      repo.slug,
    );
  },

  /**
   * The reviewer's answer (`risk-review <ID> --file …`): only the agent the board started to review that pull
   * request's head sends it, and never the task's own claim. Kept, commented on the task, and posted as the check.
   */
  async recordRiskReview(ref, { by, pr = null, summary, findings } = {}) {
    const agent = String(by ?? '').trim();
    if (!agent) throw new AgentError('say who reviewed: the agent name the board gave you', 400);
    const uuid = this.resolve(ref);
    const map = this.tasks.get(uuid);
    const id = map.wid ?? uuid.slice(0, 8);
    const row = this.riskRowForTask(
      uuid,
      pr,
      (r) => r.state === 'reviewing' && r.agent === agent,
      (n) =>
        `${agent} has no open risky-path review on ${n ? `#${n} for ` : ''}${id}: the board starts the reviewer, and a push since then starts a new one`,
    );
    if (map.claim === agent) throw new AgentError(`${agent} holds ${id}: a review comes from a separate session`);
    const checked = checkReport({ summary, findings });
    if ('error' in checked) throw new AgentError(checked.error, 400);
    this.writable();
    const now = Date.now();
    this.keepRiskRow(row.repo, row.number, {
      ...row,
      state: 'reviewed',
      summary: checked.summary,
      findings: checked.findings,
      answers: [],
      reportedAt: now,
    });
    const blocking = checked.findings.filter((f) => f.severity === 'blocking');
    const list = checked.findings
      .map(
        (f) =>
          `${f.n}. ${f.severity === 'blocking' ? 'Blocking' : 'Note'}${f.path ? ` (${f.path}${f.line ? `:${f.line}` : ''})` : ''}: ${f.text}`,
      )
      .join('\n');
    this.change(
      uuid,
      {
        annotate: [
          `Risky-path review of #${row.number} at ${row.sha.slice(0, 7)}: ${blocking.length ? `${blocking.length} blocking, Merge when green waits for the author’s answer (risk-answer ${id} <finding> "<answer>")` : 'nothing blocking'}`,
          '',
          checked.summary,
          ...(list ? ['', list] : []),
        ].join('\n'),
        by: agent,
      },
      new Date(now),
      'agents',
    );
    const kept = this.riskRow(row.repo, row.number);
    await this.afterRiskChange(kept);
    return { review: this.riskReviewOut(row.repo, row.number), task: this.detail(uuid) };
  },

  /**
   * The author's answer to one finding (`risk-answer <ID> <finding> <text>`): the agent holding the task, or the
   * owner. Not the reviewer. A blocking finding answered no longer holds Merge when green; answering again replaces it.
   */
  async answerRiskFinding(ref, { by, pr = null, finding, text } = {}) {
    const who = String(by ?? '').trim() || 'owner';
    const uuid = this.resolve(ref);
    const map = this.tasks.get(uuid);
    const id = map.wid ?? uuid.slice(0, 8);
    const row = this.riskRowForTask(
      uuid,
      pr,
      (r) => r.state === 'reviewed',
      (n) => `${id} has no risky-path review${n ? ` on #${n}` : ''} to answer`,
    );
    if (who === row.agent) throw new AgentError('the reviewer can’t answer its own findings: the author does');
    if (who !== 'owner' && map.claim !== who)
      throw new AgentError(
        `${id} is ${map.claim ? `${map.claim}’s` : 'unclaimed'}: the author answers, holding the task`,
      );
    const n = Number(String(finding ?? '').replace(/^#/u, ''));
    const f = row.findings.find((x) => x.n === n);
    if (!f)
      throw new AgentError(
        `#${row.number}’s review has no finding ${finding ?? ''}: it has ${row.findings.map((x) => `#${x.n}`).join(', ') || 'none'}`,
        400,
      );
    const answer = String(text ?? '').trim();
    if (!answer) throw new AgentError('say how you answered it: what you changed, or why it’s safe', 400);
    if (answer.length > ANSWER_MAX) throw new AgentError(`keep the answer under ${ANSWER_MAX} characters`, 400);
    this.writable();
    const answers = [
      ...row.answers.filter((a) => a.finding !== n),
      { finding: n, text: answer, by: who, at: new Date().toISOString() },
    ].sort((a, b) => a.finding - b.finding);
    this.keepRiskRow(row.repo, row.number, { ...row, answers });
    const left = unanswered(row.findings, answers);
    this.change(
      uuid,
      {
        annotate: `Answer to finding #${n} of #${row.number}’s risky-path review: ${answer}${left.length ? '' : '\n\nEvery blocking finding is answered: nothing holds Merge when green.'}`,
        by: who === 'owner' ? undefined : who,
      },
      new Date(),
      'agents',
    );
    await this.afterRiskChange(this.riskRow(row.repo, row.number));
    return { review: this.riskReviewOut(row.repo, row.number), task: this.detail(uuid) };
  },

  /** `risk-review <ID>` with nothing to send: the reviews on the task's pull requests. */
  riskReviewsOfTask(ref) {
    const uuid = this.resolve(ref);
    return this.sql
      .exec('SELECT repo, number FROM risk_reviews WHERE task = ? ORDER BY number', uuid)
      .toArray()
      .map((r) => ({ pr: Number(r.number), ...this.riskReviewOut(r.repo, r.number) }))
      .filter((r) => r.name);
  },
};
