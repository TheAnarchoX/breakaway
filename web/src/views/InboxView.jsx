import { useEffect, useState } from 'preact/hooks';
import { Check, CircleCheck, FastForward, Inbox, Plug, TriangleAlert, X } from 'lucide-preact';
import { api, enc } from '../lib/api.js';
import { HORIZONS, NOTICE_LABEL, PING_KIND_LABEL as KIND_LABEL, ago } from '../lib/model.js';
import {
  dismissInboxItem,
  focusPing,
  hashFor,
  loadPings,
  loadTasks,
  navOrder,
  pings,
  repoName,
  repoScope,
  scopedPings,
  toast,
} from '../lib/store.js';
import { Title } from '../lib/richtext.jsx';
import { Dialog, RepoChip, Dictate } from '../components/ui.jsx';

const link = (wid) => (
  <a class="wid" href={hashFor({ task: wid })}>
    {wid}
  </a>
);
const list = (items) =>
  items.map((x, i) => (
    <span key={x}>
      {i ? ', ' : ''}
      {link(x)}
    </span>
  ));

/**
 * One change as the owner reads it: what applying it would do.
 * @param {Record<string, any>} props
 */
function Describe({ change: c }) {
  if (c.type === 'add') {
    return (
      <>
        <strong>Add a task:</strong> {c.title}
        <span class="meta">
          {' '}
          · {c.project}, {c.horizon}, +{c.tags.join(' +')}
        </span>
        {c.depends.length > 0 && <span class="meta"> · waits for {c.depends.join(', ')}</span>}
      </>
    );
  }
  if (c.type === 'depend') {
    return (
      <>
        {link(c.task)}
        {c.add.length > 0 && (
          <>
            {' '}
            <strong>now waits for</strong> {list(c.add)}
          </>
        )}
        {c.add.length > 0 && c.remove.length > 0 && '; '}
        {c.remove.length > 0 && (
          <>
            {' '}
            <strong>no longer waits for</strong> {list(c.remove)}
          </>
        )}
      </>
    );
  }
  if (c.type === 'modify') {
    const parts = [];
    if (c.horizon) parts.push(`horizon to ${c.horizon}`);
    if (c.addTags) parts.push(`add +${c.addTags.join(' +')}`);
    if (c.removeTags) parts.push(`remove +${c.removeTags.join(' +')}`);
    if (c.brief) parts.push('rewrite the description');
    if (c.done_when) parts.push('rewrite done when');
    return (
      <>
        <strong>Edit</strong> {link(c.task)}: {parts.join(', ')}
      </>
    );
  }
  if (c.type === 'done')
    return (
      <>
        <strong>Finish</strong> {link(c.task)}
        {c.note && <span class="meta"> · “{c.note}”</span>}
      </>
    );
  return (
    <>
      <strong>Release the claim on</strong> {link(c.task)}
    </>
  );
}

/** @param {Record<string, any>} props */
function ApplyDialog({ ping, onClose }) {
  const proposal = ping.proposal;
  const [chosen, setChosen] = useState(() => new Set(proposal.map((_, i) => i)));
  const [edits, setEdits] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const edit = (i, field, value) => setEdits({ ...edits, [i]: { ...edits[i], [field]: value } });
  const toggle = (i) => {
    const next = new Set(chosen);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setChosen(next);
  };
  const apply = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const numbers = [...chosen].sort((a, b) => a - b);
    const sent = {};
    for (const i of numbers) {
      const changed = Object.fromEntries(Object.entries(edits[i] ?? {}).filter(([k, v]) => v !== proposal[i][k]));
      if (Object.keys(changed).length) sent[i] = changed;
    }
    try {
      const { created } = await api(`pings/${enc(ping.id)}/apply`, {
        method: 'POST',
        body: { chosen: numbers, edits: sent },
      });
      toast(created.length ? `Applied. Added ${created.join(', ')}.` : 'Applied.', 'success');
      onClose();
      await Promise.all([loadPings(), loadTasks()]);
    } catch (err) {
      setError(err.message);
      if (err.status === 409) loadPings();
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="sheet apply-sheet" onSubmit={apply}>
      <h2 id="apply-title">Apply {ping.task}’s proposal</h2>
      <p class="muted small">
        Untick what you don’t want. Everything is checked again against the board as it is now, and if any of it no
        longer holds, nothing changes.
      </p>
      {ping.warnings.length > 0 && (
        <ul class="apply-warnings">
          {ping.warnings.map((w) => (
            <li key={w}>
              <TriangleAlert size={15} aria-hidden="true" />
              {w}
            </li>
          ))}
        </ul>
      )}
      <ol class="changes-list">
        {proposal.map((c, i) => (
          <li key={i} class={chosen.has(i) ? '' : 'is-off'}>
            <label class="check-row">
              <input type="checkbox" checked={chosen.has(i)} onChange={() => toggle(i)} />
              <span>
                <span class="visually-hidden">
                  {chosen.has(i) ? 'Include' : 'Skip'} change {i + 1}:{' '}
                </span>
                <Describe change={c} />
              </span>
            </label>
            {c.type === 'add' && chosen.has(i) && (
              <details class="change-edit">
                <summary>Edit this task before adding it</summary>
                <label class="field">
                  <span class="field-label">Title</span>
                  <input
                    class="input input-sm"
                    value={edits[i]?.title ?? c.title}
                    onInput={(e) => edit(i, 'title', e.currentTarget.value)}
                  />
                </label>
                <label class="field">
                  <span class="field-label">Horizon</span>
                  <select
                    class="select select-sm"
                    value={edits[i]?.horizon ?? c.horizon}
                    onChange={(e) => edit(i, 'horizon', e.currentTarget.value)}
                  >
                    {HORIZONS.filter((h) => ['now', 'next', 'later'].includes(h.id)).map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label class="field">
                  <span class="field-label">Description</span>
                  <Dictate>
                    <textarea
                      class="input"
                      rows={3}
                      value={edits[i]?.brief ?? c.brief}
                      onInput={(e) => edit(i, 'brief', e.currentTarget.value)}
                    />
                  </Dictate>
                </label>
                <label class="field">
                  <span class="field-label">Done when</span>
                  <Dictate>
                    <textarea
                      class="input"
                      rows={2}
                      value={edits[i]?.done_when ?? c.done_when}
                      onInput={(e) => edit(i, 'done_when', e.currentTarget.value)}
                    />
                  </Dictate>
                </label>
              </details>
            )}
          </li>
        ))}
      </ol>
      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
      <div class="sheet-actions">
        <button type="button" class="btn btn-quiet btn-sm" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="submit" class="btn btn-primary btn-sm" disabled={busy || !chosen.size}>
          {busy
            ? 'Applying…'
            : chosen.size === proposal.length
              ? 'Apply all'
              : `Apply ${chosen.size} of ${proposal.length}`}
        </button>
      </div>
    </form>
  );
}

/** @param {Record<string, any>} props */
function PingCard({ ping, focused, onApply }) {
  const [busy, setBusy] = useState(false);
  const handled = async () => {
    setBusy(true);
    try {
      await api(`pings/${enc(ping.id)}/handled`, { method: 'POST', body: {} });
      toast('Marked handled.', 'success');
      await loadPings();
    } catch (error) {
      toast(error.message, 'error');
      loadPings();
    } finally {
      setBusy(false);
    }
  };
  const dismiss = async () => {
    setBusy(true);
    await dismissInboxItem('ping', ping);
    setBusy(false);
  };
  const label = `${ping.task} ${KIND_LABEL[ping.kind] ?? ping.kind}`;
  return (
    <li class={`ping ${focused ? 'is-focus' : ''}`} id={`ping-${ping.id}`}>
      <article aria-label={label} tabIndex={focused ? -1 : undefined}>
        <header class="ping-head">
          <span class={`ping-kind ping-${ping.kind}`}>{KIND_LABEL[ping.kind] ?? ping.kind}</span>
          <a class="event-task" href={hashFor({ task: ping.task ?? ping.taskUuid.slice(0, 8) })}>
            <span class="wid">{ping.task ?? ping.taskUuid.slice(0, 8)}</span>
            <RepoChip slug={ping.repo} />
            <Title text={ping.taskTitle} />
          </a>
          <span class="meta">
            {ping.by}, <time dateTime={ping.at}>{ago(ping.at)}</time>
          </span>
        </header>
        <p class="ping-message">{ping.message}</p>
        {ping.proposal && (
          <div class="ping-proposal">
            <h3 class="kicker">Proposal</h3>
            <ul class="changes-list">
              {ping.proposal.map((c, i) => (
                <li key={i}>
                  <Describe change={c} />
                </li>
              ))}
            </ul>
            {ping.warnings.map((w) => (
              <p key={w} class="foot-warn small">
                <TriangleAlert size={14} aria-hidden="true" /> {w}
              </p>
            ))}
          </div>
        )}
        <div class="ping-actions">
          {ping.proposal && (
            <button type="button" class="btn btn-primary btn-sm" disabled={busy} onClick={onApply}>
              <Check size={16} aria-hidden="true" />
              Review and apply<span class="visually-hidden"> {ping.task}’s proposal</span>
            </button>
          )}
          {!ping.proposal && (
            <button type="button" class="btn btn-primary btn-sm" disabled={busy} onClick={handled}>
              <CircleCheck size={16} aria-hidden="true" />
              Handled<span class="visually-hidden"> {ping.task}</span>
            </button>
          )}
          <button type="button" class="btn btn-quiet btn-sm" disabled={busy} onClick={dismiss}>
            <X size={16} aria-hidden="true" />
            Dismiss<span class="visually-hidden"> {ping.task}</span>
          </button>
        </div>
      </article>
    </li>
  );
}

/**
 * A note about a connection that broke or works again (CLD-121): an fyi, no push, cleared here.
 * @param {Record<string, any>} props
 */
function NoticeCard({ notice: x }) {
  const [busy, setBusy] = useState(false);
  const dismiss = async () => {
    setBusy(true);
    await dismissInboxItem('notice', x);
    setBusy(false);
  };
  const label = `${NOTICE_LABEL[x.kind]}: ${x.name}`;
  return (
    <li class="ping notice">
      <article aria-label={label}>
        <header class="ping-head">
          <span class={`ping-kind ${x.kind === 'broke' ? 'ping-stale' : 'ping-done'}`}>{NOTICE_LABEL[x.kind]}</span>
          <a class="event-task" href={hashFor({ view: 'connections', task: null, pr: null, ping: null })}>
            <Plug size={15} aria-hidden="true" /> {x.name}
          </a>
          <span class="meta">
            <time dateTime={x.at}>{ago(x.at)}</time>
          </span>
        </header>
        {x.detail && <p class="ping-message">{x.detail}</p>}
        <div class="ping-actions">
          {x.kind === 'broke' && (
            <a class="btn btn-primary btn-sm" href={hashFor({ view: 'connections', task: null, pr: null, ping: null })}>
              See how to fix it
            </a>
          )}
          <button type="button" class="btn btn-quiet btn-sm" disabled={busy} onClick={dismiss}>
            <X size={16} aria-hidden="true" />
            Dismiss<span class="visually-hidden"> {label}</span>
          </button>
        </div>
      </article>
    </li>
  );
}

/**
 * A note that a chase ended (docs/specs/IDEA-28-features-and-chase.md, section 3.7): no push, cleared here.
 * @param {Record<string, any>} props
 */
function ChaseCard({ chase: x }) {
  const [busy, setBusy] = useState(false);
  const dismiss = async () => {
    setBusy(true);
    await dismissInboxItem('chase', x);
    setBusy(false);
  };
  const label = `Chase ended: ${x.title}`;
  const feature = hashFor({ view: 'roadmap', feature: x.feature, task: null, pr: null, ping: null });
  return (
    <li class="ping notice">
      <article aria-label={label}>
        <header class="ping-head">
          <span class="ping-kind ping-done">Chase ended</span>
          <a class="event-task" href={feature}>
            <FastForward size={15} aria-hidden="true" /> {x.title}
          </a>
          <span class="meta">
            <time dateTime={x.at}>{ago(x.at)}</time>
          </span>
        </header>
        {x.detail && <p class="ping-message">{x.detail}</p>}
        <div class="ping-actions">
          <a class="btn btn-primary btn-sm" href={feature}>
            Open the feature<span class="visually-hidden"> {x.title}</span>
          </a>
          <button type="button" class="btn btn-quiet btn-sm" disabled={busy} onClick={dismiss}>
            <X size={16} aria-hidden="true" />
            Dismiss<span class="visually-hidden"> {label}</span>
          </button>
        </div>
      </article>
    </li>
  );
}

export function InboxView() {
  const state = pings.value;
  const [applying, setApplying] = useState(null);
  const focus = focusPing.value;
  useEffect(() => {
    navOrder.value = [];
    loadPings();
  }, []);
  // Opened at one ping (from the bell or a push): bring it into view and put focus on it.
  useEffect(() => {
    if (!focus || !state.loaded) return;
    const item = document.getElementById(`ping-${focus}`);
    item?.scrollIntoView({ block: 'center' });
    item?.querySelector('article')?.focus({ preventScroll: true });
  }, [focus, state.loaded]);
  const target = state.list.find((p) => p.id === applying);
  // The switcher's pings; the notes about connections are the whole board's.
  // A ping opened by its link (a push, the bell) shows whichever repository it's in.
  const list = state.list.filter((p) => scopedPings.value.includes(p) || String(p.id) === focus);
  const elsewhere = state.list.length - list.length;
  return (
    <div class="inbox-view">
      <div class="view-intro">
        <h1>Inbox</h1>
        <p class="muted">
          Agents ping you when only you can help: something to decide, a task that looks done, or one that can’t be
          reproduced. Applying a proposal is yours alone; agents only suggest. The board also notes here when a
          connection stops working, when it works again, and when a chase ends.
        </p>
      </div>
      {state.error && (
        <p class="field-error" role="alert">
          {state.error}
        </p>
      )}
      {!state.loaded && !state.error && (
        <p class="muted" aria-busy="true">
          Loading the inbox…
        </p>
      )}
      {state.loaded && !list.length && !state.notices.length && !state.chases.length && !state.error && (
        <div class="empty">
          <Inbox size={28} aria-hidden="true" />
          <h2>Nothing needs you</h2>
          <p class="muted">When an agent gets stuck or finds a task is already done, it shows here.</p>
        </div>
      )}
      {state.notices.length > 0 && (
        <section class="inbox-notices" aria-labelledby="notices-title">
          <h2 id="notices-title" class="kicker">
            Connections
          </h2>
          <ol class="pings">
            {state.notices.map((x) => (
              <NoticeCard key={x.id} notice={x} />
            ))}
          </ol>
        </section>
      )}
      {state.chases.length > 0 && (
        <section class="inbox-notices" aria-labelledby="chases-title">
          <h2 id="chases-title" class="kicker">
            Chases
          </h2>
          <ol class="pings">
            {state.chases.map((x) => (
              <ChaseCard key={x.id} chase={x} />
            ))}
          </ol>
        </section>
      )}
      {(state.notices.length > 0 || state.chases.length > 0) && list.length > 0 && (
        <h2 class="kicker inbox-pings-title">Pings</h2>
      )}
      <ol class="pings" aria-label="Open pings">
        {list.map((p) => (
          <PingCard key={p.id} ping={p} focused={String(p.id) === focus} onApply={() => setApplying(p.id)} />
        ))}
      </ol>
      {elsewhere > 0 && repoScope.value && (
        <p class="muted small inbox-elsewhere">
          {elsewhere === 1
            ? '1 more ping is in another repository'
            : `${elsewhere} more pings are in other repositories`}
          . Switch from {repoName(repoScope.value)} to every repository to see {elsewhere === 1 ? 'it' : 'them'}.
        </p>
      )}
      <Dialog
        open={Boolean(target)}
        onClose={() => setApplying(null)}
        labelledBy="apply-title"
        className="dialog-apply"
      >
        {target && <ApplyDialog ping={target} onClose={() => setApplying(null)} />}
      </Dialog>
    </div>
  );
}
