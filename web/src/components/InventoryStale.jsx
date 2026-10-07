import { TriangleAlert } from 'lucide-preact';
import { ago } from '../lib/model.js';
import { sentence } from '../lib/api.js';

/**
 * Whether an environment's inventory is up to date (BRK-257). Each environment's discovery stands on its own: one that
 * fails keeps what the board last saw there, out of date, with what the provider said, until a discovery works again.
 */

/** @param {{ iso: string | null | undefined }} props */
function When({ iso }) {
  if (!iso) return null;
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {ago(iso)}
    </time>
  );
}

/**
 * The status band's line: when the board last looked, or, when it couldn't, since when what it shows is out of date,
 * and why.
 * @param {{ stale: any, seen: string | null }} props `stale` from GET /api/infra/inventory's `stale`; `seen` the latest resource's
 */
export function InventoryFreshness({ stale, seen }) {
  if (stale)
    return (
      <span class="band-value inventory-stale">
        Out of date{' '}
        <span class="meta">
          {stale.seen ? (
            <>
              as of <When iso={stale.seen} />
            </>
          ) : (
            'never looked at yet'
          )}
        </span>
        <span class="meta inventory-stale-why">{sentence(stale.error)}</span>
      </span>
    );
  return seen ? (
    <span class="band-value">
      Up to date{' '}
      <span class="meta">
        looked <When iso={seen} />
      </span>
    </span>
  ) : (
    <span class="band-value muted">Not looked at yet</span>
  );
}

/** An Infrastructure card's line when its environment's inventory is out of date. @param {{ stale: any }} props */
export function StaleLine({ stale }) {
  if (!stale) return null;
  return (
    <p class="meta inventory-stale-line" title={sentence(stale.error)}>
      <TriangleAlert size={14} aria-hidden="true" />
      <span>Out of date: {sentence(stale.error)}</span>
    </p>
  );
}
