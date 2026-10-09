/**
 * TaskStore's watch on Claude's status page (BRK-315), the way it watches GitHub's (BRK-217): the 5-minute cron reads
 * status.claude.com, and Check now on Connections reads it straight away. While a part of Claude the agents run on is
 * down, sessions fail to start or die mid-work, so chases start no new agents; they carry on by themselves once it's
 * working again. Only on an install with an agent routine connected, so the board never asks a service its owner
 * didn't connect. `TASKS_CLAUDE_STATUS` points it at another status page, or `off` turns it off.
 *
 * Agents hear it too, as for GitHub (BRK-279): once an outage holds the chases, every running chase's peloton gets the
 * playbook from the board, once, and when it's over, the all-clear, naming the tasks whose agents left work they
 * couldn't push (a comment that starts `Not pushed:`).
 */
import { CLAUDE_STATUS_URL, readClaudeStatus } from './claude-status.js';
import { describeOutage } from './github-status.js';
import { STATUS_EVERY_MS, STATUS_STALE_MS, iso, readPage } from './store-github-status.js';

/** What the board tells a chase's agents when Claude goes down; the core prompt says the same. */
export const CLAUDE_PLAYBOOK =
  'Your session may end without warning: keep your work committed on your branch, and push it while you can. ' +
  'If you have to stop, or your session might end, comment on your task first: `Not pushed: <branch>, <what isn’t pushed>`, then release it or wait. ' +
  'Chases start no new agents until Claude works again.';

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const claudeStatusMethods = {
  /** The status page this install reads, or null when it reads none (`TASKS_CLAUDE_STATUS` is `off`). */
  claudeStatusPage() {
    const page = String(this.env.TASKS_CLAUDE_STATUS ?? '').trim();
    if (page === 'off') return null;
    return (page || CLAUDE_STATUS_URL).replace(/\/+$/u, '');
  },

  /** Whether Claude is connected: some repository's agent routine is. */
  async claudeConnected() {
    return (await this.connectedRepos()).size > 0;
  },

  /**
   * Reads the status page, at most every five minutes unless `force` (Check now). A failed read keeps the last
   * reading and says why. Returns what's kept, or null when the install reads no status page or no routine is
   * connected. Never throws.
   */
  async claudeStatusCheck({ force = false } = {}) {
    try {
      const page = this.claudeStatusPage();
      if (!page || !(await this.claudeConnected())) return null;
      const last = JSON.parse(this.meta('claude_status') ?? 'null');
      const now = Date.now();
      if (!force && last && now - Number(last.checked ?? 0) < STATUS_EVERY_MS) return last;
      const next = await readPage(page, readClaudeStatus, last, now);
      this.setMeta('claude_status', JSON.stringify(next));
      this.claudeOutageNotice();
      return next;
    } catch (error) {
      console.error('reading Claude’s status failed', error);
      return null;
    }
  },

  /**
   * Tells the running chases' agents about Claude's outage: the playbook once while it holds, the all-clear once the
   * page says Claude works. A page that's gone quiet says neither. Never throws.
   */
  claudeOutageNotice() {
    try {
      const s = JSON.parse(this.meta('claude_status') ?? 'null');
      this.tellChases({
        key: 'claude_outage_told',
        outage: this.claudeOutage(),
        over: !(s?.error || s?.disrupted),
        down: (outage) => `Claude is down (${describeOutage(outage)}). ${CLAUDE_PLAYBOOK}`,
        clear: 'Claude works again: sessions can start, and the chase carries on.',
      });
    } catch (error) {
      console.error('the Claude outage notice failed', error);
    }
  },

  /** The last reading if it says Claude is disrupted and is recent enough to act on, else null. */
  claudeOutage() {
    if (!this.claudeStatusPage()) return null;
    const s = JSON.parse(this.meta('claude_status') ?? 'null');
    if (!s?.disrupted || Date.now() - Number(s.at ?? 0) > STATUS_STALE_MS) return null;
    return s;
  },

  /** Why chases start no agents because of Claude, in one sentence, or null when they aren't held for it. */
  claudeHold() {
    const s = this.claudeOutage();
    return s ? `Claude reports trouble (${describeOutage(s)})` : null;
  },

  /**
   * Claude's status as Connections shows it, or null when the install reads no status page. `held` is whether
   * chases are waiting on it.
   */
  claudeStatusView() {
    const page = this.claudeStatusPage();
    if (!page) return null;
    const s = JSON.parse(this.meta('claude_status') ?? 'null');
    if (!s) return { page, checked: null, held: false };
    const outage = this.claudeOutage();
    return {
      page,
      checked: iso(s.checked),
      at: iso(s.at),
      since: outage ? iso(s.since) : null,
      held: Boolean(outage),
      summary: outage ? describeOutage(outage) : null,
      components: s.components ?? [],
      affected: s.affected ?? [],
      incidents: s.incidents ?? [],
      error: s.error ?? null,
    };
  },
};
