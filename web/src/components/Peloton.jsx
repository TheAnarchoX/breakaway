import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { CornerDownRight, FastForward, LogIn, LogOut, Square, StepForward } from 'lucide-preact';
import { api, enc } from '../lib/api.js';
import { ago, plural } from '../lib/model.js';
import { hashFor } from '../lib/store.js';
import { RepoChip } from './ui.jsx';

/**
 * A peloton, read-only (docs/specs/IDEA-32-peloton.md, section 5): who rides it (agent, task, last post) and
 * its posts, newest last. The Agents view shows one per repository; a feature with a chase on shows the chase's
 * under its live line. You read it here and steer one agent with a message, so nothing on it posts.
 */

const REFRESH = 5000;
const KINDS = {
  checkin: { label: 'Checked in', Icon: LogIn },
  step: { label: 'Step', Icon: StepForward },
  reply: { label: 'Reply', Icon: CornerDownRight },
  leave: { label: 'Left', Icon: LogOut },
  // The board's own lines on a chase's peloton, when the chase starts and when it stops or ends.
  open: { label: 'Opened', Icon: FastForward },
  close: { label: 'Closed', Icon: Square },
};
/** Who posted: an agent by its name, or the board's own line. */
const Who = ({ agent }) =>
  agent === 'board' ? <span class="pl-board">The board</span> : <span class="pl-agent">{agent}</span>;

/** Peloton `name`'s roster and posts, refreshed while the page is visible: `{ data, error }`. */
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
  return state;
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

/** Who rides it now: each agent, its task, since when, and what it last said. */
function Roster({ roster, id }) {
  return (
    <ul class="pl-roster" aria-labelledby={id}>
      {roster.map((r) => (
        <li key={r.agent} class="pl-rider">
          <span class="pl-head">
            <span class="pl-agent">{r.agent}</span>
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

/** One post: its kind, who and on which task, when, what it answers, and its text. */
function Post({ post, byId }) {
  const to = post.replyTo ? byId.get(post.replyTo) : null;
  return (
    <li class={`pl-post ${post.kind === 'leave' ? 'is-leave' : ''}`}>
      <span class="pl-head">
        <Kind kind={post.kind} />
        <Who agent={post.agent} />
        <TaskLink task={post.task} />
        <RepoChip slug={post.repo} />
        <When at={post.at} />
      </span>
      {post.replyTo && (
        <span class="pl-to meta">
          {to ? (
            <>
              To {to.agent === 'board' ? 'the board' : to.agent}: <span class="pl-quote">{to.text}</span>
            </>
          ) : (
            'To an earlier post.'
          )}
        </span>
      )}
      <p class="pl-text">{post.text}</p>
    </li>
  );
}

/**
 * The posts, newest last, in a box of fixed height that scrolls (WEB-51); only the latest `shown` until you ask
 * for the earlier ones. It opens on the newest and follows new posts while you're at the bottom, as the live log
 * does.
 */
function Posts({ posts, shown, compact, id }) {
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
            <Post key={p.id} post={p} byId={byId} />
          ))}
        </ol>
      </section>
    </>
  );
}

/**
 * Peloton `name` (a repository's slug, or `chase:<feature>`). `compact` shows fewer posts at first, in a shorter
 * box, for a peloton that sits inside another panel.
 * @param {{ name: string, compact?: boolean }} props
 */
export function PelotonPanel({ name, compact = false }) {
  const { data, error } = usePeloton(name);
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
  return (
    <div class="pl-panel">
      {error && (
        <p class="field-error" role="alert">
          Couldn’t refresh the peloton. {error}
        </p>
      )}
      {!roster.length && !posts.length ? (
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
              <Posts posts={posts} shown={compact ? 5 : 20} compact={compact} id={`${id}-posts`} />
            </>
          )}
        </>
      )}
    </div>
  );
}
