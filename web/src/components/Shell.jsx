import { useEffect, useRef, useState } from 'preact/hooks';
import {
  Activity,
  Bell,
  Bot,
  FolderGit2,
  FolderPlus,
  Inbox,
  GitPullRequest,
  Kanban,
  List,
  ListFilter,
  Menu,
  Milestone,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Plus,
  Repeat,
  ScrollText,
  Search,
  Settings,
  X,
} from 'lucide-preact';
import { HORIZONS, NOTICE_LABEL, PING_KIND_LABEL, ROLES, ago, plural } from '../lib/model.js';
import {
  EMPTY_FILTERS,
  VIEWS,
  activeFilters,
  agents,
  areaList,
  countByRepo,
  inScope,
  multiRepo,
  openAddRepo,
  openRepoSettings,
  openPingsHere,
  repoName,
  repoScope,
  repos,
  scopedPings,
  setRepo,
  connectionsAttention,
  github,
  githubView,
  filters,
  hashFor,
  health,
  healthFailed,
  helpOpen,
  lanes,
  installName,
  me,
  menuOpen,
  canNewAgent,
  newAgent,
  newTask,
  pings,
  setFilter,
  sidebar,
  tasks,
  toggleSidebar,
  view,
  visible,
} from '../lib/store.js';
import { useMedia } from '../lib/media.js';
import { Title } from '../lib/richtext.jsx';
import { Dialog, Kbd, Popover, RepoChip, Segmented } from './ui.jsx';
import { Logo } from './Logo.jsx';

const VIEW_ICONS = {
  board: Kanban,
  list: List,
  roadmap: Milestone,
  graph: Network,
  activity: Activity,
  github: GitPullRequest,
  specs: ScrollText,
  agents: Bot,
  routines: Repeat,
  connections: Plug,
};
/** The views in the sidebar. The inbox opens from the bell at the top right instead. */
const NAV_VIEWS = VIEWS.filter((v) => v.id !== 'inbox');

/** How many connections need attention, on the Connections item and the Settings gear (CLD-121). */
function AttentionBadge() {
  const n = connectionsAttention.value;
  if (!n) return null;
  return (
    <span class="side-badge side-badge-attention">
      <span class="visually-hidden">, </span>
      {n}
      <span class="visually-hidden"> {n === 1 ? 'connection needs' : 'connections need'} attention</span>
    </span>
  );
}

/**
 * A count on a view's item: pull requests ready to merge, agents working, connections needing attention.
 * @param {Record<string, any>} props
 */
function NavBadge({ id }) {
  if (id === 'connections') return <AttentionBadge />;
  if (id === 'github') {
    // The switcher's repository, or every one under All, split by repository.
    const ready = (githubView.value?.open ?? []).filter((p) => p.verdict === 'ready');
    const n = github.value.data?.all ? ready.length : (github.value.data?.readyToMerge ?? 0);
    if (!n) return null;
    const split = countByRepo(ready.map((p) => p.repo));
    return (
      <span class="side-badge side-badge-ready" title={split ?? undefined}>
        <span class="visually-hidden">, </span>
        {n}
        <span class="visually-hidden"> ready to merge{split ? `: ${split}` : ''}</span>
      </span>
    );
  }
  if (id === 'agents') {
    const d = agents.value.data;
    const running = d?.connected ? d.running.filter((r) => inScope(r.repo)) : [];
    const n = running.length;
    if (!n) return null;
    const live = running.some((r) => r.live);
    const split = countByRepo(running.map((r) => r.repo));
    return (
      <span class={`side-badge side-badge-agents ${live ? 'is-live' : ''}`} title={split ?? undefined}>
        {live && <span class="live-dot" aria-hidden="true" />}
        <span class="visually-hidden">, </span>
        {n}
        <span class="visually-hidden">
          {' '}
          {n === 1 ? 'agent' : 'agents'} working{split ? `: ${split}` : ''}
          {live ? ', live now' : ''}
        </span>
      </span>
    );
  }
  return null;
}

/** Whether the board reaches its server, in words as well as a dot. Settings has the details. */
function ServerStatus() {
  const h = health.value;
  const [tone, label] = healthFailed.value
    ? ['bad', 'Can’t reach the board']
    : !h
      ? ['', 'Connecting…']
      : h.ok
        ? ['ok', 'Connected']
        : ['bad', 'The board needs attention'];
  return (
    <p class={`side-status ${tone === 'bad' ? 'is-bad' : ''}`} title={label}>
      <span class="side-icon" aria-hidden="true">
        <span class={`health ${tone ? `health-${tone}` : ''}`} />
      </span>
      <span class="side-label">{label}</span>
    </p>
  );
}

/**
 * breakaway's logo, and the install's own name beside it when it has one (a named install shows its own).
 * @param {Record<string, any>} props
 */
function Brand({ onClick }) {
  const name = installName.value;
  const own = name !== 'breakaway';
  return (
    <a
      class="brand"
      href={hashFor({ view: 'board', task: null })}
      onClick={onClick}
      aria-label={own ? `${name}, on breakaway: the board` : 'breakaway: the board'}
    >
      <Logo kind="mark" class="brand-mark" />
      <span class="brand-name">
        <Logo kind="logo" class="brand-logo" />
        {own && <span class="brand-install">{name}</span>}
      </span>
    </a>
  );
}

/**
 * The repository switcher (IDEA-14 section 6): one repository or all of them, for every view that lists
 * work. A select with the sidebar open, a button with a short list on the rail. Nothing while only one
 * repository is registered, so the board looks as it always did.
 */
const ADD_REPO = '+add';
const REPO_SETTINGS = '+settings';

/** @param {Record<string, any>} props */
function RepoSwitcher({ rail = false }) {
  if (!multiRepo.value) return null;
  const value = repoScope.value ?? 'all';
  const options = [
    { id: 'all', label: 'All repositories' },
    ...repos.value.list.map((r) => ({ id: r.slug, label: r.name })),
  ];
  if (rail) {
    return (
      <Popover
        className="repo-switch-pop"
        buttonClass="side-item repo-switch-button"
        icon={
          <span class="side-icon">
            <FolderGit2 size={20} aria-hidden="true" />
          </span>
        }
        label={<span class="visually-hidden">Repository: {value === 'all' ? 'all' : repoName(value)} (s)</span>}
      >
        {(close) => (
          <fieldset class="check-list">
            <legend class="kicker">Repository</legend>
            {options.map((o) => (
              <label key={o.id} class="check-row">
                <input
                  type="radio"
                  name="repo-rail"
                  checked={o.id === value}
                  onChange={() => {
                    setRepo(o.id);
                    close();
                  }}
                />
                {o.label}
              </label>
            ))}
            <button
              type="button"
              class="btn btn-quiet btn-sm repo-switch-add"
              onClick={() => {
                close();
                openAddRepo(null);
              }}
            >
              <FolderPlus size={16} aria-hidden="true" />
              Add a repository
            </button>
            <button
              type="button"
              class="btn btn-quiet btn-sm repo-switch-add"
              onClick={() => {
                close();
                openRepoSettings(repoScope.value);
              }}
            >
              <Settings size={16} aria-hidden="true" />
              Repository settings
            </button>
          </fieldset>
        )}
      </Popover>
    );
  }
  return (
    <label class="repo-switch" title="Switch repository (s)">
      <FolderGit2 size={18} aria-hidden="true" />
      <span class="visually-hidden">Repository</span>
      <select
        class="select select-sm"
        value={value}
        onChange={(e) => {
          // The last option opens the Add a repository wizard (CLD-194) and leaves the switcher as it was.
          if (e.currentTarget.value === ADD_REPO) {
            e.currentTarget.value = value;
            openAddRepo(null);
          } else if (e.currentTarget.value === REPO_SETTINGS) {
            // Repository settings opens the page of the repository it shows (WEB-30), and Settings' list under All.
            e.currentTarget.value = value;
            openRepoSettings(repoScope.value);
          } else setRepo(e.currentTarget.value);
        }}
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
        <option value={ADD_REPO}>Add a repository…</option>
        <option value={REPO_SETTINGS}>Repository settings…</option>
      </select>
    </label>
  );
}

/**
 * The views, the server's status, and settings. On a computer it sits on the left, open (icons and
 * labels) or as a rail of icons; on a phone it's the drawer the menu button opens.
 * @param {Record<string, any>} props
 */
export function Sidebar({ drawer = false }) {
  const rail = !drawer && sidebar.value === 'rail';
  const close = drawer
    ? () => {
        menuOpen.value = false;
      }
    : undefined;
  const tip = (text) => (rail ? text : undefined);
  return (
    <div class={`sidebar ${rail ? 'is-rail' : ''} ${drawer ? 'is-drawer' : ''}`}>
      <div class="sidebar-head">
        <Brand onClick={close} />
        {drawer && (
          <button type="button" class="btn btn-quiet btn-icon" aria-label="Close the menu" onClick={close}>
            <X size={20} aria-hidden="true" />
          </button>
        )}
      </div>
      {multiRepo.value && (
        <div class="sidebar-repo">
          <RepoSwitcher rail={rail} />
        </div>
      )}
      <nav class="side-nav" aria-label="Views">
        {NAV_VIEWS.map((v) => {
          const Icon = VIEW_ICONS[v.id];
          return (
            <a
              key={v.id}
              class="side-item"
              href={hashFor({ view: v.id, pr: null, ping: null })}
              aria-current={view.value === v.id ? 'page' : undefined}
              title={tip(v.label)}
              onClick={close}
            >
              <span class="side-icon">
                <Icon size={20} aria-hidden="true" />
              </span>
              <span class="side-label">{v.label}</span>
              <NavBadge id={v.id} />
            </a>
          );
        })}
      </nav>
      <div class="sidebar-foot">
        <ServerStatus />
        <a
          class="side-item"
          href={hashFor({ view: 'settings', task: null, pr: null, ping: null })}
          aria-current={['settings', 'repo-settings'].includes(view.value) ? 'page' : undefined}
          title={tip('Settings')}
          onClick={close}
        >
          <span class="side-icon">
            <Settings size={20} aria-hidden="true" />
          </span>
          <span class="side-label">Settings</span>
          <AttentionBadge />
        </a>
        {!drawer && (
          <button
            type="button"
            class="side-item"
            title={rail ? 'Expand the menu ([)' : 'Collapse the menu ([)'}
            onClick={toggleSidebar}
          >
            <span class="side-icon">
              {rail ? <PanelLeftOpen size={20} aria-hidden="true" /> : <PanelLeftClose size={20} aria-hidden="true" />}
            </span>
            <span class="side-label">
              {rail ? 'Expand' : 'Collapse'}
              <span class="visually-hidden"> the menu</span>
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

/** The sidebar as a drawer, on a phone. */
export function MenuDrawer() {
  return (
    <Dialog
      open={menuOpen.value}
      onClose={() => {
        menuOpen.value = false;
      }}
      label="Menu"
      className="dialog-drawer"
    >
      <Sidebar drawer />
    </Dialog>
  );
}

function SearchBox() {
  const [draft, setDraft] = useState(filters.value.q);
  useEffect(() => setDraft(filters.value.q), [filters.value.q]);
  useEffect(() => {
    const id = setTimeout(() => {
      if (draft !== filters.value.q) setFilter({ q: draft });
    }, 150);
    return () => clearTimeout(id);
  }, [draft]);
  return (
    <label class="search">
      <Search size={18} aria-hidden="true" />
      <span class="visually-hidden">Search tasks</span>
      <input
        id="search"
        type="search"
        value={draft}
        placeholder="Search: ID, words, +tag, who"
        autocomplete="off"
        spellcheck={false}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setDraft('');
            setFilter({ q: '' });
            e.currentTarget.blur();
          }
        }}
      />
      <Kbd>/</Kbd>
    </label>
  );
}

const RECENT_PINGS = 5;

/** The bell: how many pings need you, the latest few, and the way to the inbox. */
function Notifications() {
  const n = openPingsHere.value;
  const { notices, chases, error } = pings.value;
  const list = scopedPings.value;
  // Under "All" with several repositories, the count says where the pings are.
  const split = countByRepo(list.map((p) => p.repo));
  const name = n ? `Inbox, ${n} open${split ? `: ${split}` : ''}` : 'Inbox';
  // Pings and the notes about connections and ended chases, newest first.
  const recent = [
    ...list.map((p) => ({ type: 'ping', ...p })),
    ...notices.map((x) => ({ type: 'notice', ...x })),
    ...chases.map((x) => ({ type: 'chase', ...x })),
  ]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, RECENT_PINGS);
  return (
    <Popover
      className="notifications"
      buttonClass={`btn btn-quiet btn-icon bell ${view.value === 'inbox' ? 'is-current' : ''}`}
      align="end"
      icon={
        <>
          <Bell size={20} aria-hidden="true" />
          {n > 0 && (
            <span class="bell-count" aria-hidden="true">
              {n > 99 ? '99+' : n}
            </span>
          )}
        </>
      }
      label={<span class="visually-hidden">{name}</span>}
    >
      {(close) => (
        <section class="notif-panel" aria-labelledby="notif-title">
          <header class="notif-head">
            <h2 id="notif-title">Inbox</h2>
            {n > 0 && (
              <span class="meta" title={split ?? undefined}>
                {n} open{repoScope.value ? ` in ${repoName(repoScope.value)}` : ''}
              </span>
            )}
          </header>
          {error && (
            <p class="field-error" role="alert">
              {error}
            </p>
          )}
          {n === 0 && !error && (
            <p class="notif-empty muted">
              Nothing needs you. When an agent gets stuck or finds a task is already done, it shows here.
            </p>
          )}
          {n > 0 && (
            <ol class="notif-list" aria-label={n > RECENT_PINGS ? `The latest ${RECENT_PINGS}` : 'Open in the inbox'}>
              {recent.map((p) =>
                p.type === 'chase' ? (
                  <li key={`chase-${p.id}`}>
                    <a
                      class="notif"
                      href={hashFor({ view: 'inbox', task: null, pr: null, ping: null })}
                      onClick={close}
                    >
                      <span class="notif-top">
                        <span class="ping-kind ping-done">Chase ended</span>
                        <time class="meta" dateTime={p.at}>
                          {ago(p.at)}
                        </time>
                      </span>
                      <span class="notif-title">{p.title}</span>
                      <span class="notif-message">{p.detail}</span>
                    </a>
                  </li>
                ) : p.type === 'notice' ? (
                  <li key={`notice-${p.id}`}>
                    <a
                      class="notif"
                      href={hashFor({ view: 'connections', task: null, pr: null, ping: null })}
                      onClick={close}
                    >
                      <span class="notif-top">
                        <span class={`ping-kind ${p.kind === 'broke' ? 'ping-stale' : 'ping-done'}`}>
                          {NOTICE_LABEL[p.kind]}
                        </span>
                        <time class="meta" dateTime={p.at}>
                          {ago(p.at)}
                        </time>
                      </span>
                      <span class="notif-title">{p.name}</span>
                      <span class="notif-message">{p.detail}</span>
                    </a>
                  </li>
                ) : (
                  <li key={p.id}>
                    <a class="notif" href={hashFor({ view: 'inbox', pr: null, ping: String(p.id) })} onClick={close}>
                      <span class="notif-top">
                        <span class={`ping-kind ping-${p.kind}`}>{PING_KIND_LABEL[p.kind] ?? p.kind}</span>
                        <span class="wid">{p.task ?? p.taskUuid.slice(0, 8)}</span>
                        <RepoChip slug={p.repo} />
                        <time class="meta" dateTime={p.at}>
                          {ago(p.at)}
                        </time>
                      </span>
                      <span class="notif-title">
                        <Title text={p.taskTitle} />
                      </span>
                      <span class="notif-message">{p.message}</span>
                    </a>
                  </li>
                ),
              )}
            </ol>
          )}
          <a
            class="btn btn-outline btn-sm notif-all"
            href={hashFor({ view: 'inbox', pr: null, ping: null })}
            onClick={close}
          >
            <Inbox size={16} aria-hidden="true" />
            {n > RECENT_PINGS ? `Open inbox, all ${n}` : 'Open inbox'}
          </a>
        </section>
      )}
    </Popover>
  );
}

/**
 * Search, New agent, New task, and the bell; on a phone also the menu button and the name.
 * @param {Record<string, any>} props
 */
export function TopBar({ phone = false }) {
  return (
    <header class="topbar">
      {phone && (
        <>
          <button
            type="button"
            class="btn btn-quiet btn-icon menu-button"
            aria-label={
              connectionsAttention.value
                ? `Open the menu (${connectionsAttention.value === 1 ? '1 connection needs' : `${connectionsAttention.value} connections need`} attention)`
                : 'Open the menu'
            }
            aria-haspopup="dialog"
            onClick={() => {
              menuOpen.value = true;
            }}
          >
            <Menu size={22} aria-hidden="true" />
            {connectionsAttention.value > 0 && <span class="menu-dot" aria-hidden="true" />}
          </button>
          <Brand />
        </>
      )}
      <SearchBox />
      <div class="topbar-end">
        {canNewAgent.value && (
          <button
            type="button"
            class="btn btn-outline btn-sm new-agent"
            aria-label="New agent"
            aria-haspopup="dialog"
            title="Start an agent from a prompt (p)"
            onClick={() => {
              newAgent.value = true;
            }}
          >
            <Bot size={18} aria-hidden="true" />
            <span class="new-label" aria-hidden="true">
              New agent
            </span>
          </button>
        )}
        <button
          type="button"
          class="btn btn-primary btn-sm new-task"
          onClick={() => {
            newTask.value = {};
          }}
        >
          <Plus size={18} aria-hidden="true" />
          <span class="new-label">New task</span>
        </button>
        <Notifications />
      </div>
    </header>
  );
}

function AreaPicker() {
  const chosen = filters.value.areas;
  return (
    <Popover
      label={chosen.length ? `Area (${chosen.length})` : 'Area'}
      buttonClass={`btn btn-outline btn-sm ${chosen.length ? 'is-active' : ''}`}
    >
      <fieldset class="check-list">
        <legend class="visually-hidden">Areas</legend>
        {areaList.value.map((a) => (
          <label key={a.id} class="check-row">
            <input
              type="checkbox"
              checked={chosen.includes(a.id)}
              onChange={(e) =>
                setFilter({ areas: e.currentTarget.checked ? [...chosen, a.id] : chosen.filter((x) => x !== a.id) })
              }
            />
            {a.label}
            <span class="meta">{a.prefix}</span>
          </label>
        ))}
      </fieldset>
    </Popover>
  );
}

function Filters() {
  const f = filters.value;
  return (
    <>
      <AreaPicker />
      <Segmented
        label="Horizon"
        multiple
        options={HORIZONS}
        value={f.horizons}
        onChange={(v) => setFilter({ horizons: v })}
      />
      <Segmented
        label="Who can move it"
        multiple
        options={ROLES}
        value={f.roles}
        onChange={(v) => setFilter({ roles: v })}
      />
      <label class="inline-select">
        <span>Claimed</span>
        <select class="select select-sm" value={f.claim} onChange={(e) => setFilter({ claim: e.currentTarget.value })}>
          <option value="any">Anyone or nobody</option>
          <option value="unclaimed">Nobody</option>
          <option value="claimed">Someone</option>
          <option value="mine">You ({me.value})</option>
        </select>
      </label>
      <label class="inline-select">
        <span>Finished</span>
        <select class="select select-sm" value={f.done} onChange={(e) => setFilter({ done: e.currentTarget.value })}>
          <option value="recent">Last 30 days</option>
          <option value="all">All</option>
          <option value="unshipped">Not on staging</option>
          <option value="staged">On staging, not live</option>
          <option value="hide">Hide</option>
        </select>
      </label>
      {view.value === 'board' && (
        <label class="inline-select">
          <span>Rows</span>
          <select
            class="select select-sm"
            value={lanes.value}
            onChange={(e) => {
              lanes.value = e.currentTarget.value;
            }}
          >
            <option value="horizon">By horizon</option>
            <option value="area">By area</option>
            <option value="none">None</option>
          </select>
        </label>
      )}
    </>
  );
}

export function FilterBar() {
  const wide = useMedia('(min-width: 900px)');
  const [open, setOpen] = useState(false);
  const count = activeFilters.value;
  if (
    [
      'activity',
      'inbox',
      'github',
      'specs',
      'agents',
      'routines',
      'roadmap',
      'connections',
      'add-repo',
      'settings',
      'repo-settings',
    ].includes(view.value)
  )
    return null;
  const here = tasks.value.filter((t) => t.status !== 'deleted' && inScope(t.repo));
  const scope = repoScope.value;
  const split = countByRepo(visible.value.map((t) => t.repo));
  const summary = (
    <span class="muted filter-count" title={split ?? undefined}>
      {visible.value.length} of {plural(here.length, 'task')}
      {scope ? ` in ${repoName(scope)}` : multiRepo.value ? ' in every repository' : ''}
    </span>
  );
  return (
    <div class="filterbar" role="region" aria-label="Filters">
      {wide ? (
        <div class="filters">
          <ListFilter size={18} aria-hidden="true" class="muted" />
          <Filters />
          {count > 0 && (
            <button type="button" class="btn btn-quiet btn-sm" onClick={() => setFilter(EMPTY_FILTERS)}>
              <X size={16} aria-hidden="true" />
              Clear filters
            </button>
          )}
          {summary}
        </div>
      ) : (
        <>
          <div class="filters-toggle">
            <button
              type="button"
              class={`btn btn-outline btn-sm ${count ? 'is-active' : ''}`}
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              <ListFilter size={16} aria-hidden="true" />
              Filters{count ? ` (${count})` : ''}
            </button>
            {count > 0 && (
              <button type="button" class="btn btn-quiet btn-sm" onClick={() => setFilter(EMPTY_FILTERS)}>
                Clear
              </button>
            )}
            {summary}
          </div>
          {open && (
            <div class="filters filters-stacked">
              <Filters />
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Going to a view: one row per key, read from VIEWS so the sheet follows the keys the app handles. */
const VIEW_SHORTCUTS = VIEWS.map((v) => [v.key, v.label]);

export const SHORTCUTS = [
  {
    title: 'Go to a view',
    rows: VIEW_SHORTCUTS,
  },
  {
    title: 'Actions',
    rows: [
      ['/', 'Search'],
      ['n', 'New task'],
      ['i', 'New idea'],
      ['p', 'New agent, when an agent routine is connected'],
      ['[', 'Collapse or expand the menu'],
      ['s', 'Switch repository, when there are several'],
      ['j k', 'Next and previous task'],
      ['c', 'Claim or release the open task'],
      ['d', 'Mark the open task done'],
      ['Shift+F10', 'The menu of the focused task (the Menu key opens it too)'],
      ['Esc', 'Close the task'],
      ['r', 'Refresh'],
      ['?', 'These shortcuts'],
    ],
  },
];

export function HelpContent() {
  return (
    <div class="sheet">
      <h2 id="help-title">Keyboard shortcuts</h2>
      <div class="shortcut-groups">
        {SHORTCUTS.map((group) => (
          <section key={group.title}>
            <h3 class="shortcut-title">{group.title}</h3>
            <dl class="shortcuts">
              {group.rows.map(([keys, what]) => (
                <div key={keys} class="shortcut">
                  <dt>
                    {keys.split(' ').map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p class="muted small">Shortcuts don’t fire while you type in a field.</p>
      <div class="sheet-actions">
        <button
          type="button"
          class="btn btn-primary btn-sm"
          onClick={() => {
            helpOpen.value = false;
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
}

export function useFocusFirst(active) {
  const ref = useRef(null);
  useEffect(() => {
    if (active) ref.current?.focus();
  }, [active]);
  return ref;
}
