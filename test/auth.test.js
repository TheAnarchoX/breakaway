import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { authenticate, login } from '../src/auth.js';
import { ORIGIN, TEST_API_TOKEN } from './constants.js';

function signIn(token, origin = ORIGIN) {
  return SELF.fetch(`${ORIGIN}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  });
}

describe('web sign-in', () => {
  it('turns the token into a long-lived, locked-down cookie', async () => {
    const res = await signIn(TEST_API_TOKEN);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/');
    const cookie = res.headers.get('Set-Cookie');
    expect(cookie).toMatch(
      /^__Host-sw_tasks=\d+\.[\w-]+; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=15552000$/u,
    );

    const value = cookie.split(';')[0];
    const session = await SELF.fetch(`${ORIGIN}/api/session`, { headers: { Cookie: value } });
    expect(await session.json()).toEqual({
      ok: true,
      via: 'cookie',
      install: {
        name: 'samewave tasks',
        url: 'https://tasks.samewave.dev',
        docs: 'https://github.com/TheAnarchoX/samewave/blob/main/docs/tasks.md',
      },
    });

    // Changes with the cookie must come from this origin.
    const post = (origin) =>
      SELF.fetch(`${ORIGIN}/api/tasks`, {
        method: 'POST',
        headers: { Cookie: value, 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify({ description: 'From the web' }),
      });
    expect((await post('https://evil.example')).status).toBe(403);
    expect((await post(null)).status).toBe(403);
    expect((await post(ORIGIN)).status).toBe(201);
  });

  it('sends a wrong token back to the sign-in form', async () => {
    const res = await signIn('nope');
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/?signin=failed');
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('lets nobody in with a blank or short token, as a secret left empty would set (CLD-139)', async () => {
    for (const weak of ['', 'unset', 'a'.repeat(31)]) {
      const env = { TASKS_API_TOKEN: weak };
      const bearer = new Request(`${ORIGIN}/api/session`, { headers: { Authorization: `Bearer ${weak}` } });
      expect(await authenticate(bearer, env)).toBeNull();
      const form = new Request(`${ORIGIN}/login`, {
        method: 'POST',
        headers: { Origin: ORIGIN },
        body: new URLSearchParams({ token: weak || 'x' }),
      });
      expect((await login(form, env)).headers.get('Location')).toBe('/?signin=failed');
    }
    const strong = 'b'.repeat(32);
    expect(
      await authenticate(new Request(`${ORIGIN}/api/session`, { headers: { Authorization: `Bearer ${strong}` } }), {
        TASKS_API_TOKEN: strong,
      }),
    ).toBe('token');
  });

  it('refuses a sign-in posted from another site', async () => {
    expect((await signIn(TEST_API_TOKEN, 'https://evil.example')).status).toBe(403);
  });

  it('refuses a forged or expired cookie', async () => {
    const forged = await SELF.fetch(`${ORIGIN}/api/session`, {
      headers: { Cookie: `__Host-sw_tasks=${Date.now() + 1e9}.AAAA` },
    });
    expect(forged.status).toBe(401);
    const expired = await SELF.fetch(`${ORIGIN}/api/session`, { headers: { Cookie: '__Host-sw_tasks=1000.AAAA' } });
    expect(expired.status).toBe(401);
  });

  it('signs out', async () => {
    const res = await SELF.fetch(`${ORIGIN}/logout`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: ORIGIN },
    });
    expect(res.headers.get('Set-Cookie')).toMatch(/Max-Age=0/u);
  });

  it('keeps API answers out of caches and search engines', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/session`);
    expect(res.status).toBe(401);
    expect(res.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
  });
});
