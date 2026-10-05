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
 */
import { AgentError } from './store-agents.js';
import { appCredentials } from './github.js';
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
    return next;
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
      return;
    }
    const s = this.githubDisruption();
    if (!s) throw new AgentError('GitHub’s status isn’t holding anything, so there’s nothing to override', 409);
    this.setMeta('gh_status_override', JSON.stringify({ at: Date.now(), key: outageKey(s) }));
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
