import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import {
  Bot,
  CircleAlert,
  ExternalLink,
  Hand,
  CirclePause,
  RefreshCw,
  Sparkles,
  FileText,
  Globe,
  Hourglass,
  Pencil,
  Play,
  Search,
  SquareTerminal,
  TriangleAlert,
  Wrench,
  Zap,
  MessageSquareText,
  Send,
} from 'lucide-preact';
import { api, enc, sentence } from '../lib/api.js';
import { ago, openPr, ref, time } from '../lib/model.js';
import { actions, agents, go, hashFor, openPull } from '../lib/store.js';
import { RichText } from '../lib/richtext.jsx';
import { Dialog, useAutosize, Dictate } from './ui.jsx';

const ext = { target: '_blank', rel: 'noopener noreferrer' };
export const TRIGGER_LABEL = {
  manual: 'started by hand',
  next: 'started with the next few',
  auto: 'started by itself when ready',
  alert: 'started for a security alert',
  review: 'started to test a Dependabot update',
  general: 'started from a prompt',
  kickoff: 'started by Send answers and carry on',
  routines: 'started by Make with an agent, to make routines',
  'routines-carry-on': 'started by Send answers and carry on, to make routines',
  chase: 'started by a chase',
  'chase-fix': 'started by a chase to fix a pull request',
  'road-captain': 'started as a chase’s road captain',
  move: 'started to move a repository to the deploy flow',
};

/** The same rules the server uses, to decide which controls to show. */
export function agentBlocker(t) {
  if (t.status !== 'pending') return 'it isn’t open';
  if (t.tags.includes('decide')) return 'it waits on a decision (+decide)';
  if (!t.tags.includes('agent')) return 'it isn’t tagged +agent';
  if (openPr(t)) return 'it’s already in review';
  if (t.claim) return `${t.claim} has it`;
  if (t.blocked) return 'it waits for another task';
  if (t.waiting) return 'it waits for a date';
  return null;
}

/** Why a task can't be refined: unlike a build, +decide, +owner, and untagged tasks are fine. Mirrors the server. */
export function refineBlocker(t) {
  if (t.status !== 'pending') return 'it isn’t open';
  if (openPr(t)) return 'it’s in review: ask for changes on its pull request instead';
  if (t.claim) return `${t.claim} has it`;
  return null;
}

/** Marks a run started with Force start, past the board's own limits. */
export function ForcedMark() {
  return (
    <span class="pill pill-warn" title="Started with Force start, past the board’s own limits">
      Forced
    </span>
  );
}

/** Why Refine with an agent is off right now, or null when it can start. */
export function refineReason(t) {
  if (t.status !== 'pending') return 'it isn’t open';
  const { loaded, data } = agents.value;
  return refineBlocker(t) ?? (loaded && !data?.connected ? 'the agent routine isn’t connected yet' : null);
}

/**
 * Refine with an agent's dialog: a required request, kept on failure. Opened by RefineButton and the task menu.
 * @param {Record<string, any>} props
 */
export function RefineDialog({ task: t, open, onClose }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);
  const close = () => {
    if (!busy) onClose();
  };
  const submit = async (e) => {
    e.preventDefault();
    if (!text.trim()) {
      setError('Say what it should look at or change.');
      return;
    }
    setBusy(true);
    const finish = () => {
      onClose();
      setText('');
    };
    const result = await actions.refineAgent(t, text.trim(), finish);
    setBusy(false);
    if (result) finish();
  };
  return (
    <Dialog open={open} onClose={close} labelledBy="refine-title">
      <form class="sheet" onSubmit={submit} noValidate>
        <h2 id="refine-title">Refine {ref(t)} with an agent</h2>
        <label class="field">
          <span class="field-label">What should it look at or change?</span>
          <Dictate>
            <textarea
              class="textarea"
              rows={6}
              maxLength={4000}
              required
              autoFocus
              value={text}
              aria-describedby={error ? 'refine-error refine-hint' : 'refine-hint'}
              onInput={(e) => {
                setText(e.currentTarget.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
              }}
            />
          </Dictate>
          {error && (
            <span class="field-error" id="refine-error">
              {error}
            </span>
          )}
          <span class="field-hint" id="refine-hint">
            It improves the task on the board: notes, area, horizon, what it waits for, or splitting it. It doesn’t
            build it. Ctrl + Enter starts it.
          </span>
        </label>
        <div class="sheet-actions">
          <button type="button" class="btn btn-quiet" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button type="submit" class="btn btn-primary" disabled={busy}>
            {busy ? 'Starting…' : 'Start refining'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * In the Agent section, beside Start an agent: opens RefineDialog.
 * @param {Record<string, any>} props
 */
export function RefineButton({ task: t }) {
  const [open, setOpen] = useState(false);
  const reason = refineReason(t);
  if (t.status !== 'pending') return null;
  const hintId = `refine-hint-${t.uuid}`;
  return (
    <>
      <button
        type="button"
        class="btn btn-outline btn-sm"
        disabled={Boolean(reason)}
        aria-describedby={reason ? hintId : undefined}
        title={reason ? `Can’t refine: ${reason}` : undefined}
        onClick={() => setOpen(true)}
      >
        <Sparkles size={16} aria-hidden="true" />
        Refine with an agent
      </button>
      {reason && (
        <span class="visually-hidden" id={hintId}>
          Can’t refine: {reason}.
        </span>
      )}
      <RefineDialog task={t} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/**
 * On a card: an agent is on it (with a live dot), or it will start one by itself.
 * @param {Record<string, any>} props
 */
export function AgentBadge({ task: t }) {
  const run = t.agentRun;
  if (t.status === 'pending' && run && t.claim && t.claim === run.agent) {
    return (
      <span class={`agent-badge ${run.live ? 'is-live' : ''}`} title={`${run.agent}${run.live ? ', working now' : ''}`}>
        <Bot size={14} aria-hidden="true" />
        {run.live && <span class="live-dot" aria-hidden="true" />}
        <span class="agent-badge-label">{run.live ? 'Working' : 'Agent'}</span>
      </span>
    );
  }
  if (t.status === 'pending' && t.autostart && !t.claim) {
    return (
      <span class="agent-badge agent-badge-auto" title="Starts an agent by itself when it’s ready">
        <Zap size={14} aria-hidden="true" />
        <span class="agent-badge-label">Auto</span>
      </span>
    );
  }
  return null;
}

const TOOL_ICON = {
  Bash: SquareTerminal,
  Read: FileText,
  Write: Pencil,
  Edit: Pencil,
  MultiEdit: Pencil,
  Grep: Search,
  Glob: Search,
  WebFetch: Globe,
  WebSearch: Globe,
};

/** @param {Record<string, any>} props */
function Entry({ e }) {
  if (e.kind === 'message') {
    return (
      <li class="log-entry log-message">
        <MessageSquareText size={15} aria-hidden="true" />
        <div class="log-body">
          <RichText text={e.text} />
        </div>
      </li>
    );
  }
  if (e.kind === 'tool') {
    const Icon = TOOL_ICON[e.tool] ?? Wrench;
    return (
      <li class={`log-entry log-tool ${e.failed ? 'is-failed' : ''}`}>
        <Icon size={15} aria-hidden="true" />
        <div class="log-body">
          <span class="log-tool-line">
            <span class="log-tool-name">{e.tool}</span>
            {e.title && <span class="log-title">{e.title}</span>}
            {e.detail && <code class="log-detail">{e.detail}</code>}
            {e.failed && <span class="log-failed">failed</span>}
          </span>
          {e.output && (
            <details class="log-output">
              <summary>Output</summary>
              <pre>{e.output}</pre>
            </details>
          )}
        </div>
      </li>
    );
  }
  if (e.kind === 'prompt') {
    return (
      <li class="log-entry log-quiet">
        <Play size={14} aria-hidden="true" />
        <details class="log-body">
          <summary>Instructions</summary>
          <pre>{e.text}</pre>
        </details>
      </li>
    );
  }
  return (
    <li class="log-entry log-quiet">
      <Play size={14} aria-hidden="true" />
      <span class="log-body">{e.text}</span>
    </li>
  );
}

/** States of a run whose session started, so it has output to watch. */
const SESSION_STATES = new Set(['starting', 'working', 'quiet', 'silent']);

/** States that ask nothing of you while the run goes well. */
const QUIET_STATES = new Set(['starting', 'working', 'quiet']);

/** Run kinds Try again starts the same way (Start an agent); the others start from their own button. */
const AGAIN_KINDS = new Set(['build', 'kickoff', null, undefined]);

/** Why Claude refused the routine, in plain words, from a paused run's error (BRK-144's wordings). */
function pausedWhy(error) {
  const text = String(error ?? '');
  if (/token was refused/iu.test(text)) return 'Claude refused the routine’s token.';
  if (/has no access/iu.test(text)) return 'Claude says the routine’s token has no access to it.';
  if (/is gone on claude/iu.test(text)) return 'Claude has no routine at that address any more.';
  return text.trim() ? sentence(text) : 'Claude refused the routine.';
}

/**
 * A run's state in words (docs/specs/IDEA-33-onboarding-hardening.md, "When an agent run goes wrong"): its label,
 * the `tone` it shows in, what it means and what happens next, and whether it asks something of you. Null for a
 * run that finished its part.
 * @param {Record<string, any> | null | undefined} state the run's `state` from the board (src/run-state.js)
 * @param {number} [now]
 */
export function runWords(state, now = Date.now()) {
  if (!state || state.id === 'ended') return null;
  const at = (iso) => time(iso);
  switch (state.id) {
    case 'starting':
      return state.late
        ? {
            label: 'Starting',
            tone: 'warn',
            line: `Nothing from it for ${ago(state.since, now).replace(' ago', '')}. Open the session to see what it’s doing.`,
            yours: true,
          }
        : {
            label: 'Starting',
            tone: 'quiet',
            line: 'Nothing to do. It shows here once the session says something; the first run can take several minutes.',
          };
    case 'working':
      return { label: 'Working now', tone: 'live', line: 'Nothing to do.' };
    case 'quiet':
      return {
        label: `Quiet for ${ago(state.since, now).replace(' ago', '')}`,
        tone: 'quiet',
        line: 'Nothing to do. Agents go quiet while they think or wait on checks.',
      };
    case 'silent':
      return {
        label: `Silent since ${at(state.since)}`,
        tone: 'warn',
        line: 'It keeps its claim and its slot. Open the session and decide: let it carry on, or stop it and release the task.',
        yours: true,
      };
    case 'retrying':
      return state.again
        ? {
            label: 'Retrying',
            tone: 'quiet',
            line: `Claude’s limit for starting sessions. Nothing to do: it starts again by itself at ${at(state.until)}.`,
          }
        : {
            label: 'Claude’s limit',
            tone: 'quiet',
            line: `Claude’s limit for starting sessions. Start it again after ${at(state.until)}.`,
          };
    case 'paused':
      return {
        label: 'Paused',
        tone: 'warn',
        line: `${pausedWhy(state.error)} Reconnect the routine; starts resume once it works.`,
        yours: true,
      };
    case 'failed':
      return {
        label: 'Couldn’t start',
        tone: 'error',
        line: `${state.error ? sentence(state.error) : 'Claude didn’t start the session.'}${state.until ? ` Auto-start tries again at ${at(state.until)}.` : ''}`,
        yours: !state.until,
      };
    case 'needs-you':
      return {
        label: 'Needs you',
        tone: 'warn',
        line: state.fix
          ? `${state.fix.tries} fix agents on #${state.fix.pr} didn’t get it green, so no third starts by itself. Read what they tried, then fix it yourself or force start one more.`
          : `It pinged you: “${state.ping?.message ?? ''}”`,
        yours: true,
      };
    default:
      return null;
  }
}

const TONE_ICON = { warn: TriangleAlert, error: CircleAlert, quiet: Hourglass };

/**
 * A run's state, what happens next, and your action, if any: Try again, Reconnect the routine, or Open the session.
 * `compact` keeps it to the label and the line, for the Agents view's lists.
 * @param {Record<string, any>} props
 */
export function RunStatus({ state, run = null, repo = null, onRetry = null, busy = false, compact = false }) {
  const words = runWords(state);
  if (!words) return null;
  const Icon = state.id === 'paused' ? CirclePause : state.id === 'needs-you' ? Hand : TONE_ICON[words.tone];
  const url = run?.url ?? null;
  const retry = onRetry && state.id === 'failed' && !state.until && AGAIN_KINDS.has(run?.kind);
  const openSession = url && (state.id === 'silent' || (state.id === 'starting' && state.late));
  return (
    <div class={`run-status is-${words.tone} ${compact ? 'is-compact' : ''}`}>
      <span class={`live-state run-label ${words.tone === 'live' ? 'is-live' : ''}`}>
        {words.tone === 'live' ? (
          <span class="live-dot" aria-hidden="true" />
        ) : (
          Icon && <Icon size={14} aria-hidden="true" />
        )}
        {words.label}
      </span>
      {/* In a list, a run that's fine needs only its label: the line is for what happens next or what to do. */}
      {!(compact && QUIET_STATES.has(state.id) && !words.yours) && <p class="run-line small">{words.line}</p>}
      {(retry || openSession || state.id === 'paused' || state.id === 'needs-you') && (
        <div class="run-actions">
          {retry && (
            <button type="button" class="btn btn-primary btn-sm" disabled={busy} onClick={onRetry}>
              <RefreshCw size={16} aria-hidden="true" />
              {busy ? 'Starting…' : 'Try again'}
            </button>
          )}
          {state.id === 'paused' && (
            <a class="btn btn-outline btn-sm" href={hashFor({ view: 'connections', task: null, pr: null, ping: null })}>
              Reconnect the routine
            </a>
          )}
          {state.id === 'needs-you' && state.fix && (
            <button type="button" class="btn btn-outline btn-sm" onClick={() => openPull(state.fix.pr, repo)}>
              Open #{state.fix.pr}
            </button>
          )}
          {state.id === 'needs-you' && state.ping && (
            <a
              class="btn btn-outline btn-sm"
              href={hashFor({ view: 'inbox', task: null, pr: null, ping: String(state.ping.id) })}
            >
              Open the ping
            </a>
          )}
          {openSession && (
            <a class="btn btn-outline btn-sm" href={url} {...ext}>
              Open the session
              <ExternalLink size={14} aria-hidden="true" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * What the session has done, as it happens. Polls while it's on screen; for watching only.
 * @param {Record<string, any>} props
 */
export function LiveLog({ task: t, onRetry = null, busy = false }) {
  const [entries, setEntries] = useState([]);
  const [info, setInfo] = useState(null);
  const box = useRef(null);
  const stick = useRef(true);
  const after = useRef(0);
  useEffect(() => {
    let stopped = false;
    let timer = null;
    after.current = 0;
    setEntries([]);
    const poll = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const data = await api(`tasks/${enc(t.uuid)}/session?after=${after.current}`);
          if (stopped) return;
          if (data.entries.length) {
            after.current = data.entries.at(-1).id;
            setEntries((list) => [...list, ...data.entries].slice(-500));
          }
          setInfo({ live: data.live, lastAt: data.lastAt, run: data.run });
        } catch {
          /* the next poll tries again */
        }
      }
      if (!stopped) timer = setTimeout(poll, 3000);
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [t.uuid]);
  useLayoutEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [entries]);
  const onScroll = () => {
    const el = box.current;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  const run = info?.run;
  // Started a while ago with nothing at all: the session isn't sending, rather than still starting.
  const silent = !info?.lastAt && (run?.state?.late || run?.state?.id === 'silent');
  // Until the first poll answers, the task's own copy of its run says where it is.
  const state = run ? run.state : (t.agentRun?.state ?? null);
  return (
    <div class="live-log">
      <div class="live-head">
        {state && runWords(state) ? (
          <RunStatus state={state} run={run ?? t.agentRun} repo={t.repo} onRetry={onRetry} busy={busy} />
        ) : (
          <span class="live-state">
            {!info ? 'Loading…' : info.lastAt ? `Not running · last output ${ago(info.lastAt)}` : 'Not running'}
          </span>
        )}
        {/* Silent, or late to start: Open the session is the action, in the state's own line. */}
        {run?.url && !(state?.id === 'silent' || state?.late) && (
          <a class="btn btn-quiet btn-sm live-session" href={run.url} {...ext}>
            Open the session
            <ExternalLink size={14} aria-hidden="true" />
          </a>
        )}
      </div>
      {entries.length ? (
        <ol class="log" ref={box} onScroll={onScroll} aria-live="off" aria-label="What the agent is doing">
          {entries.map((e) => (
            <Entry key={e.id} e={e} />
          ))}
        </ol>
      ) : silent ? (
        <p class="muted small">
          This session hasn’t sent anything. Its copy of the repository may not have the session hooks (sessions start
          from main, and hooks load when a session starts), or it can’t reach the board. Open the session on claude.ai
          to follow it there.
        </p>
      ) : state?.id === 'starting' ? (
        <p class="muted small">
          Nothing yet. The session shows up here once it has claimed the task; that takes a minute while it starts.
        </p>
      ) : null}
      {(entries.length > 0 || SESSION_STATES.has(state?.id)) && (
        <p class="meta">
          For watching only: kept 14 days, never in Taskwarrior. Secrets are removed before they leave the session.
        </p>
      )}
    </div>
  );
}

const MESSAGE_MAX = 2000;

function messageStatus(m) {
  if (m.status === 'delivered') return `Delivered ${time(m.delivered)}`;
  if (m.status === 'waiting') return 'Waiting';
  return 'Not delivered: the agent finished';
}

/**
 * The owner's note to the agent that holds a task (IDEA-15). Its session hooks collect it on the agent's
 * next step; the board only queues it. Polls while on screen; shows nothing once there's no agent and no messages.
 * @param {Record<string, any>} props
 */
export function MessageAgent({
  task: t,
  url = null,
  autoFocus = false,
  label = 'Message the agent',
  placeholder = 'Something to add or keep in mind',
  onSent,
}) {
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const area = useRef(null);
  useAutosize(area, text);
  useEffect(() => {
    let stopped = false;
    let timer = null;
    setData(null);
    const poll = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const next = await api(`tasks/${enc(t.uuid)}/messages`);
          if (!stopped) setData(next);
        } catch {
          /* the next poll tries again */
        }
      }
      if (!stopped) timer = setTimeout(poll, 5000);
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [t.uuid]);
  if (!data || (!data.canSend && !data.messages.length)) return null;
  const submit = async (e) => {
    e?.preventDefault();
    const clean = text.trim();
    if (!clean) {
      setError('Write a message first.');
      return;
    }
    setBusy(true);
    try {
      const result = await api(`tasks/${enc(t.uuid)}/messages`, { method: 'POST', body: { text: clean } });
      setData(result);
      setText('');
      setError(null);
      onSent?.();
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };
  const id = `message-${t.uuid}`;
  return (
    <div class="agent-messages">
      {data.messages.length > 0 && (
        <ol class="notes" aria-label="Your messages to the agent">
          {data.messages.map((m) => (
            <li key={m.id} class="note">
              <span class="meta">
                <strong class="note-by">You</strong> ·{' '}
                <time dateTime={m.sent} title={m.sent}>
                  {time(m.sent)}
                </time>{' '}
                · <span class={`message-status is-${m.status}`}>{messageStatus(m)}</span>
              </span>
              <p class="message-text">{m.text}</p>
            </li>
          ))}
        </ol>
      )}
      {data.canSend && (
        <form class="note-add" onSubmit={submit} noValidate>
          {data.idle && (
            <p class="message-idle small" role="status">
              <TriangleAlert size={14} aria-hidden="true" />
              <span>
                The agent is idle and won’t see this until it wakes.{' '}
                {url ? (
                  <a href={url} {...ext}>
                    Open its session
                  </a>
                ) : (
                  'Open its session'
                )}{' '}
                to wake it now.
              </span>
            </p>
          )}
          <label class="field-label" for={id}>
            {label}
          </label>
          <Dictate>
            <textarea
              id={id}
              ref={area}
              class="textarea"
              rows={2}
              maxLength={MESSAGE_MAX}
              autoFocus={autoFocus}
              value={text}
              aria-describedby={error ? `${id}-error ${id}-hint` : `${id}-hint`}
              placeholder={placeholder}
              onInput={(e) => {
                setText(e.currentTarget.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
              }}
            />
          </Dictate>
          {error && (
            <span class="field-error" id={`${id}-error`} role="alert">
              {error}
            </span>
          )}
          <span class="field-hint" id={`${id}-hint`}>
            {data.agent} gets it on its next step, as your guidance for this task. It can’t change the agent’s rules. No
            secrets or personal data.
          </span>
          <div class="note-actions">
            <span class="meta">Ctrl + Enter sends it</span>
            <button type="submit" class="btn btn-outline btn-sm" disabled={busy || !text.trim()}>
              <Send size={15} aria-hidden="true" />
              {busy ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * In the Agents view: Message on a running agent's card opens the same box.
 * @param {Record<string, any>} props
 */
export function MessageButton({ run: r }) {
  const [open, setOpen] = useState(false);
  const titleId = `message-title-${r.uuid}`;
  return (
    <>
      <button type="button" class="btn btn-quiet btn-sm" onClick={() => setOpen(true)}>
        <MessageSquareText size={15} aria-hidden="true" />
        Message
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} labelledBy={titleId}>
        <div class="sheet">
          <h2 id={titleId}>Message {r.agent}</h2>
          <p class="muted small">
            <span class="wid">{r.wid}</span> {r.description}
          </p>
          {open && <MessageAgent task={r} url={r.url} autoFocus />}
          <div class="sheet-actions">
            <button type="button" class="btn btn-quiet" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

/** Turns Start by itself when ready on or off. */
export const setAutostart = (t, on) =>
  actions.update(
    t,
    { autostart: on ? 'yes' : null },
    on ? `${ref(t)} will start an agent by itself when it’s ready.` : `${ref(t)} won’t start by itself.`,
  );

/**
 * Which start controls a task shows, by the panel's rules (the task menu uses the same): why it can't start
 * (`blocker`), whether Start by itself when ready applies (`canAuto`), whether Start an agent shows (`canStart`),
 * and the queue entry while it waits for the board's room (`queued`, with `forceable` when Force start applies).
 */
export function startState(t) {
  const blocker = agentBlocker(t);
  const canAuto = t.status === 'pending' && t.tags.includes('agent') && !t.tags.includes('decide');
  const canStart = canAuto && !blocker && Boolean(agents.value.data?.connected);
  // Start when ready, and held back by the board's room (a general agent waits here until there's a slot).
  const queued =
    canAuto && !blocker && t.autostart && !t.claim
      ? (agents.value.data?.queue?.find((q) => q.uuid === t.uuid && !q.ready) ?? null)
      : null;
  return { blocker, canAuto, canStart, queued };
}

/**
 * In a task, right below its actions: start or refine an agent, Start when ready, and the session's live output.
 * @param {Record<string, any>} props
 */
export function AgentSection({ task: t }) {
  const [note, setNote] = useState('');
  const [writing, setWriting] = useState(false);
  const [busy, setBusy] = useState(false);
  const connected = agents.value.data?.connected;
  const { blocker, canAuto, canStart, queued } = startState(t);
  const run = t.agentRun;
  // A run whose start failed has no session, but its state (and Try again) still shows (WEB-41).
  const hasSession = Boolean(run?.url || run?.lastAt || runWords(run?.state));
  // Try again in the run's state stands in for Start an agent.
  const again = canStart && run?.state?.id === 'failed' && !run.state.until && AGAIN_KINDS.has(run.kind);
  const open = t.status === 'pending';
  // Every open task can be refined, so the section shows on all of them.
  if (!hasSession && !open) return null;
  const start = async () => {
    setBusy(true);
    const finish = () => {
      setWriting(false);
      setNote('');
    };
    const result = await actions.startAgent(t, note.trim(), finish);
    setBusy(false);
    if (result) finish();
  };
  return (
    <section class="panel-section agent-section" aria-labelledby={`agent-${t.uuid}`}>
      <h3 id={`agent-${t.uuid}`}>
        <Bot size={16} aria-hidden="true" />
        Agent
      </h3>
      {hasSession && (
        <p class="small agent-line">
          <strong>{run.agent}</strong>
          {run.trigger && `, ${TRIGGER_LABEL[run.trigger] ?? run.trigger}`}
          {run.startedAt && ` ${ago(run.startedAt)}`} {run.forced && <ForcedMark />}
        </p>
      )}
      {open && (
        <div class="agent-start">
          {canStart && writing && (
            <label class="field">
              <span class="field-label">Note for the agent (optional)</span>
              <Dictate>
                <textarea
                  class="textarea"
                  rows={3}
                  value={note}
                  onInput={(e) => setNote(e.currentTarget.value)}
                  placeholder="Anything it should know or keep in mind"
                />
              </Dictate>
            </label>
          )}
          <div class="agent-actions">
            {canStart && !again && (
              <button type="button" class="btn btn-primary btn-sm" disabled={busy} onClick={start}>
                <Bot size={16} aria-hidden="true" />
                {busy ? 'Starting…' : 'Start an agent'}
              </button>
            )}
            {canStart && !writing && (
              <button type="button" class="btn btn-quiet btn-sm" onClick={() => setWriting(true)}>
                Add a note
              </button>
            )}
            <RefineButton task={t} />
          </div>
        </div>
      )}
      {canAuto && !connected && agents.value.loaded && (
        <p class="muted small">
          Connect the agent routine to start agents from here.{' '}
          <button type="button" class="linkish" onClick={() => go('agents')}>
            How
          </button>
        </p>
      )}
      {canAuto && !t.claim && (
        <label class="check-row agent-auto">
          <input type="checkbox" checked={t.autostart} onChange={(e) => setAutostart(t, e.currentTarget.checked)} />
          <span>
            <Zap size={14} aria-hidden="true" /> Start by itself when ready
            {blocker && !t.autostart ? ` (${blocker})` : ''}
          </span>
        </label>
      )}
      {t.autostart && blocker && !t.claim && (
        <p class="meta">
          <TriangleAlert size={13} aria-hidden="true" /> Waiting: {blocker}.
        </p>
      )}
      {queued && (
        <div class="agent-waiting">
          <p class="meta">
            <Hourglass size={13} aria-hidden="true" /> Waiting to start: {queued.reason}. It starts by itself once that
            clears.
          </p>
          {queued.forceable && (
            <button
              type="button"
              class="btn btn-outline btn-sm"
              aria-label={`Force start ${ref(t)}, past: ${queued.reason}`}
              disabled={busy}
              onClick={start}
            >
              Force start
            </button>
          )}
        </div>
      )}
      {hasSession && <LiveLog task={t} onRetry={canStart ? start : null} busy={busy} />}
      {hasSession && t.status === 'pending' && t.claim && <MessageAgent task={t} url={run?.url ?? t.session ?? null} />}
    </section>
  );
}
