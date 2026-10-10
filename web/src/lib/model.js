// What the board knows about tasks: areas, horizons, states, order, and time.

export const AREAS = [
  { id: 'product', label: 'Product', prefix: 'PRD' },
  { id: 'brand', label: 'Brand', prefix: 'BRD' },
  { id: 'moderation', label: 'Moderation', prefix: 'MOD' },
  { id: 'ops', label: 'Operations', prefix: 'OPS' },
  { id: 'cloud', label: 'Cloud', prefix: 'CLD' },
  { id: 'debt', label: 'Tech debt', prefix: 'DEBT' },
  { id: 'compliance', label: 'Compliance', prefix: 'CMP' },
  { id: 'ideas', label: 'Ideas', prefix: 'IDEA' },
  { id: 'routines', label: 'Routines', prefix: 'RUN' },
];
export const AREA_LABEL = Object.fromEntries(AREAS.map((a) => [a.id, a.label]));

export const HORIZONS = [
  { id: 'now', label: 'Now', hint: 'What is being worked on now' },
  { id: 'next', label: 'Next', hint: 'What comes after' },
  { id: 'later', label: 'Later', hint: 'Bigger bets, written up first' },
  { id: 'archive', label: 'Archived', hint: 'Finished when a horizon was closed' },
];
export const HORIZON_LABEL = Object.fromEntries(HORIZONS.map((h) => [h.id, h.label]));

export const PRIORITIES = [
  { id: 'H', label: 'High' },
  { id: 'M', label: 'Medium' },
  { id: 'L', label: 'Low' },
];
export const PRIORITY_LABEL = Object.fromEntries(PRIORITIES.map((p) => [p.id, p.label]));

/** Who does a task (BRK-330): one of these, and on a person's task, who it's for (its assignee). */
export const WHO = [
  { id: 'agent', label: 'Agent', hint: 'An agent builds it in the repository' },
  { id: 'person', label: 'Person', hint: 'A person does it: production, dashboards, accounts, sign-offs' },
  { id: 'decision', label: 'Decision', hint: 'The owner decides before work starts' },
];

/** The board's columns, in order. Every open task is in exactly one. */
export const STATES = [
  { id: 'decision', label: 'Needs a decision', hint: 'A decision: the owner decides before anyone starts.' },
  { id: 'ready', label: 'Ready', hint: 'Nothing blocks it and nobody has claimed it.' },
  { id: 'active', label: 'In progress', hint: 'Claimed by an agent or the owner.' },
  { id: 'review', label: 'In review', hint: 'A pull request that closes it is open.' },
  { id: 'blocked', label: 'Blocked or waiting', hint: 'Waits for another task to finish, or for a date.' },
  { id: 'done', label: 'Done', hint: 'Finished.' },
];
export const STATE_LABEL = Object.fromEntries(STATES.map((s) => [s.id, s.label]));

/** What each kind of ping is called in the inbox and on the bell. */
export const PING_KIND_LABEL = {
  blocked: 'Blocked',
  question: 'Question',
  stale: 'Stale',
  done: 'Looks done',
  fyi: 'For your information',
  incident: 'Incident',
  envelope: 'Inside an envelope',
};
/** The inbox's notes about connections (CLD-121). */
export const NOTICE_LABEL = {
  broke: 'Connection needs attention',
  recovered: 'Connection working again',
  update: 'Update available',
};

export function stateOf(t) {
  if (t.status === 'completed') return 'done';
  if (t.status === 'deleted') return 'deleted';
  if (openPr(t)) return 'review';
  if (t.claim || t.active) return 'active';
  if (t.blocked || t.waiting) return 'blocked';
  if (t.who === 'decision') return 'decision';
  return 'ready';
}

/** The open pull request that closes this task, if any. */
export function openPr(t) {
  return (t.github ?? []).find((p) => p.closes && p.state === 'open') ?? null;
}

export const isDependabot = (author) => /^dependabot(\[bot\])?$/iu.test(author ?? '');

/**
 * Whether an agent can review this pull request as it stands (IDEA-30 section 9): open, not a draft, not
 * Dependabot's (those keep Safe to merge?), mergeable, and its checks passed or still running. The board checks
 * again with GitHub when it starts one.
 */
export function canAgentReview(pr) {
  return (
    pr?.state === 'open' &&
    !pr.draft &&
    !isDependabot(pr.author) &&
    ['ready', 'running'].includes(pr.verdict) &&
    pr.mergeable === true
  );
}

/** The pull request to show on a card: the open closing one, else the latest closing one. */
export function mainPr(t) {
  const list = (t.github ?? []).filter((p) => p.closes);
  return list.find((p) => p.state === 'open') ?? list[0] ?? null;
}

export const ref = (t) => t.wid ?? t.short ?? t.uuid.slice(0, 8);

/**
 * A general agent's open task with no area yet: its agent picks one, and the work ID comes with it. A routine maker's
 * needs none: its work is on the board (BRK-220 section 2).
 */
export const picksArea = (t) =>
  !t.project &&
  t.status === 'pending' &&
  (t.tags ?? []).includes('general') &&
  !(t.tags ?? []).includes('routine-maker');
/** What shows where such a task's area would be. */
export const PICKS_AREA = 'Its agent picks the area';

const WID = /^([A-Z]+)-(\d+)$/u;
const HORIZON_ORDER = { now: 0, next: 1, later: 2, archive: 3 };
const PRIORITY_ORDER = { H: 0, M: 1, L: 2 };

/** Horizon, then priority, then work ID number: the server's order. */
export function rank(a, b) {
  const h = (HORIZON_ORDER[a.horizon] ?? 4) - (HORIZON_ORDER[b.horizon] ?? 4);
  if (h) return h;
  const p = (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3);
  if (p) return p;
  return compareWid(a, b);
}

export function compareWid(a, b) {
  const wa = WID.exec(a.wid ?? '');
  const wb = WID.exec(b.wid ?? '');
  if (wa && wb) return wa[1].localeCompare(wb[1]) || Number(wa[2]) - Number(wb[2]);
  if (wa || wb) return wa ? -1 : 1;
  return String(a.entry).localeCompare(String(b.entry));
}

/** Recently finished first. */
export const byEnd = (a, b) => String(b.end ?? '').localeCompare(String(a.end ?? ''));

export const DAY = 86_400_000;
/** A claim with no change for this long probably needs a look. */
export const STALE_AFTER = 2 * DAY;

export function isStale(t, now = Date.now()) {
  return Boolean(t.claim && t.status === 'pending' && now - Date.parse(t.modified ?? t.start ?? 0) > STALE_AFTER);
}

export function ago(iso, now = Date.now()) {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days} days ago`;
  return day(iso);
}

/** Short age for tight spots: 5m, 3h, 2d. */
export function age(iso, now = Date.now()) {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (mins < 60) return `${mins}m`;
  if (mins < 2880) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

export function day(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function time(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** 2026-10-10T00:00:00.000Z → 2026-10-10, for <input type=date>. */
export const dateInput = (iso) => (iso ? iso.slice(0, 10) : '');

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

import { linkFor, repoBaseUrl } from './links.js';

export function prUrl(pr) {
  if (!pr) return null;
  if (/^\d+$/u.test(pr)) return repoBaseUrl() ? `${repoBaseUrl()}/pull/${pr}` : null;
  if (/^https:\/\/github\.com\//u.test(pr)) return pr;
  return null;
}

export function prLabel(pr) {
  if (/^\d+$/u.test(pr)) return `#${pr}`;
  const m = /\/pull\/(\d+)/u.exec(pr);
  return m ? `#${m[1]}` : pr;
}

/** A spec path (docs/specs/…) or URL → a link, or null. */
export const specUrl = (spec) => (spec ? linkFor(spec.replace(/^\/+/u, '')) : null);

/**
 * A finished task whose pull request merged: `shipped` once a production deploy carried it,
 * `staged` when only staging runs it so far, `nodeploy` when everything it merged changes nothing
 * that runs in a Worker (docs, skills, CI: no deploy will come), else `unshipped`, not on staging
 * yet. A pull request's files not being read yet counts as waiting.
 */
export function shipState(t) {
  if (t.shipped) return 'shipped';
  if (t.staged) return 'staged';
  const merged = t.status === 'completed' ? (t.github ?? []).filter((p) => p.closes && p.state === 'merged') : [];
  if (!merged.length) return null;
  return merged.every((p) => Array.isArray(p.workers) && !p.workers.length) ? 'nodeploy' : 'unshipped';
}

/** "4f2c8a10" for a version ID, or the short commit. */
export const shortVersion = (s) => (s?.version ?? s?.sha ?? '').slice(0, 8);

/**
 * Who pressed what on a pull request, on its page (WEB-132): the latest board press the page's `pressed` names, as a
 * sentence. "you" for the owner, anyone else by handle (BRK-303); a press a pull request setting made says which.
 * @param {{ kind: string, by: string, method: string | null, setting: boolean } | null} pressed
 * @param {string} [base] the branch the pull request goes into
 */
export function pressedWords(pressed, base = 'main') {
  if (!pressed) return null;
  const who = pressed.by && pressed.by !== 'owner' ? pressed.by : 'you';
  const whose = who === 'you' ? 'your' : `${who}’s`;
  const how = pressed.method === 'squash' ? 'squash' : 'merge commit';
  switch (pressed.kind) {
    case 'pr_merged_by_owner':
      return pressed.setting
        ? `Merged on the board by ${whose} Merge when green setting (${how})`
        : `Merged on the board by ${who} (${how})`;
    case 'pr_published':
      return `Published for review on the board by ${who}`;
    case 'pr_branch_updated':
      return pressed.setting
        ? `Updated with ${base} on the board by ${whose} Keep branches up to date setting`
        : `Updated with ${base} on the board by ${who}`;
    case 'pr_auto_merge_on':
      return pressed.setting
        ? `Set to merge when green on the board by ${whose} Merge when green setting (${how})`
        : `Set to merge when green on the board by ${who} (${how})`;
    case 'pr_auto_merge_off':
      return `Merge when green turned off on the board by ${who}`;
    default:
      return null;
  }
}
