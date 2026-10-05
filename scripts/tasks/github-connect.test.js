import { describe, expect, it } from 'vitest';
import { appInPlace } from './github-connect.js';

/** GET /api/connections as a board reports it, with its GitHub App row as given. */
const report = (app) => ({
  connections: [{ id: 'cloudflare.worker', state: 'working', name: 'Worker' }, ...(app ? [app] : [])],
});
const WORKING = {
  id: 'github.app',
  state: 'working',
  name: 'GitHub App',
  detail: 'acme-board (ID 123)',
  at: '2026-10-05T01:00:00.000Z',
  link: 'https://github.com/apps/acme-board',
};
const UNCHECKED = { id: 'github.app', state: 'attention', name: 'GitHub App', detail: 'connected, not checked yet' };
const REFUSED = {
  id: 'github.app',
  state: 'attention',
  name: 'GitHub App',
  detail: 'GitHub refused the App (401): Bad credentials',
  at: '2026-10-05T01:00:00.000Z',
  link: 'https://github.com/settings/apps',
};
const OFF = { id: 'github.app', state: 'off', name: 'GitHub App', detail: 'not connected: its secrets are unset' };

describe('github-connect never makes a second App by accident (CLI-2)', () => {
  it('goes ahead on a board with no App', () => {
    expect(appInPlace(report(OFF), { replace: false })).toEqual({ ok: true });
  });

  it('refuses on a board with a working App, naming it, before the code is traded', () => {
    const result = appInPlace(report(WORKING), { replace: false });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('the board already has a working GitHub App: acme-board (ID 123)');
    expect(result.message).toContain('https://github.com/apps/acme-board');
    expect(result.message).toContain('Nothing was changed');
    expect(result.message).toContain('delete it on GitHub');
    expect(result.message).toContain('--replace');
  });

  it('refuses while the App it has isn’t checked yet: it may well work', () => {
    const result = appInPlace(report(UNCHECKED), { replace: false });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('connected, not checked yet');
    expect(result.message).toContain('Check now');
    expect(result.message).toContain('--replace');
  });

  it('goes ahead in place of an App GitHub refused, and says to delete the old one', () => {
    const result = appInPlace(report(REFUSED), { replace: false });
    expect(result.ok).toBe(true);
    expect(result.note).toContain('GitHub refused the App (401)');
    expect(result.note).toContain('delete the old one');
  });

  it('with --replace, goes ahead over a working App and says what it replaces', () => {
    const result = appInPlace(report(WORKING), { replace: true });
    expect(result.ok).toBe(true);
    expect(result.note).toContain('acme-board (ID 123)');
    expect(result.note).toContain('https://github.com/apps/acme-board');
    expect(appInPlace(report(OFF), { replace: true })).toEqual({ ok: true });
  });

  it('refuses when it can’t tell, unless --replace', () => {
    for (const unknown of [null, undefined, {}, report(null)]) {
      const result = appInPlace(unknown, { replace: false });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("couldn't ask the board whether it already has a GitHub App");
      expect(appInPlace(unknown, { replace: true }).ok).toBe(true);
    }
  });
});
