import { UserRoundX } from 'lucide-preact';
import { ago, day } from '../lib/model.js';
import { enc } from '../lib/api.js';

/**
 * What nobody owns on an environment's page (WEB-93; docs/specs/IDEA-19-architect.md, "Clean up"): what runs in its
 * scope that its desired state doesn't declare and no task owns, as BRK-201 flags it on the environment's view
 * (`unowned`). Each shows when it was flagged and when the board proposes removing it, then the removal plan it waits
 * on, or that the owner kept it by rejecting that plan.
 */

/** A removal plan's state (brand/README.md, "Infrastructure words"). */
const PLAN_STATE = {
  draft: 'Draft',
  waiting: 'Waiting for you',
  approved: 'Approved',
  rejected: 'Rejected',
  applying: 'Applying',
  applied: 'Applied',
  failed: 'Failed',
  'rolled back': 'Rolled back',
};

/** A plan's page (WEB-62), under its environment: the same address a waiting plan's push links to. */
const planHref = (/** @type {number} */ envId, /** @type {string} */ plan) =>
  `#/infrastructure/${enc(envId)}?plan=${enc(plan)}`;

/** @param {{ iso: string }} props */
function When({ iso }) {
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {ago(iso)}
    </time>
  );
}

/** Where a flag stands: proposed for removal, kept, or still in its grace period. */
function Standing({ r, env, now }) {
  if (r.kept)
    return (
      <p class="meta">
        Kept: you rejected its removal, so the board doesn’t propose it again. Add it to the desired state to stop
        flagging it.
      </p>
    );
  if (r.plan)
    return (
      <p class="meta">
        {'Removal plan '}
        <a href={planHref(env.id, r.plan.id)}>
          <code>{r.plan.id}</code>
        </a>
        {r.plan.state && (
          <span class={`unowned-plan unowned-plan-${r.plan.state.replace(' ', '-')}`}>
            {' · '}
            {PLAN_STATE[r.plan.state] ?? r.plan.state}
          </span>
        )}
      </p>
    );
  if (r.error) return null;
  if (env.frozen)
    return <p class="meta">{env.name} is frozen, so the board proposes no removal until you unfreeze it.</p>;
  return (
    <p class="meta">
      {Date.parse(r.removeAfter) > now
        ? `The board proposes removing it on ${day(r.removeAfter)}, in a plan that waits for you.`
        : 'Its week is up: the board proposes removing it on its next check, in a plan that waits for you.'}
    </p>
  );
}

/** @param {{ env: { id: number, name: string, frozen?: boolean, observeOnly?: boolean, unowned?: any[] } }} props */
export function UnownedSection({ env }) {
  const unowned = env.unowned ?? [];
  if (env.observeOnly && !unowned.length) return null;
  const now = Date.now();
  const file = `.github/breakaway-infra/${env.name}.json`;
  return (
    <section class="infra-section" aria-labelledby="infra-unowned">
      <h2 id="infra-unowned">
        <UserRoundX size={18} aria-hidden="true" />
        Nobody owns {unowned.length > 0 && <span class="count">{unowned.length}</span>}
      </h2>
      {unowned.length ? (
        <>
          <p class="muted">
            These run here, but <code>{file}</code> doesn’t declare them and no task owns them. A week after it flags
            one, the board proposes a plan to remove it, which waits for you. To keep one, add it to that file by pull
            request.
          </p>
          <ul class="infra-res-list">
            {unowned.map((r) => (
              <li key={r.id} class="infra-res unowned">
                <div class="infra-res-head">
                  <h4 class="infra-res-name">{r.name}</h4>
                  <span class="meta">{r.kind}</span>
                </div>
                <p class="meta infra-res-id">
                  <code>{r.id}</code>
                  {' · flagged '}
                  <When iso={r.flagged} />
                </p>
                <Standing r={r} env={env} now={now} />
                {r.error && (
                  <p class="field-error" role="alert">
                    {r.error.charAt(0).toUpperCase()}
                    {r.error.slice(1)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p class="muted">
          Nothing flagged. What runs here that the desired state doesn’t declare and no task owns shows here, and a week
          later the board proposes removing it.
        </p>
      )}
    </section>
  );
}
