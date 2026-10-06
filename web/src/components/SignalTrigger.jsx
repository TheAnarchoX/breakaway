import { useEffect, useState } from 'preact/hooks';
import { Activity, Pencil, Plus } from 'lucide-preact';
import { api, enc } from '../lib/api.js';
import { actions, confirmDialog } from '../lib/store.js';
import { Segmented } from './ui.jsx';

/**
 * A routine's signal trigger (WEB-89, on BRK-196's PUT/DELETE /api/infra/runbooks/<slug>): which signals start it,
 * whether it's on, and whether a match starts the agent or waits for the owner's Start. Only the owner sets one, from
 * the signed-in board; a new one is off and waits.
 */

/** Signal kinds and levels, as src/infra-provider.js has them, in the brand's words. */
export const SIGNAL_KINDS = [
  ['health', 'Health'],
  ['alert', 'A platform’s alert'],
  ['cost', 'Cost'],
];
const LEVELS = [
  ['info', 'Info and up'],
  ['warning', 'Warning and up'],
  ['critical', 'Critical only'],
];

const any = (list, what) => (list.length ? list.join(', ') : `Any ${what}`);
const kindWords = (kinds) =>
  kinds.length
    ? SIGNAL_KINDS.filter(([k]) => kinds.includes(k))
        .map(([, l]) => l)
        .join(', ')
    : 'Any kind';

/** A comma-separated list, as the server takes it, trimmed and lowercased. */
const listOf = (text) =>
  String(text ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

/**
 * Pick from what the board knows (checkboxes), or type when it knows nothing yet. What's already set stays on offer
 * even when the board no longer sees it, so saving never drops it silently.
 * @param {{ name: string, legend: string, known: string[] | null, chosen: string[], hint: string,
 *   placeholder: string }} props
 */
function Choices({ name, legend, known, chosen, hint, placeholder }) {
  const options = [...new Set([...(known ?? []), ...chosen])].sort();
  if (!options.length)
    return (
      <label class="field">
        <span class="field-label">{legend}</span>
        <input class="input" name={name} maxLength={600} placeholder={placeholder} defaultValue={chosen.join(', ')} />
        <span class="field-hint">Separate them with commas. {hint}</span>
      </label>
    );
  return (
    <fieldset class="field">
      <legend class="field-label">{legend}</legend>
      <div class="check-list">
        {options.map((v) => (
          <label key={v} class="check-row">
            <input type="checkbox" name={name} value={v} defaultChecked={chosen.includes(v)} />
            {v}
          </label>
        ))}
      </div>
      <span class="field-hint">{hint}</span>
    </fieldset>
  );
}

/**
 * The environments of the routine's repository and the resource kinds seen in them, to pick from. Null while loading;
 * empty lists when the board has none or can't say (Architect isn't set up yet), and the form falls back to typing.
 */
function useKnown(repo) {
  const [known, setKnown] = useState(/** @type {{ environments: string[], kinds: string[] } | null} */ (null));
  useEffect(() => {
    let live = true;
    Promise.all([
      api('infra/environments').catch(() => ({ environments: [] })),
      api(`infra/inventory?repo=${enc(repo)}`).catch(() => ({ resources: [] })),
    ]).then(([{ environments }, { resources }]) => {
      if (!live) return;
      setKnown({
        environments: [
          ...new Set(
            (environments ?? []).filter((e) => e.repo === repo && e.kind !== 'short-lived').map((e) => e.name),
          ),
        ],
        kinds: [...new Set((resources ?? []).map((r) => r.kind).filter(Boolean))],
      });
    });
    return () => {
      live = false;
    };
  }, [repo]);
  return known;
}

/** @param {{ r: Record<string, any>, onDone: () => void }} props */
function SignalTriggerForm({ r, onDone }) {
  const t = r.signal;
  const known = useKnown(r.repo);
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const picked = (name) => f.getAll(name).flatMap((v) => listOf(v));
    const body = {
      environments: picked('environments'),
      resourceKinds: picked('resourceKinds'),
      kinds: f.getAll('kinds'),
      level: f.get('level'),
      start: f.get('start'),
      on: f.get('on') === 'on',
    };
    setBusy(true);
    const result = await actions.saveSignalTrigger(r.slug, body, t ? 'Signal trigger saved.' : 'Signal trigger added.');
    setBusy(false);
    if (result) onDone();
  };
  if (!known) return <p class="muted small">Loading environments…</p>;
  return (
    <form class="routine-form" onSubmit={save}>
      <fieldset class="field">
        <legend class="field-label">Signals that start it</legend>
        <div class="check-list">
          {SIGNAL_KINDS.map(([k, l]) => (
            <label key={k} class="check-row">
              <input type="checkbox" name="kinds" value={k} defaultChecked={t?.kinds.includes(k)} />
              {l}
            </label>
          ))}
        </div>
        <span class="field-hint">None ticked: any kind.</span>
      </fieldset>
      <label class="field">
        <span class="field-label">Lowest level</span>
        <select class="select" name="level">
          {LEVELS.map(([v, l]) => (
            <option key={v} value={v} selected={v === (t?.level ?? 'critical')}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <Choices
        name="environments"
        legend="Environments"
        known={known.environments}
        chosen={t?.environments ?? []}
        placeholder="production, staging"
        hint="None: any environment of this routine’s repository."
      />
      <Choices
        name="resourceKinds"
        legend="Resource kinds"
        known={known.kinds}
        chosen={t?.resourceKinds ?? []}
        placeholder="worker, database"
        hint="None: any resource, and signals about no resource in particular."
      />
      <label class="field">
        <span class="field-label">When a signal matches</span>
        <select class="select" name="start">
          <option value="wait" selected={t?.start !== 'auto'}>
            Make the task and wait for my Start
          </option>
          <option value="auto" selected={t?.start === 'auto'}>
            Start the agent by itself
          </option>
        </select>
        <span class="field-hint">
          The agent only reads and proposes: it never changes infrastructure. The same signal starts nothing again for a
          day, and the routine’s runs a day and gap still apply.
        </span>
      </label>
      <label class="check-row">
        <input type="checkbox" name="on" defaultChecked={t?.on ?? false} />
        Turn it on
      </label>
      <div class="sheet-actions">
        <button type="button" class="btn btn-quiet" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" class="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : t ? 'Save changes' : 'Add signal trigger'}
        </button>
      </div>
    </form>
  );
}

/**
 * The routine page's section: what its signal trigger listens for, on or off, and Edit and Remove.
 * @param {{ r: Record<string, any> }} props
 */
export function SignalTrigger({ r }) {
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [r.slug]);
  const t = r.signal;
  if (editing) return <SignalTriggerForm r={r} onDone={() => setEditing(false)} />;
  if (!t)
    return (
      <>
        <p class="muted small">
          No signal trigger. One starts this routine when the board hears something about an environment: its health, a
          platform’s alert, or its cost.
        </p>
        <button type="button" class="btn btn-outline btn-sm" onClick={() => setEditing(true)}>
          <Plus size={16} aria-hidden="true" />
          Add a signal trigger
        </button>
      </>
    );
  const remove = async () => {
    const ok = await confirmDialog({
      title: `Remove the signal trigger from ${r.name}?`,
      body: 'Signals stop starting this routine. Its runs so far stay, and you can add a trigger again later.',
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (ok) actions.removeSignalTrigger(r.slug);
  };
  return (
    <>
      <div class="panel-actions-row">
        <div class="panel-actions">
          <button type="button" class="btn btn-outline btn-sm" onClick={() => setEditing(true)}>
            <Pencil size={16} aria-hidden="true" />
            Edit
          </button>
          <button type="button" class="btn btn-quiet btn-sm" onClick={remove}>
            Remove
          </button>
        </div>
        <Segmented
          label="The signal trigger is"
          options={[
            { id: 'on', label: 'On' },
            { id: 'off', label: 'Off' },
          ]}
          value={t.on ? 'on' : 'off'}
          onChange={(v) =>
            actions.saveSignalTrigger(
              r.slug,
              { on: v === 'on' },
              v === 'on' ? 'Signal trigger on.' : 'Signal trigger off.',
            )
          }
        />
      </div>
      <dl class="facts">
        <div class="fact">
          <dt>Signals</dt>
          <dd>{kindWords(t.kinds)}</dd>
        </div>
        <div class="fact">
          <dt>Level</dt>
          <dd>{LEVELS.find(([v]) => v === t.level)?.[1] ?? t.level}</dd>
        </div>
        <div class="fact">
          <dt>Environments</dt>
          <dd>{any(t.environments, 'environment')}</dd>
        </div>
        <div class="fact">
          <dt>Resource kinds</dt>
          <dd>{any(t.resourceKinds, 'resource')}</dd>
        </div>
        <div class="fact">
          <dt>A match</dt>
          <dd>{t.start === 'auto' ? 'Starts the agent by itself' : 'Waits for your Start'}</dd>
        </div>
      </dl>
      {!t.on && <p class="meta">Off: no signal starts this routine until you turn it on.</p>}
    </>
  );
}

/**
 * The routine card's chip for its signal trigger.
 * @param {{ t: Record<string, any> }} props
 */
export function SignalChip({ t }) {
  return (
    <li>
      <Activity size={14} aria-hidden="true" />
      Signals
      {!t.on && <span class="muted">off</span>}
    </li>
  );
}
