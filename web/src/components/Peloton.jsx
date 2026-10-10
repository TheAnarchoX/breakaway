import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import {
  ClipboardList,
  CornerDownRight,
  Eye,
  FastForward,
  Flag,
  Lightbulb,
  LogIn,
  LogOut,
  MessageCircleQuestionMark,
  MessageSquare,
  Pencil,
  Reply,
  Send,
  Square,
  StepForward,
  UserCheck,
  Users,
  X,
} from 'lucide-preact';
import { api, enc } from '../lib/api.js';
import { Named } from '../lib/avatar.jsx';
import { ago, plural } from '../lib/model.js';
import { hashFor, session } from '../lib/store.js';
import { Dictate, RepoChip, Segmented, useAutosize } from './ui.jsx';

/**
 * A peloton (docs/specs/IDEA-32-peloton.md section 5, IDEA-36-peloton-planning.md section 9): who rides it (agent,
 * task, last post) and its posts, newest last. The Agents view shows one per repository; a feature with a chase on
 * shows the chase's under its live line. Signed in, you post on it too, as the owner; on a chase's peloton you also
 * call and close a huddle, and keep the chase's plan. Your posts are guidance to the agents riding it, like a message.
 */

const REFRESH = 5000;
/** The most a post, the plan, and the plan's line on what changed take (src/store-peloton.js). */
const POST_MAX = 2000;
const PLAN_MAX = 4000;
const WHY_MAX = 300;
const KINDS = {
  checkin: { label: 'Checked in', Icon: LogIn },
  step: { label: 'Step', Icon: StepForward },
  reply: { label: 'Reply', Icon: CornerDownRight },
  leave: { label: 'Left', Icon: LogOut },
  note: { label: 'Note', Icon: MessageSquare },
  ask: { label: 'Ask', Icon: MessageCircleQuestionMark },
  propose: { label: 'Propose', Icon: Lightbulb },
  review: { label: 'Review', Icon: Eye },
  // A huddle on a chase's peloton: it's called, agents say they're in, and someone closes it with the outcome.
  huddle: { label: 'Huddle', Icon: Users },
  in: { label: 'In', Icon: UserCheck },
  outcome: { label: 'Outcome', Icon: Flag },
  // The board's line when the chase's plan changes.
  plan: { label: 'Plan', Icon: ClipboardList },
  // The board's own lines on a chase's peloton, when the chase starts and when it stops or ends.
  open: { label: 'Opened', Icon: FastForward },
  close: { label: 'Closed', Icon: Square },
};
/** What you post as from the box; a reply is what you pick with Reply on a post. */
const POST_KINDS = [
  { id: 'note', label: 'Note', hint: 'Anything, for talking' },
  { id: 'ask', label: 'Ask', hint: 'A question for whoever knows' },
  { id: 'propose', label: 'Propose', hint: 'A change to the plan or the tasks' },
  { id: 'review', label: 'Review', hint: 'Ask the agents to look at an approach or a branch' },
];
/** `@<agent name>` or `@captain`, as the board reads them (src/store-peloton.js). */
const MENTION = /(?<![\w.@:/-])@([\w.:/-]{1,64})/gu;

/** Who posted, with their avatar: you, an agent by its name, or the board's own line. */
const Who = ({ agent }) =>
  agent === 'owner' ? (
    <Named name={agent} label="You" class="pl-you" />
  ) : agent === 'board' ? (
    <Named name={agent} label="The board" class="pl-board" />
  ) : (
    <Named name={agent} class="pl-agent" />
  );
const whoText = (agent) => (agent === 'owner' ? 'you' : agent === 'board' ? 'the board' : agent);

/** Peloton `name`'s roster, posts, huddle, and plan, refreshed while the page is visible: `{ data, error, set }`. */
function usePeloton(name) {
  const [state, setState] = useState({ data: null, error: null });
  useEffect(() => {
    let live = true;
    setState({ data: null, error: null });
    const load = () =>
      api(`peloton/${enc(name)}`)
        .then((data) => live && setState({ data, error: null }))
        .catch((error) => live && setState((s) => ({ data: s.data, error: error.message })));
    load();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, REFRESH);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [name]);
  return { ...state, set: (data) => setState({ data, error: null }) };
}

function TaskLink({ task }) {
  if (!task) return null;
  return (
    <a class="wid" href={hashFor({ task })}>
      {task}
    </a>
  );
}

function Kind({ kind }) {
  const k = KINDS[kind] ?? { label: kind, Icon: StepForward };
  return (
    <span class={`pl-kind pl-kind-${kind}`}>
      <k.Icon size={13} aria-hidden="true" />
      {k.label}
    </span>
  );
}

function When({ at }) {
  return (
    <time class="meta" datetime={at} title={new Date(at).toLocaleString()}>
      {ago(at)}
    </time>
  );
}

/**
 * A post's text, with each agent it mentions as a link to that agent's task (or marked, when the board doesn't know
 * the task). `@captain` stands for the road captain, which the board resolved to a name when the post was made.
 */
function Mentioned({ text, mentions, tasks }) {
  if (!mentions?.length) return text;
  const named = new Set(mentions.map((m) => m.toLowerCase()));
  const literal = new Set([...text.matchAll(MENTION)].map((m) => m[1].replace(/[.:/-]+$/u, '').toLowerCase()));
  const captain = mentions.find((m) => !literal.has(m.toLowerCase())) ?? null;
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(MENTION)) {
    const raw = m[1].replace(/[.:/-]+$/u, '');
    const key = raw.toLowerCase();
    const agent = key === 'captain' ? captain : named.has(key) ? mentions.find((n) => n.toLowerCase() === key) : null;
    if (!agent) continue;
    const at = m.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    const task = tasks.get(agent);
    const label = `@${raw}`;
    parts.push(
      task ? (
        <a key={at} class="pl-mention" href={hashFor({ task })} title={`${agent} on ${task}`}>
          {label}
        </a>
      ) : (
        <span key={at} class="pl-mention" title={agent}>
          {label}
        </span>
      ),
    );
    last = at + label.length;
  }
  if (!parts.length) return text;
  parts.push(text.slice(last));
  return <>{parts}</>;
}

/** Who rides it now: each agent, its task, since when, and what it last said. */
function Roster({ roster, id }) {
  return (
    <ul class="pl-roster" aria-labelledby={id}>
      {roster.map((r) => (
        <li key={r.agent} class="pl-rider">
          <span class="pl-head">
            <Who agent={r.agent} />
            <TaskLink task={r.task} />
            <RepoChip slug={r.repo} />
            <span class="meta">since {ago(r.since)}</span>
          </span>
          {r.last && (
            <span class="pl-last">
              <Kind kind={r.last.kind} /> {r.last.text} <When at={r.last.at} />
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** One post: its kind, who and on which task, when, what it answers, and its text. Yours are marked as yours. */
function Post({ post, byId, tasks, onReply }) {
  const to = post.replyTo ? byId.get(post.replyTo) : null;
  const mine = post.agent === 'owner';
  const cls = ['pl-post', post.kind === 'leave' ? 'is-leave' : '', mine ? 'is-mine' : '', onReply ? 'has-reply' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <li class={cls}>
      <span class="pl-head">
        <Kind kind={post.kind} />
        <Who agent={post.agent} />
        <TaskLink task={post.task} />
        <RepoChip slug={post.repo} />
        <When at={post.at} />
      </span>
      {onReply && (
        <button
          type="button"
          class="btn btn-quiet btn-icon btn-sm pl-reply"
          aria-label={`Reply to ${whoText(post.agent)}’s post`}
          title="Reply"
          onClick={() => onReply(post)}
        >
          <Reply size={14} aria-hidden="true" />
        </button>
      )}
      {post.replyTo && (
        <span class="pl-to meta">
          {to ? (
            <>
              To {whoText(to.agent)}: <span class="pl-quote">{to.text}</span>
            </>
          ) : (
            'To an earlier post.'
          )}
        </span>
      )}
      <p class="pl-text">
        <Mentioned text={post.text} mentions={post.mentions} tasks={tasks} />
      </p>
    </li>
  );
}

/**
 * The posts, newest last, in a box of fixed height that scrolls (WEB-51); only the latest `shown` until you ask
 * for the earlier ones. It opens on the newest and follows new posts while you're at the bottom, as the live log
 * does.
 */
function Posts({ posts, shown, compact, id, tasks, onReply }) {
  const [all, setAll] = useState(false);
  const box = useRef(/** @type {HTMLElement | null} */ (null));
  const stick = useRef(true);
  const byId = new Map(posts.map((p) => [p.id, p]));
  const list = all ? posts : posts.slice(-shown);
  const earlier = posts.length - list.length;
  const newest = posts.at(-1)?.id;
  const scroller = compact ? 'pl-scroll is-compact' : 'pl-scroll';
  useLayoutEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [newest]);
  // Asking for the earlier posts takes you to the first of them.
  useLayoutEffect(() => {
    if (all && box.current) box.current.scrollTop = 0;
  }, [all]);
  const onScroll = () => {
    const el = box.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  // Agents' posts take a reply; the board's lines and your own don't.
  const replyable = (p) => onReply && p.agent !== 'owner' && p.agent !== 'board';
  return (
    <>
      {earlier > 0 && (
        <button type="button" class="btn btn-quiet btn-sm pl-earlier" onClick={() => setAll(true)}>
          Show {plural(earlier, 'earlier post')}
        </button>
      )}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the posts scroll, so they take focus to scroll by keyboard. */}
      <section class={scroller} ref={box} onScroll={onScroll} tabIndex={0} aria-labelledby={id}>
        <ol class="pl-posts" aria-labelledby={id}>
          {list.map((p) => (
            <Post key={p.id} post={p} byId={byId} tasks={tasks} onReply={replyable(p) ? onReply : null} />
          ))}
        </ol>
      </section>
    </>
  );
}

/**
 * A textarea with its label, hint, and error, that grows with its text and sends on Ctrl + Enter.
 * @param {Record<string, any>} props
 */
function Field({ id, label, value, onInput, max, hint, error, rows = 2, area, onSubmit, placeholder }) {
  const own = useRef(/** @type {HTMLTextAreaElement | null} */ (null));
  const ref = area ?? own;
  useAutosize(ref, value);
  return (
    <>
      <label class="field-label" for={id}>
        {label}
      </label>
      <Dictate>
        <textarea
          id={id}
          ref={ref}
          class="textarea"
          rows={rows}
          maxLength={max}
          value={value}
          placeholder={placeholder}
          aria-describedby={error ? `${id}-error ${id}-hint` : `${id}-hint`}
          onInput={(e) => onInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSubmit(e);
          }}
        />
      </Dictate>
      {error && (
        <span class="field-error" id={`${id}-error`} role="alert">
          {error}
        </span>
      )}
      <span class="field-hint" id={`${id}-hint`}>
        {hint}
      </span>
    </>
  );
}

/** Sends `body` to `path` and hands the peloton the board answers with to `onDone`; `{ busy, error, send, clear }`. */
function useSend(onDone) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const send = async (path, method, body) => {
    setBusy(true);
    try {
      const result = await api(path, { method, body });
      setError(null);
      if (result.peloton) onDone(result.peloton);
      setBusy(false);
      return true;
    } catch (err) {
      setError(err.message);
      setBusy(false);
      return false;
    }
  };
  return { busy, error, setError, send };
}

/** "closes in 12 min", from the huddle's close time. */
function timeLeft(closes) {
  const min = Math.ceil((Date.parse(closes) - Date.now()) / 60_000);
  return min > 0 ? `closes by itself in ${plural(min, 'minute')}` : 'closing now';
}

/**
 * The open huddle, at the top: its question, who called it, who's in, and its time left. Signed in, Close huddle takes
 * the outcome. With none open on a chase's peloton, Call a huddle asks the question.
 */
function Huddle({ name, id, huddle, canPost, onDone }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const { busy, error, setError, send } = useSend(onDone);
  const opened = huddle?.id ?? null;
  // A huddle that closes or opens while you write starts the form over.
  useEffect(() => {
    setOpen(false);
    setText('');
    setError(null);
  }, [opened]);
  const fieldId = `${id}-huddle-text`;
  const submit = async (e) => {
    e?.preventDefault();
    const clean = text.trim();
    if (!clean) {
      setError(huddle ? 'Write what was agreed first.' : 'Write the question first.');
      return;
    }
    if (await send(`peloton/${enc(name)}`, 'POST', { kind: huddle ? 'outcome' : 'huddle', text: clean })) {
      setText('');
      setOpen(false);
    }
  };
  const cancel = () => {
    setOpen(false);
    setError(null);
  };
  const form = open && (
    <form class="note-add pl-form" onSubmit={submit} noValidate>
      <Field
        id={fieldId}
        label={huddle ? 'Outcome' : 'What should they talk through?'}
        value={text}
        onInput={(v) => {
          setText(v);
          setError(null);
        }}
        max={POST_MAX}
        error={error}
        onSubmit={submit}
        placeholder={huddle ? 'What was agreed, and who does what' : 'One question for every agent on the chase'}
        hint={
          huddle
            ? 'Closes the huddle. Each agent whose work it changes writes it on its task. No secrets or personal data.'
            : 'Every agent riding the chase stops after its current step to talk it through. It closes with an outcome, or by itself after 20 minutes. No secrets or personal data.'
        }
      />
      <div class="note-actions">
        <button type="button" class="btn btn-quiet btn-sm" onClick={cancel}>
          Cancel
        </button>
        <button type="submit" class="btn btn-outline btn-sm" disabled={busy || !text.trim()}>
          {huddle ? <Flag size={15} aria-hidden="true" /> : <Users size={15} aria-hidden="true" />}
          {busy ? (huddle ? 'Closing…' : 'Calling…') : huddle ? 'Close huddle' : 'Call a huddle'}
        </button>
      </div>
    </form>
  );
  if (!huddle) {
    if (!canPost) return null;
    return open ? (
      form
    ) : (
      <div class="pl-actions">
        <button type="button" class="btn btn-quiet btn-sm" onClick={() => setOpen(true)}>
          <Users size={15} aria-hidden="true" />
          Call a huddle
        </button>
      </div>
    );
  }
  return (
    <section class="pl-huddle" aria-labelledby={`${id}-huddle`}>
      <h4 class="pl-sub" id={`${id}-huddle`}>
        <Users size={13} aria-hidden="true" />
        Huddle <span class="meta">{timeLeft(huddle.closes)}</span>
      </h4>
      <p class="pl-text">{huddle.question}</p>
      <p class="pl-huddle-who meta">
        Called by {whoText(huddle.caller)}
        {huddle.task ? (
          <>
            {' '}
            on <TaskLink task={huddle.task} />
          </>
        ) : null}{' '}
        <When at={huddle.opened} />.{' '}
        {huddle.in.length ? (
          <>
            In: <span class="pl-in">{huddle.in.join(', ')}</span>
          </>
        ) : (
          'Nobody’s in yet.'
        )}
      </p>
      {canPost &&
        (open ? (
          form
        ) : (
          <div class="pl-actions">
            <button type="button" class="btn btn-outline btn-sm" onClick={() => setOpen(true)}>
              <Flag size={15} aria-hidden="true" />
              Close huddle
            </button>
          </div>
        ))}
    </section>
  );
}

/** The plan's revisions, newest first, from the board when you open them. */
function Revisions({ name, version }) {
  const [state, setState] = useState({ list: null, error: null });
  useEffect(() => {
    let live = true;
    api(`peloton/${enc(name)}/plan`)
      .then((data) => live && setState({ list: data.revisions, error: null }))
      .catch((error) => live && setState({ list: null, error: error.message }));
    return () => {
      live = false;
    };
  }, [name, version]);
  if (state.error)
    return (
      <p class="field-error" role="alert">
        Couldn’t load the revisions. {state.error}
      </p>
    );
  if (!state.list) return <p class="muted small">Loading…</p>;
  return (
    <ol class="pl-revisions">
      {state.list.map((r) => (
        <li key={r.version}>
          <details>
            <summary>
              <span class="pl-version">v{r.version}</span> {r.why}{' '}
              <span class="meta">
                {whoText(r.agent)}, <When at={r.at} />
              </span>
            </summary>
            <p class="pl-text">{r.text}</p>
          </details>
        </li>
      ))}
    </ol>
  );
}

/**
 * The chase's plan, pinned above the posts: the bigger picture every agent on the chase lines up with. Signed in,
 * Edit plan revises it with a line on what changed; Revisions lists every version.
 */
function Plan({ name, id, plan, canPost, onDone }) {
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  const [text, setText] = useState('');
  const [why, setWhy] = useState('');
  const { busy, error, setError, send } = useSend(onDone);
  const edit = () => {
    setText(plan?.text ?? '');
    setWhy('');
    setError(null);
    setEditing(true);
  };
  const submit = async (e) => {
    e?.preventDefault();
    if (!text.trim()) {
      setError('Write the plan first.');
      return;
    }
    if (!why.trim()) {
      setError('Say in a line what changed.');
      return;
    }
    if (await send(`peloton/${enc(name)}/plan`, 'PUT', { text: text.trim(), why: why.trim() })) setEditing(false);
  };
  const fieldId = `${id}-plan-text`;
  return (
    <section class="pl-plan" aria-labelledby={`${id}-plan`}>
      <h4 class="pl-sub" id={`${id}-plan`}>
        <ClipboardList size={13} aria-hidden="true" />
        The chase’s plan
        {plan && (
          <span class="meta">
            v{plan.version}, by {whoText(plan.agent)} <When at={plan.at} />
          </span>
        )}
      </h4>
      {editing ? (
        <form class="note-add pl-form" onSubmit={submit} noValidate>
          <Field
            id={fieldId}
            label="Plan"
            value={text}
            onInput={(v) => {
              setText(v);
              setError(null);
            }}
            max={PLAN_MAX}
            rows={6}
            onSubmit={submit}
            placeholder="What the chase is building, in what order, who’s on what, and what’s decided"
            hint={`Up to ${PLAN_MAX.toLocaleString('en-GB')} characters. Every agent riding the chase gets it at once. No secrets or personal data.`}
          />
          <label class="field-label" for={`${fieldId}-why`}>
            What changed
          </label>
          <input
            id={`${fieldId}-why`}
            class="input"
            maxLength={WHY_MAX}
            value={why}
            placeholder="One line, like “BRK-12 goes before BRK-14”"
            aria-describedby={error ? `${fieldId}-error` : undefined}
            onInput={(e) => {
              setWhy(e.currentTarget.value);
              setError(null);
            }}
          />
          {error && (
            <span class="field-error" id={`${fieldId}-error`} role="alert">
              {error}
            </span>
          )}
          <div class="note-actions">
            <button type="button" class="btn btn-quiet btn-sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="submit" class="btn btn-outline btn-sm" disabled={busy || !text.trim() || !why.trim()}>
              {busy ? 'Saving…' : 'Save plan'}
            </button>
          </div>
        </form>
      ) : plan ? (
        <p class="pl-text">{plan.text}</p>
      ) : (
        <p class="muted small">
          No plan yet. The agents riding the chase, its road captain, or you write what it’s building and in what order.
        </p>
      )}
      {!editing && (canPost || plan) && (
        <div class="pl-actions">
          {canPost && (
            <button type="button" class="btn btn-quiet btn-sm" onClick={edit}>
              <Pencil size={14} aria-hidden="true" />
              {plan ? 'Edit plan' : 'Write the plan'}
            </button>
          )}
          {plan && (
            <button
              type="button"
              class="btn btn-quiet btn-sm"
              aria-expanded={history}
              onClick={() => setHistory(!history)}
            >
              {history ? 'Hide revisions' : `Revisions (${plan.version})`}
            </button>
          )}
        </div>
      )}
      {history && plan && !editing && <Revisions name={name} version={plan.version} />}
    </section>
  );
}

/**
 * The box you post from, as the owner: a note, a question, a proposal, or a request for review, or a reply to one
 * agent's post. Agents get it urgently, as guidance within their task and their rules.
 */
function Compose({ name, id, kind: chase, replyTo, onCancelReply, area, onDone }) {
  const [kind, setKind] = useState('note');
  const [text, setText] = useState('');
  const { busy, error, setError, send } = useSend(onDone);
  const fieldId = `${id}-post`;
  const submit = async (e) => {
    e?.preventDefault();
    const clean = text.trim();
    if (!clean) {
      setError('Write the post first.');
      return;
    }
    const body = replyTo ? { kind: 'reply', text: clean, reply_to: replyTo.id } : { kind, text: clean };
    if (await send(`peloton/${enc(name)}`, 'POST', body)) {
      setText('');
      setKind('note');
      onCancelReply();
    }
  };
  return (
    <form class="note-add pl-compose" onSubmit={submit} noValidate>
      {replyTo ? (
        <p class="pl-replying meta">
          <CornerDownRight size={13} aria-hidden="true" />
          <span>
            Replying to {whoText(replyTo.agent)}: <span class="pl-quote">{replyTo.text}</span>
          </span>
          <button
            type="button"
            class="btn btn-quiet btn-icon btn-sm"
            aria-label="Cancel the reply"
            title="Cancel the reply"
            onClick={onCancelReply}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </p>
      ) : (
        <Segmented label="Kind of post" options={POST_KINDS} value={kind} onChange={setKind} />
      )}
      <Field
        id={fieldId}
        area={area}
        label={replyTo ? 'Your reply' : 'Post on the peloton'}
        value={text}
        onInput={(v) => {
          setText(v);
          setError(null);
        }}
        max={POST_MAX}
        error={error}
        onSubmit={submit}
        placeholder={replyTo ? 'Your answer' : 'Something for the agents riding it; @name reaches one'}
        hint={`The agents riding it get it at once, as your guidance within their task and their rules. ${chase === 'chase' ? '@captain reaches the road captain. ' : ''}No secrets or personal data.`}
      />
      <div class="note-actions">
        <span class="meta">Ctrl + Enter posts it</span>
        <button type="submit" class="btn btn-outline btn-sm" disabled={busy || !text.trim()}>
          <Send size={15} aria-hidden="true" />
          {busy ? 'Posting…' : 'Post'}
        </button>
      </div>
    </form>
  );
}

/**
 * Peloton `name` (a repository's slug, or `chase:<feature>`). `compact` shows fewer posts at first, in a shorter
 * box, for a peloton that sits inside another panel.
 * @param {{ name: string, compact?: boolean }} props
 */
export function PelotonPanel({ name, compact = false }) {
  const { data, error, set } = usePeloton(name);
  const [replyTo, setReplyTo] = useState(/** @type {Record<string, any> | null} */ (null));
  const area = useRef(/** @type {HTMLTextAreaElement | null} */ (null));
  if (!data)
    return error ? (
      <p class="field-error" role="alert">
        Couldn’t load the peloton. {error}
      </p>
    ) : (
      <p class="muted small">Loading…</p>
    );
  const { roster, posts } = data;
  const id = `pl-${name.replace(/[^\w-]/gu, '-')}`;
  const chase = data.kind === 'chase';
  // Only the signed-in board posts as the owner, and an ended chase's peloton takes no posts.
  const canPost = session.value === 'in' && data.open;
  // Each agent's task, for its mentions: from its posts, then from who rides now.
  const tasks = new Map();
  for (const p of posts) if (p.task && p.agent !== 'owner' && p.agent !== 'board') tasks.set(p.agent, p.task);
  for (const r of roster) if (r.task) tasks.set(r.agent, r.task);
  const reply = (post) => {
    setReplyTo(post);
    area.current?.focus();
  };
  const empty = !roster.length && !posts.length;
  return (
    <div class="pl-panel">
      {error && (
        <p class="field-error" role="alert">
          Couldn’t refresh the peloton. {error}
        </p>
      )}
      {chase && data.open && <Huddle name={name} id={id} huddle={data.huddle} canPost={canPost} onDone={set} />}
      {chase && (data.plan || canPost) && <Plan name={name} id={id} plan={data.plan} canPost={canPost} onDone={set} />}
      {empty ? (
        <p class="pl-empty">Nobody’s riding yet. Agents check in here when they start.</p>
      ) : (
        <>
          <h4 class="pl-sub" id={`${id}-riding`}>
            Riding now <span class="count">{roster.length}</span>
          </h4>
          {roster.length ? (
            <Roster roster={roster} id={`${id}-riding`} />
          ) : (
            <p class="muted small">
              {data.open ? 'Nobody’s riding now.' : 'Closed with the chase. Its posts go a day after.'}
            </p>
          )}
          {posts.length > 0 && (
            <>
              <h4 class="pl-sub" id={`${id}-posts`}>
                Posts, newest last <span class="count">{posts.length}</span>
              </h4>
              <Posts
                posts={posts}
                shown={compact ? 5 : 20}
                compact={compact}
                id={`${id}-posts`}
                tasks={tasks}
                onReply={canPost ? reply : null}
              />
            </>
          )}
        </>
      )}
      {canPost && (
        <Compose
          name={name}
          id={id}
          kind={data.kind}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          area={area}
          onDone={set}
        />
      )}
    </div>
  );
}
