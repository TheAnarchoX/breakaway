import { useEffect } from 'preact/hooks';
import {
  actions,
  byUuid,
  checkSession,
  closeRoutine,
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
  newTask,
  openTask,
  selected,
  selectedRoutine,
  session,
  sidebar,
  taskMode,
  toast,
  toggleSidebar,
  view,
  VIEWS,
} from './lib/store.js';
import { useMedia } from './lib/media.js';
import { Logo } from './components/Logo.jsx';
import { dockFrom } from './lib/layout.js';
import { BoardView } from './views/BoardView.jsx';
import { ListView } from './views/ListView.jsx';
import { GraphView } from './views/GraphView.jsx';
import { InboxView } from './views/InboxView.jsx';
import { ActivityView } from './views/ActivityView.jsx';
import { GitHubView } from './views/GitHubView.jsx';
import { AgentsView } from './views/AgentsView.jsx';
import { RoutinePanel, RoutinesView } from './views/RoutinesView.jsx';
import { ConnectionsView, FirstRunNotice } from './views/ConnectionsView.jsx';
import { AddRepoView } from './views/AddRepoView.jsx';
import { TaskPanel } from './components/TaskPanel.jsx';
import { NewTaskDialog } from './components/NewTask.jsx';
import { SignIn } from './components/SignIn.jsx';
import { FilterBar, HelpContent, MenuDrawer, SettingsDialog, Sidebar, TopBar } from './components/Shell.jsx';
import { ConfirmHost, Dialog, ForceStartHost, Toasts } from './components/ui.jsx';

const VIEW_COMPONENTS = {
  board: BoardView,
  list: ListView,
  graph: GraphView,
  inbox: InboxView,
  activity: ActivityView,
  github: GitHubView,
  agents: AgentsView,
  routines: RoutinesView,
  connections: ConnectionsView,
  'add-repo': AddRepoView,
};

function typing(target) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      // Dialogs own the keyboard, except that the task modal still steps with j and k.
      const others = [...document.querySelectorAll('dialog[open]')].filter((d) => !d.classList.contains('dialog-task'));
      if (others.length || (document.querySelector('dialog[open]') && !['j', 'k'].includes(e.key))) return;
      const t = current.value;
      const step = (delta) => {
        const order = navOrder.value;
        if (!order.length) return;
        const i = t ? order.indexOf(t.uuid) : -1;
        const next = byUuid.value.get(order[Math.min(order.length - 1, Math.max(0, i + delta))] ?? order[0]);
        if (next) openTask(next);
      };
      const view_ = VIEWS.find((v) => v.key === e.key);
      let handled = true;
      if (e.key === '/') document.getElementById('search')?.focus();
      else if (e.key === 'n') newTask.value = {};
      else if (e.key === 'i') newTask.value = { mode: 'idea' };
      else if (e.key === 's') cycleRepo();
      else if (view_) go(view_.id);
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
  const View = VIEW_COMPONENTS[view.value] ?? BoardView;
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
            {!['connections', 'add-repo'].includes(view.value) && <FirstRunNotice />}
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
      <SettingsDialog />
      <NewTaskDialog />
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
  if (s === 'out') return <SignIn />;
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
  return <Board />;
}
