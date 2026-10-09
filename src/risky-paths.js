/**
 * Risky-path review (docs/specs/BRK-280-risky-path-review.md), the pure part. A repository lists the paths where a
 * wrong default merges, deletes, overwrites, leaks, or pages the owner, in `risky-paths.json` beside its policy. A
 * pull request that touches one gets a review from a separate agent session, posted as one check on its head commit,
 * and a finding the reviewer marks blocking holds Merge when green until the author answers it.
 *
 * This file reads the list, says which of a pull request's files it covers, checks what the reviewer sends, and
 * words the check. Pure and Node-safe: no store and no network.
 */
import { DESIRED_DIR } from './infra-desired.js';

/** The list's name in the desired-state folder, beside `policy.json`: reserved, so no environment takes it. */
export const RISKY_PATHS_NAME = 'risky-paths';
/** Where a repository lists its risky paths. */
export const RISKY_PATHS_FILE = `${DESIRED_DIR}/${RISKY_PATHS_NAME}.json`;
/** The check's name on the pull request. */
export const RISK_CHECK_NAME = 'breakaway: risky-path review';

/** The list is small: a few areas, each a few globs. */
export const RISKY_PATHS_MAX_BYTES = 32 * 1024;
const MAX_AREAS = 30;
const MAX_GLOBS = 60;
/** A reviewer's report: at most this many findings, each this long, and a summary this long. */
export const MAX_FINDINGS = 30;
export const FINDING_MAX = 2000;
export const SUMMARY_MAX = 4000;
/** An author's answer to one finding. */
export const ANSWER_MAX = 2000;
/** A pull request gets a reviewer for at most this many heads; after that, the owner reads it. */
export const MAX_REVIEWS_PER_PULL = 3;
/** At most this many pull requests are looked at in one sync; the rest wait for the next. */
export const MAX_RISK_PULLS_PER_SYNC = 3;

/** What a finding can be: `blocking` holds Merge when green until the author answers; a `note` doesn't. */
export const SEVERITIES = ['blocking', 'note'];

/**
 * One glob against one path. `**` is any number of folders (none too), `*` anything within one name, `?` one
 * character; anything else matches itself. A glob ending in `/` covers everything under that folder.
 * @param {string} glob
 * @param {string} path
 */
export function globMatches(glob, path) {
  const g = String(glob).endsWith('/') ? `${glob}**` : String(glob);
  let re = '';
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      // `**/` is zero or more folders; a trailing `**` is anything.
      if (g[i + 2] === '/') {
        re += '(?:[^/]+/)*';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`^${re}$`, 'u').test(String(path));
}

/**
 * Reads a repository's list. `{ list }` is its areas in order, each `{ name, why, paths }`; `{ error }` says what's
 * wrong with it, and the board reviews nothing until it's fixed (the check says so).
 * @param {string} text the file's contents
 * @returns {{ list: Array<{ name: string, why: string, paths: string[] }> } | { error: string }}
 */
export function checkRiskyPaths(text) {
  let data;
  try {
    data = JSON.parse(String(text ?? ''));
  } catch (error) {
    return { error: `${RISKY_PATHS_FILE} isn’t JSON: ${error.message}` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return { error: `${RISKY_PATHS_FILE} is an object with "version": 1 and "areas"` };
  if (data.version !== 1) return { error: `${RISKY_PATHS_FILE} needs "version": 1` };
  if (!Array.isArray(data.areas) || !data.areas.length)
    return { error: `${RISKY_PATHS_FILE} needs "areas": a list of { "name", "why", "paths" }` };
  if (data.areas.length > MAX_AREAS) return { error: `${RISKY_PATHS_FILE} lists more than ${MAX_AREAS} areas` };
  const list = [];
  let globs = 0;
  for (const [i, area] of data.areas.entries()) {
    const at = `areas[${i}]`;
    const name = typeof area?.name === 'string' ? area.name.trim() : '';
    if (!name || name.length > 60) return { error: `${at}.name is a short name, up to 60 characters` };
    const why = typeof area.why === 'string' ? area.why.trim() : '';
    if (why.length > 300) return { error: `${at}.why is up to 300 characters` };
    if (!Array.isArray(area.paths) || !area.paths.length) return { error: `${at}.paths is a list of paths or globs` };
    for (const p of area.paths)
      if (typeof p !== 'string' || !p.trim() || p.startsWith('/') || p.length > 200)
        return {
          error: `${at}.paths holds paths from the repository’s root, like "src/auth.js" or "src/**/*-tokens.js"`,
        };
    globs += area.paths.length;
    if (globs > MAX_GLOBS) return { error: `${RISKY_PATHS_FILE} lists more than ${MAX_GLOBS} paths` };
    list.push({ name, why, paths: area.paths.map((p) => p.trim()) });
  }
  return { list };
}

/**
 * Which areas a pull request touches, from GitHub's list of its files: an area counts when any file it adds,
 * changes, or removes (or a renamed file's old name) matches one of its paths.
 * @param {Array<{ name: string, why: string, paths: string[] }>} list
 * @param {Array<{ filename: string, previous_filename?: string }>} files
 * @returns {Array<{ name: string, why: string, files: string[] }>}
 */
export function riskyAreasIn(list, files) {
  const names = [];
  for (const f of files ?? []) {
    if (f?.filename) names.push(f.filename);
    if (f?.previous_filename && f.previous_filename !== f.filename) names.push(f.previous_filename);
  }
  const out = [];
  for (const area of list ?? []) {
    const hit = [...new Set(names.filter((n) => area.paths.some((g) => globMatches(g, n))))].sort();
    if (hit.length) out.push({ name: area.name, why: area.why, files: hit });
  }
  return out;
}

/** The areas in one line, for the reviewer's payload and the check's title. */
export function areasLine(areas) {
  return areas.map((a) => `${a.name} (${a.files.slice(0, 5).join(', ')}${a.files.length > 5 ? ', …' : ''})`).join('; ');
}

/**
 * What a reviewer sends: a summary and its findings. Each finding is `{ severity, text, path?, line? }`; they're
 * numbered from 1 in the order sent, which is how the author answers them.
 * @returns {{ summary: string, findings: Array<{ n: number, severity: string, text: string, path: string | null, line: number | null }> } | { error: string }}
 */
export function checkReport(body) {
  const summary = String(body?.summary ?? '').trim();
  if (!summary) return { error: 'say what you looked at and what you found: "summary" is the review' };
  if (summary.length > SUMMARY_MAX) return { error: `keep the summary under ${SUMMARY_MAX} characters` };
  const raw = body?.findings ?? [];
  if (!Array.isArray(raw)) return { error: '"findings" is a list (empty when you found nothing)' };
  if (raw.length > MAX_FINDINGS) return { error: `at most ${MAX_FINDINGS} findings: keep the ones that matter` };
  const findings = [];
  for (const [i, f] of raw.entries()) {
    const at = `findings[${i}]`;
    if (!SEVERITIES.includes(f?.severity)) return { error: `${at}.severity is blocking or note` };
    const text = String(f.text ?? '').trim();
    if (!text) return { error: `${at}.text says what could go wrong, and how` };
    if (text.length > FINDING_MAX) return { error: `${at}.text is up to ${FINDING_MAX} characters` };
    const path = f.path === undefined || f.path === null || f.path === '' ? null : String(f.path).slice(0, 300);
    const line = f.line === undefined || f.line === null || f.line === '' ? null : Number(f.line);
    if (line !== null && !(Number.isInteger(line) && line > 0)) return { error: `${at}.line is a line number` };
    findings.push({ n: i + 1, severity: f.severity, text, path, line });
  }
  return { summary, findings };
}

/** The blocking findings nobody has answered yet. */
export function unanswered(findings, answers) {
  const done = new Set((answers ?? []).map((a) => a.finding));
  return (findings ?? []).filter((f) => f.severity === 'blocking' && !done.has(f.n));
}

/**
 * Why Merge when green waits on a review, or null. `review` is the store's row as riskReviewOut gives it: a reviewer
 * that's reading the head, or is waiting for room to start, holds it; so does a blocking finding without an answer.
 */
export function riskHold(review) {
  if (!review) return null;
  if (review.state === 'waiting' || review.state === 'reviewing')
    return 'a reviewer is reading its risky paths: Merge when green waits for the review';
  if (review.state !== 'reviewed') return null;
  const open = unanswered(review.findings, review.answers);
  if (!open.length) return null;
  return `${open.length === 1 ? 'a blocking finding waits' : `${open.length} blocking findings wait`} for the author’s answer (${open.map((f) => `#${f.n}`).join(', ')}): Merge when green waits until then`;
}

/**
 * The check's status and conclusion for a review: running while a reviewer reads it or waits for room; action
 * required while a blocking finding has no answer; success once every one has; neutral when no review happens.
 * @returns {{ status: 'in_progress' | 'completed', conclusion: string | null }}
 */
export function riskConclusion(review) {
  if (review.state === 'waiting' || review.state === 'reviewing') return { status: 'in_progress', conclusion: null };
  if (review.state === 'reviewed')
    return {
      status: 'completed',
      conclusion: unanswered(review.findings, review.answers).length ? 'action_required' : 'success',
    };
  return { status: 'completed', conclusion: 'neutral' };
}

/** The check's title, in one line. */
export function riskTitle(review) {
  const n = review.areas?.length ?? 0;
  const touches = `touches ${n} risky ${n === 1 ? 'area' : 'areas'}`;
  switch (review.state) {
    case 'waiting':
      return `Waiting for room to start a reviewer: it ${touches}`;
    case 'reviewing':
      return `A separate agent is reviewing it: it ${touches}`;
    case 'reviewed': {
      const open = unanswered(review.findings, review.answers).length;
      const blocking = review.findings.filter((f) => f.severity === 'blocking').length;
      if (open) return `${open} blocking ${open === 1 ? 'finding waits' : 'findings wait'} for the author’s answer`;
      if (blocking) return `Reviewed: ${blocking} blocking ${blocking === 1 ? 'finding' : 'findings'}, all answered`;
      return review.findings.length
        ? `Reviewed: ${review.findings.length} ${review.findings.length === 1 ? 'note' : 'notes'}, nothing blocking`
        : 'Reviewed: nothing found';
    }
    case 'no-task':
      return `Not reviewed: it ${touches} but closes no open task`;
    case 'unstarted':
      return `Not reviewed: no reviewer could start, and it ${touches}`;
    case 'outside':
      return `Not reviewed: a pull request from a fork, and it ${touches}`;
    case 'capped':
      return `Not reviewed again: reviewed ${MAX_REVIEWS_PER_PULL} times already`;
    case 'invalid':
      return `Not reviewed: ${RISKY_PATHS_FILE} doesn’t check`;
    default:
      return 'Not reviewed';
  }
}

/** The check's summary, in Markdown. `page` is the pull request's page on the board, or null. */
export function riskSummary(review, { page = null } = {}) {
  const lines = [];
  if (review.state === 'invalid') {
    lines.push(
      `The board can’t read the list of risky paths on the base branch: ${review.error ?? 'it doesn’t check'}.`,
    );
    lines.push('', `Fix \`${RISKY_PATHS_FILE}\` on the default branch, and the next push is reviewed.`);
    return lines.join('\n');
  }
  lines.push(`It touches what \`${RISKY_PATHS_FILE}\` lists as risky:`, '');
  for (const a of review.areas ?? [])
    lines.push(`- **${a.name}**${a.why ? `: ${a.why}` : ''} (${a.files.map((f) => `\`${f}\``).join(', ')})`);
  lines.push('');
  if (review.state === 'waiting')
    lines.push(
      `No reviewer could start yet (${review.error ?? 'no room'}). The board tries again at its next sync, and Merge when green waits.`,
    );
  else if (review.state === 'reviewing')
    lines.push(
      'A separate agent session, not the author’s, is reading it for what could merge, delete, overwrite, leak, or page wrongly. Merge when green waits for its review.',
    );
  else if (review.state === 'unstarted')
    lines.push(
      `No reviewer could start (${review.error ?? 'the agent routine refused it'}), so nothing holds it: read these paths yourself before you merge.`,
    );
  else if (review.state === 'no-task')
    lines.push('It closes no open task, so no reviewer started: read these paths yourself before you merge.');
  else if (review.state === 'outside')
    lines.push('It comes from a fork, so no reviewer started: read these paths yourself before you merge.');
  else if (review.state === 'capped')
    lines.push(
      `A reviewer read ${MAX_REVIEWS_PER_PULL} of its heads already, so the board starts no more: read what changed since yourself.`,
    );
  else if (review.state === 'reviewed') {
    lines.push(`**Review** by ${review.agent}:`, '', review.summary, '');
    if (!review.findings.length) lines.push('No findings.');
    const answers = new Map((review.answers ?? []).map((a) => [a.finding, a]));
    for (const f of review.findings) {
      const where = f.path ? ` \`${f.path}${f.line ? `:${f.line}` : ''}\`` : '';
      lines.push(`${f.n}. **${f.severity === 'blocking' ? 'Blocking' : 'Note'}**${where}: ${f.text}`);
      const a = answers.get(f.n);
      if (a) lines.push(`   - *Answer* from ${a.by}: ${a.text}`);
      else if (f.severity === 'blocking') lines.push('   - *Waits for the author’s answer.*');
    }
    const open = unanswered(review.findings, review.answers);
    lines.push(
      '',
      open.length
        ? `Merge when green waits until the author answers ${open.map((f) => `#${f.n}`).join(', ')}: \`npx breakaway risk-answer <task> <finding> "<answer>"\`. Merging stays the owner’s.`
        : 'Nothing holds Merge when green. Merging stays the owner’s.',
    );
  }
  if (page) lines.push('', `[On the board](${page})`);
  const text = lines.join('\n');
  return text.length > 60_000 ? `${text.slice(0, 60_000)}\n\n…` : text;
}
