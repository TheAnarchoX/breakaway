import { TriangleAlert } from 'lucide-preact';
import { sentence } from '../lib/api.js';

/**
 * Whether an environment's inventory is up to date (BRK-257). Each environment's discovery stands on its own: one that
 * fails keeps what the board last saw there, out of date, with what the provider said, until a discovery works again.
 */

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
