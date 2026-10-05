// The board's state: tasks, filters, the view, and the open task, kept in the URL hash so every
// view and task has a link and the back button works. Side effects live here too.
import { batch, computed, effect, signal } from '@preact/signals';
import { api, enc, whenSignedOut } from './api.js';
import { AREAS, DAY, AREA_LABEL, isDependabot, plural, ref, shipState, stateOf } from './model.js';
import { actionKey, planPullActions } from './autopilot.js';
import { repoFacts, scopeGitHub } from './github-scope.js';
import { sidebarDefault } from './layout.js';
import { setRepoBase } from './links.js';
import { readSpecParam, specParam } from './specs.js';

// ---- preferences (this browser only) -------------------------------------------------------

function pref(name, fallback) {
  try {
    return localStorage.getItem(`tasks.${name}`) ?? fallback;
  } catch {
    return fallback;
  }
}

function savePref(name, value) {
  try {
    localStorage.setItem(`tasks.${name}`, value);
  } catch {
    /* storage blocked: the choice lasts until reload */
  }
}

export const me = signal(pref('claimName', 'owner'));
export const theme = signal(pref('theme', 'system'));
export const lanes = signal(pref('lanes', 'horizon'));
/** Where a task opens by default: 'sidebar' (beside the view) or 'modal'. */
export const openIn = signal(pref('openIn', 'sidebar') === 'modal' ? 'modal' : 'sidebar');
effect(() => savePref('openIn', openIn.value));
effect(() => savePref('claimName', me.value));
effect(() => savePref('theme', theme.value));
effect(() => savePref('lanes', lanes.value));
/** Whether a pull request's unified diff wraps long lines instead of scrolling sideways (WEB-45). */
export const diffWrap = signal(pref('diffWrap', 'off') === 'on');
effect(() => savePref('diffWrap', diffWrap.value ? 'on' : 'off'));
/** The sidebar on a computer: 'open' (icons and labels) or 'rail' (icons). Saved once it's toggled. */
const savedSidebar = pref('sidebar', '');
export const sidebar = signal(['open', 'rail'].includes(savedSidebar) ? savedSidebar : sidebarDefault(innerWidth));
export function toggleSidebar() {
  sidebar.value = sidebar.value === 'open' ? 'rail' : 'open';
  savePref('sidebar', sidebar.value);
}
/** On a phone the sidebar is a drawer; whether it's open. */
export const menuOpen = signal(false);

// The owner's pull request settings: off unless turned on, only in this browser, and per repository
// (CLD-125). These two are the default repository's, under the keys they always had; another
// repository's are in `repoPullSettings` below.
/** Keep branches up to date: update any open pull request's branch that falls behind main. */
export const keepUpdated = signal(pref('keepUpdated', 'off') === 'on');
/** Merge when green: every open, non-draft pull request merges once its checks pass. */
export const mergeWhenGreen = signal(pref('mergeWhenGreen', 'off') === 'on');
effect(() => savePref('keepUpdated', keepUpdated.value ? 'on' : 'off'));
effect(() => savePref('mergeWhenGreen', mergeWhenGreen.value ? 'on' : 'off'));
/**
 * Pull requests the owner turned merge when green off on: the setting leaves them alone. The default
 * repository's are numbers, as they always were; another repository's are "<slug>#<number>".
 */
export const mergeSkip = signal(
  new Set(
    (() => {
      try {
        return JSON.parse(pref('mergeWhenGreenSkip', '[]')).filter(
          (k) => Number.isInteger(k) || /^[a-z][a-z0-9-]{0,31}#\d+$/u.test(k),
        );
      } catch {
        return [];
      }
    })(),
  ),
);
effect(() => savePref('mergeWhenGreenSkip', JSON.stringify([...mergeSkip.value].slice(-200))));
/** The key `mergeSkip` holds for pull request `number` of repository `slug` (none: the default). */
export const skipKey = (number, slug = null) =>
  !slug || slug === repos.peek().default ? Number(number) : `${slug}#${Number(number)}`;
export function skipMergeWhenGreen(number, skip, slug = null) {
  const next = new Set(mergeSkip.value);
  if (skip) next.add(skipKey(number, slug));
  else next.delete(skipKey(number, slug));
  mergeSkip.value = next;
}

/** Squash or merge commit: the last one chosen in the merge dialog, also what the settings use. */
const METHOD_KEY = 'breakaway-merge-method';
export const mergeMethod = signal(
  (() => {
    try {
      return localStorage.getItem(METHOD_KEY) === 'merge' ? 'merge' : 'squash';
    } catch {
      return 'squash';
    }
  })(),
);
effect(() => {
  try {
    localStorage.setItem(METHOD_KEY, mergeMethod.value);
  } catch {
    /* the choice just isn't remembered */
  }
});

effect(() => {
  const root = document.documentElement;
  if (theme.value === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme.value;
  const dark =
    theme.value === 'dark' || (theme.value === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0d0e10' : '#f4f4f1');
});

// ---- data ----------------------------------------------------------------------------------

export const session = signal('checking'); // checking | in | out | offline
/** The install's name from its breakaway.config.json (CLD-133), for the tab title and the top bar; breakaway until it loads. */
export const installName = signal('breakaway');
/** The install's docs page (https), from its config; null when it has none, and the board links no docs. */
export const installDocs = signal(null);
export const tasks = signal([]);
export const loaded = signal(false);
export const loadError = signal(null);
export const health = signal(null);
/** Whether the last health check got no answer: the board can't reach its server. */
export const healthFailed = signal(false);
export const activity = signal({ events: [], next: null, loading: false, loaded: false, error: null });
/** The Activity view's dashboard (CLD-185): the numbers for the last `statsDays` days. */
export const stats = signal({ loaded: false, loading: false, data: null, error: null });
export const statsDays = signal(['7', '30', '90'].includes(pref('statsDays', '30')) ? pref('statsDays', '30') : '30');
effect(() => savePref('statsDays', statsDays.value));
export const github = signal({ loaded: false, loading: false, data: null, error: null });
export const agents = signal({ loaded: false, data: null, error: null });
export const routines = signal({ loaded: false, data: null, error: null });
/** The roadmap (docs/specs/IDEA-28-features-and-chase.md, section 2): features, suggested tags, and other release tasks. */
export const features = signal({ loaded: false, data: null, error: null });
/** The feature open on the roadmap, with its tasks: `{ slug, data, error }`, or null. */
export const featureOpen = signal(null);
/** The owner's inbox: open pings, newest first (docs/specs/IDEA-12-agent-pings.md). */
export const pings = signal({ loaded: false, list: [], notices: [], chases: [], error: null });
/**
 * What's open in the inbox: pings, the notes about connections that broke or work again (CLD-121), and the notes
 * about chases that ended (docs/specs/IDEA-28-features-and-chase.md, section 3.7).
 */
export const openPings = computed(
  () => pings.value.list.length + pings.value.notices.length + pings.value.chases.length,
);
/** The pings of the repository the switcher shows (each ping's task's), and every note about connections. */
export const scopedPings = computed(() => pings.value.list.filter((p) => inScope(p.repo)));
/** What the bell counts: the switcher's pings, and the notes about connections and ended chases. */
export const openPingsHere = computed(
  () => scopedPings.value.length + pings.value.notices.length + pings.value.chases.length,
);
/** The Connections view (CLD-121): the last report, and whether Check now is running. */
export const connections = signal({ loaded: false, data: null, error: null, checking: false });
/**
 * How many connections need attention, for the nav and the settings gear: from the view's own report when
 * it's the newer one, else from health, which carries the count from the cron's last report.
 */
export const connectionsAttention = computed(() => {
  const data = connections.value.data;
  const summary = health.value?.connections;
  if (data && (!summary || Date.parse(data.generated) >= Date.parse(summary.at))) return data.attention;
  return summary?.attention ?? 0;
});
/** The code GitHub returned after creating the App, from #/github?connect=… */
export const githubConnect = signal(null);
export const githubPr = signal(null); // the pull request open on the GitHub view: "12", or "<slug>:12" for another repository's
/** The open pull request as { repo, number }: `repo` is null for the default repository's. */
export const pullRef = computed(() => {
  const m = /^(?:([a-z][a-z0-9-]{0,31}):)?(\d+)$/u.exec(githubPr.value ?? '');
  return m ? { repo: m[1] ?? null, number: m[2] } : null;
});

export const byUuid = computed(() => new Map(tasks.value.map((t) => [t.uuid, t])));

// ---- repositories (docs/specs/IDEA-14-multi-repo.md, section 6) -----------------------------

/** The registered repositories, the default first. */
export const repos = signal({ loaded: false, list: [], default: null, removed: [] });
/** Whether there's more than one: until then the switcher and the chips stay hidden. */
export const multiRepo = computed(() => repos.value.list.length > 1);
/** What the switcher says: a repository's slug, or 'all'. Remembered in this browser and kept in the URL. */
export const repoChoice = signal(pref('repo', 'all'));
effect(() => savePref('repo', repoChoice.value));
/** The repository the views show, or null for all of them (always null while there's only one). */
export const repoScope = computed(() =>
  multiRepo.value && repos.value.list.some((r) => r.slug === repoChoice.value) ? repoChoice.value : null,
);
export const repoBySlug = computed(() => new Map(repos.value.list.map((r) => [r.slug, r])));
/** A repository's name for people, from its slug (the default's when none is given). */
export const repoName = (slug) =>
  repoBySlug.value.get(slug ?? repos.value.default)?.name ?? slug ?? repos.value.default;
/** Whether something of repository `slug` (none: the default's) shows under the switcher. */
export function inScope(slug) {
  const scope = repoScope.value;
  return !scope || (slug || repos.value.default) === scope;
}
/** The repository of the task with this UUID, or null when the board doesn't know the task. */
export const repoOfUuid = (uuid) => byUuid.value.get(uuid)?.repo ?? null;

export async function loadRepos() {
  try {
    const { repos: list, default: fallback, removed = [] } = await api('repos');
    repos.value = { loaded: true, list, default: fallback, removed };
    setRepoBase((list.find((r) => r.isDefault) ?? list[0])?.github);
  } catch {
    repos.value = { ...repos.value, loaded: true };
  }
}

/** Whether the board has no repository yet: a fresh install before its owner registers one (CLD-131). */
export const noRepos = computed(() => repos.value.loaded && repos.value.list.length === 0);

/** Registers a repository, the owner's (from Connections on a fresh install, CLD-131): the first is the default. */
export async function registerRepo(input) {
  const { repo } = await api('repos', { method: 'POST', body: { ...input, by: 'owner' } });
  await Promise.all([loadRepos(), loadConnections()]);
  toast(
    repo.isDefault
      ? `Registered ${repo.name}. It’s the default: tasks without a repository are its.`
      : `Registered ${repo.name}.`,
    'success',
  );
  return repo;
}

/** The GitHub view's data for the repository the switcher shows (all of them under All). */
export const githubView = computed(() => scopeGitHub(github.value.data, repoScope.value));
/** One repository's facts from the last GitHub load (its access, pipeline), by slug; null is the default's. */
export const githubRepoFacts = (slug = null) => repoFacts(github.value.data, slug);
// Registering a second repository changes what the GitHub view loads.
let githubWasMulti = false;
effect(() => {
  const several = multiRepo.value;
  if (several !== githubWasMulti && github.peek().loaded) setTimeout(() => loadGitHub(), 0);
  githubWasMulti = several;
});

/** Shows one repository, or all of them with 'all'. */
export function setRepo(slug) {
  repoChoice.value = slug;
}

/** The s key: All, then each repository in turn. Says where it landed. */
export function cycleRepo() {
  if (!multiRepo.value) return;
  const order = ['all', ...repos.value.list.map((r) => r.slug)];
  const next = order[(order.indexOf(repoScope.value ?? 'all') + 1) % order.length];
  setRepo(next);
  toast(next === 'all' ? 'Showing every repository.' : `Showing ${repoName(next)}.`, 'info');
}

/**
 * "2 in widgets, 1 in breakaway": how a count splits by repository, for "All" with several, else null.
 * `slugs` is each counted item's repository (null for the default's).
 */
export function countByRepo(slugs) {
  if (!multiRepo.value || repoScope.value) return null;
  const counts = new Map();
  for (const slug of slugs) {
    const key = slug || repos.value.default;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (!counts.size) return null;
  return repos.value.list
    .filter((r) => counts.has(r.slug))
    .map((r) => `${counts.get(r.slug)} in ${r.name}`)
    .join(', ');
}

const SHARED = AREAS.filter((a) => ['ideas', 'routines'].includes(a.id));

/** An area's name: the board's own, else the one its repository gave it. */
export function areaLabel(project) {
  if (!project) return null;
  if (AREA_LABEL[project]) return AREA_LABEL[project];
  for (const r of repos.value.list) {
    const area = r.areas.find((a) => a.project === project);
    if (area) return area.name;
  }
  return project;
}

/** The areas a task in repository `slug` may have: its own, then the install-wide ideas and routines. */
export function areasOfRepo(slug) {
  const repo = repoBySlug.value.get(slug ?? repos.value.default);
  if (!repo) return AREAS;
  return [...repo.areas.map((a) => ({ id: a.project, label: areaLabel(a.project), prefix: a.prefix })), ...SHARED];
}

/** The areas of the repositories the switcher shows, for the filter and the lanes. */
export const areaList = computed(() => {
  const list = repos.value.list;
  if (!list.length) return AREAS;
  const seen = new Map();
  for (const r of list.filter((x) => inScope(x.slug))) {
    for (const a of r.areas)
      if (!seen.has(a.project)) seen.set(a.project, { id: a.project, label: areaLabel(a.project), prefix: a.prefix });
  }
  for (const a of SHARED) seen.set(a.id, a);
  return [...seen.values()];
});

whenSignedOut(() => {
  session.value = 'out';
});

export async function checkSession() {
  try {
    const res = await fetch('/api/session', { credentials: 'same-origin' });
    session.value = res.status === 200 ? 'in' : 'out';
    if (res.status === 200) {
      const found = (await res.json().catch(() => null))?.install;
      if (typeof found?.name === 'string' && found.name) installName.value = found.name;
      installDocs.value = typeof found?.docs === 'string' && found.docs.startsWith('https://') ? found.docs : null;
    }
  } catch {
    session.value = 'offline';
  }
  if (session.value === 'in') await Promise.all([loadTasks(), loadHealth(), loadAgents(), loadPings(), loadRepos()]);
}

export async function loadTasks() {
  try {
    const { tasks: list } = await api('tasks?status=all');
    batch(() => {
      tasks.value = list.filter((t) => t.status !== 'deleted');
      loaded.value = true;
      loadError.value = null;
    });
  } catch (error) {
    loadError.value = error.message;
  }
}

export async function loadHealth() {
  try {
    health.value = await api('health');
    healthFailed.value = false;
  } catch {
    healthFailed.value = true;
  }
}

export async function loadActivity({ more = false } = {}) {
  const current = activity.value;
  if (current.loading) return;
  activity.value = { ...current, loading: true, error: null };
  try {
    const query = more && current.next ? `activity?limit=40&before=${current.next}` : 'activity?limit=40';
    const { events, next } = await api(query);
    activity.value = {
      events: more ? [...current.events, ...events] : events,
      next,
      loading: false,
      loaded: true,
      error: null,
    };
  } catch (error) {
    activity.value = { ...activity.value, loading: false, error: error.message };
  }
}

export async function loadStats({ quiet = false } = {}) {
  if (quiet && stats.peek().loading) return;
  const days = statsDays.peek();
  const repo = repoScope.peek();
  if (!quiet) stats.value = { ...stats.value, loading: true, error: null };
  let tz = 'UTC';
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    /* no time zone support: count in UTC */
  }
  try {
    const data = await api(`stats?days=${days}&tz=${enc(tz)}${repo ? `&repo=${enc(repo)}` : ''}`);
    // A slower answer for a period or repository that's no longer chosen is dropped.
    if (statsDays.peek() === days && repoScope.peek() === repo)
      stats.value = { loaded: true, loading: false, data, error: null };
  } catch (error) {
    stats.value = { ...stats.value, loaded: true, loading: false, error: error.message };
  }
}

export async function loadGitHub({ sync = false, quiet = false } = {}) {
  // A quiet load (the fast poll) leaves the Sync button alone and never overlaps another load.
  if (quiet && github.peek().loading) return;
  if (!quiet) github.value = { ...github.value, loading: true, error: null };
  // With several repositories, every one at once: the view picks the switcher's, and the pull request settings see them all.
  const several = multiRepo.peek();
  try {
    let data;
    if (!several) data = sync ? await api('github/sync', { method: 'POST' }) : await api('github');
    else {
      if (sync) await api('github/sync', { method: 'POST', body: { repo: repoScope.peek() ?? 'all' } });
      data = await api('github?repo=all');
    }
    github.value = { loaded: true, loading: false, data, error: null };
    if (sync) await loadTasks();
  } catch (error) {
    github.value = { ...github.value, loaded: true, loading: false, error: error.message };
  }
}

/** Whether repository `slug`'s agent routine is connected, from the Agents API (false until it loads). */
export function routineConnected(slug) {
  const want = slug ?? repos.value.default;
  return Boolean(agents.value.data?.repos?.find((r) => r.slug === want)?.connected);
}

/** A kickoff's IDEA (IDEA-26): an idea tagged as a kickoff's, whose decision keeps it open (src/kickoff.js). */
export const isKickoffIdea = (t) => Boolean(t) && t.project === 'ideas' && (t.tags ?? []).includes('kickoff-project');

/** Whether Refine from the answers applies to `t`: a structured decision the owner has answered. */
export const isDecided = (t) =>
  Array.isArray(t.decision) && t.decision.length > 0 && t.status === 'completed' && Boolean(t.decisionAnswers);

/** The open general task refining from decision `t`'s answers, if there is one (the board allows one at a time). */
export const refiningFrom = (t) =>
  tasks.value.find((x) => x.status === 'pending' && x.tags.includes('general') && x.related?.includes(t.uuid)) ?? null;

/**
 * Whether New agent shows: the agent routine of the repository in scope is connected, and with every repository
 * in scope, any is. Hidden rather than shown and refused.
 */
export const canNewAgent = computed(() => {
  const d = agents.value.data;
  if (!d?.connected) return false;
  return !repoScope.value || routineConnected(repoScope.value);
});

export async function loadAgents() {
  try {
    agents.value = { loaded: true, data: await api('agents'), error: null };
  } catch (error) {
    agents.value = { ...agents.value, loaded: true, error: error.message };
  }
}

const seenPings = new Set();
let pingsSeeded = false;

/** Loads the open pings. Ones that turn up after the first load raise a toast while the board is open. */
export async function loadPings() {
  try {
    const { pings: list, notices, chases } = await api('pings');
    const fresh = pingsSeeded ? list.filter((p) => !seenPings.has(p.id) && p.kind !== 'fyi') : [];
    for (const p of list) seenPings.add(p.id);
    pingsSeeded = true;
    pings.value = { loaded: true, list, notices: notices ?? [], chases: chases ?? [], error: null };
    if (fresh.length === 1) toast(`${fresh[0].task ?? 'A task'} needs you: ${fresh[0].kind}. See the inbox.`, 'info');
    else if (fresh.length > 1) toast(`${fresh.length} pings need you. See the inbox.`, 'info');
  } catch (error) {
    pings.value = { ...pings.value, loaded: true, error: error.message };
  }
}

// The count on the browser tab's title and the installed app's icon, where the browser has them.
effect(() => {
  const n = openPings.value;
  document.title = n ? `(${n}) ${installName.value}` : installName.value;
  try {
    if (n) navigator.setAppBadge?.(n)?.catch(() => {});
    else navigator.clearAppBadge?.()?.catch(() => {});
  } catch {
    /* no badge API here */
  }
});

export async function loadConnections() {
  try {
    const data = await api('connections');
    connections.value = { ...connections.peek(), loaded: true, data, error: null };
  } catch (error) {
    connections.value = { ...connections.peek(), loaded: true, error: error.message };
  }
}

/** Check now: asks GitHub again (at most every 30 seconds), then shows the new report. */
export async function checkConnections() {
  if (connections.peek().checking) return;
  connections.value = { ...connections.peek(), checking: true };
  try {
    const data = await api('connections/check', { method: 'POST' });
    connections.value = { loaded: true, data, error: null, checking: false };
    toast(
      data.attention
        ? `Checked. ${data.attention === 1 ? '1 connection needs' : `${data.attention} connections need`} attention.`
        : 'Checked. Everything is working.',
      data.attention ? 'info' : 'success',
    );
    loadPings();
  } catch (error) {
    connections.value = { ...connections.peek(), checking: false };
    toast(
      error.status === 429 ? error.message : `Couldn’t check: ${error.message}`,
      error.status === 429 ? 'info' : 'error',
    );
  }
}

export async function loadFeatures() {
  try {
    features.value = { loaded: true, data: await api('features'), error: null };
  } catch (error) {
    features.value = { ...features.value, loaded: true, error: error.message };
  }
}

/** Loads the feature open on the roadmap; a reply for a feature that's no longer open is dropped. */
export async function loadFeature(slug) {
  if (!slug) return;
  try {
    const { feature } = await api(`features/${enc(slug)}`);
    if (selectedFeature.peek() === slug) featureOpen.value = { slug, data: feature, error: null };
  } catch (error) {
    if (selectedFeature.peek() === slug)
      featureOpen.value = {
        slug,
        data: error.status === 404 ? null : (featureOpen.peek()?.data ?? null),
        error: error.message,
      };
  }
}

export async function loadRoutines() {
  try {
    routines.value = { loaded: true, data: await api('routines'), error: null };
  } catch (error) {
    routines.value = { ...routines.value, loaded: true, error: error.message };
  }
}

// ---- the pull request settings at work ----------------------------------------------------

/**
 * Another repository's pull request settings (CLD-125): slug → { keep, merge }, in this browser. The
 * default repository's stay in `keepUpdated` and `mergeWhenGreen`, so the default repository's work as they always did.
 */
export const repoPullSettings = signal(
  (() => {
    try {
      const saved = JSON.parse(pref('pullSettings', '{}'));
      return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    } catch {
      return {};
    }
  })(),
);
effect(() => savePref('pullSettings', JSON.stringify(repoPullSettings.value)));

const isDefaultRepo = (slug) => !slug || slug === repos.value.default;

/** Whether a setting ('keep' or 'merge') is on for repository `slug` (none: the default). */
export function pullSetting(slug, key) {
  if (isDefaultRepo(slug)) return (key === 'keep' ? keepUpdated : mergeWhenGreen).value;
  return Boolean(repoPullSettings.value[slug]?.[key]);
}

export function setPullSetting(slug, key, on) {
  if (isDefaultRepo(slug)) {
    (key === 'keep' ? keepUpdated : mergeWhenGreen).value = on;
    return;
  }
  const next = { ...repoPullSettings.value, [slug]: { ...repoPullSettings.value[slug], [key]: on } };
  if (!next[slug].keep && !next[slug].merge) delete next[slug];
  repoPullSettings.value = next;
}

/** The registered repositories with a setting on: [{ slug, keep, merge }]. */
export const pullSettingsList = computed(() => {
  const slugs = repos.value.list.length ? repos.value.list.map((r) => r.slug) : [repos.value.default];
  return slugs
    .map((slug) => ({ slug, keep: pullSetting(slug, 'keep'), merge: pullSetting(slug, 'merge') }))
    .filter((r) => r.keep || r.merge);
});

/**
 * Only one tab acts on the settings: the one holding this lock, until it closes and the next takes
 * over. Without Web Locks every tab acts, and the server's head-commit check turns a second try away.
 */
const pullLeader = signal(false);
const pullSettingsOn = () => pullSettingsList.value.length > 0 && pullLeader.value;
const pullTried = new Set();
let pullRunning = false;

const PULL_DONE = {
  'update-branch': (n) => `Kept ${n} up to date with main.`,
  'auto-merge': (n) => `Set ${n} to merge when green.`,
  merge: (n) => `Merged ${n}: its checks passed.`,
};
const PULL_WHAT = { 'update-branch': 'update', 'auto-merge': 'set merge when green on', merge: 'merge' };
/** "#12" for the default repository's pull request, "scratch #12" for another's. */
const pullName = (slug, number) => (isDefaultRepo(slug) ? `#${number}` : `${repoName(slug)} #${number}`);
const triedKey = (slug, step) => `${slug}:${actionKey(step)}`;

/** Sends what each repository's settings call for on the last sync, one request at a time, each head commit once. */
async function runPullSettings() {
  const data = github.peek().data;
  if (pullRunning || !pullSettingsOn() || session.peek() !== 'in' || !data?.connected) return;
  const fallback = repos.peek().default;
  const plan = [];
  for (const { slug, keep, merge } of pullSettingsList.peek()) {
    const facts = repoFacts(data, isDefaultRepo(slug) ? null : slug);
    // A repository the board can't write to is left alone; its pull request page says why.
    if (!facts || facts.access?.write?.ok === false) continue;
    const pulls = (data.open ?? []).filter((p) => (p.repo || fallback) === slug);
    const skip = new Set(pulls.filter((p) => mergeSkip.peek().has(skipKey(p.number, slug))).map((p) => p.number));
    const steps = planPullActions(pulls, {
      keepUpdated: keep,
      mergeWhenGreen: merge,
      method: mergeMethod.peek(),
      skip,
      tried: new Set([...pullTried].filter((k) => k.startsWith(`${slug}:`)).map((k) => k.slice(slug.length + 1))),
    });
    for (const step of steps) {
      if (step.action === 'auto-merge' && facts.access?.autoMerge?.ok === false) continue;
      plan.push({ ...step, slug });
    }
  }
  if (!plan.length) return;
  pullRunning = true;
  let wrote = false;
  for (const step of plan) {
    pullTried.add(triedKey(step.slug, step));
    // The owner may have turned a setting off while earlier requests ran.
    if (
      step.action === 'update-branch'
        ? !pullSetting(step.slug, 'keep')
        : !pullSetting(step.slug, 'merge') || mergeSkip.peek().has(skipKey(step.number, step.slug))
    )
      continue;
    try {
      const repo = isDefaultRepo(step.slug) ? {} : { repo: step.slug };
      await api(`github/pulls/${step.number}/${step.action}`, {
        method: 'POST',
        body: { sha: step.sha, method: step.method, setting: true, ...repo },
      });
      wrote = true;
      toast(PULL_DONE[step.action](pullName(step.slug, step.number)), 'success');
    } catch (error) {
      // The board's own checks found the last sync out of date (pushed, merged, closed, not ready, conflicts),
      // or GitHub says it's green already: the next sync says what to do. GitHub's other refusals show.
      if (error.status === 409 && (!error.data?.github || /clean status/iu.test(error.message))) continue;
      toast(`Couldn’t ${PULL_WHAT[step.action]} ${pullName(step.slug, step.number)}: ${error.message}`, 'error');
    }
  }
  pullRunning = false;
  if (wrote) setTimeout(() => loadGitHub(), 8_000); // the server syncs 5 seconds after a write
}
// Turning a setting on again tries its actions afresh, say after fixing what GitHub refused.
const pullOnNow = () => Object.fromEntries(pullSettingsList.value.map((r) => [r.slug, r]));
let pullWasOn = pullOnNow();
effect(() => {
  const now = pullOnNow();
  for (const key of [...pullTried]) {
    const slug = key.slice(0, key.indexOf(':'));
    const updating = key.slice(slug.length + 1).startsWith('update-branch:');
    const kind = updating ? 'keep' : 'merge';
    if (now[slug]?.[kind] && !pullWasOn[slug]?.[kind]) pullTried.delete(key);
  }
  pullWasOn = now;
});
// Runs after every GitHub load and whenever a setting changes; the timeout keeps it out of the effect.
effect(() => {
  void [github.value, pullSettingsList.value, mergeSkip.value, pullLeader.value];
  setTimeout(runPullSettings, 0);
});

let poll = null;
let githubPoll = null;
export function startPolling() {
  if (navigator.locks)
    navigator.locks.request('breakaway-pull-settings', () => {
      pullLeader.value = true;
      return new Promise(() => {});
    });
  else pullLeader.value = true;
  const refresh = () => {
    if (session.value !== 'in') return;
    // A hidden tab keeps reading GitHub only for the pull request settings (browsers slow it to about once a minute).
    if (document.visibilityState !== 'visible') {
      if (pullSettingsOn()) loadGitHub();
      return;
    }
    loadTasks();
    loadHealth();
    if (view.value === 'activity' && activity.value.events.length <= 40) loadActivity();
    if (view.value === 'activity') loadStats({ quiet: true });
    if (view.value === 'connections') loadConnections();
    if (view.value === 'roadmap') {
      loadFeatures();
      loadFeature(selectedFeature.value);
    }
    loadGitHub(); // the nav counts what is ready to merge
    loadAgents();
    loadPings();
    loadRepos();
  };
  clearInterval(poll);
  poll = setInterval(refresh, 30_000);
  // The GitHub view is where people watch checks finish, and the server syncs about 5 seconds after a webhook.
  clearInterval(githubPoll);
  githubPoll = setInterval(() => {
    if (session.value === 'in' && view.value === 'github' && document.visibilityState === 'visible')
      loadGitHub({ quiet: true });
  }, 8_000);
  if (!github.value.loaded) loadGitHub();
  document.addEventListener('visibilitychange', refresh);
}

// ---- messages ------------------------------------------------------------------------------

export const toasts = signal([]);
let toastId = 0;

/** A short message; the toast region is a polite live region, so it's read out once. */
export function toast(text, tone = 'info') {
  const id = (toastId += 1);
  toasts.value = [...toasts.value.slice(-2), { id, text, tone }];
  setTimeout(
    () => {
      toasts.value = toasts.value.filter((t) => t.id !== id);
    },
    tone === 'error' ? 8000 : 4500,
  );
}

export const confirmState = signal(null);
/** An in-app confirm dialog: resolves true or false. */
export function confirmDialog(options) {
  return new Promise((resolve) => {
    confirmState.value = { ...options, resolve };
  });
}

// ---- the view, filters, and the URL -------------------------------------------------------

export const VIEWS = [
  { id: 'board', label: 'Board', key: 'b' },
  { id: 'list', label: 'List', key: 'l' },
  { id: 'roadmap', label: 'Roadmap', key: 'm' },
  { id: 'graph', label: 'Dependencies', key: 'g' },
  { id: 'inbox', label: 'Inbox', key: 'o' },
  { id: 'activity', label: 'Activity', key: 'a' },
  { id: 'github', label: 'GitHub', key: 'h' },
  { id: 'specs', label: 'Specs', key: 'e' },
  { id: 'agents', label: 'Agents', key: 'x' },
  { id: 'routines', label: 'Routines', key: 'u' },
  { id: 'connections', label: 'Connections', key: 'w' },
];
/**
 * Pages that aren't in the nav: the Add a repository wizard (CLD-194), reached from Connections and the switcher,
 * Settings (WEB-32), at #/settings from the sidebar's foot, a repository's settings (WEB-30), at
 * #/settings/<slug>, and Kickoff (WEB-35), at #/kickoff to start one and #/kickoff/<id> to carry one on.
 */
const PAGE_IDS = ['add-repo', 'settings', 'repo-settings', 'kickoff'];
const VIEW_IDS = [...VIEWS.map((v) => v.id), ...PAGE_IDS];

export const EMPTY_FILTERS = { q: '', areas: [], horizons: [], roles: [], claim: 'any', done: 'recent' };
export const view = signal('board');
export const selected = signal(null);
export const taskView = signal(null); // 'sidebar' or 'modal' when the URL says how to open the task, else null
export const taskMode = computed(() => taskView.value ?? openIn.value);
export const filters = signal(EMPTY_FILTERS);
export const listSort = signal({ key: 'rank', dir: 'asc' });
export const listGroup = signal('none');
export const selectedRoutine = signal(null); // a routine's slug, open in the routines view's panel
export const selectedFeature = signal(null); // a feature's slug, open on the roadmap
/** The spec open in the Specs view (WEB-25): `{ slug, path }`, slug null for the default repository's, or null. */
export const selectedSpec = signal(null);
export const focusPing = signal(null); // the ping the inbox scrolls to and focuses, from #/inbox?ping=<id>
export const newTask = signal(null); // null, or the defaults for the new-task dialog
/** Whether the New agent dialog is open (docs/specs/IDEA-30-new-agent.md, section 5). */
export const newAgent = signal(false);
/** The task menu (WEB-24), open on a task: `{ uuid, x, y, from, selection }`, or null. */
export const taskMenu = signal(null);
/** A task to open at its comment field, set by the task menu's Add a comment; the panel focuses it and clears it. */
export const focusComment = signal(null);
export const helpOpen = signal(false);
/** The repository the Add a repository wizard is on: `{ slug }` once registered, `{ github }` before, or null to pick one. */
export const addRepoTarget = signal(null);
/** The repository whose settings page is open (#/settings/<slug>, WEB-30), as the address spells it, or null. */
export const settingsSlug = signal(null);
/** The kickoff open on #/kickoff/<id> (WEB-35), or null for #/kickoff: the list and the form to start one. */
export const kickoffId = signal(null);
/** The wizard's step to open and scroll to once it loads (`'deploys'`, from Kickoff's Put it online, WEB-36), or null. */
export const addRepoAt = signal(null);
/** Where the Settings page scrolls to once it opens (`'repos'` for its list of repositories), or null for the top. */
export const settingsAt = signal(null);

const safeDecode = (text) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

const csv = (value) => (value ? value.split(',').filter(Boolean) : []);

let firstParse = true;

function parseHash() {
  const [path, query = ''] = location.hash.replace(/^#\/?/u, '').split('?');
  const p = new URLSearchParams(query);
  batch(() => {
    // A link without ?repo= means every repository; the first load falls back on the one remembered here.
    const repo = p.get('repo');
    if (repo || !firstParse) repoChoice.value = repo && /^[a-z][a-z0-9-]{0,31}$/u.test(repo) ? repo : 'all';
    firstParse = false;
    // Settings is #/settings, and a repository's are at #/settings/<slug>; the slug is kept as typed, so a misspelt
    // one can say so.
    const settings = /^settings(?:\/([^/]{0,64}))?$/u.exec(path);
    const kickoff = /^kickoff(?:\/([0-9a-f-]{36}))?$/u.exec(path);
    kickoffId.value = kickoff?.[1] ?? null;
    view.value = settings
      ? settings[1]
        ? 'repo-settings'
        : 'settings'
      : kickoff
        ? 'kickoff'
        : VIEW_IDS.includes(path)
          ? path
          : 'board';
    settingsSlug.value = settings?.[1] ? safeDecode(settings[1]).toLowerCase() : null;
    selected.value = p.get('task');
    selectedRoutine.value = path === 'routines' ? p.get('routine') : null;
    selectedSpec.value = path === 'specs' ? readSpecParam(p.get('spec')) : null;
    const feature = path === 'roadmap' ? p.get('feature') : null;
    selectedFeature.value = feature && /^[a-z][a-z0-9_-]{0,39}$/u.test(feature) ? feature : null;
    focusPing.value = path === 'inbox' && /^\d+$/u.test(p.get('ping') ?? '') ? p.get('ping') : null;
    taskView.value = ['sidebar', 'modal'].includes(p.get('view')) ? p.get('view') : null;
    githubConnect.value = p.get('connect');
    githubPr.value = /^(?:[a-z][a-z0-9-]{0,31}:)?\d+$/u.test(p.get('pr') ?? '') ? p.get('pr') : null;
    const add = p.get('add');
    const gh = p.get('github');
    addRepoTarget.value =
      path !== 'add-repo'
        ? null
        : add && /^[a-z][a-z0-9-]{0,31}$/u.test(add)
          ? { slug: add }
          : gh && /^[\w.-]{1,39}\/[\w.-]{1,100}$/u.test(gh)
            ? { github: gh }
            : null;
    filters.value = {
      q: p.get('q') ?? '',
      areas: csv(p.get('area')),
      horizons: csv(p.get('horizon')),
      roles: csv(p.get('role')),
      claim: p.get('claim') ?? 'any',
      done: p.get('done') ?? 'recent',
    };
    listSort.value = { key: p.get('sort') ?? 'rank', dir: p.get('dir') === 'desc' ? 'desc' : 'asc' };
    listGroup.value = p.get('group') ?? 'none';
  });
}

export function hashFor({
  view: v = view.value,
  task = selected.value,
  f = filters.value,
  pr = githubPr.value,
  mode = taskView.value,
  routine = selectedRoutine.value,
  feature = selectedFeature.value,
  ping = focusPing.value,
  settings = settingsSlug.value,
  spec = selectedSpec.value,
  kickoff = kickoffId.value,
} = {}) {
  const p = new URLSearchParams();
  if (repoScope.value) p.set('repo', repoScope.value);
  if (v === 'routines' && routine) p.set('routine', routine);
  if (v === 'roadmap' && feature) p.set('feature', feature);
  if (v === 'specs' && spec) p.set('spec', specParam(spec.path, spec.slug, repos.peek().default));
  if (v === 'inbox' && ping) p.set('ping', ping);
  if (task) p.set('task', task);
  if (task && mode) p.set('view', mode);
  if (v === 'github' && githubConnect.value) p.set('connect', githubConnect.value);
  if (v === 'github' && pr) p.set('pr', pr);
  if (v === 'add-repo' && addRepoTarget.value?.slug) p.set('add', addRepoTarget.value.slug);
  else if (v === 'add-repo' && addRepoTarget.value?.github) p.set('github', addRepoTarget.value.github);
  if (f.q) p.set('q', f.q);
  if (f.areas.length) p.set('area', f.areas.join(','));
  if (f.horizons.length) p.set('horizon', f.horizons.join(','));
  if (f.roles.length) p.set('role', f.roles.join(','));
  if (f.claim !== 'any') p.set('claim', f.claim);
  if (f.done !== 'recent') p.set('done', f.done);
  if (v === 'list') {
    if (listSort.value.key !== 'rank') p.set('sort', listSort.value.key);
    if (listSort.value.dir !== 'asc') p.set('dir', listSort.value.dir);
    if (listGroup.value !== 'none') p.set('group', listGroup.value);
  }
  const qs = p.toString().replaceAll('%2C', ',').replaceAll('%2F', '/');
  const path =
    v === 'repo-settings'
      ? `settings${settings ? `/${enc(settings)}` : ''}`
      : v === 'kickoff' && kickoff
        ? `kickoff/${kickoff}`
        : v;
  return `#/${path}${qs ? `?${qs}` : ''}`;
}

// A push links to /?inbox=<ping id>: open the inbox on it.
try {
  const target = new URLSearchParams(location.search).get('inbox');
  if (target !== null) history.replaceState(null, '', `/#/inbox${/^\d+$/u.test(target) ? `?ping=${target}` : ''}`);
} catch {
  /* the inbox just opens from the nav */
}

parseHash();
addEventListener('hashchange', parseHash);
// Filter and sort changes replace the URL; opening tasks and switching views add history.
effect(() => {
  const hash = hashFor();
  if (location.hash !== hash) history.replaceState(null, '', hash);
});

/** The `pr` a link carries: the number for the default repository's pull request, "<slug>:<number>" for another's. */
export const pullParam = (number, slug = null) =>
  !number ? null : slug && slug !== repos.peek().default ? `${slug}:${number}` : String(number);

export function openPull(number, slug = null) {
  location.hash = hashFor({ view: 'github', task: null, pr: pullParam(number, slug) });
}

export function go(v) {
  location.hash = hashFor({ view: v, pr: null, ping: null });
}

/**
 * Opens the Add a repository wizard: on a registered repository (`slug`), one not registered yet (`github`), or
 * neither; `at` names a step to open and scroll to (`'deploys'`).
 */
export function openAddRepo(target = null, at = null) {
  addRepoTarget.value = target;
  addRepoAt.value = at;
  location.hash = hashFor({ view: 'add-repo', task: null, pr: null, ping: null });
}

/** Opens Kickoff (WEB-35): one kickoff's page by its id, or the list and the form to start one with none. */
export function openKickoff(id = null) {
  kickoffId.value = id;
  location.hash = hashFor({ view: 'kickoff', kickoff: id, task: null, pr: null, ping: null });
}

/** A link to a repository's settings page (WEB-30), or to Settings (WEB-32) with none. */
export const repoSettingsHref = (slug = null) =>
  hashFor({ view: slug ? 'repo-settings' : 'settings', settings: slug, task: null, pr: null, ping: null });

/** Opens a repository's settings page (WEB-30), or Settings at its list of repositories with none (WEB-32). */
export function openRepoSettings(slug = null) {
  if (!slug) settingsAt.value = 'repos';
  location.hash = repoSettingsHref(slug);
}

export function openTask(t) {
  location.hash = hashFor({ task: typeof t === 'string' ? t : ref(t) });
}

/** Show the open task in the modal or the sidebar; the URL carries the choice. */
export function setTaskMode(mode) {
  if (selected.value) location.hash = hashFor({ mode });
}

export function openRoutine(slug) {
  location.hash = hashFor({ view: 'routines', routine: slug });
}

/** The Specs view's address with spec `path` of repository `slug` (null: the default's) open, or none. */
export const specHref = (path, slug = null) =>
  hashFor({ view: 'specs', spec: path ? { slug, path } : null, pr: null, ping: null });

/** Opens a spec in the Specs view (WEB-25); a task stays open beside it only where it already was. */
export function openSpec(path, slug = null) {
  location.hash = specHref(path, slug);
}

export function closeSpec() {
  location.hash = specHref(null);
}

export function openFeature(slug) {
  location.hash = hashFor({ view: 'roadmap', feature: slug });
}

export function closeFeature() {
  location.hash = hashFor({ view: 'roadmap', feature: null });
}

export function closeRoutine() {
  location.hash = hashFor({ view: 'routines', routine: null });
}

export function closeTask() {
  if (selected.value) location.hash = hashFor({ task: null });
}

export function setFilter(changes) {
  filters.value = { ...filters.value, ...changes };
}

export const activeFilters = computed(() => {
  const f = filters.value;
  return (
    (f.q ? 1 : 0) +
    f.areas.length +
    f.horizons.length +
    f.roles.length +
    (f.claim !== 'any' ? 1 : 0) +
    (f.done !== 'recent' ? 1 : 0)
  );
});

function haystack(t) {
  return [
    t.wid,
    t.short,
    t.description,
    t.claim,
    areaLabel(t.project),
    t.project,
    multiRepo.value ? t.repo : null,
    t.horizon,
    t.spec,
    t.pr,
    t.brief,
    t.doneWhen,
    ...t.tags.map((x) => `+${x}`),
    ...t.annotations.map((a) => a.text),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** Tasks that pass the filters, in the server's order. Deleted tasks never show. */
export const visible = computed(() => {
  const f = filters.value;
  const words = f.q.toLowerCase().split(/\s+/u).filter(Boolean);
  const now = Date.now();
  return tasks.value.filter((t) => {
    if (!inScope(t.repo)) return false;
    const state = stateOf(t);
    if (state === 'done') {
      if (f.done === 'hide') return false;
      if (f.done === 'recent' && now - Date.parse(t.end ?? 0) > 30 * DAY) return false;
      if (f.done === 'unshipped' && shipState(t) !== 'unshipped') return false;
      if (f.done === 'staged' && shipState(t) !== 'staged') return false;
    }
    if (t.horizon === 'archive' && !f.horizons.includes('archive')) return false;
    if (f.areas.length && !f.areas.includes(t.project)) return false;
    if (f.horizons.length && !f.horizons.includes(t.horizon)) return false;
    if (f.roles.length && !f.roles.every((r) => t.tags.includes(r))) return false;
    if (f.claim === 'unclaimed' && t.claim) return false;
    if (f.claim === 'claimed' && !t.claim) return false;
    if (f.claim === 'mine' && t.claim !== me.value) return false;
    if (words.length) {
      const hay = haystack(t);
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
});

/** The open task, found by work ID or UUID (prefix). */
export const current = computed(() => {
  const r = selected.value;
  if (!r) return null;
  const upper = r.toUpperCase();
  const lower = r.toLowerCase();
  return (
    tasks.value.find((t) => t.wid === upper) ??
    tasks.value.find((t) => t.uuid === lower || t.uuid.startsWith(lower)) ??
    null
  );
});

/** The order j and k move through: whatever the current view shows. */
export const navOrder = signal([]);

// ---- changes -------------------------------------------------------------------------------

/**
 * A start the board's own limits refused, which Force start could skip: the reason, and `run`, which starts it
 * again past them. Shown by ForceStartHost, so every start control offers it the same way.
 */
export const forceOffer = signal(null);

/**
 * Runs a change and toasts the result. `request` gets whether this is a forced try. With `forceable`, a refusal
 * only the board's limits caused (`data.forceable`) opens the Force start offer instead of a toast; `after` runs
 * when the forced try works, since the caller has moved on by then.
 * @param {(force: boolean) => Promise<any>} request
 * @param {string | ((result: any) => string) | null} message
 * @param {{ forceable?: boolean, force?: boolean, after?: (result: any) => void }} [options]
 */
async function change(request, message, { forceable = false, force = false, after } = {}) {
  try {
    const result = await request(force);
    if (message) toast(typeof message === 'function' ? message(result) : message, 'success');
    await loadTasks();
    if (activity.value.loaded) loadActivity();
    loadHealth();
    if (force) after?.(result);
    return result;
  } catch (error) {
    if (forceable && !force && error.data?.forceable) {
      forceOffer.value = {
        reason: error.message,
        run: () => change(request, message, { forceable, force: true, after }),
      };
      return null;
    }
    toast(error.message, 'error');
    return null;
  }
}

const path = (t) => `tasks/${enc(t.uuid)}`;

/** Releases someone else's claim, once the owner confirms: they may still be working on it. */
export async function releaseOther(t) {
  const ok = await confirmDialog({
    title: `Release ${t.claim}’s claim?`,
    body: `${t.claim} may still be working on ${ref(t)}. Check its notes first, and tell them if you can.`,
    confirmLabel: 'Release it',
  });
  if (ok) actions.release(t, true);
}

export const actions = {
  claim: (t) =>
    change(() => api(`${path(t)}/claim`, { method: 'POST', body: { agent: me.value } }), `You have ${ref(t)} now.`),
  release: (t, force = false) =>
    change(
      () => api(`${path(t)}/release`, { method: 'POST', body: { agent: me.value, force } }),
      `${ref(t)} is free again.`,
    ),
  done: (t, note) =>
    change(() => api(`${path(t)}/done`, { method: 'POST', body: note ? { note } : {} }), `${ref(t)} is done.`),
  reopen: (t) =>
    change(() => api(path(t), { method: 'PATCH', body: { status: 'pending' } }), `${ref(t)} is open again.`),
  remove: (t) => change(() => api(path(t), { method: 'PATCH', body: { status: 'deleted' } }), `${ref(t)} is deleted.`),
  update: (t, changes, message = 'Saved.') => change(() => api(path(t), { method: 'PATCH', body: changes }), message),
  comment: (t, text) => change(() => api(`${path(t)}/comments`, { method: 'POST', body: { text } }), 'Comment added.'),
  /**
   * Submits the owner's answers (the board finishes the task and unblocks what waited; a kickoff's IDEA stays open).
   * With `carryOn` (a kickoff's Send answers and carry on, BRK-134), the board also starts the next run on it, or
   * queues it for room. Resolves to the result, or null after showing the error.
   */
  async submitDecision(t, answers, { carryOn = false } = {}) {
    const result = await change(
      () => api(`${path(t)}/decision/answers`, { method: 'POST', body: carryOn ? { answers, carryOn } : { answers } }),
      (r) =>
        !carryOn
          ? isKickoffIdea(t)
            ? `Sent your answers on ${ref(t)}. Start the next run when you’re ready.`
            : `${ref(t)} is decided.`
          : r.waiting
            ? `Sent your answers. The next run on ${ref(t)} starts when there’s room: ${r.waiting}`
            : r.refusal
              ? `Sent your answers, but the next run didn’t start: ${r.refusal}`
              : `Sent your answers and started the next run on ${ref(t)}.`,
    );
    if (!result) loadTasks();
    if (carryOn) loadAgents();
    return result;
  },
  reopenDecision: (t) =>
    change(
      () => api(`${path(t)}/decision/answers`, { method: 'DELETE', body: {} }),
      `${ref(t)} is open again, with your answers kept.`,
    ),
  /** A decision with no questions: the note becomes a comment, +decide goes, and the task is done, in one change. */
  decide: (t, text) =>
    change(
      () =>
        api(path(t), {
          method: 'PATCH',
          body: { annotate: `Decided by the owner: ${text}`, removeTags: ['decide'], status: 'completed' },
        }),
      `${ref(t)} is decided.`,
    ),
  /**
   * New agent: a task from the owner's prompt, and an agent on it, or waiting for room. Throws the board's
   * refusal (no task is made then), so the dialog can show it beside the prompt.
   * With `decision` (Refine from the answers), the board writes the prompt from that answered decision, and `note`
   * goes under it; with `next` (minor or major, BRK-100), the prompt that sets `repo`'s next version, which must
   * still be `version`; with `spec` (a path in `repo`'s specs directory, WEB-26), the prompt that refines that spec,
   * and `note` is the owner's request; with `chase` (a feature's slug, BRK-137), a road captain for that chase, in
   * its repository and always force started.
   * With `feature` (a feature's slug, BRK-150), the board writes the prompt from the feature and its tasks, and `note`
   * is what to refine.
   * @param {{ prompt?: string, repo?: string, force?: boolean, decision?: string, next?: string, version?: string, spec?: string, note?: string, chase?: string, feature?: string }} body
   */
  async startGeneral({ prompt, repo, force = false, decision, next, version, spec, note, chase, feature }) {
    const result = await api('agents/general', {
      method: 'POST',
      body: {
        prompt,
        repo: repo || undefined,
        force: force || undefined,
        decision,
        next,
        version,
        spec,
        note: note || undefined,
        chase,
        feature,
      },
    });
    if (next) loadGitHub({ quiet: true });
    if (feature) loadFeature(feature);
    await loadTasks();
    if (activity.value.loaded) loadActivity();
    loadAgents();
    loadHealth();
    return result;
  },
  /**
   * Refine from the answers, before starting: the prompt the board would write from decision `t`, the task already
   * refining from it, and why its repository's routine can't start one. Makes nothing; throws the board's refusal.
   */
  previewRefine: (t) => api('agents/general', { method: 'POST', body: { decision: t.uuid, dryRun: true } }),
  /**
   * Prepare the next version (BRK-100), before starting: the prompt the board would write to set repository `repo`'s
   * next `next` (minor or major), the task already preparing one, and why its routine can't start one. Makes nothing.
   */
  previewNextVersion: (repo, next) => api('agents/general', { method: 'POST', body: { repo, next, dryRun: true } }),
  /**
   * Refine a spec with an agent (WEB-26), before starting: the prompt the board would write for spec `path` in
   * repository `repo`, the task already on it, and why its routine can't start one. Makes nothing.
   */
  previewSpec: (repo, path) => api('agents/general', { method: 'POST', body: { repo, spec: path, dryRun: true } }),
  /** Refine a feature with an agent, before starting (BRK-150): the prompt, the open one, and why it can't start. */
  previewFeature: (slug) => api('agents/general', { method: 'POST', body: { feature: slug, dryRun: true } }),
  /** `after` runs when the owner forces a start the board's limits refused. */
  async startAgent(t, note, after) {
    const result = await change(
      (force) =>
        api('agents/start', {
          method: 'POST',
          body: { ref: t.uuid, note: note || undefined, force: force || undefined },
        }),
      `Started an agent on ${ref(t)}.`,
      { forceable: true, after },
    );
    loadAgents();
    return result;
  },
  /** Starts a refine run. Resolves to the result, or null after showing the error, so the caller can keep what was typed. */
  async refineAgent(t, note, after) {
    const result = await change(
      (force) =>
        api('agents/start', { method: 'POST', body: { ref: t.uuid, note, mode: 'refine', force: force || undefined } }),
      `Started an agent refining ${ref(t)}.`,
      { forceable: true, after },
    );
    loadAgents();
    return result;
  },
  /** With dryRun, only asks which tasks would start and why the rest wouldn't. */
  async startNext(count, dryRun = false) {
    if (dryRun) {
      try {
        return await api('agents/next', {
          method: 'POST',
          body: { count, repo: repoScope.value ?? undefined, dryRun: true },
        });
      } catch (error) {
        toast(error.message, 'error');
        return null;
      }
    }
    const result = await change(
      () => api('agents/next', { method: 'POST', body: { count, repo: repoScope.value ?? undefined } }),
      (r) =>
        r.started.length
          ? `Started ${r.started.length === 1 ? 'an agent' : `${r.started.length} agents`}: ${r.started.map((s) => s.wid).join(', ')}.`
          : 'Nothing could start just now.',
    );
    loadAgents();
    return result;
  },
  /** With dryRun, only asks what closing now would move. */
  async closeHorizon(dryRun = false) {
    if (dryRun) {
      try {
        return await api('horizons/close', { method: 'POST', body: { dryRun: true } });
      } catch (error) {
        toast(error.message, 'error');
        return null;
      }
    }
    return change(
      () => api('horizons/close', { method: 'POST', body: {} }),
      (r) => `Now is closed: ${r.archived} archived, ${r.carriedOver} carried over, ${r.movedUp} moved up.`,
    );
  },
  /** Runs a routine. Resolves to the result, or null after showing the error, so the caller can keep what was typed. */
  async runRoutine(r, note, after) {
    const result = await change(
      (force) =>
        api(`routines/${r.slug}/run`, { method: 'POST', body: { note: note || undefined, force: force || undefined } }),
      (x) => `Started ${x.task.wid}, ${r.name}.`,
      { forceable: true, after },
    );
    loadRoutines();
    return result;
  },
  async saveRoutine(slug, body) {
    const result = await change(
      () => (slug ? api(`routines/${slug}`, { method: 'PATCH', body }) : api('routines', { method: 'POST', body })),
      'Routine saved.',
    );
    loadRoutines();
    return result;
  },
  async addTrigger(slug, label) {
    const result = await change(
      () => api(`routines/${slug}/triggers`, { method: 'POST', body: { label: label || undefined } }),
      'Trigger made.',
    );
    loadRoutines();
    return result;
  },
  async revokeTrigger(slug, id) {
    const result = await change(
      () => api(`routines/${slug}/triggers/${id}`, { method: 'DELETE', body: {} }),
      'Trigger revoked.',
    );
    loadRoutines();
    return result;
  },
  async routineSettings(settings) {
    const message =
      settings.paused === undefined
        ? `Routines can run ${settings.dailyCap} times a day in all.`
        : settings.paused
          ? 'All routines are paused.'
          : 'Routines can run.';
    const result = await change(() => api('routines/settings', { method: 'PATCH', body: settings }), message);
    loadRoutines();
    return result;
  },
  /** A repository's caps on agents (`max`, `hourly`; null for none), kept with the rest of its routine settings. */
  async repoCaps(slug, caps) {
    const result = await change(async () => {
      const current = (await api('repos')).repos.find((r) => r.slug === slug);
      return api(`repos/${slug}`, { method: 'PATCH', body: { routine: { ...current?.routine, ...caps } } });
    }, 'Cap saved.');
    loadAgents();
    return result;
  },
  /** The owner's Claude plan (CLD-198): sets the shared limits and the routines' daily cap to its defaults. */
  async claudePlan(plan) {
    const result = await change(
      () => api('agents/settings', { method: 'PATCH', body: { plan } }),
      (r) => `Limits set for your plan: ${r.settings.max} agents at once, ${r.settings.hourly} starts an hour.`,
    );
    loadAgents();
    loadRoutines();
    return result;
  },
  async agentSettings(settings) {
    const result = await change(
      () => api('agents/settings', { method: 'PATCH', body: settings }),
      'Agent settings saved.',
    );
    loadAgents();
    return result;
  },
  async fixAlert(alert) {
    const result = await change(
      (force) =>
        api(`github/alerts/${alert.number}/fix`, {
          method: 'POST',
          body: { ...(isDefaultRepo(alert.repo) ? {} : { repo: alert.repo }), force: force || undefined },
        }),
      (r) =>
        r.run
          ? `Started an agent on ${ref(r.task)} for the ${alert.package} alert.`
          : `${ref(r.task)} already has it: ${r.already}.`,
      { forceable: true },
    );
    loadAgents();
    loadGitHub();
    return result;
  },
  /** Fix with an agent on a pull request. `problem`: conflicts, failing, or review. */
  async fixPull(pr, problem, after) {
    const result = await change(
      (force) =>
        api(`github/pulls/${pr.number}/fix`, {
          method: 'POST',
          body: { problem, ...(isDefaultRepo(pr.repo) ? {} : { repo: pr.repo }), force: force || undefined },
        }),
      (r) =>
        r.run
          ? `Started an agent on ${ref(r.task)} for #${pr.number}.`
          : `${ref(r.task)} already has it: ${r.already}.`,
      { forceable: true, after },
    );
    loadAgents();
    loadGitHub();
    return result;
  },
  /** Safe to merge? on a Dependabot pull request, or Review with an agent on any other one (WEB-23). */
  async reviewPull(pr, after) {
    const started = isDependabot(pr.author)
      ? `Started an agent to test #${pr.number}. Its answer comes as a note and a comment.`
      : `Started an agent to review #${pr.number}. Its answer shows on the pull request’s page.`;
    const result = await change(
      (force) =>
        api(`github/pulls/${pr.number}/review`, {
          method: 'POST',
          body: { ...(isDefaultRepo(pr.repo) ? {} : { repo: pr.repo }), force: force || undefined },
        }),
      (r) => (r.run ? started : `${ref(r.task)} already has it: ${r.already}.`),
      { forceable: true, after },
    );
    loadAgents();
    loadGitHub();
    return result;
  },
  /** Adds a feature (no `slug` given: `body.slug`) or changes one. Resolves to the feature, or null after the error. */
  async saveFeature(slug, body, message = 'Feature saved.') {
    const result = await change(
      () =>
        slug ? api(`features/${enc(slug)}`, { method: 'PATCH', body }) : api('features', { method: 'POST', body }),
      message,
    );
    loadFeatures();
    if (result?.feature && selectedFeature.peek() === result.feature.slug) {
      featureOpen.value = { slug: result.feature.slug, data: result.feature, error: null };
      loadFeature(result.feature.slug); // with its chase's queue, which a save doesn't return
    }
    return result?.feature ?? null;
  },
  /**
   * Adds a feature and shapes it as an idea (WEB-42): the board makes an idea from its brief, tagged with it, and
   * starts its agent. Resolves to the feature, or null after the error.
   */
  async shapeFeature(body) {
    const result = await change(
      () => api('features', { method: 'POST', body }),
      (r) => `Feature added. ${r.idea.wid ?? 'Its idea'} shapes it: an agent starts on it when there’s room.`,
    );
    loadFeatures();
    return result?.feature ?? null;
  },
  /**
   * Makes a feature from tasks picked on the Dependencies view (WEB-15): `body.tasks` join by the tag, except
   * those already in another feature. Resolves to `{ feature, joined, kept }`, or null after the error.
   */
  async featureFromTasks(body) {
    const result = await change(
      () => api('features', { method: 'POST', body }),
      (r) => `+${r.feature.slug} is a feature now, with ${plural(r.joined.length, 'task')}.`,
    );
    loadFeatures();
    return result?.feature ? result : null;
  },
  /**
   * Starts or stops the chase on feature `f`, or sets how many agents it allows in an area (`body`: `on`,
   * `parallel`). The feature page and the Agents view follow the answer straight away.
   */
  async chase(f, body, message) {
    const result = await change(() => api(`features/${enc(f.slug)}/chase`, { method: 'POST', body }), message);
    const open = featureOpen.peek();
    if (result?.chase && open?.slug === f.slug && open.data)
      featureOpen.value = { ...open, data: { ...open.data, chase: result.chase } };
    if (open?.slug === f.slug) loadFeature(f.slug); // its progress moves with what the chase started
    loadFeatures();
    loadAgents();
    return result;
  },
  /** What a chase on `f` would start now, without starting anything; null after the error. */
  async chasePreview(f) {
    try {
      return await api(`features/${enc(f.slug)}/chase`, { method: 'POST', body: { on: true, dryRun: true } });
    } catch (error) {
      toast(error.message, 'error');
      return null;
    }
  },
  /**
   * Pulls `release` into now (BRK-126): asks the server what would move, warns that the whole dependency
   * chain comes too, then moves it. Resolves to the result, or null when cancelled or after the error.
   */
  async pullRelease(release) {
    let plan;
    try {
      plan = await api(`releases/${enc(release)}/pull`, { method: 'POST', body: { dryRun: true } });
    } catch (error) {
      toast(error.message, 'error');
      return null;
    }
    const chain = plan.tasks.filter((t) => t.chain);
    const own = plan.tasks.length - chain.length;
    const named = chain.slice(0, 5).map((t) => t.wid ?? t.uuid.slice(0, 8));
    const more = chain.length > named.length ? `, and ${chain.length - named.length} more` : '';
    const ok = await confirmDialog({
      title: `Pull ${release} into now?`,
      body: `${plural(own, 'open task')} aimed at ${release} ${own === 1 ? 'moves' : 'move'} into now, and the whole dependency chain comes too${
        chain.length
          ? `: ${plural(chain.length, 'task')} from outside ${release}, whatever ${chain.length === 1 ? 'its' : 'their'} release or feature (${named.join(', ')}${more})`
          : ''
      }.`,
      confirmLabel: 'Pull into now',
    });
    if (!ok) return null;
    const result = await change(
      () => api(`releases/${enc(release)}/pull`, { method: 'POST', body: {} }),
      (r) => `${release} is in now: ${plural(r.tasks.length, 'task')} moved.`,
    );
    loadFeatures();
    return result;
  },
  async deleteFeature(f) {
    const ok = await confirmDialog({
      title: `Delete ${f.title}?`,
      body: `Its tasks keep their +${f.slug} tag, so you can make it a feature again.`,
      confirmLabel: 'Delete it',
      tone: 'danger',
    });
    if (!ok) return null;
    const result = await change(() => api(`features/${enc(f.slug)}`, { method: 'DELETE', body: {} }), 'Deleted.');
    if (result) closeFeature();
    loadFeatures();
    return result;
  },
  async create(input) {
    const result = await change(
      () => api('tasks', { method: 'POST', body: input }),
      (r) => `Added ${ref(r.tasks[0])}.`,
    );
    return result?.tasks?.[0] ?? null;
  },
};
