// The road ahead on the landing page (LCH-39): a snapshot of breakaway's own roadmap, taken from the board by
// scripts/site-roadmap.mjs into site/content/roadmap.json, and the section site/build.mjs renders from it. Pure, so
// the script, the build, and test/site-roadmap.test.js share it. site/public/site.js marks the releases that are out
// from the site's own feed, so a release going out needs no rebuild; only a change to the plan does.
import { escape } from './markdown.js';

/** The repository whose features the site shows. The board tracks others too, and the site is public. */
export const ROADMAP_REPO = 'breakaway';

/** Where the section goes in site/content/index.html. */
export const ROADMAP_MARK = '<!-- road-ahead -->';

const VERSION = /^\d+\.\d+\.\d+$/u;
const WORK_ID = /\b[A-Z]{2,}-\d+\b/gu;

/**
 * Compares two x.y.z versions.
 * @param {string} a
 * @param {string} b
 */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * A line for a feature with no written one: its brief's first sentence, without work IDs. A stand-in until someone
 * writes the line in roadmap.json's `edits`, which the script says.
 * @param {string | null | undefined} brief
 */
export function firstSentence(brief) {
  const text = (brief ?? '').replace(WORK_ID, '').replace(/\s+/gu, ' ').trim();
  const end = text.search(/[.:](\s|$)/u);
  return end === -1 ? text : `${text.slice(0, end)}.`;
}

/**
 * @typedef {{ slug: string, title: string, brief?: string | null, release?: string | null, state?: string,
 *   shipped?: boolean, repos?: string[] }} BoardFeature
 * @typedef {{ title?: string, line?: string }} Edit
 * @typedef {{ slug: string, title: string, line: string }} RoadFeature
 * @typedef {{ version: string, features: RoadFeature[] }} RoadRelease
 * @typedef {{ note: string, releases: RoadRelease[], edits: Record<string, Edit> }} Roadmap
 */

/**
 * The roadmap from the board's features: only this repository's (a feature that spans another is left out), only
 * those aimed at a release, and only releases with something still to ship, in version order. Titles and lines
 * written in `edits` win over the board's, so a refresh keeps them.
 * @param {BoardFeature[]} features what `npx breakaway features --json` lists
 * @param {Pick<Roadmap, 'note' | 'edits'>} kept the note and the edits from the file as it was
 * @returns {{ roadmap: Roadmap, unwritten: string[] }} the roadmap, and the features that have no written line yet
 */
export function roadmapFrom(features, kept) {
  const ours = features.filter(
    (f) =>
      f.release &&
      VERSION.test(f.release) &&
      f.state !== 'deleted' &&
      (f.repos ?? []).length > 0 &&
      (f.repos ?? []).every((r) => r === ROADMAP_REPO),
  );
  /** @type {Map<string, BoardFeature[]>} */
  const byRelease = new Map();
  for (const f of ours) {
    const release = /** @type {string} */ (f.release);
    byRelease.set(release, [...(byRelease.get(release) ?? []), f]);
  }
  const unwritten = [];
  const releases = [...byRelease]
    .filter(([, list]) => list.some((f) => !f.shipped && f.state !== 'shipped'))
    .sort(([a], [b]) => compareVersions(a, b))
    .map(([version, list]) => ({
      version,
      features: list.map((f) => {
        const edit = kept.edits[f.slug] ?? {};
        if (!edit.line) unwritten.push(f.slug);
        return {
          slug: f.slug,
          title: (edit.title ?? f.title).replace(WORK_ID, '').replace(/'/gu, '’').trim(),
          line: edit.line ?? firstSentence(f.brief).replace(/'/gu, '’'),
        };
      }),
    }));
  return { roadmap: { note: kept.note, releases, edits: kept.edits }, unwritten };
}

/**
 * The section's list: one stop per release. As written, the first is Next and the rest are Planned; site.js moves
 * them along from the feed.
 * @param {Roadmap} roadmap
 * @param {string} repo the repository's URL, for each release's notes
 */
export function roadmapHtml(roadmap, repo) {
  const stops = roadmap.releases.map((release, i) => {
    const state = i === 0 ? 'Next' : 'Planned';
    const features = release.features
      .map((f) => `<li><h3>${escape(f.title)}</h3><p>${escape(f.line)}</p></li>`)
      .join('');
    return `<li class="stop" data-version="${escape(release.version)}" data-state="${state.toLowerCase()}">
          <p class="stop-head"><span class="stop-version">${escape(release.version)}</span> <span class="stop-state" data-road-state>${state}</span></p>
          <p class="stop-out" hidden><a href="${escape(`${repo}/releases/tag/v${release.version}`)}">Out now in ${escape(release.version)}</a></p>
          <ul class="stop-features">${features}</ul>
        </li>`;
  });
  return `<section aria-labelledby="road-title">
  <div class="wrap">
    <div class="section-head">
      <p class="label">The road ahead</p>
      <h2 id="road-title" class="section-title">Where it rides next.</h2>
      <p class="muted">${escape(roadmap.note)}</p>
    </div>
    <ol class="road" data-road tabindex="0" aria-label="Releases, in order">
        ${stops.join('\n        ')}
    </ol>
  </div>
</section>`;
}
