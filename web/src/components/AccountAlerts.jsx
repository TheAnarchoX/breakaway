import { useEffect, useState } from 'preact/hooks';
import { TriangleAlert } from 'lucide-preact';
import { ago } from '../lib/model.js';
import { api, enc } from '../lib/api.js';
import { connections } from '../lib/store.js';

/**
 * A provider's account-wide alerts (BRK-255): alerts that name no environment's Worker or zone, like a platform
 * incident or a billing alert. The board keeps each one once, from GET /api/infra/account-alerts, instead of copying it
 * into every environment's stream. One collapsed line per provider; opening it lists them. Nothing shows when there
 * are none. `source` narrows it to one provider (an environment's page passes its own); `reload` reads them again
 * when it changes.
 * @param {{ source?: string, reload?: unknown }} props
 */
export function AccountAlerts({ source, reload }) {
  const [alerts, setAlerts] = useState(/** @type {any[]} */ ([]));
  useEffect(() => {
    let live = true;
    api(`infra/account-alerts?limit=50${source ? `&source=${enc(source)}` : ''}`).then(
      (data) => live && setAlerts(data.alerts ?? []),
      // An extra: the page shows without it.
      () => live && setAlerts([]),
    );
    return () => {
      live = false;
    };
  }, [source, reload]);
  if (!alerts.length) return null;
  const bySource = new Map();
  for (const a of alerts) bySource.set(a.source, [...(bySource.get(a.source) ?? []), a]);
  const nameOf = (/** @type {string} */ id) =>
    (connections.value.data?.connections ?? []).find((c) => c.id === `provider.${id}`)?.name ?? id;
  return (
    <>
      {[...bySource].map(([id, list]) => (
        <details key={id} class="infra-account">
          <summary>
            <TriangleAlert size={15} aria-hidden="true" />
            <span>
              {list.length === 1 ? '1 alert' : `${list.length} alerts`} about the whole {nameOf(id)} account, the latest{' '}
              {ago(list[0].at)}
            </span>
          </summary>
          <p class="muted">
            They name no environment’s Worker or zone, so the board keeps each one here once, not in every environment’s
            stream. Kept a week.
          </p>
          <ul>
            {list.map((a) => (
              <li key={a.id}>
                <span>{a.text}</span>
                <time class="muted" dateTime={a.at} title={new Date(a.at).toLocaleString()}>
                  {ago(a.at)}
                </time>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </>
  );
}
