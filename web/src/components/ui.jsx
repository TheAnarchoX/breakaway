import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { CircleAlert, CircleCheck, Info, Mic, Square } from 'lucide-preact';
import { confirmState, forceOffer, multiRepo, repoBySlug, repos, toasts } from '../lib/store.js';
import { STATE_LABEL, age, isStale, stateOf } from '../lib/model.js';
import { canDictate, checkOnDevice, dictate } from '../lib/dictation.js';

/**
 * A native <dialog>, shown modally while `open`. Escape and a click on the backdrop call
 * onClose; focus goes back to whatever opened it. Named by `labelledBy` (a heading's id) or `label`.
 * @param {Record<string, any>} props
 */
export function Dialog({ open, onClose, labelledBy, label, className = '', children }) {
  const ref = useRef(null);
  const opener = useRef(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    if (open && !dialog.open) {
      opener.current = document.activeElement;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
    return undefined;
  }, [open]);
  useEffect(
    () => () => {
      if (opener.current?.isConnected) opener.current.focus();
    },
    [],
  );
  const onCloseEvent = () => {
    if (opener.current?.isConnected) opener.current.focus();
    if (open) onClose();
  };
  return (
    <dialog
      ref={ref}
      class={`dialog ${className}`}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      onClose={onCloseEvent}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && children}
    </dialog>
  );
}

/**
 * A button that opens a small panel below it. Escape or a click outside closes it.
 * @param {Record<string, any>} props
 */
export function Popover({
  label,
  icon,
  className = '',
  buttonClass = 'btn btn-outline btn-sm',
  align = 'start',
  badge,
  children,
}) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const button = useRef(null);
  const panel = useRef(null);
  // Once per opening, nudge the panel sideways so it stays inside the nearest scrolling box (a
  // docked panel or a sheet clips what sticks out) or the window. Measured once: no feedback loop.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!open || !el) return;
    el.style.transform = '';
    const rect = el.getBoundingClientRect();
    let box = { left: 0, right: window.innerWidth };
    for (let node = root.current?.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll|hidden)/u.test(style.overflowX + style.overflowY)) {
        box = node.getBoundingClientRect();
        break;
      }
    }
    const shift =
      rect.left < box.left + 8 ? box.left + 8 - rect.left : rect.right > box.right - 8 ? box.right - 8 - rect.right : 0;
    if (shift) el.style.transform = `translateX(${Math.round(shift)}px)`;
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (e) => {
      if (!root.current?.contains(e.target)) setOpen(false);
    };
    const key = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    root.current?.addEventListener('keydown', key);
    panel.current?.querySelector('input, button, select, textarea, a[href]')?.focus();
    const node = root.current;
    return () => {
      document.removeEventListener('pointerdown', outside);
      node?.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div
      class={`popover ${className}`}
      ref={root}
      onFocusOut={(e) => {
        if (open && !root.current.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button ref={button} type="button" class={buttonClass} aria-expanded={open} onClick={() => setOpen(!open)}>
        {icon}
        {label}
        {badge ? <span class="count-badge">{badge}</span> : null}
      </button>
      {open && (
        // tabIndex -1: pressing on something inside that can't take focus (a row's text) focuses the panel, so
        // focus stays inside and the panel doesn't close before the press becomes a click (WEB-57).
        <div ref={panel} class={`popover-panel popover-${align}`} tabIndex={-1}>
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>
      )}
    </div>
  );
}

/**
 * Buttons in a group where one is chosen (aria-pressed), for filters and sort orders.
 * @param {Record<string, any>} props
 */
export function Segmented({ label, options, value, onChange, multiple = false, size = 'sm' }) {
  const isOn = (id) => (multiple ? value.includes(id) : value === id);
  const toggle = (id) => {
    if (!multiple) return onChange(id);
    return onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  };
  return (
    <div class={`segmented segmented-${size}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={isOn(o.id)} title={o.hint} onClick={() => toggle(o.id)}>
          {o.icon}
          {o.label}
          {o.count !== undefined ? <span class="seg-count">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Toasts() {
  const icons = {
    success: <CircleCheck size={18} aria-hidden="true" />,
    error: <CircleAlert size={18} aria-hidden="true" />,
    info: <Info size={18} aria-hidden="true" />,
  };
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.value.map((t) => (
        <div key={t.id} class={`toast toast-${t.tone}`}>
          {icons[t.tone]}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

export function ConfirmHost() {
  const state = confirmState.value;
  const close = (answer) => {
    state?.resolve(answer);
    confirmState.value = null;
  };
  return (
    <Dialog open={Boolean(state)} onClose={() => close(false)} labelledBy="confirm-title" className="dialog-small">
      {state && (
        <div class="sheet">
          <h2 id="confirm-title">{state.title}</h2>
          {state.body && <p class="muted">{state.body}</p>}
          <div class="sheet-actions">
            <button type="button" class="btn btn-quiet" onClick={() => close(false)}>
              {state.cancelLabel ?? 'Cancel'}
            </button>
            <button
              type="button"
              class={`btn ${state.tone === 'danger' ? 'btn-danger' : 'btn-primary'}`}
              onClick={() => close(true)}
            >
              {state.confirmLabel}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/**
 * Force start (IDEA-30 section 4): when the board's own limits refused a start, say which one and offer to skip
 * it. Claude's limits never come here: those show their message as an error.
 */
export function ForceStartHost() {
  const offer = forceOffer.value;
  const close = () => {
    forceOffer.value = null;
  };
  const force = () => {
    close();
    offer?.run();
  };
  return (
    <Dialog open={Boolean(offer)} onClose={close} labelledBy="force-title" className="dialog-small">
      {offer && (
        <div class="sheet">
          <h2 id="force-title">Force start?</h2>
          <p>Not started: {offer.reason}.</p>
          <p class="muted">
            Force start skips the board’s own limit and starts the agent now. It still counts as a start, and Claude’s
            limits still apply.
          </p>
          <div class="sheet-actions">
            <button type="button" class="btn btn-quiet" onClick={close}>
              Cancel
            </button>
            <button type="button" class="btn btn-primary" onClick={force}>
              Force start
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** @param {Record<string, any>} props */
export function StateBadge({ task }) {
  const state = stateOf(task);
  return (
    <span class={`state state-${state}`}>
      <span class="state-dot" aria-hidden="true" />
      {STATE_LABEL[state] ?? state}
    </span>
  );
}

/** @param {Record<string, any>} props */
export function RoleTags({ tags }) {
  // Real tag names, so what you see is what you filter on in Taskwarrior.
  return tags.map((tag) => (
    <span key={tag} class={`tag tag-${tag}`}>
      {tag}
    </span>
  ));
}

/** Who has it, and for how long; a claim idle for two days shows as stale. */
/**
 * A task's work ID, as the red number while it's claimed and not done (brand/README.md, Signature moves):
 * white on red, like the race number of the rider in the break. Nothing else wears it.
 */
export const widClass = (task, extra = '') =>
  `wid ${extra} ${task.claim && task.status !== 'completed' ? 'red-number' : ''}`.trim().replace(/\s+/gu, ' ');

/** @param {Record<string, any>} props */
export function ClaimChip({ task, compact = false }) {
  if (!task.claim) return null;
  const stale = isStale(task);
  const initial =
    task.claim
      .replace(/^(claude|codex)-/u, '')
      .charAt(0)
      .toUpperCase() || '?';
  return (
    <span
      class={`claim ${stale ? 'claim-stale' : ''}`}
      title={`Claimed by ${task.claim}${stale ? ', no change for 2 days or more' : ''}`}
    >
      <span class="claim-avatar" aria-hidden="true">
        {initial}
      </span>
      {!compact && <span class="claim-name">{task.claim}</span>}
      <span class="claim-age">
        {age(task.start)}
        {stale ? ' · stale' : ''}
      </span>
    </span>
  );
}

/**
 * Which repository something belongs to (IDEA-14 section 6): a small chip on tasks, rows, nodes,
 * activity lines, pings, and pull requests. Nothing while only one repository is registered.
 * `slug` null or empty is the default repository's.
 * @param {Record<string, any>} props
 */
export function RepoChip({ slug }) {
  if (!multiRepo.value) return null;
  const key = slug || repos.value.default;
  const repo = repoBySlug.value.get(key);
  return (
    <span class="repo-chip" title={repo ? `${repo.name}, ${repo.github}` : key}>
      <span class="visually-hidden">Repository </span>
      {repo?.name ?? key}
    </span>
  );
}

/** @param {Record<string, any>} props */
export function Kbd({ children }) {
  return <kbd class="kbd">{children}</kbd>;
}

/**
 * Wraps a text field (its one child) with a microphone button that dictates into it with the
 * browser's speech recognition. Where the browser can't dictate, it renders the field alone.
 * The field keeps its own ref, value, and handlers: the words go in as input events.
 * @param {Record<string, any>} props
 */
export function Dictate({ children }) {
  const root = useRef(/** @type {HTMLElement | null} */ (null));
  const stop = useRef(/** @type {(() => void) | null} */ (null));
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    checkOnDevice();
    return () => stop.current?.();
  }, []);
  if (!canDictate) return children;

  const field = () => /** @type {HTMLTextAreaElement | null} */ (root.current?.querySelector('textarea, input'));
  const toggle = () => {
    if (stop.current) {
      stop.current();
      return;
    }
    const el = field();
    if (!el || el.disabled || el.readOnly) return;
    setError('');
    setListening(true);
    el.focus();
    let ended = false;
    const stopIt = dictate(el, {
      onEnd: () => {
        ended = true;
        stop.current = null;
        setListening(false);
      },
      onError: setError,
    });
    // It can end before it returns, when the browser refuses to start.
    if (!ended) stop.current = stopIt;
  };

  return (
    <span class={`dictate${listening ? ' is-listening' : ''}`} ref={root}>
      {children}
      <button
        type="button"
        class="btn btn-quiet btn-icon btn-sm dictate-btn"
        aria-pressed={listening}
        aria-label={listening ? 'Stop dictating' : 'Dictate'}
        title={listening ? 'Stop dictating' : 'Dictate'}
        // Keep the cursor in the field, so the words go where it is.
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggle}
      >
        {listening ? <Square size={14} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
      </button>
      <span class="visually-hidden" aria-live="polite">
        {listening ? 'Listening. Speak, then press Stop dictating.' : ''}
      </span>
      {error && (
        <span class="field-error dictate-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

/** Keeps a textarea as tall as its text, also when its width changes (a sheet opening, a resize). */
export function useAutosize(ref, value) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const fit = () => {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight + 2}px`;
    };
    fit();
    const frame = requestAnimationFrame(fit);
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        fit();
      }
    });
    observer.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [value]);
}

/**
 * Tabs over panels the caller renders: a tablist whose tabs move with the arrow keys, Home, and End,
 * and select as they get focus. `tabs` is [{ id, label, count }]; the panel is `${idBase}-panel-${id}`.
 * @param {Record<string, any>} props
 */
export function Tabs({ label, tabs, value, onChange, idBase }) {
  const list = useRef(null);
  const onKeyDown = (e) => {
    const i = tabs.findIndex((t) => t.id === value);
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = tabs[(to + tabs.length) % tabs.length];
    onChange(next.id);
    requestAnimationFrame(() => list.current?.querySelector(`#${idBase}-tab-${next.id}`)?.focus());
  };
  return (
    <div ref={list} class="tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={`${idBase}-tab-${t.id}`}
          aria-selected={t.id === value}
          aria-controls={`${idBase}-panel-${t.id}`}
          tabIndex={t.id === value ? 0 : -1}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.count != null && <span class="seg-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
