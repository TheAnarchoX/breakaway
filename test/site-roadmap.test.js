import { describe, expect, it } from 'vitest';
import { compareVersions, firstSentence, ROADMAP_MARK, roadmapFrom, roadmapHtml } from '../site/lib/roadmap.js';
import ROADMAP from '../site/content/roadmap.json';
import INDEX from '../site/content/index.html?raw';
import BUILT_INDEX from '../site/public/index.html?raw';

// The road ahead on the landing page (LCH-39): a snapshot of breakaway's own features by release, which the page moves
// along from the feed. Made-up features; only the committed snapshot is breakaway's own.

const feature = (slug, release, more = {}) => ({
  slug,
  title: `The ${slug}`,
  brief: null,
  release,
  state: 'open',
  shipped: false,
  repos: ['breakaway'],
  ...more,
});

describe('the roadmap snapshot', () => {
  it('keeps breakaway’s own features aimed at a release, in version order', () => {
    const { roadmap } = roadmapFrom(
      [
        feature('later', '2.10.0'),
        feature('soon', '2.9.0'),
        feature('elsewhere', '2.9.0', { repos: ['widgets'] }),
        feature('both', '2.9.0', { repos: ['breakaway', 'widgets'] }),
        feature('unplaced', null),
        feature('gone', '2.9.0', { state: 'deleted' }),
      ],
      { note: 'Planned.', edits: {} },
    );
    expect(roadmap.releases.map((r) => [r.version, r.features.map((f) => f.slug)])).toEqual([
      ['2.9.0', ['soon']],
      ['2.10.0', ['later']],
    ]);
  });

  it('leaves out a release with nothing left to ship, and keeps a shipped feature beside an open one', () => {
    const { roadmap } = roadmapFrom(
      [
        feature('old', '1.0.0', { shipped: true }),
        feature('done-early', '2.0.0', { shipped: true }),
        feature('still-open', '2.0.0'),
      ],
      { note: '', edits: {} },
    );
    expect(roadmap.releases.map((r) => r.version)).toEqual(['2.0.0']);
    expect(roadmap.releases[0].features.map((f) => f.slug)).toEqual(['done-early', 'still-open']);
  });

  it('keeps written titles and lines, and names the features without one', () => {
    const { roadmap, unwritten } = roadmapFrom(
      [
        feature('a', '3.0.0', { brief: 'Builds on WEB-12 for widgets. Then more.' }),
        feature('b', '3.0.0', { title: 'Board words' }),
      ],
      { note: 'n', edits: { b: { title: 'Your words', line: 'Written by hand.' } } },
    );
    expect(roadmap.releases[0].features).toEqual([
      { slug: 'a', title: 'The a', line: 'Builds on for widgets.' },
      { slug: 'b', title: 'Your words', line: 'Written by hand.' },
    ]);
    expect(unwritten).toEqual(['a']);
    expect(roadmap.edits.b.line).toBe('Written by hand.');
  });

  it('compares versions by number and cuts a brief at its first sentence', () => {
    expect(compareVersions('2.10.0', '2.9.0')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
    expect(firstSentence('One: two. Three')).toBe('One.');
    expect(firstSentence(null)).toBe('');
  });
});

describe('the road ahead', () => {
  const html = roadmapHtml(
    {
      note: 'Planned <and> changing.',
      edits: {},
      releases: [
        { version: '2.0.0', features: [{ slug: 'a', title: 'A & B', line: 'Line.' }] },
        { version: '2.1.0', features: [{ slug: 'c', title: 'C', line: 'More.' }] },
      ],
    },
    'https://github.com/acme/widgets',
  );

  it('marks the first release next and the rest planned, with a link for when each is out', () => {
    expect(html).toContain('data-version="2.0.0" data-state="next"');
    expect(html).toContain('data-version="2.1.0" data-state="planned"');
    expect(html).toContain('href="https://github.com/acme/widgets/releases/tag/v2.1.0">Out now in 2.1.0</a>');
    expect(html).toContain('A &amp; B');
    expect(html).toContain('Planned &lt;and&gt; changing.');
  });

  it('is on the landing page near the bottom, built from the committed snapshot', () => {
    expect(INDEX).toContain(ROADMAP_MARK);
    // test/site-pages.test.js checks the committed page is what the content builds.
    const page = BUILT_INDEX;
    expect(page).not.toContain(ROADMAP_MARK);
    expect(page.indexOf('id="road-title"')).toBeGreaterThan(page.indexOf('id="trust-title"'));
    expect(page.indexOf('id="road-title"')).toBeLessThan(page.indexOf('id="close-title"'));
    expect(BUILT_INDEX).toContain(roadmapHtml(ROADMAP, 'https://github.com/TheAnarchoX/breakaway'));
  });

  it('holds only breakaway’s own words: no work IDs and no dates', () => {
    const text = JSON.stringify(ROADMAP.releases);
    expect(text).not.toMatch(/\b[A-Z]{2,}-\d+\b/u);
    expect(text).not.toMatch(/\b20\d\d\b/u);
    expect(ROADMAP.releases.length).toBeGreaterThan(0);
  });
});
