import { useEffect, useState } from 'preact/hooks';
import { api } from '../lib/api.js';
import { toast } from '../lib/store.js';
import { PROVIDER_CURRENCY, RATE_SOURCE, checkCurrency, rateWords, rateOf } from '../../../src/infra-currency.js';

const COMMON = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'SEK', 'NOK', 'DKK', 'PLN', 'INR', 'BRL'];

/** A currency's name the way the browser says it: "Euro". */
function nameOf(code) {
  try {
    return new Intl.DisplayNames(undefined, { type: 'currency' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** A source's day, as the brand writes it: "5 Oct". */
function dayOf(/** @type {string} */ date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/**
 * The board's currency (BRK-226): one for the whole board, with a rate the owner sets. Platforms price in US dollars,
 * so every estimate, the cost limit, and each budget read in this currency at this rate. Fetch today's rate (BRK-239)
 * asks the source in RATE_SOURCE, only on the owner's press, and only fills the field: the owner still saves it.
 */
export function CurrencySettings() {
  const [saved, setSaved] = useState(/** @type {any} */ (null));
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [draft, setDraft] = useState({ currency: '', rate: '' });
  const [problem, setProblem] = useState(/** @type {string | null} */ (null));
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(false);
  /** The rate the last press fetched, while it's still what the field holds. */
  const [fetched, setFetched] = useState(/** @type {any} */ (null));

  const take = (c) => {
    setSaved(c);
    setFetched(null);
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
  const fresh = fetched && fetched.currency === code && draft.rate.trim() === String(fetched.rate) ? fetched : null;
  const known = /^[A-Z]{3}$/u.test(code);

  const fetchRate = async () => {
    setProblem(null);
    setFetching(true);
    try {
      const d = await api('infra/currency/rate', { method: 'POST', body: { currency: code } });
      setDraft((dr) => ({ ...dr, rate: String(d.rate.rate) }));
      setFetched(d.rate);
    } catch (err) {
      setProblem(err.message);
    } finally {
      setFetching(false);
    }
  };

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
          <div class="field">
            <label class="field-label" for="st-rate">
              Rate: 1 USD buys
            </label>
            <div class="st-rate-row">
              <input
                id="st-rate"
                class="input input-sm st-rate"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.92"
                value={draft.rate}
                onInput={(e) => setDraft((d) => ({ ...d, rate: e.currentTarget.value }))}
                aria-describedby="st-rate-hint st-fetch-hint"
                aria-invalid={problem ? 'true' : undefined}
              />
              <button
                type="button"
                class="btn btn-sm"
                onClick={fetchRate}
                disabled={!known || fetching || busy}
                aria-busy={fetching}
              >
                {fetching ? 'Fetching…' : 'Fetch today’s rate'}
              </button>
            </div>
            <span class="field-hint" id="st-rate-hint">
              Platforms price in US dollars. The board converts at your rate; change it when you like.
            </span>
            <span class="field-hint" id="st-fetch-hint">
              Fetch today’s rate asks{' '}
              <a href={RATE_SOURCE.site} target="_blank" rel="noopener noreferrer">
                {RATE_SOURCE.name}
              </a>{' '}
              ({RATE_SOURCE.about}), only when you press it, and sends only USD and {known ? code : 'your currency'}. It
              fills the field; you save it.
            </span>
          </div>
        )}
      </div>
      {problem && (
        <p class="field-error" role="alert">
          {problem}
        </p>
      )}
      {fresh && (
        <p class="meta" role="status">
          {fresh.source}’s rate{fresh.date ? ` for ${dayOf(fresh.date)}` : ''}: 1 USD = {fresh.rate} {fresh.currency}.
          Save to use it.
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
