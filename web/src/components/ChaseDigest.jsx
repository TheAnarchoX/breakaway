import { useEffect, useState } from 'preact/hooks';
import { ArrowLeft, GitMerge, Hand, Image, Megaphone, Newspaper, OctagonAlert, StepForward } from 'lucide-preact';
import { api } from '../lib/api.js';
import { ago } from '../lib/model.js';
import { actions, hashFor } from '../lib/store.js';
import { Title } from '../lib/richtext.jsx';
import { sentence } from './Chase.jsx';

/**
 * A chase's digests (BRK-277, docs/specs/BRK-277-chase-digest.md): once an hour while it runs, and once when it stops
 * or ends, what merged, what waits for you, what's stuck, and what starts next. The feature lists them; each has a
 * page of its own.
 */

const enc = encodeURIComponent;
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const day = (iso) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });

/** A digest's page, as a link from anywhere. */
export const digestHref = (slug, id) => hashFor({ view: 'roadmap', feature: slug, digest: id, task: null });

/** What a digest's counts say, in words. */
export function countsWords(c) {
  const parts = [];
  if (c.merged) parts.push(`${c.merged} merged`);
  if (c.waiting) parts.push(`${c.waiting} ${c.waiting === 1 ? 'waits' : 'wait'} for you`);
  if (c.stuck) parts.push(`${c.stuck} stuck`);
  return parts.length ? parts.join(' · ') : 'Nothing new';
}

/**
 * The chase's digests on its feature's page: whether each pushes to your phone, and the latest, newest first.
 * @param {{ feature: { slug: string, title: string }, chase: Record<string, any>, onChange?: () => void }} props
 */
export function Digests({ feature, chase, onChange }) {
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const digest = chase.digest;
  if (!digest || (chase.state === 'off' && !digest.list.length)) return null;
  const shown = all ? digest.list : digest.list.slice(0, 6);
  const push = async (on) => {
    setBusy(true);
    await actions.chase(feature, { digestPush: on }, on ? 'Digests push.' : 'Digests stay in the inbox.');
    setBusy(false);
    onChange?.();
  };
  return (
    <section class="gh-section" aria-labelledby="fr-digests-title">
      <h2 id="fr-digests-title">
        <Newspaper size={18} aria-hidden="true" />
        Digests
      </h2>
      <p class="muted small">
        Once an hour while the chase runs, and once when it ends: what merged, what waits for you, and what’s next. The
        newest is in your inbox.
      </p>
      <label class="check-row">
        <input type="checkbox" checked={digest.push} disabled={busy} onChange={(e) => push(e.currentTarget.checked)} />
        <span>Push digests to your devices, at most one an hour</span>
      </label>
      {shown.length > 0 ? (
        <ol class="dg-list">
          {shown.map((d) => (
            <li key={d.id}>
              <a href={digestHref(feature.slug, d.id)}>
                {d.kind === 'final' ? 'Last digest' : 'Digest'}, {day(d.at)} {clock(d.at)}
              </a>
              <span class="meta"> · {countsWords(d.counts)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p class="meta">The first comes an hour after the chase starts.</p>
      )}
      {shown.length < digest.list.length && (
        <button type="button" class="btn btn-quiet btn-sm" onClick={() => setAll(true)}>
          Show all {digest.list.length}
        </button>
      )}
    </section>
  );
}

/** A task's work ID linked to it, else its description. */
function TaskRef({ x }) {
  return x.wid ? (
    <a class="wid" href={hashFor({ task: x.wid })}>
      {x.wid}
    </a>
  ) : null;
}

/**
 * A digest's page: its stretch of time, then what merged with its screenshots, what waits for you in the order to
 * take it, what's stuck, what the chase starts next, and its road captain's lines.
 * @param {{ slug: string, id: string }} props
 */
export function DigestPage({ slug, id }) {
  const [state, setState] = useState(
    /** @type {{ digest: any, error: string | null }} */ ({ digest: null, error: null }),
  );
  useEffect(() => {
    let live = true;
    setState({ digest: null, error: null });
    api(`features/${enc(slug)}/digests/${enc(id)}`).then(
      ({ digest }) => live && setState({ digest, error: null }),
      (error) => live && setState({ digest: null, error: error.message }),
    );
    return () => {
      live = false;
    };
  }, [slug, id]);
  const back = (
    <a class="fr-back" href={hashFor({ view: 'roadmap', feature: slug, digest: null, task: null })}>
      <ArrowLeft size={16} aria-hidden="true" />+{slug}
    </a>
  );
  const d = state.digest;
  if (!d)
    return (
      <div class="roadmap-view">
        {back}
        {state.error ? (
          <div class="empty">
            <h2>Can’t show this digest.</h2>
            <p class="muted">{state.error}</p>
          </div>
        ) : (
          <p class="muted" aria-busy="true">
            Loading the digest…
          </p>
        )}
      </div>
    );
  return (
    <div class="roadmap-view dg-page">
      {back}
      <div class="view-intro">
        <p class="fr-kicker">
          <span class="fr-slug">+{d.feature}</span> · {d.kind === 'final' ? 'last digest' : 'digest'} · {day(d.from)}{' '}
          {clock(d.from)} to {clock(d.to)}
        </p>
        <h1>
          <Title text={d.title} />
        </h1>
        <p class="muted">{d.ended ?? `${d.summary}.`}</p>
      </div>
      {d.ended && <p class="muted">When it ended: {d.summary}.</p>}

      {d.captain && (
        <section class="gh-section" aria-labelledby="dg-captain">
          <h2 id="dg-captain">
            <Megaphone size={18} aria-hidden="true" />
            From the road captain
          </h2>
          <p class="dg-captain">{d.captain.text}</p>
          <p class="meta">
            {d.captain.agent} · {ago(d.captain.at)}
          </p>
        </section>
      )}

      <section class="gh-section" aria-labelledby="dg-waiting">
        <h2 id="dg-waiting">
          <Hand size={18} aria-hidden="true" />
          Waits for you <span class="count">{d.waiting.length}</span>
        </h2>
        {d.waiting.length ? (
          <ol class="dg-items">
            {d.waiting.map((x) => (
              <li key={x.uuid}>
                <TaskRef x={x} /> <Title text={x.description} />
                {x.priority ? <span class="meta"> · {x.priority}</span> : null}
                <p class="meta">
                  {sentence(
                    x.unblocks ? `${x.why}; ${x.unblocks} more wait${x.unblocks === 1 ? 's' : ''} for it` : x.why,
                  )}
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <p class="meta">Nothing waits on you.</p>
        )}
      </section>

      <section class="gh-section" aria-labelledby="dg-merged">
        <h2 id="dg-merged">
          <GitMerge size={18} aria-hidden="true" />
          Merged <span class="count">{d.merged.length}</span>
        </h2>
        {d.merged.length ? (
          <ul class="dg-items">
            {d.merged.map((m) => (
              <li key={`${m.repo}#${m.pr}`}>
                <TaskRef x={m} /> <Title text={m.description} />{' '}
                {m.url ? (
                  <a href={m.url} target="_blank" rel="noopener noreferrer">
                    #{m.pr}
                  </a>
                ) : (
                  <span class="meta">#{m.pr}</span>
                )}
                <span class="meta"> · {clock(m.mergedAt)}</span>
                {m.screenshots.length > 0 && (
                  <ul class="dg-shots" aria-label={`Screenshots in #${m.pr}`}>
                    {m.screenshots.map((s, i) => (
                      <li key={s.url}>
                        <Image size={14} aria-hidden="true" />
                        <a href={s.url} target="_blank" rel="noopener noreferrer">
                          {s.alt || `Screenshot ${i + 1}`}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p class="meta">Nothing merged in this stretch.</p>
        )}
      </section>

      {d.stuck.length > 0 && (
        <section class="gh-section" aria-labelledby="dg-stuck">
          <h2 id="dg-stuck">
            <OctagonAlert size={18} aria-hidden="true" />
            Stuck <span class="count">{d.stuck.length}</span>
          </h2>
          <ul class="dg-items">
            {d.stuck.map((x) => (
              <li key={x.uuid}>
                <TaskRef x={x} /> <Title text={x.description} />
                <p class="meta">{sentence(x.why)}</p>
                {x.last && <p class="meta dg-last">Last: {x.last}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {d.kind !== 'final' && (
        <section class="gh-section" aria-labelledby="dg-next">
          <h2 id="dg-next">
            <StepForward size={18} aria-hidden="true" />
            Next
          </h2>
          {d.next.length ? (
            <ol class="dg-items">
              {d.next.map((x) => (
                <li key={x.uuid}>
                  <TaskRef x={x} /> <Title text={x.description} />
                  <p class="meta">{x.ready ? 'Starts now.' : sentence(x.reason)}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p class="meta">Nothing is ready to start: the rest waits on running work or on you.</p>
          )}
        </section>
      )}
    </div>
  );
}
