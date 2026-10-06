import { useEffect } from 'preact/hooks';
import { CodeBlock } from '../lib/highlight.jsx';
import { CircleArrowUp, FolderPlus, Keyboard, LogOut, Plug, RefreshCw } from 'lucide-preact';
import { plural } from '../lib/model.js';
import {
  agents,
  codeColors,
  connectionsAttention,
  hashFor,
  health,
  healthFailed,
  helpOpen,
  loadAgents,
  loadHealth,
  loadRepos,
  loadRoutines,
  loadTasks,
  me,
  mergeMethod,
  navOrder,
  openAddRepo,
  openIn,
  repoSettingsHref,
  repos,
  routines,
  settingsAt,
  theme,
  toast,
} from '../lib/store.js';
import { notifications, turnOffNotifications, turnOnNotifications } from '../lib/push.js';
import { AgentSettings, RoutinesDailyCap, RoutinesSwitch } from '../components/BoardSettings.jsx';
import { SelfUpdateSwitch } from '../components/SelfUpdate.jsx';
import { CurrencySettings } from '../components/CurrencySettings.jsx';
import { openWhatsNew, whatsNew } from '../components/WhatsNew.jsx';
import { Segmented } from '../components/ui.jsx';
import { Pick as PickRepo } from './AddRepoView.jsx';

/**
 * Settings (docs/specs/IDEA-29-settings.md, section 3; WEB-32): this browser's, the board's, and the list of
 * repositories, each linking to its own page (WEB-30). The board's groups are the same components the Agents and
 * Routines views render, saving through the same routes, so a change in one place shows in the other. New
 * board-level settings go in The board.
 */

const ON_OFF = [
  { id: 'on', label: 'On' },
  { id: 'off', label: 'Off' },
];

const link = (v) => hashFor({ view: v, task: null, pr: null, ping: null });

const NOTIFICATION_HINTS = {
  off: 'A notification when an agent pings you and needs you.',
  on: 'Agents’ pings that need you arrive here, even when the board is closed.',
  busy: 'One moment…',
  nokey: 'Notifications need a key the owner hasn’t set up yet.',
  blocked: 'This browser is blocking notifications for the board. Allow them in its site settings, then turn this on.',
  unsupported:
    'This browser can’t show notifications from the board. On an iPhone, add the board to the Home Screen first.',
};

/** Web Push for pings: off until turned on here, and only for this browser. */
function NotificationSettings() {
  const state = notifications.value;
  const unavailable = state === 'nokey' || state === 'unsupported';
  return (
    <div class="field">
      <span class="field-label">Notifications</span>
      <Segmented
        label="Notifications"
        options={ON_OFF}
        value={state === 'on' || state === 'busy' ? 'on' : 'off'}
        onChange={(v) => {
          if (unavailable || state === 'busy') return;
          if (v === 'on') turnOnNotifications();
          else turnOffNotifications();
        }}
      />
      <span class={`field-hint ${state === 'blocked' ? 'field-error' : ''}`} role="status">
        {NOTIFICATION_HINTS[state] ?? NOTIFICATION_HINTS.off}
      </span>
    </div>
  );
}

/** What Code colors shows each palette on. */
const CODE_SAMPLE = `// Claim the next task, if there is one
export async function claim(board, name = 'claude') {
  const task = await board.next({ horizon: 'now', limit: 1 });
  return task ? board.claim(task.id, name) : null;
}`;

/** Claim as, theme, code colors, open tasks in, notifications, and the merge method: kept in this browser. */
function ThisBrowser() {
  return (
    <section class="rs-section" aria-labelledby="st-browser">
      <h2 id="st-browser">This browser</h2>
      <p class="muted small">Only for this browser: they’re kept here, not on the board.</p>
      <div class="rs-fields">
        <label class="field">
          <span class="field-label">Claim as</span>
          <input
            class="input input-sm"
            value={me.value}
            onChange={(e) => {
              me.value = e.currentTarget.value.trim() || 'owner';
            }}
            spellcheck={false}
          />
          <span class="field-hint">Your name on claims you make here. Agents use their own.</span>
        </label>
        <div class="field">
          <span class="field-label">Theme</span>
          <Segmented
            label="Theme"
            options={[
              { id: 'system', label: 'System' },
              { id: 'dark', label: 'Dark' },
              { id: 'light', label: 'Light' },
            ]}
            value={theme.value}
            onChange={(v) => {
              theme.value = v;
            }}
          />
        </div>
        <div class="field">
          <span class="field-label">Code colors</span>
          <Segmented
            label="Code colors"
            options={[
              { id: 'board', label: 'breakaway' },
              { id: 'github', label: 'GitHub' },
              { id: 'one', label: 'One' },
              { id: 'gruvbox', label: 'Gruvbox' },
            ]}
            value={codeColors.value}
            onChange={(v) => {
              codeColors.value = v;
            }}
          />
          <CodeBlock code={CODE_SAMPLE} lang="js" class="md-code st-code-sample" />
          <span class="field-hint">
            How code looks in diffs and documents. Each has a dark and a light side that follow the theme.
          </span>
        </div>
        <div class="field">
          <span class="field-label">Open tasks in</span>
          <Segmented
            label="Open tasks in"
            options={[
              { id: 'sidebar', label: 'Sidebar' },
              { id: 'modal', label: 'Modal' },
            ]}
            value={openIn.value}
            onChange={(v) => {
              openIn.value = v;
            }}
          />
          <span class="field-hint">Phones always open a task full screen.</span>
        </div>
        <NotificationSettings />
        <div class="field">
          <span class="field-label">Merge method</span>
          <Segmented
            label="Merge method"
            options={[
              { id: 'squash', label: 'Squash' },
              { id: 'merge', label: 'Merge commit' },
            ]}
            value={mergeMethod.value}
            onChange={(v) => {
              mergeMethod.value = v;
            }}
          />
          <span class="field-hint">
            What Merge starts with and what Merge when green uses. Picking one in Merge changes it here too.
          </span>
        </div>
      </div>
      <p class="meta">Keep branches up to date and Merge when green are on each repository’s page, below.</p>
    </section>
  );
}

/** The board's agents, as the Agents view has them, or the way to connect Claude first. */
function BoardAgents() {
  const { data, error } = agents.value;
  return (
    <div class="st-group">
      <h3>Agents</h3>
      {error && !data ? (
        <p class="field-error" role="alert">
          {error}
        </p>
      ) : !data ? (
        <p class="muted" aria-busy="true">
          Loading…
        </p>
      ) : data.connected ? (
        <AgentSettings d={data} />
      ) : (
        <p class="meta">
          The board starts agents once a routine on claude.ai is connected. <a href={link('agents')}>Open Agents</a> to
          set it up.
        </p>
      )}
    </div>
  );
}

/** Whether routines run, and how often in all, as the Routines view has it. */
function BoardRoutines() {
  const { data, error } = routines.value;
  const s = data?.settings;
  return (
    <div class="st-group">
      <h3>Routines</h3>
      {error && !data ? (
        <p class="field-error" role="alert">
          {error}
        </p>
      ) : !s ? (
        <p class="muted" aria-busy="true">
          Loading…
        </p>
      ) : (
        <div class="rs-fields">
          <div class="field">
            <span class="field-label">Routines can run</span>
            <RoutinesSwitch s={s} />
            <span class="field-hint">
              {s.paused
                ? 'Paused: no schedule, trigger, or Run starts anything until you switch it back on.'
                : `${s.runsToday} of ${s.dailyCap} runs today.`}
            </span>
          </div>
          <RoutinesDailyCap s={s} />
        </div>
      )}
      {s && (
        <p class="meta">
          Each routine’s own settings are on <a href={link('routines')}>Routines</a>.
        </p>
      )}
    </div>
  );
}

function TheBoard() {
  return (
    <section class="rs-section" aria-labelledby="st-board">
      <h2 id="st-board">The board</h2>
      <p class="muted small">For everyone who uses this board. The Agents and Routines views have these too.</p>
      <BoardAgents />
      <BoardRoutines />
      <div class="st-group">
        <h3>Currency</h3>
        <CurrencySettings />
      </div>
      <div class="st-group">
        <h3>Updates</h3>
        <SelfUpdateSwitch connections={link('connections')} />
      </div>
    </section>
  );
}

/** The registered repositories, each with a link to its page, and the ones taken off the board, collapsed. */
function Repositories() {
  const { loaded, list, removed = [] } = repos.value;
  return (
    <section class="rs-section" id="settings-repos" aria-labelledby="st-repos" tabIndex={-1}>
      <h2 id="st-repos">Repositories</h2>
      {!loaded ? (
        <p class="muted" aria-busy="true">
          Loading…
        </p>
      ) : !list.length ? (
        <>
          <p class="muted small">
            This board has no repository yet. Name the first one on GitHub to start: the board walks you through the
            rest.
          </p>
          <PickRepo />
        </>
      ) : (
        <>
          <p class="muted small">Each has its own settings: its name, areas, agents, deploys, and pull requests.</p>
          <ul class="st-repos">
            {list.map((r) => (
              <li key={r.slug}>
                <span class="st-repo-name">
                  <a href={repoSettingsHref(r.slug)}>
                    {r.name}
                    <span class="visually-hidden">’s settings</span>
                  </a>
                  {r.isDefault && <span class="meta"> · the default</span>}
                </span>
                <span class="meta">{r.github}</span>
                <span class="meta">{r.areas.map((a) => `${a.name ?? a.project} ${a.prefix}`).join(', ')}</span>
              </li>
            ))}
          </ul>
          <p>
            <button type="button" class="btn btn-outline btn-sm" onClick={() => openAddRepo(null)}>
              <FolderPlus size={16} aria-hidden="true" />
              Add a repository
            </button>
          </p>
        </>
      )}
      {removed.length > 0 && (
        <details class="rs-details">
          <summary>Taken off the board ({removed.length})</summary>
          <ul class="st-repos">
            {removed.map((r) => (
              <li key={r.slug}>
                <span class="st-repo-name">
                  <a href={repoSettingsHref(r.slug)}>{r.name}</a>
                </span>
                <span class="meta">{r.github}</span>
                <span class="meta">Taken off {new Date(r.removed).toLocaleDateString()}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/**
 * The server's health, the way to Connections, Refresh, Shortcuts, and Sign out, as the dialog's foot had them, and
 * What's new when the board's files have notes for the release it runs (WEB-80).
 */
function Foot() {
  const h = health.value;
  const n = connectionsAttention.value;
  return (
    <footer class="st-foot">
      <div class="settings-health">
        <strong>Server</strong>
        {healthFailed.value && (
          <span class="field-error">Can’t reach the board right now. It tries again every 30 seconds.</span>
        )}
        {h ? (
          <>
            <span>{h.ok ? 'Healthy' : `Can’t read its history: ${h.replicaError}`}</span>
            <span class="muted">
              {plural(h.tasks.pending, 'open task')} of {h.tasks.total}, {plural(h.versions, 'version')}
            </span>
            {h.secretsStoreInSync === false && (
              <span class="field-error">
                The Secrets Store is behind the server’s sync credentials. See docs/tasks.md.
              </span>
            )}
          </>
        ) : (
          !healthFailed.value && <span class="muted">Checking…</span>
        )}
        <a class={`settings-connections ${n ? 'is-bad' : ''}`} href={link('connections')}>
          <Plug size={15} aria-hidden="true" />
          {n ? `${n === 1 ? '1 connection needs' : `${n} connections need`} attention` : 'Connections'}
        </a>
      </div>
      <div class="settings-actions">
        {whatsNew.value && (
          <button type="button" class="btn btn-quiet btn-sm" onClick={openWhatsNew}>
            <CircleArrowUp size={16} aria-hidden="true" />
            See what’s new
          </button>
        )}
        <button
          type="button"
          class="btn btn-quiet btn-sm"
          onClick={() =>
            Promise.all([loadTasks(), loadHealth(), loadRepos()]).then(() => toast('Board refreshed.', 'success'))
          }
        >
          <RefreshCw size={16} aria-hidden="true" />
          Refresh
        </button>
        <button
          type="button"
          class="btn btn-quiet btn-sm"
          onClick={() => {
            helpOpen.value = true;
          }}
        >
          <Keyboard size={16} aria-hidden="true" />
          Shortcuts
        </button>
        <form method="post" action="/logout">
          <button type="submit" class="btn btn-quiet btn-sm">
            <LogOut size={16} aria-hidden="true" />
            Sign out
          </button>
        </form>
      </div>
    </footer>
  );
}

export function SettingsView() {
  useEffect(() => {
    navOrder.value = [];
    loadAgents();
    loadRoutines();
  }, []);
  // Repository settings under All repositories opens here, at the list.
  useEffect(() => {
    if (settingsAt.value !== 'repos' || !repos.value.loaded) return;
    settingsAt.value = null;
    const el = document.getElementById('settings-repos');
    el?.scrollIntoView({ block: 'start' });
    el?.focus({ preventScroll: true });
  }, [settingsAt.value, repos.value.loaded]);
  return (
    <div class="repo-settings">
      <div class="view-intro">
        <h1>Settings</h1>
        <p class="muted">This browser’s, the board’s, and each repository’s.</p>
      </div>
      <ThisBrowser />
      <TheBoard />
      <Repositories />
      <Foot />
    </div>
  );
}
