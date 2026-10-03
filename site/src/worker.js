// breakaway.example.com/releases.json (BRK-8): one public feed of the latest release on each channel, so
// installs don't each ask GitHub (which limits requests per address, and Workers share addresses).
// Open CORS, no cookies, no analytics, and nothing about who asked: the Worker reads only the request's path.
import { buildFeed } from './feed.js';

const FRESH_SECONDS = 600;
const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'x-content-type-options': 'nosniff',
};

/** @param {unknown} body @param {number} status @param {Record<string, string>} [extra] */
const json = (body, status, extra = {}) =>
  new Response(`${JSON.stringify(body, null, 2)}\n`, { status, headers: { ...HEADERS, ...extra } });

/** @param {string} url */
async function fetchJson(url, init) {
  const response = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'breakaway-releases-feed' },
    ...init,
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  return response.json();
}

export default {
  /** @param {Request} request @param {{ RELEASES_REPO?: string, GITHUB_API?: string }} env @param {ExecutionContext} ctx */
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS });
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return json({ error: 'Use GET.' }, 405, { allow: 'GET, HEAD, OPTIONS' });
    if (pathname !== '/releases.json') return json({ error: 'Not found. The feed is at /releases.json.' }, 404);

    const cache = globalThis.caches?.default;
    const key = new Request(new URL('/releases.json', request.url).href);
    const hit = await cache?.match(key);
    if (hit) return new Response(request.method === 'HEAD' ? null : hit.body, hit);

    const repo = env.RELEASES_REPO ?? 'TheAnarchoX/breakaway';
    const api = env.GITHUB_API ?? 'https://api.github.com';
    try {
      const releases = await fetchJson(`${api}/repos/${repo}/releases?per_page=100`);
      const feed = await buildFeed(releases, fetchJson);
      const response = json({ repository: repo, ...feed }, 200, {
        'cache-control': `public, max-age=${FRESH_SECONDS}`,
      });
      if (cache) ctx.waitUntil(cache.put(key, response.clone()));
      return request.method === 'HEAD' ? new Response(null, response) : response;
    } catch {
      return json({ error: 'GitHub could not be reached for the releases. Try again in a few minutes.' }, 503, {
        'retry-after': '120',
        'cache-control': 'no-store',
      });
    }
  },
};
