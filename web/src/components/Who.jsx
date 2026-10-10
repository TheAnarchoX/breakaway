// Who does a task, on the web (WEB-133, docs/specs/BRK-299-people-and-roles.md, section 11): an agent, a person (its
// assignee, or any member of its repository), or a decision. The chip on cards and rows, and the task panel's control,
// which only someone who may change the task can use (task.write in src/permissions.js, as the Worker checks it).
import { useEffect } from 'preact/hooks';
import { UserRound } from 'lucide-preact';
import { WHO } from '../lib/model.js';
import { actions, repos } from '../lib/store.js';
import { assignable, ensurePeople, may, personName, whoCan } from '../lib/people.js';

const slugOf = (t) => t.repo || repos.value.default;

/**
 * Who a person's task is for, on a card or a row: "For you", "For Ana", or "Any member"; "Nobody yet" for an open task
 * nobody has said who does. Nothing for an agent's task (most of the board) or a decision (its column says so).
 * @param {Record<string, any>} props
 */
export function WhoChip({ task: t }) {
  useEffect(ensurePeople, []);
  if (t.status !== 'pending') return null;
  if (t.who === 'person') {
    const words = t.assignee ? `For ${personName(t.assignee)}` : 'Any member';
    const title = t.assignee ? `A person’s task, for ${personName(t.assignee)}` : 'A person’s task: any member does it';
    return (
      <span class="who-chip" title={title}>
        <UserRound size={13} aria-hidden="true" />
        {words}
      </span>
    );
  }
  if (!t.who)
    return (
      <span class="who-chip who-none" title="Nobody has said who does it, so nothing starts on it">
        Nobody yet
      </span>
    );
  return null;
}

/**
 * The task panel's Who does it: agent, person, or decision (pressing the one that's on clears it), and on a person's
 * task, who it's for. Someone who can't change the task sees it, with who can.
 * @param {Record<string, any>} props
 */
export function WhoField({ task: t }) {
  useEffect(ensurePeople, []);
  const slug = slugOf(t);
  const no = may('task.write', slug) ? null : whoCan('task.write', slug, { what: 'change who does it' });
  const options = t.who === 'person' ? assignable(slug, t.assignee) : [];
  return (
    <div class="who-field">
      <div class="segmented segmented-sm" role="group" aria-label="Who does it">
        {WHO.map((w) => {
          const on = t.who === w.id;
          return (
            <button
              key={w.id}
              type="button"
              aria-pressed={on}
              title={no ?? w.hint}
              disabled={Boolean(no)}
              onClick={() => actions.update(t, { who: on ? null : w.id }, null)}
            >
              {w.label}
            </button>
          );
        })}
      </div>
      {!t.who && <span class="meta">Nobody yet: nothing starts on it until someone says.</span>}
      {t.who === 'person' && (
        <label class="inline-select">
          <span>For</span>
          <select
            class="select select-sm"
            value={t.assignee ?? ''}
            disabled={Boolean(no)}
            title={no ?? undefined}
            onChange={(e) => actions.update(t, { assignee: e.currentTarget.value || null }, null)}
          >
            <option value="">Any member</option>
            {options.map((o) => (
              <option key={o.handle} value={o.handle}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {no && <span class="meta">{no}</span>}
    </div>
  );
}
