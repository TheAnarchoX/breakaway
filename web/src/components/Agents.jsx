import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import {
  Bot,
  ExternalLink,
  Sparkles,
  FileText,
  Globe,
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
import { api, enc } from '../lib/api.js';
import { ago, openPr, ref, time } from '../lib/model.js';
import { actions, agents, go } from '../lib/store.js';
import { RichText } from '../lib/richtext.jsx';
import { Dialog, useAutosize } from './ui.jsx';

const ext = { target: '_blank', rel: 'noopener noreferrer' };
/** A session that has sent nothing for this long after starting is shown as not sending. */
export const SILENT_AFTER = 3 * 60_000;
export const TRIGGER_LABEL = {
  manual: 'started by hand',
  next: 'started with the next few',
  auto: 'started by itself when ready',
  alert: 'started for a security alert',
  review: 'started to test a Dependabot update',
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

/**
 * In the Agent section, beside Start an agent, and its modal: a required request, kept on failure.
 * @param {Record<string, any>} props
 */
export function RefineButton({ task: t }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const connected = agents.value.data?.connected;
  const loaded = agents.value.loaded;
  const reason =
    t.status !== 'pending'
      ? 'it isn’t open'
      : (refineBlocker(t) ?? (loaded && !connected ? 'the agent routine isn’t connected yet' : null));
  if (t.status !== 'pending') return null;
  const close = () => {
    if (!busy) setOpen(false);
  };
  const submit = async (e) => {
    e.preventDefault();
    if (!text.trim()) {
      setError('Say what it should look at or change.');
      return;
    }
    setBusy(true);
    const result = await actions.refineAgent(t, text.trim());
    setBusy(false);
    if (result) {
      setOpen(false);
      setText('');
    }
  };
  const hintId = `refine-hint-${t.uuid}`;
  return (
    <>
      <button
        type="button"
        class="btn btn-outline btn-sm"
        disabled={Boolean(reason)}
        aria-describedby={reason ? hintId : undefined}
        title={reason ? `Can’t refine: ${reason}` : undefined}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        <Sparkles size={16} aria-hidden="true" />
        Refine with an agent
      </button>
      {reason && (
        <span class="visually-hidden" id={hintId}>
          Can’t refine: {reason}.
        </span>
      )}
      <Dialog open={open} onClose={close} labelledBy="refine-title">
        <form class="sheet" onSubmit={submit} noValidate>
          <h2 id="refine-title">Refine {ref(t)} with an agent</h2>
          <label class="field">
            <span class="field-label">What should it look at or change?</span>
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

/**
 * What the session has done, as it happens. Polls while it's on screen; for watching only.
 * @param {Record<string, any>} props
 */
export function LiveLog({ task: t }) {
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
  // Past a few minutes with nothing at all, the session isn't sending, rather than still starting.
  const silent = !info?.lastAt && run?.startedAt && Date.now() - Date.parse(run.startedAt) > SILENT_AFTER;
  return (
    <div class="live-log">
      <div class="live-head">
        <span class={`live-state ${info?.live ? 'is-live' : ''}`}>
          {info?.live ? (
            <>
              <span class="live-dot" aria-hidden="true" />
              Working now
            </>
          ) : info?.lastAt ? (
            `Quiet for ${ago(info.lastAt).replace(' ago', '')}`
          ) : silent ? (
            'No live output'
          ) : (
            'Starting…'
          )}
        </span>
        {run?.url && (
          <a class="btn btn-quiet btn-sm" href={run.url} {...ext}>
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
      ) : (
        <p class="muted small">
          Nothing yet. The session shows up here once it has claimed the task; that takes a minute while it starts.
        </p>
      )}
      <p class="meta">
        For watching only: kept 14 days, never in Taskwarrior. Secrets are removed before they leave the session.
      </p>
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
export function MessageAgent({ task: t, url = null, autoFocus = false, onSent }) {
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
            Message the agent
          </label>
          <textarea
            id={id}
            ref={area}
            class="textarea"
            rows={2}
            maxLength={MESSAGE_MAX}
            autoFocus={autoFocus}
            value={text}
            aria-describedby={error ? `${id}-error ${id}-hint` : `${id}-hint`}
            placeholder="Something to add or keep in mind"
            onInput={(e) => {
              setText(e.currentTarget.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
            }}
          />
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

/**
 * In a task, right below its actions: start or refine an agent, Start when ready, and the session's live output.
 * @param {Record<string, any>} props
 */
export function AgentSection({ task: t }) {
  const [note, setNote] = useState('');
  const [writing, setWriting] = useState(false);
  const [busy, setBusy] = useState(false);
  const connected = agents.value.data?.connected;
  const blocker = agentBlocker(t);
  const run = t.agentRun;
  const hasSession = Boolean(run?.url || run?.lastAt);
  const open = t.status === 'pending';
  const canAuto = open && t.tags.includes('agent') && !t.tags.includes('decide');
  const canStart = canAuto && !blocker && connected;
  // Every open task can be refined, so the section shows on all of them.
  if (!hasSession && !open) return null;
  const start = async () => {
    setBusy(true);
    await actions.startAgent(t, note.trim());
    setBusy(false);
    setWriting(false);
    setNote('');
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
          {run.startedAt && ` ${ago(run.startedAt)}`}
        </p>
      )}
      {open && (
        <div class="agent-start">
          {canStart && writing && (
            <label class="field">
              <span class="field-label">Note for the agent (optional)</span>
              <textarea
                class="textarea"
                rows={3}
                value={note}
                onInput={(e) => setNote(e.currentTarget.value)}
                placeholder="Anything it should know or keep in mind"
              />
            </label>
          )}
          <div class="agent-actions">
            {canStart && (
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
          <input
            type="checkbox"
            checked={t.autostart}
            onChange={(e) =>
              actions.update(
                t,
                { autostart: e.currentTarget.checked ? 'yes' : null },
                e.currentTarget.checked
                  ? `${ref(t)} will start an agent by itself when it’s ready.`
                  : `${ref(t)} won’t start by itself.`,
              )
            }
          />
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
      {hasSession && <LiveLog task={t} />}
      {hasSession && t.status === 'pending' && t.claim && <MessageAgent task={t} url={run?.url ?? t.session ?? null} />}
    </section>
  );
}
