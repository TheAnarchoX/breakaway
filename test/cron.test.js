import { describe, expect, it } from 'vitest';
import { latestSlot, matches, nextSlot, parseCron } from '../src/cron.js';

const at = (iso) => Date.parse(iso);

describe('cron text', () => {
  it('refuses what isn’t five valid fields', () => {
    for (const bad of [
      '',
      '* * * *',
      '* * * * * *',
      '60 * * * *',
      '* 24 * * *',
      '* * 0 * *',
      '* * * 13 *',
      '*/0 * * * *',
      '5-1 * * * *',
      'a * * * *',
    ])
      expect(() => parseCron(bad), bad).toThrow();
  });

  it('matches lists, ranges, steps, and both Sundays', () => {
    const c = parseCron('*/15 9-10 * * 0');
    expect(matches(c, at('2026-10-04T09:45:00Z'))).toBe(true); // a Sunday
    expect(matches(c, at('2026-10-04T09:50:00Z'))).toBe(false);
    expect(matches(c, at('2026-10-05T09:45:00Z'))).toBe(false);
    expect(matches(parseCron('0 0 * * 7'), at('2026-10-04T00:00:00Z'))).toBe(true);
    expect(matches(parseCron('5,10 * * * *'), at('2026-10-04T03:10:00Z'))).toBe(true);
  });

  it('matches a day if either day field does, when both are set', () => {
    const c = parseCron('0 0 1 * 1'); // the 1st, or any Monday
    expect(matches(c, at('2026-10-01T00:00:00Z'))).toBe(true); // Thursday the 1st
    expect(matches(c, at('2026-10-05T00:00:00Z'))).toBe(true); // a Monday
    expect(matches(c, at('2026-10-06T00:00:00Z'))).toBe(false);
  });

  it('finds the latest slot within ten minutes, and the next one', () => {
    const c = parseCron('0 9 * * 1');
    expect(latestSlot(c, at('2026-10-05T09:03:30Z'))).toBe(at('2026-10-05T09:00:00Z'));
    expect(latestSlot(c, at('2026-10-05T09:11:00Z'))).toBeNull();
    expect(nextSlot(c, at('2026-10-05T09:00:00Z'))).toBe(at('2026-10-12T09:00:00Z'));
    expect(nextSlot(parseCron('30 2 29 2 *'), at('2026-10-05T00:00:00Z'))).toBe(at('2028-02-29T02:30:00Z'));
    expect(nextSlot(parseCron('0 0 31 2 *'), at('2026-10-05T00:00:00Z'))).toBeNull();
  });
});
