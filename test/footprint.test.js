import { describe, expect, it } from 'vitest';
import {
  footprintsOverlap,
  hitRate,
  isShared,
  matches,
  normalize,
  overlaps,
  pathsNamed,
  predictFootprint,
  sharedFiles,
} from '../src/footprint.js';

// IDEA-55 sections 1 and 2 (BRK-317): footprints as patterns, the overlap of two, and the prediction. Pure, on fixtures.
const patterns = (footprint) => footprint.paths.map((p) => p.pattern);

describe('matching a pattern against a path', () => {
  it('matches a file only by its whole path', () => {
    expect(matches('src/store-chase.js', 'src/store-chase.js')).toBe(true);
    expect(matches('./src/store-chase.js', '/src/store-chase.js')).toBe(true);
    expect(matches('src/store-chase.js', 'src/store-chase.jsx')).toBe(false);
    expect(matches('src/store-chase.js', 'lib/src/store-chase.js')).toBe(false);
  });

  it('matches a folder, itself and everything under it, at any depth', () => {
    expect(matches('web/src/views/', 'web/src/views/GraphView.jsx')).toBe(true);
    expect(matches('web/src/views/', 'web/src/views/parts/Edge.jsx')).toBe(true);
    expect(matches('web/src/views/', 'web/src/views')).toBe(true);
    expect(matches('web/src/views/', 'web/src/viewsx/A.jsx')).toBe(false);
    expect(matches('web/src/views/', 'web/src/components/A.jsx')).toBe(false);
  });

  it('matches *, ** and ? the way globs do, * and ? within one folder', () => {
    expect(matches('test/*.test.js', 'test/chase.test.js')).toBe(true);
    expect(matches('test/*.test.js', 'test/lib/chase.test.js')).toBe(false);
    expect(matches('src/infra-*.js', 'src/infra-plans.js')).toBe(true);
    expect(matches('src/infra-*.js', 'src/store-infra-plans.js')).toBe(false);
    expect(matches('apps/web/api/**', 'apps/web/api/routes.js')).toBe(true);
    expect(matches('apps/web/api/**', 'apps/web/api/v1/users/list.js')).toBe(true);
    expect(matches('apps/web/api/**', 'apps/web/app.js')).toBe(false);
    expect(matches('**/store.js', 'store.js')).toBe(true);
    expect(matches('**/store.js', 'web/src/lib/store.js')).toBe(true);
    expect(matches('src/**/x.js', 'src/x.js')).toBe(true);
    expect(matches('src/**/x.js', 'src/a/b/x.js')).toBe(true);
    expect(matches('src/v?.js', 'src/v2.js')).toBe(true);
    expect(matches('src/v?.js', 'src/v22.js')).toBe(false);
    expect(matches('src/a+b(c).js', 'src/a+b(c).js')).toBe(true);
  });

  it('matches nothing for an empty path', () => {
    expect(matches('**', '')).toBe(false);
    expect(normalize(' ./src//a.js ')).toBe('src/a.js');
  });
});

describe('two patterns overlapping, segment by segment', () => {
  it('meets when either can match what the other does, globs and folders alike', () => {
    expect(overlaps('apps/web/api/**', 'apps/web/api/routes.js')).toBe(true);
    expect(overlaps('apps/web/', 'apps/web/api/**')).toBe(true);
    expect(overlaps('web/src/views/', 'web/src/views/GraphView.jsx')).toBe(true);
    expect(overlaps('src/infra-*.js', 'src/*-plans.js')).toBe(true);
    expect(overlaps('src/**/store.js', '**/lib/*.js')).toBe(true);
    expect(overlaps('**', 'anything/at/all.md')).toBe(true);
    expect(overlaps('test/*.test.js', 'test/chase.test.js')).toBe(true);
    expect(overlaps('src/a.js', 'src/a.js')).toBe(true);
  });

  it('is apart when some segment rules it out', () => {
    expect(overlaps('apps/web/api/**', 'apps/web/app.js')).toBe(false);
    expect(overlaps('web/src/views/', 'web/src/components/')).toBe(false);
    expect(overlaps('src/infra-*.js', 'src/store-*.js')).toBe(false);
    expect(overlaps('src/*.js', 'src/*.md')).toBe(false);
    expect(overlaps('test/*.test.js', 'test/lib/a.test.js')).toBe(false);
    expect(overlaps('src/a.js', 'src/b.js')).toBe(false);
    expect(overlaps('src/a.js', 'src/a.js/')).toBe(true);
    expect(overlaps('', 'src/a.js')).toBe(false);
  });

  it('is symmetric', () => {
    const list = ['apps/web/api/**', 'apps/web/app.js', 'src/infra-*.js', 'src/*-plans.js', '**/x.js', 'web/'];
    for (const a of list) for (const b of list) expect(overlaps(a, b)).toBe(overlaps(b, a));
  });

  it('finds the first pair two footprints share, leaving shared files out', () => {
    const shared = [{ path: 'docs/tasks.md', why: 'common', share: 0.44 }];
    expect(footprintsOverlap(['src/store-chase.js', 'web/'], ['test/chase.test.js', 'web/src/views/'])).toEqual({
      a: 'web/',
      b: 'web/src/views/',
    });
    expect(
      footprintsOverlap(['pnpm-lock.yaml', 'docs/tasks.md', 'src/a.js'], ['pnpm-lock.yaml', 'docs/tasks.md'], {
        shared,
      }),
    ).toBe(null);
    expect(footprintsOverlap([{ pattern: 'docs/', source: 'named' }], ['docs/tasks.md'], { shared })).toBe(null);
    expect(footprintsOverlap(['docs/'], ['docs/tasks.md', 'docs/footprints.md'], { shared })).toEqual({
      a: 'docs/',
      b: 'docs/footprints.md',
    });
    expect(footprintsOverlap(['**/pnpm-lock.yaml'], ['pnpm-lock.yaml'])).toBe(null);
  });
});

describe('the paths a text names', () => {
  it('keeps files, folders, and globs as named, and a bare file name in any folder', () => {
    expect(
      pathsNamed(
        'Change `src/store-chase.js` and web/src/views/, claim apps/web/api/** and test/*.test.js. Also store.js, ' +
          'src/infra-*.js, and the docs/specs folder.',
      ),
    ).toEqual([
      'src/store-chase.js',
      'web/src/views/',
      'apps/web/api/**',
      'test/*.test.js',
      '**/store.js',
      'src/infra-*.js',
      'docs/specs/',
    ]);
  });

  it('names nothing in a URL, a route, a package, a runtime, or a one-word folder', () => {
    expect(
      pathsNamed(
        'See https://code.claude.com/docs/en/hooks, GET /api/tasks/:id/paths, @preact/signals, ~/.claude/x.json, ' +
          'Node.js, a web/ folder, and/or version 1.2.',
      ),
    ).toEqual([]);
  });
});

describe('shared files', () => {
  const pulls = (lists) => lists.map((files) => ({ files }));

  it('are lockfiles, and files more than 40% of the last 50 merged pull requests changed', () => {
    const history = pulls([
      ...Array.from({ length: 21 }, (_, i) => ['docs/tasks.md', `src/a${i}.js`]),
      ...Array.from({ length: 20 }, (_, i) => ['src/store.js', `src/b${i}.js`, `src/b${i}.js`]),
      ['pnpm-lock.yaml', 'package.json'],
      ...Array.from({ length: 8 }, (_, i) => [`src/c${i}.js`]),
      // Past the 50 newest: never counted.
      ...Array.from({ length: 40 }, () => ['src/store.js']),
    ]);
    expect(sharedFiles(history)).toEqual([
      { path: 'docs/tasks.md', why: 'common', share: 0.42 },
      { path: 'pnpm-lock.yaml', why: 'lockfile', share: 0.02 },
    ]);
    expect(sharedFiles(history, { share: 0.3 }).map((f) => f.path)).toEqual([
      'docs/tasks.md',
      'src/store.js',
      'pnpm-lock.yaml',
    ]);
    expect(sharedFiles([])).toEqual([]);
  });

  it('count a lockfile in any folder, and a listed file only by its whole path', () => {
    expect(isShared('pnpm-lock.yaml')).toBe(true);
    expect(isShared('apps/web/package-lock.json')).toBe(true);
    expect(isShared('Cargo.lock')).toBe(true);
    expect(isShared('src/lock.js')).toBe(false);
    expect(isShared('docs/tasks.md', ['docs/tasks.md'])).toBe(true);
    expect(isShared('site/docs/tasks.md', ['docs/tasks.md'])).toBe(false);
  });
});

describe('predicting a footprint', () => {
  it('keeps the paths a task names, in its title, description, done when, comments, and spec', () => {
    const task = {
      description: 'Sort the chase queue in src/store-chase.js',
      brief: 'Reorder chaseQueue.',
      done_when: 'test/chase.test.js covers it',
      comments: [{ by: 'claude-x', text: 'Footprint: web/src/views/ChaseView.jsx' }, 'and src/feature-prompt.js'],
    };
    const footprint = predictFootprint(task, { spec: 'It reads docs/specs/IDEA-28-features-and-chase.md.' });
    expect(footprint).toEqual({
      known: true,
      paths: [
        { pattern: 'src/store-chase.js', source: 'named' },
        { pattern: 'test/chase.test.js', source: 'named' },
        { pattern: 'web/src/views/ChaseView.jsx', source: 'named' },
        { pattern: 'src/feature-prompt.js', source: 'named' },
        { pattern: 'docs/specs/IDEA-28-features-and-chase.md', source: 'spec' },
      ],
      shared: [],
    });
  });

  it('adds what related tasks name only in the folders this one names', () => {
    const task = { description: 'Draw shared-files edges in web/src/views/GraphView.jsx' };
    const related = [
      { description: 'Footprint on hover', brief: 'web/src/views/TaskPanel.jsx and src/footprint.js' },
      { description: 'Elsewhere', brief: 'scripts/tasks.mjs' },
    ];
    expect(patterns(predictFootprint(task, { related }))).toEqual([
      'web/src/views/GraphView.jsx',
      'web/src/views/TaskPanel.jsx',
    ]);
    expect(predictFootprint(task, { related }).paths[1].source).toBe('related');
  });

  it('adds the files the closest similar completed tasks changed: a file two changed, else its folder', () => {
    const task = { description: 'Show the chase queue reasons on the feature page' };
    const history = [
      {
        description: 'Show the chase queue on the feature page',
        files: ['src/store-chase.js', 'web/src/views/FeatureView.jsx', 'pnpm-lock.yaml'],
      },
      {
        description: 'Chase queue reasons in the feature page header',
        files: ['src/store-chase.js', 'web/src/components/Header.jsx', 'README.md'],
      },
      { description: 'Rotate the push keys', files: ['src/push.js'] },
      { description: 'Show the chase queue on the feature page again', files: [] },
    ];
    expect(predictFootprint(task, { history, shared: ['README.md'] })).toEqual({
      known: true,
      paths: [
        { pattern: 'src/store-chase.js', source: 'similar' },
        { pattern: 'web/src/views/', source: 'similar' },
        { pattern: 'web/src/components/', source: 'similar' },
      ],
      shared: ['README.md', 'pnpm-lock.yaml'],
    });
  });

  it('keeps a root file a single similar task changed as the file, never the whole repository', () => {
    const history = [{ description: 'Bump the release notes format', files: ['release.json'] }];
    expect(patterns(predictFootprint({ description: 'Change the release notes format' }, { history }))).toEqual([
      'release.json',
    ]);
  });

  it('leaves out shared files it names, and shows them', () => {
    const footprint = predictFootprint(
      { description: 'Document footprints in docs/tasks.md and pnpm-lock.yaml, and docs/footprints.md' },
      { shared: [{ path: 'docs/tasks.md', why: 'common', share: 0.44 }] },
    );
    expect(patterns(footprint)).toEqual(['docs/footprints.md']);
    expect(footprint.shared).toEqual(['docs/tasks.md', 'pnpm-lock.yaml']);
  });

  it('is unknown when nothing is found', () => {
    expect(predictFootprint({ description: 'Make the board faster' })).toEqual({ known: false, paths: [], shared: [] });
    expect(
      predictFootprint(
        { description: 'Make the board faster' },
        { history: [{ description: 'Rotate keys', files: ['a.js'] }] },
      ),
    ).toEqual({ known: false, paths: [], shared: [] });
  });
});

describe('the hit rate', () => {
  it('is the share of changed files the prediction covered, shared files aside', () => {
    const predicted = [{ pattern: 'web/src/views/', source: 'similar' }, 'src/store-chase.js'];
    expect(
      hitRate(predicted, [
        'web/src/views/A.jsx',
        'src/store-chase.js',
        'src/store.js',
        'test/a.test.js',
        'pnpm-lock.yaml',
      ]),
    ).toBe(0.5);
    expect(hitRate(predicted, ['web/src/views/A.jsx', 'docs/tasks.md'], { shared: ['docs/tasks.md'] })).toBe(1);
    expect(hitRate([], ['src/a.js'])).toBe(0);
    expect(hitRate(predicted, ['pnpm-lock.yaml'])).toBe(null);
    expect(hitRate(predicted, [])).toBe(null);
  });
});
