import { useEffect, useState } from 'preact/hooks';
import { api } from '../lib/api.js';
import { toast } from '../lib/store.js';
import { PROVIDER_CURRENCY, checkCurrency, rateWords, rateOf } from '../../../src/infra-currency.js';

const COMMON = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'SEK', 'NOK', 'DKK', 'PLN', 'INR', 'BRL'];

/** A currency's name the way the browser says it: "Euro". */
function nameOf(code) {
  try {
    return new Intl.DisplayNames(undefined, { type: 'currency' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * The board's currency (BRK-226): one for the whole board, with a rate the owner sets. Platforms price in US dollars,
 * so every estimate, the cost limit, and each budget read in this currency at this rate. The board never fetches a
 * rate.
 */
export function CurrencySettings() {
  const [saved, setSaved] = useState(/** @type {any} */ (null));
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [draft, setDraft] = useState({ currency: '', rate: '' });
  const [problem, setProblem] = useState(/** @type {string | null} */ (null));
  const [busy, setBusy] = useState(false);

  const take = (c) => {
    setSaved(c);
    setDraft({ currency: c.currency, rate: c.currency === PROVIDER_CURRENCY ? '' : String(c.rate) });
  };
  useEffect(() => {
    api('infra/currency')
      .then((d) => take(d.currency))
      .catch((e) => setError(e.message));
  }, []);

  if (error && !saved)
    return (
      <p class="field-error" role="alert">
        Couldn’t load the currency: {error}
      </p>
    );
  if (!saved)
    return (
      <p class="muted" aria-busy="true">
        Loading…
      </p>
    );

  const code = draft.currency.trim().toUpperCase();
  const dollars = code === PROVIDER_CURRENCY;
  const dirty = code !== saved.currency || (!dollars && draft.rate.trim() !== String(saved.rate));
  const current = rateOf(saved);

  const save = async (e) => {
    e.preventDefault();
    const checked = checkCurrency({ currency: code, rate: dollars ? undefined : draft.rate });
    if ('error' in checked) {
      setProblem(checked.error);
      return;
    }
    setProblem(null);
    setBusy(true);
    try {
      const d = await api('infra/currency', { method: 'PUT', body: checked.setting });
      take(d.currency);
      toast(
        d.currency.currency === PROVIDER_CURRENCY
          ? 'Costs show in US dollars again.'
          : `Costs show in ${d.currency.currency} now, at your rate.`,
        'success',
      );
    } catch (err) {
      setProblem(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="st-currency-form" onSubmit={save} noValidate>
      <div class="rs-fields">
        <label class="field">
          <span class="field-label">Currency</span>
          <input
            class="input input-sm st-currency"
            maxLength={3}
            autoComplete="off"
            spellcheck={false}
            list="st-currencies"
            value={draft.currency}
            onInput={(e) => setDraft((d) => ({ ...d, currency: e.currentTarget.value }))}
            aria-describedby="st-currency-hint"
            aria-invalid={problem ? 'true' : undefined}
          />
          <datalist id="st-currencies">
            {COMMON.map((c) => (
              <option key={c} value={c}>
                {nameOf(c)}
              </option>
            ))}
          </datalist>
          <span class="field-hint" id="st-currency-hint">
            A three-letter code, like EUR or GBP. Estimated costs, cost limits, and budgets read in it.
          </span>
        </label>
        {!dollars && (
          <label class="field">
            <span class="field-label">Rate: 1 USD buys</span>
            <input
              class="input input-sm st-rate"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.92"
              value={draft.rate}
              onInput={(e) => setDraft((d) => ({ ...d, rate: e.currentTarget.value }))}
              aria-describedby="st-rate-hint"
              aria-invalid={problem ? 'true' : undefined}
            />
            <span class="field-hint" id="st-rate-hint">
              Platforms price in US dollars. The board converts at your rate and never fetches one; change it when you
              like.
            </span>
          </label>
        )}
      </div>
      {problem && (
        <p class="field-error" role="alert">
          {problem}
        </p>
      )}
      <p class="meta">
        {current
          ? `Now: ${nameOf(current.to)}, ${rateWords(current)}. Saved estimates stay in US dollars, so changing this rewrites nothing.`
          : 'Now: US dollars, the platforms’ own currency, with no rate.'}
      </p>
      <div class="rs-actions">
        <button type="submit" class="btn btn-primary btn-sm" disabled={!dirty || busy} aria-busy={busy}>
          {busy ? 'Saving…' : 'Save currency'}
        </button>
      </div>
    </form>
  );
}
