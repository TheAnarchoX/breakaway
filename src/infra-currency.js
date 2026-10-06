/**
 * Costs in the owner's currency (docs/specs/IDEA-19-architect.md, "Cost"; BRK-225, BRK-226). Platforms price in US
 * dollars; the owner picks one currency for the whole board in Settings, with a rate they set and change when they
 * like. The board never fetches a rate: that would be a call to a service the owner didn't connect.
 *
 * Every estimate is kept as the provider gave it, in its own currency, and converted here, once, when the board shows
 * it or checks it against the policy's limits, which are in the owner's currency. Switching back to US dollars changes
 * nothing stored. Each converted amount carries the rate and when the owner set it. Pure and Node-safe, so the CLI can
 * import it.
 */

/** The currency providers price in: every rate is the owner's currency for one of these. */
export const PROVIDER_CURRENCY = 'USD';

/** The most a rate may be: 1,000,000 of the owner's currency to the dollar is past any currency in use. */
export const MAX_RATE = 1_000_000;

/**
 * The board's currency: `currency` is ISO 4217, `rate` is how much of it one US dollar buys, and `setAt` when the owner
 * set it. US dollars have a rate of 1.
 * @typedef {{ currency: string, rate: number, setAt: string | null }} CurrencySetting
 */

/** What the board uses when the owner hasn't picked: the providers' own currency. */
export const DEFAULT_CURRENCY = Object.freeze({ currency: PROVIDER_CURRENCY, rate: 1, setAt: null });

/**
 * How a converted amount was converted: from the provider's currency, at the owner's rate, set when.
 * @typedef {{ from: string, to: string, rate: number, setAt: string | null }} Rate
 */

/** Whether the runtime knows a currency code, when it can say. */
function known(code) {
  const list = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : null;
  return !list || list.includes(code);
}

/**
 * Checks what the owner sent from Settings: a currency code and, for anything but US dollars, a rate.
 * @param {unknown} input
 * @returns {{ ok: true, setting: { currency: string, rate: number } } | { ok: false, error: string }}
 */
export function checkCurrency(input) {
  const o = /** @type {Record<string, unknown>} */ (input && typeof input === 'object' ? input : {});
  const currency = typeof o.currency === 'string' ? o.currency.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/u.test(currency) || !known(currency))
    return { ok: false, error: 'the currency is a three-letter code, like EUR, GBP, or JPY' };
  if (currency === PROVIDER_CURRENCY) {
    if (o.rate !== undefined && o.rate !== null && o.rate !== '' && Number(o.rate) !== 1)
      return { ok: false, error: 'US dollars need no rate: leave it empty' };
    return { ok: true, setting: { currency, rate: 1 } };
  }
  const rate = typeof o.rate === 'string' ? Number(o.rate.trim().replace(',', '.')) : o.rate;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || rate > MAX_RATE)
    return { ok: false, error: `the rate is how much ${currency} one US dollar buys, a number above 0, like 0.92` };
  return { ok: true, setting: { currency, rate } };
}

/** The rate a setting converts with, or null when it converts nothing (US dollars). */
export function rateOf(/** @type {CurrencySetting} */ setting) {
  return setting.currency === PROVIDER_CURRENCY
    ? null
    : { from: PROVIDER_CURRENCY, to: setting.currency, rate: setting.rate, setAt: setting.setAt };
}

const round = (n) => Math.round(n * 100) / 100;

/**
 * An amount in the provider's currency, in the owner's: unchanged in the same currency, null when it can't be
 * converted (a provider pricing in something other than US dollars, which no rate covers).
 * @param {number | null | undefined} amount
 * @param {string | null | undefined} from the amount's currency
 * @param {CurrencySetting} setting
 * @returns {number | null}
 */
export function convert(amount, from, setting) {
  if (amount === null || amount === undefined || !from) return null;
  if (from === setting.currency) return amount;
  if (from !== PROVIDER_CURRENCY) return null;
  return round(amount * setting.rate);
}

/**
 * A resource's cost, as the inventory keeps it, in the owner's currency: the amount and currency converted, and the
 * provider's own amount and the rate beside them when it was converted. Null stays null.
 * @template {{ amount: number, currency: string | null }} C
 * @param {C | null} cost
 * @param {CurrencySetting} setting
 * @returns {(C & { rate?: Rate & { amount: number } }) | null}
 */
export function costInCurrency(cost, setting) {
  if (!cost || !cost.currency || cost.currency === setting.currency) return cost;
  const amount = convert(cost.amount, cost.currency, setting);
  const rate = rateOf(setting);
  if (amount === null || !rate) return cost;
  return { ...cost, amount, currency: setting.currency, rate: { ...rate, amount: cost.amount } };
}

/**
 * A plan's cost change (infra-plans.js) in the owner's currency, with the rate it used. A change already in their
 * currency keeps its amounts and has no rate. One in a currency no rate covers keeps nothing it can't convert: its
 * amounts are unknown, so the policy's cost and budget guards ask the owner rather than compare across currencies.
 * @param {import('./infra-plans.js').CostChange | null} cost
 * @param {CurrencySetting} setting
 * @returns {(import('./infra-plans.js').CostChange & { rate: Rate | null }) | null}
 */
export function costChangeInCurrency(cost, setting) {
  if (!cost) return null;
  if (!cost.currency || cost.currency === setting.currency) return { ...cost, rate: null };
  const from = cost.currency;
  const to = (/** @type {number | null} */ n) => convert(n, from, setting);
  const changes = cost.changes.map((c) => ({ ...c, before: to(c.before), after: to(c.after) }));
  const convertible = from === PROVIDER_CURRENCY;
  return {
    ...cost,
    currency: setting.currency,
    now: to(cost.now),
    delta: to(cost.delta),
    after: to(cost.after),
    complete: cost.complete && convertible,
    unknown: convertible ? cost.unknown : changes.map((c) => c.resource),
    changes,
    rate: convertible ? rateOf(setting) : null,
  };
}

/** A date as the brand writes it: "3 Oct", with the year when it isn't this one's. */
function day(iso, now = new Date()) {
  const d = new Date(iso);
  const year = d.getUTCFullYear() === now.getUTCFullYear() ? undefined : 'numeric';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year, timeZone: 'UTC' });
}

/**
 * A rate in words, as the brand writes it beside a total: "at 1 USD = 0.92 EUR, set 3 Oct".
 * @param {Rate | null | undefined} rate
 * @param {Date} [now]
 */
export function rateWords(rate, now = new Date()) {
  if (!rate) return '';
  return `at 1 ${rate.from} = ${rate.rate} ${rate.to}${rate.setAt ? `, set ${day(rate.setAt, now)}` : ''}`;
}
