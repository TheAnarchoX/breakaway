import { useEffect, useRef, useState } from 'preact/hooks';
import {
  CalendarClock,
  CirclePause,
  Copy,
  GitMerge,
  Hand,
  History,
  Pencil,
  Play,
  Plus,
  Repeat,
  Webhook,
  X,
} from 'lucide-preact';
import { ago } from '../lib/model.js';
import {
  actions,
  closeRoutine,
  hashFor,
  inScope,
  loadRoutines,
  multiRepo,
  navOrder,
  openRoutine,
  repoName,
  repoScope,
  repos,
  routines,
  selectedRoutine,
} from '../lib/store.js';
import { Dialog, RepoChip, Segmented } from '../components/ui.jsx';
import { RichText } from '../lib/richtext.jsx';

const RUN_TRIGGER = {
  manual: 'by hand',
  schedule: 'on schedule',
  webhook: 'by webhook',
  github: 'by GitHub',
  cloudflare: 'by a Cloudflare alert',
};
const HORIZONS = [
  ['now', 'Now'],
  ['next', 'Next'],
  ['later', 'Later'],
];
const GITHUB_EVENTS = [
  ['pr_merged', 'A pull request is merged'],
  ['release_published', 'A release is published'],
  ['workflow_failed', 'A workflow run fails'],
];

/** Another repository than `slug` for a copy to go to: the one in view, else the first other one. */
function otherRepo(slug) {
  if (repoScope.value && repoScope.value !== slug) return repoScope.value;
  return repos.value.list.find((r) => r.slug !== slug)?.slug ?? slug;
}

/** A short name for a copy of `from` in `repo`: its own with the repository's on the end, or "-copy" in the same one. */
function copySlug(from, repo) {
  const suffix = repo && repo !== from.repo ? repo : 'copy';
  const base = from.slug.endsWith(`-${from.repo}`) ? from.slug.slice(0, -from.repo.length - 1) : from.slug;
  return `${base.slice(0, Math.max(1, 39 - suffix.length))}-${suffix}`.slice(0, 40).replace(/-+$/u, '');
}

/**
 * Adds a routine, edits `routine`, or adds a copy of `from` (WEB-4): the copy's fields start as `from`'s.
 * Its selects mark the chosen option, since Preact doesn't apply defaultValue to a <select>.
 * @param {Record<string, any>} props
 */
function RoutineForm({ routine, from, onDone, id }) {
  const [busy, setBusy] = useState(false);
  const src = routine ?? from;
  const startRepo = routine?.repo ?? (from ? otherRepo(from.repo) : (repoScope.value ?? repos.value.default));
  // A copy's short name follows the repository picked until you type your own.
  const [slug, setSlug] = useState(from ? copySlug(from, startRepo) : '');
  const [slugTyped, setSlugTyped] = useState(false);
  // The Claude plan's ceiling for one routine's runs a day, and a new routine's default (CLD-198).
  const limits = routines.value.data?.settings?.limits;
  const save = async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = {
      name: f.get('name'),
      prompt: f.get('prompt'),
      done_when: f.get('done_when'),
      horizon: f.get('horizon'),
      schedule: String(f.get('schedule') ?? '').trim(),
      dailyCap: Number(f.get('dailyCap')),
      gapMinutes: Number(f.get('gap')),
      triggerStart: f.get('triggerStart'),
      githubEvents: f.getAll('githubEvents'),
    };
    // A routine runs in one repository (CLD-127); with only one registered there's nothing to pick.
    if (multiRepo.value) body.repo = f.get('repo');
    if (!routine) body.slug = f.get('slug');
    setBusy(true);
    const result = await actions.saveRoutine(routine?.slug, body);
    setBusy(false);
    if (result) onDone(routine ? undefined : result.routine?.slug);
  };
  return (
    <form id={id} class="routine-form" onSubmit={save}>
      {!routine && (
        <label class="field">
          <span class="field-label">Short name</span>
          <input
            class="input"
            name="slug"
            required
            pattern="[a-z][a-z0-9\-]{0,39}"
            placeholder="update-changelog"
            value={slug}
            onInput={(e) => {
              setSlug(e.currentTarget.value);
              setSlugTyped(true);
            }}
          />
          <span class="field-hint">Lowercase letters, digits, and hyphens. It can’t change later.</span>
        </label>
      )}
      <label class="field">
        <span class="field-label">Name</span>
        <input class="input" name="name" required maxLength={80} defaultValue={src?.name} />
      </label>
      {multiRepo.value && (
        <label class="field">
          <span class="field-label">Repository</span>
          <select
            class="select"
            name="repo"
            onChange={(e) => {
              if (from && !slugTyped) setSlug(copySlug(from, e.currentTarget.value));
            }}
          >
            {repos.value.list.map((r) => (
              <option key={r.slug} value={r.slug} selected={r.slug === startRepo}>
                {r.name}
              </option>
            ))}
          </select>
          <span class="field-hint">
            Its runs are tasks there, and its agents start through that repository’s routine.
          </span>
        </label>
      )}
      <label class="field">
        <span class="field-label">What the agent should do</span>
        <textarea class="textarea" name="prompt" required rows={8} defaultValue={src?.prompt} />
        <span class="field-hint">
          Every run copies this into its task’s description, so write it as you’d write a task. Agents can’t change it.
        </span>
      </label>
      <label class="field">
        <span class="field-label">Done when</span>
        <textarea class="textarea" name="done_when" rows={3} defaultValue={src?.done_when ?? ''} />
      </label>
      <div class="field-row">
        <label class="field">
          <span class="field-label">Horizon of its tasks</span>
          <select class="select" name="horizon">
            {HORIZONS.map(([v, l]) => (
              <option key={v} value={v} selected={v === (src?.horizon ?? 'now')}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label class="field">
          <span class="field-label">Runs a day, at most</span>
          <input
            class="input"
            name="dailyCap"
            type="number"
            min="1"
            max={limits?.routineDailyCap ?? 50}
            defaultValue={src?.dailyCap ?? limits?.routineDailyDefault ?? 3}
          />
        </label>
        <label class="field">
          <span class="field-label">Minutes between triggered runs</span>
          <input class="input" name="gap" type="number" min="0" max="10080" defaultValue={src?.gapMinutes ?? 60} />
        </label>
      </div>
      <label class="field">
        <span class="field-label">Schedule (UTC, optional)</span>
        <input
          class="input"
          name="schedule"
          maxLength={100}
          placeholder="0 9 * * 1"
          defaultValue={src?.schedule ?? ''}
        />
        <span class="field-hint">
          Five fields: minute hour day-of-month month day-of-week, like “0 9 * * 1” for Mondays at 09:00 UTC. A slot
          that passes while the routine is off, paused, capped, or already running is skipped, not made up.
        </span>
      </label>
      <fieldset class="field">
        <legend class="field-label">Start it when GitHub reports</legend>
        <div class="check-list">
          {GITHUB_EVENTS.map(([key, label]) => (
            <label key={key} class="check-row">
              <input
                type="checkbox"
                name="githubEvents"
                value={key}
                defaultChecked={src?.githubEvents?.includes(key)}
              />
              {label}
            </label>
          ))}
        </div>
        <span class="field-hint">
          {multiRepo.value ? 'Its own repository only.' : 'This repository only.'} The title, number, and link come to
          the run as a comment, never as instructions.
        </span>
      </fieldset>
      <label class="field">
        <span class="field-label">When a webhook, API, or GitHub trigger fires</span>
        <select class="select" name="triggerStart">
          <option value="wait" selected={src?.triggerStart !== 'auto'}>
            Make the task and wait for my Start
          </option>
          <option value="auto" selected={src?.triggerStart === 'auto'}>
            Start the agent by itself
          </option>
        </select>
        <span class="field-hint">
          Either way the run ends in a pull request you merge, and what the trigger sends is only ever a comment on the
          task.
        </span>
      </label>
      <div class="sheet-actions">
        <button type="button" class="btn btn-quiet" onClick={() => onDone()}>
          Cancel
        </button>
        <button type="submit" class="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : routine ? 'Save changes' : from ? 'Add the copy' : 'Add routine'}
        </button>
      </div>
    </form>
  );
}

const utc = (iso) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;
const title = (s) => s[0].toUpperCase() + s.slice(1);

/** What a routine is doing right now, in one word and a tone the row and the panel share. */
function statusOf(r) {
  if (!r.enabled) return { id: 'off', label: 'Off' };
  if (r.openRun) return { id: 'running', label: 'Running' };
  return { id: 'idle', label: 'Ready' };
}

/** @param {Record<string, any>} props */
function Status({ r }) {
  const s = statusOf(r);
  return <span class={`rt-status rt-status-${s.id}`}>{s.label}</span>;
}

/**
 * Runs used of a daily cap, as a small bar with the numbers beside it.
 * @param {Record<string, any>} props
 */
function Meter({ used, cap, label = 'runs today' }) {
  return (
    <span class="rt-meter" role="img" aria-label={`${used} of ${cap} ${label}`}>
      <span class="rt-meter-bar">
        <span class={used >= cap ? 'is-full' : ''} style={`width: ${Math.min(100, (used / cap) * 100)}%`} />
      </span>
      <span class="mono">
        {used}/{cap}
      </span>
    </span>
  );
}

/**
 * Every way a routine can start, as short chips: by hand always, then a schedule, triggers, and GitHub events.
 * @param {Record<string, any>} props
 */
function Starts({ r }) {
  const triggers = r.triggers.length;
  return (
    <ul class="rt-starts" aria-label="How it starts">
      {r.schedule ? (
        <li>
          <CalendarClock size={14} aria-hidden="true" />
          <code>{r.schedule}</code>
          {r.nextRun && <span class="muted">next {utc(r.nextRun).slice(5, 16)}</span>}
        </li>
      ) : (
        <li>
          <Hand size={14} aria-hidden="true" />
          By hand
        </li>
      )}
      {triggers > 0 && (
        <li>
          <Webhook size={14} aria-hidden="true" />
          {triggers} {triggers === 1 ? 'trigger' : 'triggers'}
        </li>
      )}
      {r.githubEvents?.length > 0 && (
        <li>
          <GitMerge size={14} aria-hidden="true" />
          {r.githubEvents.length} GitHub {r.githubEvents.length === 1 ? 'event' : 'events'}
        </li>
      )}
    </ul>
  );
}

/** @param {Record<string, any>} props */
function LastRun({ r }) {
  if (r.openRun)
    return (
      <>
        Running{' '}
        <a href={hashFor({ task: r.openRun.wid })}>
          <span class="wid">{r.openRun.wid}</span>
        </a>
      </>
    );
  if (r.lastRun)
    return (
      <>
        Last run{' '}
        {r.lastRun.wid ? (
          <a href={hashFor({ task: r.lastRun.wid })}>
            <span class="wid">{r.lastRun.wid}</span>
          </a>
        ) : null}{' '}
        {ago(r.lastRun.at)}
      </>
    );
  return 'Never run';
}

/**
 * One routine on the overview: a row with its name and prompt, how it starts, today’s runs, and a Run button.
 * @param {Record<string, any>} props
 */
function RoutineRow({ r, open }) {
  return (
    <li class={`rt-row rt-row-${statusOf(r).id} ${open ? 'is-open' : ''}`}>
      <div class="rt-row-name">
        <div class="rt-row-title">
          <h3>
            <a
              class="rt-row-link"
              data-routine={r.slug}
              aria-current={open ? 'true' : undefined}
              href={hashFor({ view: 'routines', routine: r.slug, task: null })}
            >
              {r.name}
            </a>
          </h3>
          <Status r={r} />
          <RepoChip slug={r.repo} />
        </div>
        <p class="rt-row-prompt muted">{r.prompt.replace(/[*`#]/gu, '').replace(/\s+/gu, ' ')}</p>
        {r.disabledReason && (
          <p class="rt-row-warn small" role="status">
            {r.disabledReason}
          </p>
        )}
      </div>
      <Starts r={r} />
      <div class="rt-row-runs">
        <Meter used={r.runsToday} cap={r.dailyCap} />
        <span class="meta">
          <LastRun r={r} />
        </span>
      </div>
      <button
        type="button"
        class="btn btn-outline btn-sm rt-row-run"
        aria-label={`Run ${r.name} now`}
        disabled={Boolean(r.openRun) || !r.enabled}
        onClick={() => actions.runRoutine(r, '')}
      >
        <Play size={14} aria-hidden="true" />
        Run
      </button>
    </li>
  );
}

/** @param {Record<string, any>} props */
function RunBox({ r }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const blocked = busy || Boolean(r.openRun) || !r.enabled;
  const run = async () => {
    if (blocked) return;
    setBusy(true);
    const result = await actions.runRoutine(r, note.trim(), () => setNote(''));
    setBusy(false);
    if (result) setNote('');
  };
  return (
    <div class="rt-runbox">
      <input
        class="input input-sm"
        aria-label={`A note for this run of ${r.name} (optional)`}
        placeholder="A note for this run (optional)"
        value={note}
        maxLength={2000}
        onInput={(e) => setNote(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') run();
        }}
      />
      <button type="button" class="btn btn-primary btn-sm" disabled={blocked} onClick={run}>
        <Play size={16} aria-hidden="true" />
        {busy ? 'Starting…' : 'Run now'}
      </button>
    </div>
  );
}

/** @param {Record<string, any>} props */
function Triggers({ r }) {
  const [shown, setShown] = useState(null);
  const [label, setLabel] = useState('');
  const add = async () => {
    const res = await actions.addTrigger(r.slug, label.trim());
    if (res) {
      setShown(res);
      setLabel('');
    }
  };
  return (
    <>
      {r.triggers.length > 0 ? (
        <ul class="dep-list">
          {r.triggers.map((t) => (
            <li key={t.id} class="dep-row rt-trigger">
              <Webhook size={16} aria-hidden="true" />
              <span class="rt-trigger-text">
                <strong>{t.label}</strong>
                <span class="meta">
                  made {ago(t.created)} · {t.lastUsed ? `used ${ago(t.lastUsed)}` : 'never used'}
                </span>
              </span>
              <button
                type="button"
                class="btn btn-quiet btn-sm"
                aria-label={`Revoke the trigger ${t.label}`}
                onClick={() => actions.revokeTrigger(r.slug, t.id)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p class="muted small">No triggers yet. A trigger lets a webhook or another service start this routine.</p>
      )}
      {shown && (
        <div class="rt-secret" role="status">
          <p class="small">
            <strong>Copy the secret now.</strong> It isn’t shown again.
          </p>
          <code>{shown.secret}</code>
          <button type="button" class="btn btn-outline btn-sm" onClick={() => setShown(null)}>
            I’ve copied it
          </button>
        </div>
      )}
      <form
        class="dep-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          class="input input-sm"
          aria-label={`A label for the new trigger on ${r.name}`}
          placeholder="Label, like “Cloudflare alerts”"
          value={label}
          maxLength={80}
          onInput={(e) => setLabel(e.currentTarget.value)}
        />
        <button type="submit" class="btn btn-outline btn-sm">
          <Plus size={16} aria-hidden="true" />
          Add a trigger
        </button>
      </form>
      <p class="meta">
        Send <code>POST /api/routines/{r.slug}/fire</code> with <code>Authorization: Bearer &lt;secret&gt;</code> (or an{' '}
        <code>X-Routine-Secret</code> header). Each secret is its own; the board keeps only its hash.
      </p>
    </>
  );
}

/**
 * The routine's prompt, cut to a few lines until you ask for all of it, so the rest of the panel stays in view.
 * @param {Record<string, any>} props
 */
function Prompt({ text }) {
  const box = useRef(null);
  const [long, setLong] = useState(false);
  const [all, setAll] = useState(false);
  useEffect(() => {
    setAll(false);
    const el = box.current;
    if (el) setLong(el.scrollHeight > el.clientHeight + 8);
  }, [text]);
  return (
    <>
      <div ref={box} class={`rt-prompt ${long && !all ? 'is-cut' : ''} ${all ? 'is-all' : ''}`}>
        <RichText text={text} />
      </div>
      {long && (
        <button
          type="button"
          class="btn btn-quiet btn-sm rt-prompt-toggle"
          aria-expanded={all}
          onClick={() => setAll(!all)}
        >
          {all ? 'Show less' : 'Show the whole prompt'}
        </button>
      )}
    </>
  );
}

/** @param {Record<string, any>} props */
function Section({ title: heading, id, children }) {
  return (
    <section class="panel-section" aria-labelledby={id}>
      <h3 id={id}>{heading}</h3>
      {children}
    </section>
  );
}

/** @param {Record<string, any>} props */
function Fact({ label, children }) {
  return (
    <div class="fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** @param {Record<string, any>} props */
function PanelTop({ label, children, onClose }) {
  return (
    <div class="panel-top">
      {label}
      {children}
      <span class="panel-nav">
        <button type="button" class="btn btn-quiet btn-icon btn-sm" aria-label="Close" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </span>
    </div>
  );
}

/** @param {Record<string, any>} props */
function PanelContent({ r, onClose }) {
  const [editing, setEditing] = useState(false);
  const [copying, setCopying] = useState(false);
  const heading = useRef(null);
  useEffect(() => {
    setEditing(false);
    setCopying(false);
    heading.current?.focus({ preventScroll: true });
  }, [r.slug]);
  return (
    <div class="panel-body">
      <PanelTop
        label={
          <span class="wid wid-lg rt-slug">
            <Repeat size={14} aria-hidden="true" />
            {r.slug}
          </span>
        }
        onClose={onClose}
      >
        <Status r={r} />
      </PanelTop>
      <h2 class="rt-panel-title" ref={heading} tabIndex={-1}>
        {r.name}
      </h2>
      {r.disabledReason && <p class="claim-line claim-line-stale">Switched off: {r.disabledReason}.</p>}
      {editing ? (
        <Section title="Edit routine" id="rt-edit">
          <RoutineForm routine={r} onDone={() => setEditing(false)} />
        </Section>
      ) : (
        <>
          <div class="panel-actions-row">
            <div class="panel-actions">
              <button type="button" class="btn btn-outline btn-sm" onClick={() => setEditing(true)}>
                <Pencil size={16} aria-hidden="true" />
                Edit
              </button>
              <button
                type="button"
                class="btn btn-outline btn-sm"
                aria-label={multiRepo.value ? `Copy ${r.name} to another repository` : `Copy ${r.name}`}
                onClick={() => setCopying(true)}
              >
                <Copy size={16} aria-hidden="true" />
                Copy
              </button>
            </div>
            <Segmented
              label={`${r.name} is`}
              options={[
                { id: 'on', label: 'On' },
                { id: 'off', label: 'Off' },
              ]}
              value={r.enabled ? 'on' : 'off'}
              onChange={(v) => actions.saveRoutine(r.slug, { enabled: v === 'on' })}
            />
          </div>
          <Section title="Run it" id="rt-run">
            <RunBox r={r} />
            {r.openRun && (
              <p class="meta">
                Running as{' '}
                <a href={hashFor({ task: r.openRun.wid })}>
                  <span class="wid">{r.openRun.wid}</span>
                </a>
                . A routine has one run open at a time.
              </p>
            )}
          </Section>
          <Section title="What the agent does" id="rt-prompt">
            <Prompt text={r.prompt} />
            <p class="meta">Every run copies this into its task’s description.</p>
          </Section>
          {r.done_when && (
            <Section title="Done when" id="rt-done">
              <RichText text={r.done_when} />
            </Section>
          )}
          <dl class="facts">
            <Fact label="Schedule">
              {r.schedule ? (
                <>
                  <code>{r.schedule}</code> UTC
                </>
              ) : (
                <span class="muted">By hand or a trigger</span>
              )}
            </Fact>
            {r.schedule && (
              <Fact label="Next run">
                {r.nextRun ? (
                  <time dateTime={r.nextRun}>{utc(r.nextRun)}</time>
                ) : (
                  <span class="muted">Not while it’s off or paused</span>
                )}
              </Fact>
            )}
            <Fact label="Runs today">
              <Meter used={r.runsToday} cap={r.dailyCap} label="runs in the last day" />
            </Fact>
            <Fact label="Gap">{r.gapMinutes} min between triggered runs</Fact>
            <Fact label="Triggered runs">
              {r.triggerStart === 'auto' ? 'Start the agent by itself' : 'Wait for your Start'}
            </Fact>
            <Fact label="GitHub">
              {r.githubEvents?.length ? (
                GITHUB_EVENTS.filter(([k]) => r.githubEvents.includes(k))
                  .map(([, l]) => l)
                  .join('; ')
              ) : (
                <span class="muted">No events</span>
              )}
            </Fact>
            <Fact label="Tasks go to">{title(r.horizon)}</Fact>
          </dl>
          <Section title="Webhook and API triggers" id="rt-triggers">
            <Triggers r={r} />
          </Section>
          <Section title="Recent runs" id="rt-runs">
            {r.recentRuns.length ? (
              <ul class="dep-list">
                {r.recentRuns.map((run) => (
                  <li key={`${run.wid}-${run.at}`} class="dep-row rt-run">
                    {run.wid ? (
                      <a href={hashFor({ task: run.wid })}>
                        <span class="wid">{run.wid}</span>
                      </a>
                    ) : (
                      <span class="muted">Not made</span>
                    )}
                    <span class="meta">
                      {run.failed ? 'didn’t start' : run.status === 'completed' ? 'finished' : 'open'} ·{' '}
                      {RUN_TRIGGER[run.trigger] ?? run.trigger} · {ago(run.at)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p class="muted small">Never run.</p>
            )}
          </Section>
          <p class="panel-meta meta">
            Added {ago(r.created)} · last edited by {r.editedBy} {ago(r.editedAt)}
          </p>
        </>
      )}
      <Dialog open={copying} onClose={() => setCopying(false)} labelledBy="rt-copy-title">
        <div class="sheet">
          <h2 id="rt-copy-title">Copy “{r.name}”</h2>
          <p class="muted small">
            {multiRepo.value ? 'Pick the repository it runs in. ' : ''}Its triggers and runs stay with this routine.
          </p>
          {copying && (
            <RoutineForm
              from={r}
              onDone={(slug) => {
                setCopying(false);
                if (slug) openRoutine(slug);
              }}
            />
          )}
        </div>
      </Dialog>
    </div>
  );
}

/**
 * The open routine, beside the overview on wide screens and a full sheet on small ones, like a task.
 * @param {Record<string, any>} props
 */
export function RoutinePanel({ docked }) {
  const slug = selectedRoutine.value;
  const d = routines.value.data;
  if (!slug || !d) return null;
  const r = d.routines.find((x) => x.slug === slug);
  const onClose = () => {
    const link = document.querySelector(`[data-routine="${slug}"]`);
    closeRoutine();
    requestAnimationFrame(() => /** @type {HTMLElement | null} */ (link)?.focus());
  };
  return (
    <aside class={`panel ${docked ? 'panel-docked' : 'panel-sheet'}`} aria-label={r ? `Routine ${r.name}` : 'Routine'}>
      {r ? (
        <PanelContent r={r} onClose={onClose} />
      ) : (
        <div class="panel-body">
          <PanelTop label={<span class="wid wid-lg">{slug}</span>} onClose={onClose} />
          <p class="muted">There’s no routine {slug}. It may have been deleted, or the link is off.</p>
        </div>
      )}
    </aside>
  );
}

/**
 * Whether routines may run at all, and how much of the day’s budget they’ve used.
 * @param {Record<string, any>} props
 */
function RunningCard({ d, running }) {
  const s = d.settings;
  // The cap for all routines together, up to the Claude plan's ceiling (CLD-199; the plan's from CLD-198).
  const most = s.limits?.dailyCap ?? 100;
  const setCap = (e) => {
    const n = Number(e.currentTarget.value);
    if (Number.isInteger(n) && n >= 1 && n <= most) actions.routineSettings({ dailyCap: n });
  };
  return (
    <section class="gh-section" aria-labelledby="rt-can-run">
      <div class="section-head">
        <h2 id="rt-can-run">Routines can run</h2>
        <Segmented
          label="Routines can run"
          options={[
            { id: 'on', label: 'On' },
            { id: 'off', label: 'Paused', icon: <CirclePause size={14} aria-hidden="true" /> },
          ]}
          value={s.paused ? 'off' : 'on'}
          onChange={(v) => actions.routineSettings({ paused: v === 'off' })}
        />
      </div>
      <dl class="rt-stats">
        <div>
          <dt>Routines</dt>
          <dd>{d.routines.length}</dd>
        </div>
        <div>
          <dt>Running</dt>
          <dd>{running}</dd>
        </div>
        <div>
          <dt>Runs today</dt>
          <dd>
            {s.runsToday}
            <span class="muted">/{s.dailyCap}</span>
          </dd>
        </div>
      </dl>
      <label class="field">
        <span class="field-label">All routines a day</span>
        <input
          class="input input-sm rt-cap"
          type="number"
          min="1"
          max={most}
          step="1"
          defaultValue={s.dailyCap}
          key={s.dailyCap}
          onChange={setCap}
        />
        <span class="field-hint">
          Most runs all routines start together in 24 hours, 1 to {most} on your Claude plan. Each routine also has its
          own cap.
        </span>
      </label>
      <p class="meta">
        {s.paused
          ? 'Paused: no schedule, trigger, or Run starts anything until you switch it back on.'
          : 'Every run uses your Claude subscription and waits for a free agent slot.'}
      </p>
    </section>
  );
}

/** @param {Record<string, any>} props */
function RecentRuns({ d }) {
  const runs = d.routines
    .flatMap((r) => r.recentRuns.map((run) => ({ ...run, routine: r })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 8);
  return (
    <section class="gh-section" aria-labelledby="rt-recent">
      <h2 id="rt-recent">
        <History size={18} aria-hidden="true" />
        Recent runs
      </h2>
      {runs.length ? (
        <ul class="queue-list">
          {runs.map((run) => (
            <li key={`${run.routine.slug}-${run.at}`}>
              <span>
                {run.wid ? (
                  <a href={hashFor({ task: run.wid })}>
                    <span class="wid">{run.wid}</span>
                  </a>
                ) : (
                  <span class="muted">Not made</span>
                )}{' '}
                <a href={hashFor({ view: 'routines', routine: run.routine.slug, task: null })}>{run.routine.name}</a>
              </span>
              <span class="meta">
                {run.failed ? 'didn’t start' : run.status === 'completed' ? 'finished' : 'open'} ·{' '}
                {RUN_TRIGGER[run.trigger] ?? run.trigger} · {ago(run.at)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p class="muted small">Nothing has run yet.</p>
      )}
    </section>
  );
}

export function RoutinesView() {
  const state = routines.value;
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    navOrder.value = [];
    loadRoutines();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') loadRoutines();
    }, 10000);
    return () => clearInterval(id);
  }, []);
  // A routine runs in one repository (IDEA-14 section 4, CLD-127).
  const d = state.data && { ...state.data, routines: state.data.routines.filter((r) => inScope(r.repo)) };
  const running = d ? d.routines.filter((r) => r.openRun).length : 0;
  return (
    <div class="routines-view">
      <div class="gh-intro">
        <div class="view-intro">
          <h1>Routines</h1>
          <p class="muted">
            Saved prompts that start an agent, by hand, on a schedule, or from a webhook. Each run is a task you can
            follow.
          </p>
        </div>
        <button type="button" class="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
          <Plus size={16} aria-hidden="true" />
          New routine
        </button>
      </div>
      {state.error && (
        <p class="field-error" role="alert">
          {state.error}
        </p>
      )}
      {d && (
        <div class="rt-layout">
          <section class="gh-section" aria-labelledby="rt-list">
            <h2 id="rt-list">
              <Repeat size={18} aria-hidden="true" />
              Routines <span class="count">{d.routines.length}</span>
            </h2>
            {d.routines.length ? (
              <ul class="rt-rows">
                {d.routines.map((r) => (
                  <RoutineRow key={r.slug} r={r} open={r.slug === selectedRoutine.value} />
                ))}
              </ul>
            ) : repoScope.value && state.data.routines.length ? (
              <p class="muted small">
                No routines run in {repoName(repoScope.value)} yet. Switch to every repository to see the others.
              </p>
            ) : (
              <p class="muted small">
                No routines yet. Make one with New routine: a prompt the board can start as a task, by hand, on a
                schedule, or from a trigger.
              </p>
            )}
          </section>
          <div class="gh-col">
            <RunningCard d={d} running={running} />
            <RecentRuns d={d} />
          </div>
        </div>
      )}
      <Dialog open={adding} onClose={() => setAdding(false)} labelledBy="rt-new-title">
        <div class="sheet">
          <h2 id="rt-new-title">New routine</h2>
          {adding && (
            <RoutineForm
              onDone={(slug) => {
                setAdding(false);
                if (slug) openRoutine(slug);
              }}
            />
          )}
        </div>
      </Dialog>
    </div>
  );
}
