/**
 * Connections (docs/specs/IDEA-14-multi-repo.md, section 7): is everything the board leans on wired up,
 * and if not, what fixes it. Pure: what the board needs from the GitHub App, how GitHub's answers turn into
 * a state, and the fix text for each failure it can tell apart. The checks themselves are in
 * store-connections.js. Nothing here ever holds a secret value: a secret is "set" or "unset" by name.
 */
import { redact } from './redact.js';
import { DEFAULTS, secretName } from './install.js';

/** Working, Needs attention, Not connected. */
export const STATES = ['working', 'attention', 'off'];

/** The Secrets Store bindings, by name: required ones stop the board; the others turn a feature on. */
export const SECRET_BINDINGS = [
  { name: 'TASKS_CLIENT_ID', required: true, for: 'Taskwarrior sync' },
  { name: 'TASKS_SYNC_KEY', required: true, for: 'Taskwarrior sync' },
  { name: 'TASKS_API_TOKEN', required: true, for: 'signing in, the CLI, and agents' },
  { name: 'TASKS_GITHUB_APP_ID', required: false, for: 'the GitHub App' },
  { name: 'TASKS_GITHUB_KEY', required: false, for: 'the GitHub App' },
  { name: 'TASKS_GITHUB_WEBHOOK_SECRET', required: false, for: 'the GitHub App' },
  { name: 'TASKS_ROUTINE_URL', required: false, for: 'cloud agents' },
  { name: 'TASKS_ROUTINE_TOKEN', required: false, for: 'cloud agents' },
  { name: 'TASKS_ROUTINES', required: false, for: 'cloud agents in other repositories' },
  { name: 'TASKS_VAPID_KEY', required: false, for: 'push notifications' },
];

/**
 * What the board needs from the App on a repository, and what each permission is for (docs/tasks.md#github).
 * `pipeline` ones matter only where the repository has a deploy pipeline.
 */
export const NEEDED_PERMISSIONS = [
  { name: 'metadata', level: 'read', for: 'reading the repository' },
  { name: 'pull_requests', level: 'write', for: 'Merge, Merge when green, and Publish' },
  { name: 'contents', level: 'write', for: 'Update branch and Merge' },
  { name: 'checks', level: 'read', for: 'checks on pull requests' },
  { name: 'statuses', level: 'read', for: 'commit statuses on pull requests' },
  { name: 'actions', level: 'write', for: 'Promote and Roll back', pipeline: true },
  { name: 'deployments', level: 'read', for: 'deploys and what shipped', pipeline: true },
  { name: 'vulnerability_alerts', level: 'read', for: 'Dependabot alerts' },
];

const LEVEL = { none: 0, read: 1, write: 2, admin: 3 };
const LABEL = {
  metadata: 'Metadata',
  pull_requests: 'Pull requests',
  contents: 'Contents',
  checks: 'Checks',
  statuses: 'Commit statuses',
  actions: 'Actions',
  deployments: 'Deployments',
  vulnerability_alerts: 'Dependabot alerts',
};

/** Each needed permission, granted or missing, from an installation's `permissions`. */
export function comparePermissions(granted, { pipeline = false } = {}) {
  return NEEDED_PERMISSIONS.filter((p) => pipeline || !p.pipeline).map((p) => {
    const has = String(granted?.[p.name] ?? 'none');
    return {
      name: p.name,
      label: LABEL[p.name],
      need: p.level,
      has,
      ok: (LEVEL[has] ?? 0) >= LEVEL[p.level],
      for: p.for,
    };
  });
}

/** The App's settings page, where permissions change (the owner's own App, under their account). */
export const appSettingsUrl = (slug) =>
  slug ? `https://github.com/settings/apps/${slug}/permissions` : 'https://github.com/settings/apps';

/** The fix for missing permissions: the `CLD-56` and `CLD-104` steps, naming exactly what to change. */
export function permissionsFix(missing, appName = DEFAULTS.name) {
  const list = missing.map((p) => `${p.label} to ${p.need === 'write' ? 'read and write' : 'read-only'}`).join(', ');
  return `On GitHub, Settings → Developer settings → GitHub Apps → ${appName} → Permissions & events: set ${list}, save, then accept the new permissions on the installation (its page shows the request).`;
}

/**
 * GitHub's webhook delivery log (`GET /app/hook/deliveries`) → what the last delivery says, and the fix.
 * `webhookSecret` is the install's name for the secret in the Secrets Store.
 */
export function summarizeDeliveries(deliveries, origin, webhookSecret = secretName(DEFAULTS, 'GITHUB_WEBHOOK_SECRET')) {
  const list = (Array.isArray(deliveries) ? deliveries : []).filter((d) => d.event !== 'ping');
  const failed = list.filter((d) => !(d.status_code >= 200 && d.status_code < 300));
  const last = list[0] ?? null;
  const lastFailure = failed[0] ?? null;
  const summary = {
    seen: list.length,
    failed: failed.length,
    last: last ? { at: last.delivered_at, event: last.event, status: last.status_code } : null,
    lastFailure: lastFailure
      ? {
          at: lastFailure.delivered_at,
          event: lastFailure.event,
          status: lastFailure.status_code,
          message: clip(lastFailure.status),
        }
      : null,
  };
  const hookUrl = `${origin}/github/webhook`;
  if (!last)
    return {
      ...summary,
      state: 'attention',
      fix: `GitHub has no deliveries in its log. In the App's settings (General → Webhook), check Active is on and the URL is ${hookUrl}.`,
    };
  if (last.status_code >= 200 && last.status_code < 300) return { ...summary, state: 'working', fix: null };
  if (last.status_code === 401) {
    return {
      ...summary,
      state: 'attention',
      fix: `The board refused the signature: the App's webhook secret and ${webhookSecret} differ. Set a new secret in the App's settings (General → Webhook secret), put the same value in the Secrets Store, then Redeliver the failed delivery.`,
    };
  }
  if (last.status_code === 503)
    return {
      ...summary,
      state: 'attention',
      fix: "The board answered that the App isn't connected: run npx breakaway github-connect again from the GitHub view.",
    };
  if (!last.status_code)
    return {
      ...summary,
      state: 'attention',
      fix: `GitHub couldn't reach ${hookUrl}. Check the board is up (npx breakaway health), then Redeliver from the App's Advanced tab.`,
    };
  return {
    ...summary,
    state: 'attention',
    fix: `The board answered ${last.status_code} to GitHub's last delivery. Look at it in the App's Advanced tab, and Redeliver once it's fixed.`,
  };
}

/** The fix for an agent start that failed, from the board's own error message. `connect` is the repository's agents-connect command. */
export function routineFix(error, connect = 'npx breakaway agents-connect') {
  const text = String(error ?? '');
  if (/token was refused/iu.test(text))
    return `Claude refused the routine's token: on claude.ai/code/routines, open the routine, make a new API token, then replace it on Connections, or run ${connect}.`;
  if (/has no access/iu.test(text))
    return `Claude says the routine's token has no access to it: on claude.ai/code/routines, open the routine (signed in as the account that made it), make a new API token, then replace it on Connections, or run ${connect}. Auto-start and chase start again once it's connected.`;
  if (/is gone on claude/iu.test(text))
    return `Claude has no routine at that URL any more: make the routine again on claude.ai/code/routines with an API trigger (or copy the trigger's URL if it moved), then connect it on Connections with its URL and token, or run ${connect}. Auto-start and chase start again once it's connected.`;
  if (/hourly limit/iu.test(text))
    return "Claude's hourly limit for starting sessions was reached; starts work again within the hour. Lower Starts an hour on the Agents view to stay under it.";
  if (/paused/iu.test(text)) return 'The routine is paused on claude.ai: resume it at claude.ai/code/routines.';
  if (/isn’t connected|isn't connected/iu.test(text))
    return `Connect the routine on Connections, or run ${connect} (docs/tasks.md#cloud-agents-from-the-board).`;
  if (/couldn’t reach|couldn't reach/iu.test(text))
    return "The board couldn't reach Claude. If it happens again, check status.claude.com.";
  return `Open the failed start on the Agents view for what Claude said; if it repeats, connect the routine again (${connect}).`;
}

/** An error message from outside the board, safe to store and show: secrets redacted, short. */
export function clip(text, max = 300) {
  const s = redact(String(text ?? '')).trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** The worst of several states. */
export function worst(states) {
  if (states.includes('attention')) return 'attention';
  if (states.includes('off')) return 'off';
  return 'working';
}
