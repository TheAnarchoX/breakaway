import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import {
  Archive,
  ArrowRight,
  Bot,
  CircleCheck,
  Copy,
  Hand,
  Hash,
  Link2,
  Lock,
  MessageSquare,
  PanelRight,
  Play,
  RotateCcw,
  ScanSearch,
  Sparkles,
  Square,
  SquareCheck,
  Undo2,
} from 'lucide-preact';
import { HORIZONS, canAgentReview, openPr, ref, stateOf } from '../lib/model.js';
import { ACTIONS } from '../../../src/permissions.js';
import {
  actions,
  agents,
  byUuid,
  focusComment,
  hashFor,
  me,
  openTask,
  releaseOther,
  taskMenu,
  view,
} from '../lib/store.js';
import { copy } from '../lib/clipboard.js';
import { RefineDialog, refineReason, setAutostart, startState } from './Agents.jsx';
import { RefineFromAnswersDialog, refineFromAnswers } from './RefineFromAnswers.jsx';
import { decidesLock, taskLock } from './Who.jsx';

/*
 * The task menu (WEB-24): act on a task where it is, without opening it. Any element with `data-task-menu="<uuid>"`
 * opens it: a right-click, the Menu key or Shift+F10 while it has focus, or a long press on a touch screen.
 * The browser's own menu stays one Shift away, and in text fields.
 */

const LONG_PRESS = 500;
const MOVE_SLOP = 10;
const EDGE = 8;

/** @param {EventTarget | null} node */
const taskOf = (node) =>
  node instanceof Element ? /** @type {HTMLElement | null} */ (node.closest('[data-task-menu]')) : null;
/** @param {EventTarget | null} node */
const inField = (node) =>
  node instanceof Element &&
  Boolean(node.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));

/** The element focus goes back to when the menu closes: the task's own link. */
function focusTarget(el) {
  if (el.matches('a[href], button, [tabindex]')) return el;
  return el.querySelector('a[href], button, [tabindex]') ?? el;
}

/** Text selected inside the task, so Copy keeps working where the menu replaces the browser's. */
function selectedIn(el) {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.anchorNode || !el.contains(sel.anchorNode)) return '';
  return sel.toString().trim();
}

/**
 * Opens the menu on a task element: at a point (a pointer), or below the element (the keyboard).
 * @param {HTMLElement} el
 * @param {{ x: number, y: number } | null} point
 * @param {{ keepSelection?: boolean }} [options]
 */
function openOn(el, point, { keepSelection = true } = {}) {
  const from = focusTarget(el);
  const box = from.getBoundingClientRect();
  taskMenu.value = {
    uuid: el.dataset.taskMenu,
    x: point ? point.x : box.left,
    y: point ? point.y : box.bottom + 4,
    // Where it flips to when there's no room below: above the pointer, or above the task.
    above: point ? point.y : box.top - 4,
    from,
    selection: keepSelection ? selectedIn(el) : '',
  };
}

/** Listens on the document for whatever opens the menu, so each view only marks its tasks. */
function useTriggers() {
  useEffect(() => {
    // The key or long press that opened the menu may also send the browser's menu event, and the long press a
    // click: both are dropped until the next pointer press.
    let fromKey = false;
    let fromPress = false;
    /** @type {{ x: number, y: number, el: HTMLElement, timer: number } | null} */
    let press = null;
    const cancelPress = () => {
      if (press) clearTimeout(press.timer);
      press = null;
    };

    const onContextMenu = (/** @type {MouseEvent} */ e) => {
      const el = taskOf(e.target);
      if (!el) return;
      if (fromKey || fromPress) {
        fromKey = false;
        e.preventDefault();
        return;
      }
      if (e.shiftKey || inField(e.target)) return;
      e.preventDefault();
      cancelPress();
      // A keyboard's menu event can come with no position: open it below the task then.
      const fromKeys = e.clientX === 0 && e.clientY === 0;
      openOn(el, fromKeys ? null : { x: e.clientX, y: e.clientY });
    };

    const onKeyDown = (/** @type {KeyboardEvent} */ e) => {
      if (!(e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) return;
      const el = taskOf(e.target);
      if (!el || inField(e.target)) return;
      e.preventDefault();
      fromKey = true;
      openOn(el, null);
    };

    const onPointerDown = (/** @type {PointerEvent} */ e) => {
      fromKey = false;
      fromPress = false;
      if (e.pointerType !== 'touch') return;
      const el = taskOf(e.target);
      if (!el || inField(e.target)) return;
      cancelPress();
      const point = { x: e.clientX, y: e.clientY };
      press = {
        ...point,
        el,
        timer: window.setTimeout(() => {
          press = null;
          fromPress = true;
          openOn(el, point, { keepSelection: false });
        }, LONG_PRESS),
      };
    };
    const onPointerMove = (/** @type {PointerEvent} */ e) => {
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_SLOP) cancelPress();
    };
    // The press that opened the menu doesn't also follow the task's link.
    const onClick = (/** @type {MouseEvent} */ e) => {
      if (fromPress && taskOf(e.target)) {
        fromPress = false;
        e.preventDefault();
        e.stopPropagation();
      }
    };

    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('pointerup', cancelPress, true);
    document.addEventListener('pointercancel', cancelPress, true);
    document.addEventListener('click', onClick, true);
    return () => {
      cancelPress();
      document.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('pointerup', cancelPress, true);
      document.removeEventListener('pointercancel', cancelPress, true);
      document.removeEventListener('click', onClick, true);
    };
  }, []);
}

/**
 * @typedef {{ id: string, label: string, icon: any, run: () => void, checked?: boolean }} Item
 */

/** Joins actions in words: "a", "a or b", "a, b, or c". */
const either = (words) =>
  words.length < 3 ? words.join(' or ') : `${words.slice(0, -1).join(', ')}, or ${words[words.length - 1]}`;

/**
 * The menu's items, in groups, each only when it applies and the signed-in person may use it, by the task panel's
 * rules and in its words (WEB-139). What applies but their role can't use is left out, and `note` says who can: for
 * someone who can't change the task (a viewer), the task panel's lock line (WEB-137); for a member, the maintainer's
 * items it left out, in one sentence.
 * @param {any} t
 * @param {{ selection: string, refine: () => void, refineAnswers: () => void }} context
 * @returns {{ groups: Item[][], note: string | null }}
 */
function itemsFor(t, { selection, refine, refineAnswers }) {
  const open = t.status === 'pending';
  const done = stateOf(t) === 'done';
  const { blocker, canAuto, canStart, queued } = startState(t);
  const icon = (Icon) => <Icon size={16} aria-hidden="true" />;
  // Add, change, claim, or comment (task.write): without it, the menu only opens and copies.
  const lock = taskLock(t);
  /** @type {{ action: string, what: string }[]} */
  const left = [];
  /** Whether they may do `action` here; when not, `what` is noted as left out. */
  const may = (action, what) => {
    if (!taskLock(t, action)) return true;
    left.push({ action, what });
    return false;
  };

  const first = [];
  if (selection) first.push({ id: 'copy', label: 'Copy', icon: icon(Copy), run: () => copy(selection, 'Text') });
  first.push({ id: 'open', label: 'Open', icon: icon(PanelRight), run: () => openTask(t) });

  const agent = [];
  if (queued?.forceable && may('agent.force', 'force start an agent'))
    agent.push({ id: 'force', label: 'Force start', icon: icon(Play), run: () => actions.startAgent(t, '') });
  else if (canStart && may('agent.start', 'start an agent'))
    agent.push({ id: 'start', label: 'Start an agent', icon: icon(Bot), run: () => actions.startAgent(t, '') });
  // Review with an agent (WEB-23), on a task whose pull request can merge as it stands.
  const pr = open && agents.value.data?.connected ? openPr(t) : null;
  if (pr && canAgentReview(pr) && may('agent.general', 'review a pull request with an agent'))
    agent.push({
      id: 'review',
      label: `Review #${pr.number} with an agent`,
      icon: icon(ScanSearch),
      run: () => actions.reviewPull(pr),
    });
  if (open && !refineReason(t) && may('agent.start', 'refine a task with an agent'))
    agent.push({ id: 'refine', label: 'Refine with an agent…', icon: icon(Sparkles), run: refine });
  // Refine from the answers (WEB-22), on a decided decision: start one, or open the one already refining.
  const answers = refineFromAnswers(t);
  if (answers?.open)
    agent.push({
      id: 'refine-answers',
      label: `Open ${ref(answers.open)}, refining from the answers`,
      icon: icon(Sparkles),
      run: () => openTask(answers.open),
    });
  else if (answers && may('agent.general', 'refine from the answers'))
    agent.push({ id: 'refine-answers', label: 'Refine from the answers…', icon: icon(Sparkles), run: refineAnswers });
  if (canAuto && !t.claim && may('task.plan', 'set a task to start by itself'))
    agent.push({
      id: 'autostart',
      label: `Start by itself when ready${blocker && !t.autostart ? ` (${blocker})` : ''}`,
      icon: icon(t.autostart ? SquareCheck : Square),
      checked: Boolean(t.autostart),
      run: () => setAutostart(t, !t.autostart),
    });

  const work = [];
  // Claim, Release, comment, move, archive, done, and open again are the task's own writes (task.write): a viewer
  // gets none of them, and the lock line says who can.
  if (!lock) {
    if (!done) {
      if (!t.claim && !t.blocked)
        work.push({ id: 'claim', label: `Claim as ${me.value}`, icon: icon(Hand), run: () => actions.claim(t) });
      else if (t.claim === me.value)
        work.push({ id: 'release', label: 'Release', icon: icon(Undo2), run: () => actions.release(t) });
      // Taking someone else's claim is a maintainer's (task.plan).
      else if (t.claim && may('task.plan', `release ${t.claim}’s claim`))
        work.push({
          id: 'release',
          label: `Release ${t.claim}’s claim`,
          icon: icon(Undo2),
          run: () => releaseOther(t),
        });
    }
    work.push({
      id: 'comment',
      label: 'Add a comment…',
      icon: icon(MessageSquare),
      run: () => {
        focusComment.value = t.uuid;
        openTask(t);
      },
    });
    if (open)
      for (const h of HORIZONS)
        if (h.id !== 'archive' && h.id !== t.horizon)
          work.push({
            id: `move-${h.id}`,
            label: `Move to ${h.label.toLowerCase()}`,
            icon: icon(ArrowRight),
            run: () => actions.update(t, { horizon: h.id }, `Moved to ${h.label.toLowerCase()}.`),
          });
    // Archive a finished task (WEB-44) on the board and the list. Not on the dependency graph: its finished tasks
    // drop off by themselves once nothing still waits for them.
    if (done && t.horizon !== 'archive' && (view.value === 'board' || view.value === 'list'))
      work.push({
        id: 'archive',
        label: 'Archive',
        icon: icon(Archive),
        run: () => actions.update(t, { horizon: 'archive' }, 'Archived.'),
      });
    // Finishing a decision, or opening one again, is answering it (decidesLock, WEB-140).
    const decidesWhat = done ? 'open a decision again' : 'finish a decision';
    const decides = !decidesLock(t, decidesWhat);
    if (!decides) left.push({ action: 'decision.answer', what: decidesWhat });
    if (decides && done)
      work.push({ id: 'reopen', label: 'Open again', icon: icon(RotateCcw), run: () => actions.reopen(t) });
    else if (decides)
      work.push({ id: 'done', label: 'Mark done', icon: icon(CircleCheck), run: () => actions.done(t) });
  }

  const copies = [];
  if (t.wid) copies.push({ id: 'wid', label: 'Copy work ID', icon: icon(Hash), run: () => copy(t.wid, 'Work ID') });
  copies.push({
    id: 'link',
    label: 'Copy link',
    icon: icon(Link2),
    run: () => copy(`${location.origin}/${hashFor({ task: ref(t), view: 'board' })}`, 'Link'),
  });

  // One line says who can. A viewer's is the panel's lock line. A member's names what was left out: the menu's
  // maintainer items share a role, so one sentence holds them; any with another role keep their own rule's words.
  let note = lock;
  if (!note && left.length) {
    const role = ACTIONS[left[0].action]?.role;
    const words = left.filter((l) => ACTIONS[l.action]?.role === role).map((l) => l.what);
    note = taskLock(t, left[0].action, either([...new Set(words)]));
  }
  return { groups: [first, agent, work, copies].filter((group) => group.length), note };
}

/** @param {Record<string, any>} props */
function Menu({ menu, task: t, onRefine, onRefineAnswers }) {
  const box = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [place, setPlace] = useState({ left: menu.x, top: menu.y, ready: false });
  const close = (refocus = true) => {
    taskMenu.value = null;
    if (refocus && menu.from?.isConnected) menu.from.focus({ preventScroll: true });
  };
  const { groups, note } = itemsFor(t, {
    selection: menu.selection,
    refine: () => onRefine(t.uuid),
    refineAnswers: () => onRefineAnswers(t.uuid),
  });

  // Keep it inside the window: flip it left of or above the point when it doesn't fit, then clamp.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    let left = menu.x;
    let top = menu.y;
    if (left + width > innerWidth - EDGE) left = menu.x - width;
    if (top + height > innerHeight - EDGE) top = menu.above - height;
    left = Math.max(EDGE, Math.min(left, innerWidth - EDGE - width));
    top = Math.max(EDGE, Math.min(top, innerHeight - EDGE - height));
    setPlace({ left: Math.round(left), top: Math.round(top), ready: true });
  }, [menu]);
  // Once it's placed and visible, focus its first item.
  useLayoutEffect(() => {
    if (place.ready)
      /** @type {HTMLElement | null} */ (box.current?.querySelector('[role^="menuitem"]'))?.focus({
        preventScroll: true,
      });
  }, [place.ready, menu]);

  useEffect(() => {
    const outside = (/** @type {Event} */ e) => {
      if (!box.current?.contains(/** @type {Node} */ (e.target))) close(false);
    };
    const scrolled = (/** @type {Event} */ e) => {
      if (!box.current?.contains(/** @type {Node} */ (e.target))) close(false);
    };
    const away = () => close(false);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', away);
    window.addEventListener('blur', away);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('resize', away);
      window.removeEventListener('blur', away);
    };
  }, [menu]);

  const onKeyDown = (/** @type {KeyboardEvent} */ e) => {
    // The board's own shortcuts wait while the menu is open.
    e.stopPropagation();
    const items = /** @type {HTMLElement[]} */ ([...(box.current?.querySelectorAll('[role^="menuitem"]') ?? [])]);
    const at = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    const go = (i) => items[(i + items.length) % items.length]?.focus();
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at < 0 ? -1 : at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(-1);
    else if (e.key === 'Escape' || e.key === 'Tab') close();
    else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) close();
    else if (e.key.length === 1 && /\S/u.test(e.key)) {
      // Type a letter to jump to the next item that starts with it.
      const key = e.key.toLowerCase();
      const order = [...items.slice(at + 1), ...items.slice(0, at + 1)];
      order.find((item) => item.textContent?.trim().toLowerCase().startsWith(key))?.focus();
    } else return;
    e.preventDefault();
  };

  return (
    <div
      ref={box}
      class="task-menu menu"
      role="menu"
      aria-label={`${ref(t)} actions`}
      aria-describedby={note ? `task-menu-note-${t.uuid}` : undefined}
      style={{ left: `${place.left}px`, top: `${place.top}px`, visibility: place.ready ? 'visible' : 'hidden' }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      onFocusOut={(e) => {
        const next = /** @type {Node | null} */ (e.relatedTarget);
        if (next && !box.current?.contains(next)) close(false);
      }}
    >
      {groups.map((group, i) => [
        i > 0 && <hr key={`sep-${group[0].id}`} class="task-menu-sep" />,
        ...group.map((item) => {
          const props = {
            key: item.id,
            type: /** @type {'button'} */ ('button'),
            tabIndex: -1,
            onPointerMove: (/** @type {PointerEvent} */ e) => {
              const el = /** @type {HTMLElement} */ (e.currentTarget);
              if (document.activeElement !== el) el.focus({ preventScroll: true });
            },
            onClick: () => {
              // Open moves on to the task, so focus follows it; everything else comes back to the task.
              close(item.id !== 'open' && item.id !== 'comment');
              item.run();
            },
          };
          return item.checked === undefined ? (
            <button {...props} role="menuitem">
              {item.icon}
              {item.label}
            </button>
          ) : (
            <button {...props} role="menuitemcheckbox" aria-checked={item.checked}>
              {item.icon}
              {item.label}
            </button>
          );
        }),
      ])}
      {note && (
        <p id={`task-menu-note-${t.uuid}`} class="task-menu-note">
          <Lock size={16} aria-hidden="true" />
          {note}
        </p>
      )}
    </div>
  );
}

/** Mounted once: listens for the menu on any task, shows it, and holds the Refine dialogs it opens. */
export function TaskMenuHost() {
  useTriggers();
  const [refining, setRefining] = useState(/** @type {string | null} */ (null));
  const menu = taskMenu.value;
  const t = menu ? byUuid.value.get(menu.uuid) : null;
  const refineTask = refining ? byUuid.value.get(refining) : null;
  const [answering, setAnswering] = useState(/** @type {string | null} */ (null));
  const answersTask = answering ? byUuid.value.get(answering) : null;
  useEffect(() => {
    if (menu && !t) taskMenu.value = null;
  }, [menu, t]);
  return (
    <>
      {menu && t && <Menu menu={menu} task={t} onRefine={setRefining} onRefineAnswers={setAnswering} />}
      {refineTask && <RefineDialog task={refineTask} open onClose={() => setRefining(null)} />}
      {answersTask && <RefineFromAnswersDialog task={answersTask} open onClose={() => setAnswering(null)} />}
    </>
  );
}
