import { useEffect, useState } from 'preact/hooks';
import { Bike, CircleAlert, FastForward, Hand, Hourglass, Square } from 'lucide-preact';
import { ago, plural } from '../lib/model.js';
import { actions, agents, byUuid, hashFor } from '../lib/store.js';
import { RepoChip, Segmented, widClass } from './ui.jsx';
import { PelotonPanel } from './Peloton.jsx';
import { Title } from '../lib/richtext.jsx';

/**
 * A feature's chase (docs/specs/IDEA-28-features-and-chase.md, section 3.9): Chase and Stop chase, how many
 * agents may work in one area at once, the live line, the running agents with their live output, Needs you,
 * Stuck, and the next ones in the order they'd start with what holds each, while it's on. The feature page shows
 * it in full; the Agents view shows each chase that's on, `compact`, beside the running agents it already lists.
 * While it's on, its peloton (docs/specs/IDEA-32-peloton.md, section 5) sits under the live line.
 */

const QUEUE_SHOWN = 8;
const upTo = (n) => Array.from({ length: n }, (_, i) => String(i + 1));
const taskHref = (t) => hashFor({ task: t.wid ?? t.uuid });
/** The server's reason as a sentence; one that starts with a name (an agent's, a repository's) keeps its case. */
const sentence = (why) => `${/^(it|no|auto|\d)/u.test(why) ? `${why[0].toUpperCase()}${why.slice(1)}` : why}.`;

/** A stopped or ended chase's peloton keeps its posts a day (docs/specs/IDEA-32-peloton.md, section 2). */
const closedToday = (chase) => !chase.on && chase.endedAt && Date.now() - Date.parse(chase.endedAt) < 86_400_000;

/** What the chase is doing, in one line under its heading. */
function stateLine(chase) {
  if (chase.on) return `${chase.summary ?? 'Working it out'}. Started ${ago(chase.startedAt)}.`;
  if (chase.state === 'stopped')
    return `Stopped ${ago(chase.endedAt)}. Agents it started finish their tasks and open their pull requests.`;
  if (chase.state === 'done') return `Ended ${ago(chase.endedAt)}: every task was done or in review.`;
  return 'Starts an agent on every ready task here and on every task that blocks one, within the board’s limits. It stops at what only you can do.';
}

/** One task in the chase: its work ID, repository, title, and the lines that say where it stands. */
function ChaseRow({ t, children }) {
  const task = byUuid.value.get(t.uuid);
  return (
    <li class="ch-row">
      <a class="ch-row-head" href={taskHref(t)} data-task={t.uuid}>
        <span class={task ? widClass(task) : 'wid'}>{t.wid ?? t.uuid.slice(0, 8)}</span>
        <RepoChip slug={t.repo} />
        <span class="ch-row-title">
          <Title text={t.description} />
        </span>
      </a>
      {t.blocks?.length > 0 && <span class="meta">In the chase because it blocks {t.blocks.join(', ')}.</span>}
      {children}
    </li>
  );
}

/**
 * How many agents may work in one area at once while the chase runs: every agent there counts, not only the
 * chase's. The plan's ceiling is the most; buttons while they fit, a number past that.
 * @param {Record<string, any>} props
 */
function ParallelField({ feature, chase, id, onChange }) {
  const most = Math.max(chase.parallel, agents.value.data?.limits?.agents ?? 6);
  const [value, setValue] = useState(String(chase.parallel));
  useEffect(() => setValue(String(chase.parallel)), [chase.parallel]);
  const set = (v) => {
    const n = Number(v);
    setValue(String(v));
    if (Number.isInteger(n) && n >= 1 && n <= most && n !== chase.parallel)
      actions
        .chase(feature, { parallel: n }, `Up to ${plural(n, 'agent')} at once in an area.`)
        .then(() => onChange?.());
  };
  return (
    <div class="field ch-parallel">
      <span class="field-label" id={`${id}-label`}>
        Agents at once in an area
      </span>
      {most <= 6 ? (
        <Segmented
          label="Agents at once in an area"
          options={upTo(most).map((n) => ({ id: n, label: n }))}
          value={value}
          onChange={set}
        />
      ) : (
        <input
          class="input input-sm launch-count"
          type="number"
          aria-labelledby={`${id}-label`}
          min="1"
          max={most}
          step="1"
          value={value}
          onChange={(e) => set(e.currentTarget.value)}
        />
      )}
      <span class="field-hint">
        Every agent working in the area counts, not only the chase’s. 1 keeps one agent per area, as outside a chase.{' '}
        {chase.on ? 'A change applies on the next check.' : ''}
      </span>
    </div>
  );
}

/** @param {Record<string, any>} props */
function Controls({ feature, chase, open, onChange }) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  useEffect(() => setPreview(null), [chase.on, chase.parallel]);
  const run = async (body, message) => {
    setBusy(true);
    await actions.chase(feature, body, message);
    setBusy(false);
    onChange?.();
  };
  const start = () =>
    run({ on: true }, (r) =>
      r.started.length ? `Chasing. Started ${r.started.join(', ')}.` : 'Chasing. Nothing can start yet.',
    );
  const stop = () => run({ on: false }, 'Chase stopped.');
  const see = async () => setPreview(await actions.chasePreview(feature));
  return (
    <>
      <div class="launch-row">
        {chase.on ? (
          <button type="button" class="btn btn-sm" disabled={busy} aria-busy={busy} onClick={stop}>
            <Square size={15} aria-hidden="true" />
            Stop chase
          </button>
        ) : (
          <>
            <button
              type="button"
              class="btn btn-primary btn-sm"
              disabled={busy || !open}
              aria-busy={busy}
              onClick={start}
            >
              <FastForward size={16} aria-hidden="true" />
              {chase.state === 'off' ? 'Chase' : 'Chase again'}
            </button>
            <button type="button" class="btn btn-outline btn-sm" disabled={!open} onClick={see}>
              See what would start
            </button>
          </>
        )}
      </div>
      {!open && <p class="meta">Nothing left to chase: every task is done.</p>}
      {chase.on && <p class="meta">Stopping starts nothing new. Agents already working finish their tasks.</p>}
      {preview && (
        <div class="plan" aria-live="polite">
          {preview.wouldStart.length ? (
            <p class="small">
              Chase would start {preview.wouldStart.join(', ')} now
              {preview.chase.queue.length > preview.wouldStart.length ? '; the rest wait, below' : ''}.
            </p>
          ) : (
            <p class="muted small">Nothing would start now. What holds each task is below.</p>
          )}
        </div>
      )}
    </>
  );
}

/** The chase's tasks that have an agent on them, with the live output the Agents view shows. */
function Running({ chase }) {
  const runs = new Map((agents.value.data?.running ?? []).map((r) => [r.uuid, r]));
  const list = (chase.tasks ?? []).filter((t) => t.state === 'running');
  if (!list.length) return null;
  return (
    <div class="ch-group">
      <h3>
        Running <span class="count">{list.length}</span>
      </h3>
      <ul class="ch-list">
        {list.map((t) => {
          const r = runs.get(t.uuid);
          return (
            <ChaseRow key={t.uuid} t={t}>
              <span class="meta">
                {r?.live ? (
                  <span class="live-state is-live">
                    <span class="live-dot" aria-hidden="true" />
                    Working
                  </span>
                ) : null}{' '}
                {r ? `${r.agent} · started ${ago(r.startedAt)}` : sentence(t.why ?? 'it’s claimed')}
              </span>
              {r?.lastLine && <code class="agent-last">{r.lastLine}</code>}
            </ChaseRow>
          );
        })}
      </ul>
    </div>
  );
}

function NeedsYou({ chase }) {
  if (!chase.needsYou?.length) return null;
  return (
    <div class="ch-group">
      <h3>
        <Hand size={16} aria-hidden="true" />
        Needs you <span class="count">{chase.needsYou.length}</span>
      </h3>
      <p class="muted small">The chase never does these. It goes on with everything that doesn’t wait for them.</p>
      <ul class="ch-list">
        {chase.needsYou.map((t) => (
          <ChaseRow key={`${t.uuid}-${t.kind}`} t={t}>
            <span class="meta ch-yours">
              {sentence(t.why)}
              {t.unblocks > 0 && ` ${plural(t.unblocks, 'task')} ${t.unblocks === 1 ? 'waits' : 'wait'} for it.`}
            </span>
          </ChaseRow>
        ))}
      </ul>
    </div>
  );
}

function Stuck({ chase }) {
  if (!chase.stuck?.length) return null;
  return (
    <div class="ch-group">
      <h3>
        <CircleAlert size={16} aria-hidden="true" />
        Stuck <span class="count">{chase.stuck.length}</span>
      </h3>
      <p class="muted small">
        The chase stopped trying these. Read the last comment, change the task, then chase again to retry.
      </p>
      <ul class="ch-list">
        {chase.stuck.map((t) => (
          <ChaseRow key={t.uuid} t={t}>
            <span class="meta">{sentence(t.why)}</span>
            {t.last && <span class="ch-last">{t.last}</span>}
          </ChaseRow>
        ))}
      </ul>
    </div>
  );
}

/** The next ones, in the order they'd start, each with what holds it (the auto-start queue's words). */
function Queue({ chase, compact }) {
  const queue = chase.queue ?? [];
  const [all, setAll] = useState(false);
  if (!queue.length) return null;
  const shown = all || !compact ? queue : queue.slice(0, QUEUE_SHOWN);
  return (
    <div class="ch-group">
      <h3>
        <Hourglass size={16} aria-hidden="true" />
        Next to start <span class="count">{queue.length}</span>
      </h3>
      <ol class="ch-list">
        {shown.map((q) => (
          <ChaseRow key={q.uuid} t={q}>
            <span class={`meta ${q.ready ? 'queue-ready' : ''}`}>
              {q.ready ? (chase.on ? 'Starts on the next check.' : 'Would start now.') : `Waits: ${q.reason}.`}
            </span>
          </ChaseRow>
        ))}
      </ol>
      {shown.length < queue.length && (
        <button type="button" class="btn btn-quiet btn-sm" onClick={() => setAll(true)}>
          Show all {queue.length}
        </button>
      )}
    </div>
  );
}

/**
 * The chase on feature `feature` (`{ slug, title }`), from its `chase` view.
 * `onChange` runs after Chase, Stop chase, or a new number of agents, for a view that keeps its own copy.
 * @param {{ feature: { slug: string, title: string }, chase: Record<string, any>, open?: boolean, compact?: boolean, onChange?: () => void }} props
 */
export function ChasePanel({ feature, chase, open = true, compact = false, onChange }) {
  const id = `ch-${feature.slug}`;
  return (
    <div class={`ch-panel ${chase.on ? 'is-on' : ''}`}>
      <p class="ch-line">
        {chase.on && <span class="ch-on">Chasing</span>}
        <span class={chase.on ? '' : 'muted'}>{stateLine(chase)}</span>
      </p>
      {(chase.on || closedToday(chase)) && (
        <div class="ch-group">
          <h3>
            <Bike size={16} aria-hidden="true" />
            Peloton
          </h3>
          <PelotonPanel name={`chase:${feature.slug}`} compact />
        </div>
      )}
      <Controls feature={feature} chase={chase} open={open} onChange={onChange} />
      <ParallelField feature={feature} chase={chase} id={id} onChange={onChange} />
      {chase.on && (
        <>
          {!compact && <Running chase={chase} />}
          <NeedsYou chase={chase} />
          <Stuck chase={chase} />
          <Queue chase={chase} compact={compact} />
        </>
      )}
    </div>
  );
}
