import { describe, expect, it } from 'vitest';
import { NIL, keyFromBase64, seal, unseal, uuidBytes } from '../src/crypto.js';
import { TEST_SYNC_KEY } from './constants.js';

// taskchampion's src/server/test-good.data: "SUCCESS" sealed for this version ID.
const GOOD = '010b0874fe60261292c7d15f1e29d389e7dbfac718fbde080767ff727d882df85ab8c073';
const GOOD_VERSION = 'b0517957-f912-4d49-8330-f612e73030c4';
const hex = (s) => Uint8Array.from(s.match(/../g), (b) => parseInt(b, 16));
const text = (b) => new TextDecoder().decode(b);

describe('envelope crypto', () => {
  const key = keyFromBase64(TEST_SYNC_KEY);

  it("opens taskchampion's own test vector", () => {
    expect(text(unseal(key, GOOD_VERSION, hex(GOOD)))).toBe('SUCCESS');
  });

  it('refuses a payload sealed for another version', () => {
    expect(() => unseal(key, NIL, hex(GOOD))).toThrow();
  });

  it('refuses an unknown envelope version', () => {
    const bad = hex(GOOD);
    bad[0] = 99;
    expect(() => unseal(key, GOOD_VERSION, bad)).toThrow(/envelope version/);
  });

  it('refuses a truncated envelope', () => {
    expect(() => unseal(key, GOOD_VERSION, new Uint8Array(5))).toThrow(/too small/);
  });

  it('round-trips with a fresh nonce each time', () => {
    const v = crypto.randomUUID();
    const a = seal(key, v, new TextEncoder().encode('hello'));
    const b = seal(key, v, new TextEncoder().encode('hello'));
    expect(a[0]).toBe(1);
    expect(a).not.toEqual(b);
    expect(text(unseal(key, v, a))).toBe('hello');
  });

  it('turns a UUID into its 16 bytes', () => {
    expect([...uuidBytes('0666d464-418a-4a08-ad53-6f15c78270cd')].slice(0, 3)).toEqual([0x06, 0x66, 0xd4]);
    expect(uuidBytes(NIL)).toEqual(new Uint8Array(16));
  });
});
