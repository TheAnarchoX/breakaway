import { useEffect, useState } from 'preact/hooks';
import { Check, CircleCheck, FastForward, Inbox, Plug, Siren, TriangleAlert, X } from 'lucide-preact';
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
import { IncidentWhere, stepNote } from '../components/Incidents.jsx';

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
 * One change as the owner reads it: what applying it would do. `bare` leaves out what its group's heading
 * already says (an added task's "Add a task:").
 * @param {Record<string, any>} props
 */
function Describe({ change: c, bare = false }) {
  if (c.type === 'add') {
    return (
      <>
        {!bare && <strong>Add a task: </strong>}
        {c.title}
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
  if (c.type === 'delete')
    return (
      <>
        <strong>Delete</strong> {link(c.task)}
        {c.note && <span class="meta"> · “{c.note}”</span>}
      </>
    );
  return (
    <>
      <strong>Release the claim on</strong> {link(c.task)}
    </>
  );
}

/**
 * The kinds of change, in the order a proposal reads best, with each group's heading (BRK-261).
 * @type {[string, (n: number) => string][]}
 */
const CHANGE_GROUPS = [
  ['add', (n) => (n === 1 ? 'Add a task' : `Add ${n} tasks`)],
  ['depend', (n) => (n === 1 ? 'Change a dependency' : `Change ${n} dependencies`)],
  ['modify', (n) => (n === 1 ? 'Edit a task' : `Edit ${n} tasks`)],
  ['done', (n) => (n === 1 ? 'Finish a task' : `Finish ${n} tasks`)],
  ['delete', (n) => (n === 1 ? 'Delete a task' : `Delete ${n} tasks`)],
  ['release', (n) => (n === 1 ? 'Release a claim' : `Release ${n} claims`)],
];
/** A proposal this short reads as one plain list; a longer one is grouped by kind. */
const FLAT_UP_TO = 3;
/** How many changes a group shows on the inbox card before the rest fold away. */
const CARD_SHOWN = 3;

/**
 * A proposal's changes grouped by kind, each keeping its number in the proposal (which apply sends back). A short
 * one is a single group with no heading.
 * @param {any[]} proposal
 * @returns {{ type: string, heading: string | null, items: { c: any, i: number }[] }[]}
 */
const groupChanges = (proposal) =>
  proposal.length <= FLAT_UP_TO
    ? [{ type: 'all', heading: null, items: proposal.map((c, i) => ({ c, i })) }]
    : CHANGE_GROUPS.map(([type, heading]) => {
        const items = proposal.flatMap((c, i) => (c.type === type ? [{ c, i }] : []));
        return { type, heading: heading(items.length), items };
      }).filter((g) => g.items.length);

/**
 * A proposal on the inbox card: grouped by kind, a long group folded after its first few (BRK-261).
 * @param {{ proposal: any[] }} props
 */
function ProposalSummary({ proposal }) {
  return groupChanges(proposal).map((g) => (
    <section key={g.type} class="changes-group">
      {g.heading && <h4 class="changes-group-title">{g.heading}</h4>}
      <ul class="changes-list">
        {g.items.slice(0, CARD_SHOWN).map(({ c, i }) => (
          <li key={i}>
            <Describe change={c} bare={Boolean(g.heading)} />
          </li>
        ))}
      </ul>
      {g.items.length > CARD_SHOWN && (
        <details class="changes-more">
          <summary>Show {g.items.length - CARD_SHOWN} more</summary>
          <ul class="changes-list">
            {g.items.slice(CARD_SHOWN).map(({ c, i }) => (
              <li key={i}>
                <Describe change={c} bare />
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  ));
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
  const toggleAll = (numbers, include) => {
    const next = new Set(chosen);
    for (const i of numbers) {
      if (include) next.add(i);
      else next.delete(i);
    }
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
      {groupChanges(proposal).map((g) => {
        const on = g.items.filter(({ i }) => chosen.has(i)).length;
        return (
          <section key={g.type} class="changes-group">
            {g.heading && (
              <div class="changes-group-head">
                <h3 class="changes-group-title">{g.heading}</h3>
                {g.items.length > 1 && (
                  <button
                    type="button"
                    class="btn btn-quiet btn-sm"
                    onClick={() =>
                      toggleAll(
                        g.items.map(({ i }) => i),
                        on < g.items.length,
                      )
                    }
                  >
                    {on < g.items.length ? 'Include all' : 'Skip all'}
                    <span class="visually-hidden"> ({g.heading})</span>
                  </button>
                )}
              </div>
            )}
            <ol class="changes-list">
              {g.items.map(({ c, i }) => (
                <li key={i} class={chosen.has(i) ? '' : 'is-off'}>
                  <label class="check-row">
                    <input type="checkbox" checked={chosen.has(i)} onChange={() => toggle(i)} />
                    <span>
                      <span class="visually-hidden">
                        {chosen.has(i) ? 'Include' : 'Skip'} change {i + 1}:{' '}
                      </span>
                      <Describe change={c} bare={Boolean(g.heading)} />
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
          </section>
        );
      })}
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

/**
 * An incident ping's line (WEB-63): where it is, the step it's on, and whether it pushed. `incident` is the open
 * incident behind the ping, when the board has it.
 * @param {{ ping: any, incident: any }} props
 */
function IncidentLine({ ping, incident }) {
  const note = incident && stepNote(incident);
  return (
    <p class="meta incident-ping-line">
      <Siren size={14} aria-hidden="true" />
      {incident && (
        <span>
          In <IncidentWhere incident={incident} />
        </span>
      )}
      {note && <span>{note}</span>}
      <span>{ping.push ? 'Pushed to your phone' : 'In the inbox only, not pushed'}</span>
    </p>
  );
}

/** @param {Record<string, any>} props */
function PingCard({ ping, focused, onApply, incident = null }) {
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
        {ping.kind === 'incident' && <IncidentLine ping={ping} incident={incident} />}
        {ping.proposal && (
          <div class="ping-proposal">
            <h3 class="kicker">Proposal{ping.proposal.length > 1 ? `: ${ping.proposal.length} changes` : ''}</h3>
            <ProposalSummary proposal={ping.proposal} />
            {ping.warnings.map((w) => (
              <p key={w} class="foot-warn small">
                <TriangleAlert size={14} aria-hidden="true" /> {w}
              </p>
            ))}
          </div>
        )}
        <div class="ping-actions">
          {ping.kind === 'incident' && (
            <a class="btn btn-primary btn-sm" href={hashFor({ task: ping.task ?? ping.taskUuid.slice(0, 8) })}>
              Open the incident<span class="visually-hidden"> {ping.task}</span>
            </a>
          )}
          {ping.proposal && (
            <button type="button" class="btn btn-primary btn-sm" disabled={busy} onClick={onApply}>
              <Check size={16} aria-hidden="true" />
              Review and apply<span class="visually-hidden"> {ping.task}’s proposal</span>
            </button>
          )}
          {!ping.proposal && (
            <button
              type="button"
              class={`btn ${ping.kind === 'incident' ? 'btn-quiet' : 'btn-primary'} btn-sm`}
              disabled={busy}
              onClick={handled}
            >
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
  // The open incidents behind incident pings (WEB-63), by their task: where each is and the step it's on.
  const [incidents, setIncidents] = useState(/** @type {Map<string, any>} */ (new Map()));
  const focus = focusPing.value;
  useEffect(() => {
    navOrder.value = [];
    loadPings();
    // A board without Architect has no incidents: the pings still show, without the line's extras.
    api('infra/incidents?open=true&limit=200').then(
      ({ incidents: open }) => setIncidents(new Map(open.filter((i) => i.task).map((i) => [i.task.uuid, i]))),
      () => {},
    );
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
  // Incidents first, production's before the rest, then newest: what needs you reads first.
  const production = (/** @type {any} */ p) => incidents.get(p.taskUuid)?.environmentKind === 'production' || p.push;
  const incidentPings = list
    .filter((p) => p.kind === 'incident')
    .sort((a, b) => Number(production(b)) - Number(production(a)) || b.id - a.id);
  const others = list.filter((p) => p.kind !== 'incident');
  return (
    <div class="inbox-view">
      <div class="view-intro">
        <h1>Inbox</h1>
        <p class="muted">
          Agents ping you when only you can help: something to decide, a task that looks done, or one that can’t be
          reproduced. Applying a proposal is yours alone; agents only suggest. The board also notes here when a signal
          opens an incident, when a connection stops working or works again, and when a chase ends.
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
      {incidentPings.length > 0 && (
        <section class="inbox-notices" aria-labelledby="incidents-title">
          <h2 id="incidents-title" class="kicker">
            Incidents
          </h2>
          <ol class="pings">
            {incidentPings.map((p) => (
              <PingCard
                key={p.id}
                ping={p}
                focused={String(p.id) === focus}
                onApply={() => setApplying(p.id)}
                incident={incidents.get(p.taskUuid) ?? null}
              />
            ))}
          </ol>
        </section>
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
      {(state.notices.length > 0 || state.chases.length > 0 || incidentPings.length > 0) && others.length > 0 && (
        <h2 class="kicker inbox-pings-title">Pings</h2>
      )}
      <ol class="pings" aria-label="Open pings">
        {others.map((p) => (
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
