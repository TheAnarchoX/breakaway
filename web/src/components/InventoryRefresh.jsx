import { useEffect, useState } from 'preact/hooks';
import { RefreshCw } from 'lucide-preact';
import { ago } from '../lib/model.js';
import { api, sentence } from '../lib/api.js';

/**
 * When the board last looked at what runs, and Refresh to look now (BRK-248). The cron looks at each connected
 * provider every 15 minutes, and pasting a token looks at once; Refresh is the owner's, from the signed-in browser.
 * On an environment's page it looks at that environment's provider; on Infrastructure, at every connected one. Until
 * a provider is connected it shows nothing: the page already points at Connections.
 */

/**
 * The provider rows that matter here, and the latest look among them.
 * @param {any[]} providers GET /api/infra/inventory/refresh's providers
 * @param {string | null} provider one provider, or null for every connected one
 */
export function lastLook(providers, provider) {
  const rows = providers.filter((p) => p.connected && (provider ? p.provider === provider : p.targets > 0));
  const looked = rows.filter((p) => p.last).sort((a, b) => Date.parse(b.last.at) - Date.parse(a.last.at));
  const failed = looked.filter((p) => !p.last.ok);
  return {
    rows,
    at: looked[0]?.last.at ?? null,
    running: rows.some((p) => p.running),
    errors: failed.map((p) => p.last.error ?? `The board couldn’t look at ${p.name}.`),
  };
}

/** @param {{ provider?: string | null, onDone?: () => void }} props */
export function InventoryRefresh({ provider = null, onDone }) {
  const [providers, setProviders] = useState(/** @type {any[] | null} */ (null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  useEffect(() => {
    api('infra/inventory/refresh').then(
      (d) => setProviders(d.providers),
      () => setProviders([]),
    );
  }, [provider]);
  const look = lastLook(providers ?? [], provider);
  if (providers === null || !look.rows.length) return null;
  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const d = await api('infra/inventory/refresh', {
        method: 'POST',
        body: provider ? { provider, by: 'owner' } : { by: 'owner' },
      });
      setProviders(d.providers);
      onDone?.();
    } catch (err) {
      setError(sentence(err.message));
      api('infra/inventory/refresh').then(
        (d) => setProviders(d.providers),
        () => {},
      );
    } finally {
      setBusy(false);
    }
  };
  const errors = error ? [error] : look.errors;
  return (
    <div class="infra-refresh">
      <div class="infra-refresh-row">
        <span class="meta">
          {look.at ? (
            <>
              Last looked{' '}
              <time dateTime={look.at} title={new Date(look.at).toLocaleString()}>
                {ago(look.at)}
              </time>
            </>
          ) : (
            'Not looked yet'
          )}
        </span>
        <button
          type="button"
          class="btn btn-outline btn-sm"
          onClick={refresh}
          disabled={busy || look.running}
          aria-busy={busy || look.running}
        >
          <RefreshCw size={16} aria-hidden="true" class={busy || look.running ? 'spin' : ''} />
          {busy || look.running ? 'Looking…' : 'Refresh'}
        </button>
      </div>
      {errors.map((text) => (
        <p key={text} class="field-error infra-refresh-error" role="alert">
          {sentence(text)}
        </p>
      ))}
    </div>
  );
}
