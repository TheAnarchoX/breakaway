import { useState } from 'preact/hooks';
import { Undo2 } from 'lucide-preact';
import { ago, plural } from '../lib/model.js';
import { actions } from '../lib/store.js';

/**
 * Agents' changes to the plan (BRK-274): a feature's release, title, or brief, a release pulled into now or next, and
 * another task's horizon, priority, tags, dependencies, area, description, or done when. Each one says who changed
 * what, from what to what, and the owner undoes it with one press, in Activity and on the feature's page.
 */

const PRIORITY = { H: 'high', M: 'medium', L: 'low' };

/** One value in words: none for empty, a priority by its name. */
function value(field, v) {
  if (v === null || v === undefined || v === '') return 'none';
  if (field === 'priority') return PRIORITY[v] ?? v;
  if (field === 'title') return `“${v}”`;
  return v;
}

/** One field's change in words: `release none → 2.1.0`, `tags +studio −old`, `description rewritten`. */
function fieldWords(c) {
  if (c.added)
    return `${c.name} ${[...c.added.map((x) => `+${x}`), ...c.removed.map((x) => `−${x}`)].join(' ')}`.trim();
  if (c.field === 'brief' || c.field === 'done_when')
    return `${c.name} ${c.before ? (c.after ? 'rewritten' : 'cleared') : 'written'}`;
  return `${c.name} ${value(c.field, c.before)} → ${value(c.field, c.after)}`;
}

/** What an agent changed, in one line. `withTarget` names the feature (the task is shown beside it in Activity). */
export function planningWords(c, { withTarget = true } = {}) {
  const who = c.agent ?? c.by ?? 'An agent';
  if (c.kind === 'pull' || c.of === 'pull')
    return `${who} pulled ${c.release} into ${c.into}: ${plural(c.tasks?.length ?? 0, 'task')} moved`;
  const what = (c.changes ?? []).map(fieldWords).join(', ');
  if (c.target) return `${who} changed ${withTarget ? `+${c.target.slug}` : 'the feature'}: ${what}`;
  if (!withTarget && c.task) return `${who} changed ${c.task.wid ?? 'a task'}: ${what}`;
  return `${who} changed ${what}`;
}

/** Undo, the owner's press; once it's done, when it was undone. */
export function UndoChange({ change }) {
  const [busy, setBusy] = useState(false);
  if (change.undone) return <span class="meta agent-change-undone">Undone {ago(change.undone.at)}</span>;
  const press = async () => {
    setBusy(true);
    await actions.undoPlanning(change.id);
    setBusy(false);
  };
  return (
    <button type="button" class="btn btn-quiet btn-sm agent-change-undo" disabled={busy} onClick={press}>
      <Undo2 size={14} aria-hidden="true" />
      {busy ? 'Undoing…' : 'Undo'}
    </button>
  );
}

/** The feature page's list of agents' changes to its plan, newest first. Nothing when there are none. */
export function FeaturePlanning({ f }) {
  if (!f.planning?.length) return null;
  return (
    <section class="gh-section" aria-labelledby="fr-planning-title">
      <h2 id="fr-planning-title">Agents’ changes</h2>
      <p class="muted small">What agents changed in this feature’s plan. Undo puts one back as it was.</p>
      <ul class="agent-changes">
        {f.planning.map((c) => (
          <li key={c.id} class={`agent-change ${c.undone ? 'is-undone' : ''}`}>
            <span>
              {planningWords(c, { withTarget: false })} <span class="meta">· {ago(c.at)}</span>
            </span>
            <UndoChange change={c} />
          </li>
        ))}
      </ul>
    </section>
  );
}
