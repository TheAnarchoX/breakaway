/**
 * TaskStore's watch on GitHub's status page (BRK-217): the 5-minute cron reads githubstatus.com, and Check now on
 * Connections reads it straight away. While a part of GitHub the board leans on is down, chases start nothing new
 * and Keep branches up to date and Merge when green wait; both carry on by themselves once it's working again.
 * Only on an install with GitHub connected, so the board never asks a service its owner didn't connect.
 * `TASKS_GITHUB_STATUS` points it at another status page, or `off` turns it off.
 *
 * The owner can treat GitHub as working from Connections (BRK-218) when an incident is over but the page still
 * shows it open: the override covers the outage as it reads then, and the board holds again as soon as the page
 * reports something new (another incident, or a component's status changing). It's cleared once the page says
 * GitHub is working.
 *
 * Agents hear it too (BRK-279): once an outage holds the board, every running chase's peloton gets the playbook
 * from the board, once, and when it's over, the all-clear, naming the tasks whose agents left work they couldn't
 * push (a comment that starts `Not pushed:`).
 */
import { AgentError } from './store-agents.js';
import { appCredentials } from './github.js';
import { commentsOf } from './model.js';
import { GITHUB_STATUS_URL, describeOutage, readGitHubStatus } from './github-status.js';

/** How often the status page is read: every cron run. */
const STATUS_EVERY_MS = 5 * 60_000;
/** A reading older than this holds nothing: the status page has gone quiet, and the board shouldn't wait on it forever. */
const STATUS_STALE_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * What an outage is, for the owner's override: each affected component with its status, and each incident by name.
 * An incident moving from investigating to monitoring is the same outage; a component getting worse isn't.
 * @param {{ affected?: { name: string, status: string }[], incidents?: { name: string }[] }} s
 */
const outageKey = (s) =>
  JSON.stringify([
    (s.affected ?? []).map((c) => `${c.name}:${c.status}`).sort(),
    (s.incidents ?? []).map((i) => i.name).sort(),
  ]);

/** A handover comment for work an agent couldn't push: `Not pushed: <branch>, <what's only local>`. */
const NOT_PUSHED = /^\s*not pushed\b/iu;

/** What the board tells a chase's agents when GitHub goes down (BRK-279); the core prompt says the same. */
export const OUTAGE_PLAYBOOK =
  'Keep your work committed on your branch, and stop retrying pushes and pull requests until the board says GitHub works again. ' +
  'If you have to stop, comment on your task first: `Not pushed: <branch>, <what isn’t pushed>`, then release it or wait. ' +
  'Chases start nothing new, and Keep branches up to date and Merge when green wait.';

const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);
const clip = (text, n = 200) => {
  const s = String(text ?? '').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const githubStatusMethods = {
  /** The status page this install reads, or null when it reads none (`TASKS_GITHUB_STATUS` is `off`). */
  githubStatusPage() {
    const page = String(this.env.TASKS_GITHUB_STATUS ?? '').trim();
    if (page === 'off') return null;
    return (page || GITHUB_STATUS_URL).replace(/\/+$/u, '');
  },

  /**
   * Reads the status page, at most every five minutes unless `force` (Check now). A failed read keeps the last
   * reading and says why. Returns what's kept, or null when the install reads no status page or GitHub isn't
   * connected. Never throws.
   */
  async githubStatusCheck({ force = false } = {}) {
    const page = this.githubStatusPage();
    if (!page || !(await appCredentials(this.env))) return null;
    const last = JSON.parse(this.meta('gh_status') ?? 'null');
    const now = Date.now();
    if (!force && last && now - Number(last.checked ?? 0) < STATUS_EVERY_MS) return last;
    let next;
    try {
      const res = await fetch(`${page}/api/v2/summary.json`, {
        headers: { Accept: 'application/json', 'User-Agent': 'breakaway' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`it answered ${res.status}`);
      const reading = readGitHubStatus(await res.json());
      next = {
        ...reading,
        checked: now,
        at: now,
        since: reading.disrupted ? (last?.disrupted && last.since ? last.since : now) : null,
        error: null,
      };
    } catch (error) {
      next = { ...(last ?? { disrupted: false, components: [], affected: [], incidents: [], at: null, since: null }) };
      next.checked = now;
      next.error = clip(error?.message ?? error);
    }
    this.setMeta('gh_status', JSON.stringify(next));
    // Once the page says GitHub is working, the owner's override has done its job.
    if (!next.error && !next.disrupted) this.setMeta('gh_status_override', null);
    this.outageNotice();
    return next;
  },

  /**
   * Tells the running chases' agents about an outage (BRK-279). While the board holds for one, each chase that's on
   * gets the playbook once (a chase started during it gets it at the next reading). Once the board stops holding
   * because the page says GitHub works or the owner said so, each chase that's on gets the all-clear, with the tasks
   * in it that carry a `Not pushed:` comment since the outage began. A page that's gone quiet says neither: the next
   * reading decides. Never throws: telling the agents mustn't stop the board's own work.
   */
  outageNotice() {
    try {
      this.loadTasks();
      const told = JSON.parse(this.meta('gh_outage_told') ?? 'null');
      const outage = this.githubOutage();
      if (outage) {
        const chases = this.chasing() ? this.openChases() : [];
        const fresh = chases.filter(({ row }) => !told?.chases?.includes(row.slug));
        if (!fresh.length && told) return;
        for (const { row } of fresh)
          this.pelotonLine(row.slug, 'outage', `GitHub is down (${describeOutage(outage)}). ${OUTAGE_PLAYBOOK}`);
        const since = Number(told?.since ?? outage.since ?? Date.now());
        const slugs = [...(told?.chases ?? []), ...fresh.map(({ row }) => row.slug)];
        this.setMeta('gh_outage_told', JSON.stringify({ since, chases: slugs }));
        return;
      }
      if (!told) return;
      const s = JSON.parse(this.meta('gh_status') ?? 'null');
      if (!this.githubOverride() && (s?.error || s?.disrupted)) return;
      this.setMeta('gh_outage_told', null);
      if (!this.chasing()) return;
      for (const { row, tasks } of this.openChases()) {
        const left = [...tasks]
          .filter((uuid) => this.tasks.get(uuid)?.status === 'pending' && this.notPushedSince(uuid, told.since))
          .map((uuid) => this.tasks.get(uuid).wid ?? uuid.slice(0, 8))
          .sort();
        const which = left.length
          ? ` Work that wasn’t pushed: ${left.join(', ')}. Whoever picks one up, read its Not pushed comment first.`
          : '';
        this.pelotonLine(row.slug, 'clear', `GitHub works again: pushing is safe, and the chase carries on.${which}`);
      }
    } catch (error) {
      console.error('the outage notice failed', error);
    }
  },

  /** Whether task `uuid` has a `Not pushed:` comment from `since` (ms) on. */
  notPushedSince(uuid, since) {
    const map = this.tasks.get(uuid);
    if (!map) return false;
    return commentsOf(map).some(
      (c) => NOT_PUSHED.test(c.text) && Date.parse(c.at) >= Math.floor(Number(since) / 1000) * 1000,
    );
  },

  /** The last reading if it says GitHub is disrupted and is recent enough to act on, else null, override or not. */
  githubDisruption() {
    if (!this.githubStatusPage()) return null;
    const s = JSON.parse(this.meta('gh_status') ?? 'null');
    if (!s?.disrupted || Date.now() - Number(s.at ?? 0) > STATUS_STALE_MS) return null;
    return s;
  },

  /** The owner's override, while it still covers the outage the page reports, else null. */
  githubOverride() {
    const s = this.githubDisruption();
    const o = JSON.parse(this.meta('gh_status_override') ?? 'null');
    return s && o?.key === outageKey(s) ? o : null;
  },

  /** The disruption the board acts on: the last reading's, unless the owner has said GitHub is working. */
  githubOutage() {
    return this.githubOverride() ? null : this.githubDisruption();
  },

  /**
   * The owner's Treat as working (`on`) or Hold again on Connections (BRK-218). Treat as working needs something to
   * be held. Throws an AgentError the API answers with.
   * @param {{ on?: boolean }} body
   */
  githubStatusOverride({ on } = {}) {
    if (typeof on !== 'boolean') throw new AgentError('say on: true or on: false', 400);
    if (!on) {
      this.setMeta('gh_status_override', null);
      this.outageNotice();
      return;
    }
    const s = this.githubDisruption();
    if (!s) throw new AgentError('GitHub’s status isn’t holding anything, so there’s nothing to override', 409);
    this.setMeta('gh_status_override', JSON.stringify({ at: Date.now(), key: outageKey(s) }));
    this.outageNotice();
  },

  /** POST /api/connections/github-status/override (the signed-in browser only): the override, then the report. */
  githubStatusOverrideApi(body) {
    return this.run(async () => {
      this.githubStatusOverride(body);
      return { status: 200, body: await this.connectionsReport() };
    });
  },

  /** Why the board's automatic GitHub work is on hold, in one sentence, or null when it isn't. */
  githubHold() {
    const s = this.githubOutage();
    return s ? `GitHub reports trouble (${describeOutage(s)})` : null;
  },

  /**
   * GitHub's status as the GitHub and Connections views show it, or null when the install reads no status page.
   * `held` is whether chases, Keep branches up to date, and Merge when green are waiting on it; `overridden` is when
   * the owner said GitHub is working while the page still reports trouble.
   */
  githubStatusView() {
    const page = this.githubStatusPage();
    if (!page) return null;
    const s = JSON.parse(this.meta('gh_status') ?? 'null');
    if (!s) return { page, checked: null, held: false };
    const outage = this.githubDisruption();
    const override = this.githubOverride();
    return {
      page,
      checked: iso(s.checked),
      at: iso(s.at),
      since: outage ? iso(s.since) : null,
      held: Boolean(outage && !override),
      overridden: override ? { at: iso(override.at) } : null,
      summary: outage ? describeOutage(outage) : null,
      components: s.components ?? [],
      affected: s.affected ?? [],
      incidents: s.incidents ?? [],
      error: s.error ?? null,
    };
  },
};
