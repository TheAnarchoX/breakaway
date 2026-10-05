import { useState } from 'preact/hooks';
import { ArrowRight, Sparkles } from 'lucide-preact';
import { ref } from '../lib/model.js';
import { actions, agents, openTask, tasks } from '../lib/store.js';
import { RefineDialog } from './RefineSpec.jsx';

/*
 * Refine a feature with an agent (BRK-150): the owner says what to refine, and a general agent brings the feature's
 * tasks in line, adds the ones it still needs, and asks what only the owner can choose. The board writes its prompt
 * from the feature and its tasks; the owner's request goes in it, in their words.
 */

/** The title the board gives a refine task: with the feature's tag, it marks the open one. */
const TITLE = 'Refine the feature: ';

/** The open general task refining feature `slug`, or null. */
function refiningFeature(list, slug) {
  return (
    (list ?? []).find(
      (t) =>
        t.status === 'pending' &&
        t.tags?.includes('general') &&
        t.tags.includes(slug) &&
        t.description?.startsWith(TITLE),
    ) ?? null
  );
}

/**
 * On a feature's page: Refine with an agent, or a link to the agent already on it.
 * @param {{ feature: { slug: string, title: string } }} props
 */
export function RefineFeature({ feature }) {
  const [open, setOpen] = useState(false);
  const on = refiningFeature(tasks.value, feature.slug);
  if (on)
    return (
      <p class="meta refine-answers-link">
        <Sparkles size={14} aria-hidden="true" /> An agent is refining it:{' '}
        <button type="button" class="linkish" onClick={() => openTask(on)}>
          {ref(on)}
          <ArrowRight size={13} aria-hidden="true" />
        </button>
      </p>
    );
  // Until the board says, nothing: a button that turns off a moment later is worse than one that shows late.
  if (!agents.value.loaded) return null;
  return (
    <>
      <button type="button" class="btn btn-outline btn-sm" onClick={() => setOpen(true)}>
        <Sparkles size={15} aria-hidden="true" />
        Refine with an agent
      </button>
      <RefineDialog
        id={`refine-feature-${feature.slug}`}
        title={feature.title}
        what="this feature"
        lead="An agent refines the feature’s tasks as you ask, adds the ones it still needs with its tag, and asks you what only you can choose."
        load={() => actions.previewFeature(feature.slug)}
        start={(note, force) => actions.startGeneral({ feature: feature.slug, note, force })}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
