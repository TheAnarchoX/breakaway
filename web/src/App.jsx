import { useEffect } from 'preact/hooks';
import {
  actions,
  authorizeId,
  byUuid,
  checkSession,
  closeRoutine,
  closeSpec,
  closeTask,
  current,
  cycleRepo,
  go,
  helpOpen,
  loadHealth,
  loadTasks,
  me,
  menuOpen,
  navOrder,
  canNewAgent,
  newAgent,
  newTask,
  openTask,
  repos,
  selected,
  selectedRoutine,
  selectedSpec,
  session,
  sidebar,
  taskMode,
  toast,
  toggleSidebar,
  view,
  environmentId,
  planRef,
  VIEWS,
} from './lib/store.js';
import { useMedia } from './lib/media.js';
import { Logo } from './components/Logo.jsx';
import { dockFrom } from './lib/layout.js';
import { BoardView } from './views/BoardView.jsx';
import { ListView } from './views/ListView.jsx';
import { GraphView } from './views/GraphView.jsx';
import { RoadmapView } from './views/RoadmapView.jsx';
import { InboxView } from './views/InboxView.jsx';
import { ActivityView } from './views/ActivityView.jsx';
import { GitHubView } from './views/GitHubView.jsx';
import { SpecsView } from './views/SpecsView.jsx';
import { AgentsView } from './views/AgentsView.jsx';
import { RoutinePanel, RoutinesView } from './views/RoutinesView.jsx';
import { ConnectionsView, FirstRunNotice } from './views/ConnectionsView.jsx';
import { McpView } from './views/McpView.jsx';
import { AddRepoView } from './views/AddRepoView.jsx';
import { RepoSettingsView } from './views/RepoSettingsView.jsx';
import { KickoffView } from './views/KickoffView.jsx';
import { SettingsView } from './views/SettingsView.jsx';
import { InfrastructureView } from './views/InfrastructureView.jsx';
import { EnvironmentView } from './views/EnvironmentView.jsx';
import { PlanView } from './views/PlanView.jsx';
import { TaskPanel } from './components/TaskPanel.jsx';
import { NewTaskDialog } from './components/NewTask.jsx';
import { NewAgentDialog } from './components/NewAgent.jsx';
import { SignIn } from './components/SignIn.jsx';
import { Authorize } from './components/Authorize.jsx';
import { FilterBar, HelpContent, MenuDrawer, Sidebar, TopBar } from './components/Shell.jsx';
import { ConfirmHost, Dialog, ForceStartHost, Toasts } from './components/ui.jsx';
import { TaskMenuHost } from './components/TaskMenu.jsx';
import { WhatsNew } from './components/WhatsNew.jsx';

const VIEW_COMPONENTS = {
  board: BoardView,
  list: ListView,
  roadmap: RoadmapView,
  graph: GraphView,
  infrastructure: InfrastructureView,
  inbox: InboxView,
  activity: ActivityView,
  github: GitHubView,
  specs: SpecsView,
  agents: AgentsView,
  routines: RoutinesView,
  mcp: McpView,
  connections: ConnectionsView,
  'add-repo': AddRepoView,
  settings: SettingsView,
  'repo-settings': RepoSettingsView,
  kickoff: KickoffView,
};

function typing(target) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

/** Keys that work on the open task, even while it's open as a modal. */
const TASK_KEYS = ['j', 'k', 'c', 'd', 'm'];
/** How long g waits for the letter of a view. */
const GO_WAIT = 1500;

/**
 * The board's shortcuts (the sheet in Shell.jsx lists them): one key for the primary actions, the open task's
 * keys, and g then a letter to go to a view.
 */
function useShortcuts() {
  useEffect(() => {
    let goSince = 0;
    const onKey = (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      // Dialogs own the keyboard, except that the open task's keys still work in the task modal.
      const others = [...document.querySelectorAll('dialog[open]')].filter((d) => !d.classList.contains('dialog-task'));
      if (others.length || (document.querySelector('dialog[open]') && !TASK_KEYS.includes(e.key))) {
        goSince = 0;
        return;
      }
      const t = current.value;
      if (goSince && Date.now() - goSince < GO_WAIT) {
        goSince = 0;
        const view_ = VIEWS.find((v) => v.key === e.key);
        if (view_) go(view_.id);
        else if (e.key === ',') go('settings');
        else return;
        e.preventDefault();
        return;
      }
      goSince = 0;
      const step = (delta) => {
        const order = navOrder.value;
        if (!order.length) return;
        const i = t ? order.indexOf(t.uuid) : -1;
        const next = byUuid.value.get(order[Math.min(order.length - 1, Math.max(0, i + delta))] ?? order[0]);
        if (next) openTask(next);
      };
      let handled = true;
      if (e.key === 'g') goSince = Date.now();
      else if (e.key === '/') document.getElementById('search')?.focus();
      else if (e.key === 'n') newTask.value = {};
      else if (e.key === 'i') newTask.value = { mode: 'idea' };
      else if (e.key === 'a' && canNewAgent.value) newAgent.value = true;
      else if (e.key === 's') cycleRepo();
      else if (e.key === 'j') step(1);
      else if (e.key === 'k') step(-1);
      else if (e.key === '?') helpOpen.value = true;
      else if (e.key === '[') {
        if (matchMedia('(max-width: 759px)').matches) menuOpen.value = true;
        else toggleSidebar();
      } else if (e.key === 'r')
        Promise.all([loadTasks(), loadHealth()]).then(() => toast('Board refreshed.', 'success'));
      else if (e.key === 'Escape' && selected.value) {
        const card = t && document.querySelector(`[data-task="${t.uuid}"]`);
        closeTask();
        requestAnimationFrame(() => /** @type {HTMLElement | null} */ (card)?.focus());
      } else if (e.key === 'Escape' && selectedRoutine.value) {
        const link = document.querySelector(`[data-routine="${selectedRoutine.value}"]`);
        closeRoutine();
        requestAnimationFrame(() => /** @type {HTMLElement | null} */ (link)?.focus());
      } else if (e.key === 'Escape' && view.value === 'specs' && selectedSpec.value) {
        const { slug, path } = selectedSpec.value;
        const row = document.querySelector(`[data-spec="${CSS.escape(`${slug ?? repos.value.default}:${path}`)}"]`);
        closeSpec();
        requestAnimationFrame(() => /** @type {HTMLElement | null} */ (row)?.focus());
      } else if (e.key === 'c' && t && t.status === 'pending') {
        if (!t.claim && !t.blocked) actions.claim(t);
        else if (t.claim === me.value) actions.release(t);
        else
          toast(
            t.claim
              ? `${t.claim} has ${t.wid ?? 'it'}. Release it from the task if you’re sure.`
              : 'It’s blocked, so it can’t be claimed yet.',
            'info',
          );
      } else if (e.key === 'd' && t && t.status === 'pending') actions.done(t);
      else if (e.key === 'm' && t) document.getElementById(`comment-${t.uuid}`)?.focus();
      else handled = false;
      if (handled) e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

function Board() {
  const phone = !useMedia('(min-width: 760px)');
  // A task docks beside the view only where the view keeps room next to the sidebar.
  const wide = useMedia(`(min-width: ${dockFrom(sidebar.value)}px)`);
  useEffect(() => {
    if (!phone) menuOpen.value = false;
  }, [phone]);
  const open = Boolean(selected.value);
  const modal = open && !phone && taskMode.value === 'modal';
  // A routine opens where a task does; a task opened from it (a run) takes the place until it closes.
  const routine = Boolean(selectedRoutine.value) && !(open && !modal);
  useShortcuts();
  // An environment's page (WEB-61) lives under Infrastructure, at #/infrastructure/<id>, and a plan's (WEB-62) under
  // its environment, at #/infrastructure/<id>?plan=<plan>.
  const View =
    view.value === 'infrastructure' && environmentId.value
      ? planRef.value
        ? PlanView
        : EnvironmentView
      : (VIEW_COMPONENTS[view.value] ?? BoardView);
  return (
    <div class={`app ${phone ? 'app-phone' : ''}`}>
      <a class="skip-link" href="#main">
        Skip to the tasks
      </a>
      {!phone && <Sidebar />}
      <div class="app-main">
        <TopBar phone={phone} />
        <FilterBar />
        <div class={`workspace ${(open && wide && !modal) || (routine && wide) ? 'has-panel' : ''}`}>
          <main id="main" tabIndex={-1}>
            {!['connections', 'add-repo', 'settings', 'kickoff'].includes(view.value) && <FirstRunNotice />}
            <View />
          </main>
          {open && wide && !modal && <TaskPanel docked />}
          {routine && wide && <RoutinePanel docked />}
        </div>
      </div>
      {!wide && (
        <Dialog open={routine} onClose={closeRoutine} className="dialog-task dialog-sheet" labelledBy={undefined}>
          {routine && <RoutinePanel docked={false} />}
        </Dialog>
      )}
      {modal ? (
        <Dialog open onClose={closeTask} className="dialog-task dialog-modal" labelledBy={undefined}>
          <TaskPanel modal />
        </Dialog>
      ) : (
        !wide && (
          <Dialog open={open} onClose={closeTask} className="dialog-task dialog-sheet" labelledBy={undefined}>
            <TaskPanel docked={false} />
          </Dialog>
        )
      )}
      {phone && <MenuDrawer />}
      <NewTaskDialog />
      <NewAgentDialog />
      <Dialog
        open={helpOpen.value}
        onClose={() => {
          helpOpen.value = false;
        }}
        labelledBy="help-title"
        className="dialog-shortcuts"
      >
        <HelpContent />
      </Dialog>
      <ConfirmHost />
      <ForceStartHost />
      <TaskMenuHost />
      <WhatsNew />
      <Toasts />
    </div>
  );
}

export function App() {
  const s = session.value;
  if (s === 'checking')
    return (
      <div class="splash" aria-busy="true">
        <Logo kind="mark" class="splash-mark" />
        <span class="visually-hidden">Loading the board</span>
      </div>
    );
  if (s === 'out') return <SignIn next={authorizeId.value ? `#/authorize/${authorizeId.value}` : null} />;
  if (s === 'offline') {
    return (
      <main id="main" class="signin">
        <div class="signin-card">
          <h1>Can’t reach the board</h1>
          <p class="muted">The task server didn’t answer. Check your connection, then try again.</p>
          <button type="button" class="btn btn-primary" onClick={checkSession}>
            Try again
          </button>
        </div>
      </main>
    );
  }
  // A sign-in from MCP apps waits for the owner on its own page (BRK-157).
  if (authorizeId.value) return <Authorize id={authorizeId.value} />;
  return <Board />;
}
