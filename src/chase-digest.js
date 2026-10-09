/**
 * A chase's digest (BRK-277, docs/specs/BRK-277-chase-digest.md): once an hour while a chase runs, and once when it
 * stops or ends, the board writes the owner what happened, so they needn't read the peloton: what merged (with the
 * screenshots its pull request carries), what waits for them in priority order, what's stuck, what the chase starts
 * next, and a few lines from its road captain. Pure functions, so the content is tested without a Durable Object.
 */

/** The most screenshots a pull request keeps, and the longest caption kept with one. */
export const SCREENSHOTS_KEPT = 4;
const ALT_MAX = 120;
/** The longest note a road captain adds to the next digest. */
export const DIGEST_NOTE_MAX = 600;
/** What the chase starts next: the first few of its queue. */
const NEXT_SHOWN = 3;

/**
 * Hosts a pull request's screenshot may be on: GitHub's own, where an image pasted into a pull request goes. Any other
 * image is left out, so a digest only ever links to GitHub, which the owner connected.
 */
const IMAGE_HOSTS = /^(?:github\.com|(?:[\w-]+\.)*githubusercontent\.com)$/u;

/** A link to an image on GitHub, or null. */
function imageUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || !IMAGE_HOSTS.test(url.hostname)) return null;
  if (url.hostname === 'github.com' && !url.pathname.startsWith('/user-attachments/assets/')) return null;
  return url.href;
}

const caption = (alt) =>
  String(alt ?? '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, ALT_MAX);

/**
 * The screenshots in a pull request's description: Markdown images (`![alt](url)`) and HTML ones (`<img src alt>`),
 * on GitHub's hosts, each once, in order, at most SCREENSHOTS_KEPT.
 * @param {string | null | undefined} body
 * @returns {{ url: string, alt: string }[]}
 */
export function screenshotsIn(body) {
  const text = String(body ?? '');
  if (!text) return [];
  /** @type {{ at: number, url: string, alt: string }[]} */
  const found = [];
  for (const m of text.matchAll(/!\[([^\]]{0,500})\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/gu))
    found.push({ at: m.index ?? 0, url: m[2], alt: m[1] });
  for (const m of text.matchAll(/<img\b[^>]{0,2000}>/giu)) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/iu.exec(m[0])?.[1];
    if (src) found.push({ at: m.index ?? 0, url: src, alt: /\balt\s*=\s*["']([^"']*)["']/iu.exec(m[0])?.[1] ?? '' });
  }
  found.sort((a, b) => a.at - b.at);
  const seen = new Set();
  const out = [];
  for (const f of found) {
    const url = imageUrl(f.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, alt: caption(f.alt) });
    if (out.length >= SCREENSHOTS_KEPT) break;
  }
  return out;
}

const PRIORITY = { H: 0, M: 1, L: 2 };
/** Among equals, what frees the most first: a merge frees its task, a decision its tasks, then steps. */
const KINDS = ['merge', 'decide', 'owner', 'connect', 'untagged'];

/**
 * What waits for the owner, in the order they'd best take it: the task's priority, then how much work it frees, then
 * merges before decisions before steps.
 * @param {{ kind: string, priority?: string | null, unblocks?: number }[]} items
 */
export function ownerOrder(items) {
  const p = (x) => PRIORITY[/** @type {'H'|'M'|'L'} */ (x.priority)] ?? 3;
  const k = (x) => {
    const i = KINDS.indexOf(x.kind);
    return i < 0 ? KINDS.length : i;
  };
  return [...items].sort((a, b) => p(a) - p(b) || (b.unblocks ?? 0) - (a.unblocks ?? 0) || k(a) - k(b));
}

/**
 * The digest of the chase on `feature` for the stretch from `from` to `to` (ms).
 * @param {{
 *   feature: { slug: string, title: string },
 *   kind: 'hourly' | 'final',
 *   from: number,
 *   to: number,
 *   summary: string,
 *   merged: { wid: string | null, description: string, repo: string, pr: number, title: string, url: string | null, mergedAt: string, screenshots?: { url: string, alt: string }[] }[],
 *   needsYou: { uuid: string, wid: string | null, description: string, kind: string, why: string, pr?: number, unblocks?: number, priority?: string | null }[],
 *   stuck: { uuid: string, wid: string | null, description: string, why: string, last?: string | null, pr?: number }[],
 *   queue: { uuid: string, wid: string | null, description: string, ready: boolean, reason: string }[],
 *   captain?: { agent: string, text: string, at: string } | null,
 *   ended?: string | null,
 * }} input
 */
export function buildDigest({
  feature,
  kind,
  from,
  to,
  summary,
  merged,
  needsYou,
  stuck,
  queue,
  captain = null,
  ended = null,
}) {
  return {
    feature: feature.slug,
    title: feature.title,
    kind,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    summary,
    merged: [...merged]
      .sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt))
      .map((m) => ({ ...m, screenshots: m.screenshots ?? [] })),
    waiting: ownerOrder(needsYou).map((x) => ({
      uuid: x.uuid,
      wid: x.wid,
      description: x.description,
      kind: x.kind,
      why: x.why,
      ...(x.pr ? { pr: x.pr } : {}),
      unblocks: x.unblocks ?? 0,
      priority: x.priority ?? null,
    })),
    stuck: stuck.map((x) => ({
      uuid: x.uuid,
      wid: x.wid,
      description: x.description,
      why: x.why,
      last: x.last ? String(x.last).slice(0, 300) : null,
      ...(x.pr ? { pr: x.pr } : {}),
    })),
    next: queue
      .slice(0, NEXT_SHOWN)
      .map((q) => ({ uuid: q.uuid, wid: q.wid, description: q.description, ready: q.ready, reason: q.reason })),
    captain,
    ended,
  };
}

/** Whether a digest has nothing the owner would act on: nothing merged, waiting for them, or stuck, and no end. */
export function digestQuiet(d) {
  return !d.merged.length && !d.waiting.length && !d.stuck.length && !d.ended;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The digest in one line: "2 merged, 3 wait for you, 1 stuck", or what the chase is doing. */
export function digestHeadline(d) {
  const parts = [];
  if (d.merged.length) parts.push(`${d.merged.length} merged`);
  if (d.waiting.length) parts.push(`${plural(d.waiting.length, 'waits', 'wait')} for you`);
  if (d.stuck.length) parts.push(`${d.stuck.length} stuck`);
  if (d.ended) return parts.length ? `${d.ended} Since the last digest: ${parts.join(', ')}.` : d.ended;
  return parts.length ? parts.join(', ') : `Nothing new: ${d.summary}`;
}

/** The digest's counts, for the inbox and the feature's list. */
export const digestCounts = (d) => ({ merged: d.merged.length, waiting: d.waiting.length, stuck: d.stuck.length });

/**
 * A digest's notification: the install's name, the chase and its headline. It opens the digest's page.
 * @param {{ id: number, feature: string, title: string, kind: string } & Record<string, any>} d
 * @param {string} title the install's name
 */
export function digestMessage(d, title) {
  const head = `${d.kind === 'final' ? 'Last digest' : 'Digest'} of the chase on ${d.title}`;
  const line = digestHeadline(d);
  return {
    title,
    body: `${head}\n${line.length > 100 ? `${line.slice(0, 99).trimEnd()}…` : line}`,
    tag: `digest-${d.feature}`,
    url: `/#/roadmap?feature=${encodeURIComponent(d.feature)}&digest=${d.id}`,
  };
}
