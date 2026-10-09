/**
 * TaskStore's currency (docs/specs/IDEA-19-architect.md, "Cost"; BRK-226): one currency for the whole board, with a
 * rate the owner sets in Settings (BRK-225). Kept in `meta` as `infra_currency`. Anyone signed in reads it; setting it
 * is the owner's, from the signed-in browser only (the worker refuses the bearer token, and an agent's `by` here).
 * Nothing stored is converted: the inventory converts on read, and a plan converts its cost change when it's made, so
 * the policy's limits, which are in this currency, compare like with like.
 *
 * Fetch today's rate (BRK-239) is the one call here to a service the owner didn't connect: it runs only on the owner's
 * press in Settings, sends only the currency pair, stores nothing, and hands the rate back for the owner to save.
 */
import { AgentError } from './store-agents.js';
import {
  checkCurrency,
  DEFAULT_CURRENCY,
  PROVIDER_CURRENCY,
  RATE_SOURCE,
  rateSourceUrl,
  readFetchedRate,
} from './infra-currency.js';

const KEY = 'infra_currency';

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraCurrencyMethods = {
  /** The board's currency, or US dollars when the owner hasn't picked one. @returns {import('./infra-currency.js').CurrencySetting} */
  infraCurrency() {
    const kept = this.meta(KEY);
    if (!kept) return DEFAULT_CURRENCY;
    try {
      const s = JSON.parse(kept);
      return { currency: s.currency, rate: Number(s.rate), setAt: s.setAt ?? null };
    } catch {
      return DEFAULT_CURRENCY;
    }
  },

  /** The setting as the API shows it. */
  currencyOut() {
    const s = this.infraCurrency();
    return { currency: s.currency, rate: s.rate, from: PROVIDER_CURRENCY, setAt: s.setAt };
  },

  /** GET /api/infra/currency: the board's currency and rate. */
  currencyApi() {
    return this.run(async () => ({ status: 200, body: { currency: this.currencyOut() } }));
  },

  /** PUT /api/infra/currency: the owner sets the currency and its rate. Stored estimates don't change. */
  currencySetApi(body = {}) {
    return this.run(async () => {
      this.allow(body, 'currency', null, 'only the owner sets the board’s currency; agents read it');
      const checked = checkCurrency(body);
      if ('error' in checked) throw new AgentError(checked.error, 400);
      const { currency, rate } = checked.setting;
      if (currency === PROVIDER_CURRENCY) this.setMeta(KEY, null);
      else this.setMeta(KEY, JSON.stringify({ currency, rate, setAt: new Date().toISOString() }));
      return { status: 200, body: { currency: this.currencyOut() } };
    });
  },

  /** POST /api/infra/currency/rate: the owner pressed Fetch today's rate. Returns the rate; stores nothing. */
  currencyRateApi(body = {}) {
    return this.run(async () => {
      this.allow(body, 'currency', null, 'only the owner fetches a rate, from Settings');
      const checked = checkCurrency({ currency: body.currency, rate: 1 });
      if ('error' in checked) throw new AgentError(checked.error, 400);
      const { currency } = checked.setting;
      if (currency === PROVIDER_CURRENCY) throw new AgentError('US dollars need no rate', 400);
      let answer;
      try {
        const res = await fetch(rateSourceUrl(currency), {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 404 || res.status === 422) answer = null;
        else if (!res.ok) throw new Error(`HTTP ${res.status}`);
        else answer = await res.json();
      } catch {
        throw new AgentError(`couldn’t reach ${RATE_SOURCE.name}: try again, or type the rate yourself`, 502);
      }
      const read = readFetchedRate(answer, currency);
      if ('error' in read) throw new AgentError(read.error, 422);
      return { status: 200, body: { rate: read.rate } };
    });
  },
};
