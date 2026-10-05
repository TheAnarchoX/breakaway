/**
 * GitHub's status page (BRK-217): what githubstatus.com says about the parts of GitHub the board leans on. While
 * one of them is down, a chase starts nothing new and the owner's Keep branches up to date and Merge when green
 * wait: agents can't push, checks don't run, and merges can land on checks that never ran. Pure, so it's tested
 * on its own; the store fetches the page (store-github-status.js).
 */

/** GitHub's status page, a Statuspage site with its JSON at /api/v2/summary.json. */
export const GITHUB_STATUS_URL = 'https://www.githubstatus.com';

/** The components the board leans on: pushes, the API and webhooks it syncs from, pull requests, and checks. */
export const WATCHED = ['Git Operations', 'API Requests', 'Webhooks', 'Pull Requests', 'Actions'];

/** A component's status, in words. */
export const STATUS_WORDS = {
  operational: 'working',
  degraded_performance: 'degraded performance',
  partial_outage: 'partial outage',
  major_outage: 'major outage',
  under_maintenance: 'under maintenance',
};

const clip = (text, n = 200) => {
  const s = String(text ?? '').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const words = (status) => STATUS_WORDS[status] ?? String(status ?? 'unknown').replaceAll('_', ' ');

/**
 * Reads the status page's summary: the watched components that aren't working, and the open incidents that touch
 * one of them (or name no component yet, as an incident often doesn't while it's being investigated).
 * `disrupted` is whether either list has anything. Throws when the answer isn't a status summary.
 * @param {any} summary
 */
export function readGitHubStatus(summary) {
  if (!Array.isArray(summary?.components)) throw new Error('the status page’s answer has no components');
  const components = WATCHED.map((name) => summary.components.find((c) => c?.name === name))
    .filter(Boolean)
    .map((c) => ({ name: c.name, status: String(c.status ?? 'unknown') }));
  const affected = components.filter((c) => c.status !== 'operational');
  const incidents = (Array.isArray(summary.incidents) ? summary.incidents : [])
    .filter((i) => i && !['resolved', 'postmortem', 'completed'].includes(i.status))
    .map((i) => ({
      name: clip(i.name),
      status: String(i.status ?? 'investigating'),
      impact: String(i.impact ?? 'none'),
      url: typeof i.shortlink === 'string' && /^https:\/\//u.test(i.shortlink) ? i.shortlink : null,
      started: typeof i.created_at === 'string' ? i.created_at : null,
      components: (Array.isArray(i.components) ? i.components : []).map((c) => c?.name).filter(Boolean),
    }))
    .filter((i) => (i.components.length ? i.components.some((n) => WATCHED.includes(n)) : i.impact !== 'none'))
    .map(({ components: named, ...i }) => ({ ...i, components: named.filter((n) => WATCHED.includes(n)) }));
  return {
    disrupted: affected.length > 0 || incidents.length > 0,
    components,
    affected: affected.map((c) => ({ ...c, words: words(c.status) })),
    incidents,
  };
}

/**
 * What's wrong, in one line: each affected component with its status, then each incident by name.
 * @param {{ affected?: { name: string, status: string }[], incidents?: { name: string }[] }} status
 */
export function describeOutage(status) {
  const parts = (status.affected ?? []).map((c) => `${c.name}: ${words(c.status)}`);
  const named = (status.incidents ?? []).map((i) => `“${i.name}”`);
  if (!parts.length && !named.length) return 'nothing';
  return [parts.join(', '), named.length ? `${named.length === 1 ? 'incident' : 'incidents'} ${named.join(', ')}` : '']
    .filter(Boolean)
    .join('; ');
}
