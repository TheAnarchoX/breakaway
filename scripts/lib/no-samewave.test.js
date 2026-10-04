import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// BRK-4: breakaway's repository names nothing of samewave's (the first install's own product and repository)
// or of its owner's other repositories. A line that does fails here, unless its file is on the reviewed list
// below. The list is the compatibility fallbacks and history that remain, each with its reason and the number of
// lines it may keep: a new one in a listed file fails too, and a file that no longer needs its entry fails until
// the entry is gone, so the list only shrinks. Naming this project's own repository (`TheAnarchoX/breakaway`) is fine.

const ROOT = new URL('../../', import.meta.url);
const NAMED = /samewave|theanarchox(?!\/breakaway\b)/iu;

const LEGACY_INSTALL =
  'a Worker without TASKS_INSTALL is the first install, so its Durable Object, secrets, default repository, and Workers keep their names';
const LEGACY_TESTS =
  'the Workers test runtime is a Worker without TASKS_INSTALL, so these tests run as the first install';
const HISTORY = 'the board began in the first install: its decisions and specs keep their history';

/** Reviewed files: path → [most lines allowed, why]. A path ending in / covers the folder, without a count. */
const ALLOWED = {
  // The first install, as a Worker without TASKS_INSTALL.
  'src/install.js': [9, LEGACY_INSTALL],
  'src/repos.js': [4, LEGACY_INSTALL],
  'src/release.js': [2, LEGACY_INSTALL],
  'src/default-deploy-paths.json': [1, LEGACY_INSTALL],
  'src/backfill-shipped.js': [6, 'its first deployments are recorded under the first install’s Worker names'],
  'web/src/components/PullPage.jsx': [2, LEGACY_INSTALL],
  'web/src/components/Shell.jsx': [1, 'a comment on the name a first install shows'],
  'interop.mjs': [1, LEGACY_INSTALL],
  // The licensor: the owner's account, which the repository lives under.
  LICENSE: [1, 'the licence’s notice names the licensor'],
  // History.
  'docs/decisions.md': [3, HISTORY],
  'docs/specs/': [0, HISTORY],
  // Tests that keep it out.
  'scripts/lib/release.test.js': [3, 'checks the release helpers never name it'],
  'test/agent-files.test.js': [2, 'checks the agent files never name it'],
  'test/brand.test.js': [3, 'checks the brand’s files never name it'],
  'test/install.test.js': [16, LEGACY_INSTALL],
  'wrangler.test.jsonc': [2, LEGACY_TESTS],
  'test/constants.js': [1, LEGACY_TESTS],
  'test/agents.test.js': [10, LEGACY_TESTS],
  'test/alert-agents.test.js': [3, LEGACY_TESTS],
  'test/auth.test.js': [3, LEGACY_TESTS],
  'test/updates.test.js': [1, LEGACY_TESTS],
  'test/connections.test.js': [20, LEGACY_TESTS],
  'test/first-run.test.js': [8, LEGACY_TESTS],
  'test/fix-pr.test.js': [2, LEGACY_TESTS],
  'test/github-scope.test.js': [10, LEGACY_TESTS],
  'test/github.test.js': [70, LEGACY_TESTS],
  'test/ideas.test.js': [2, LEGACY_TESTS],
  'test/messages.test.js': [1, LEGACY_TESTS],
  'test/pipelines.test.js': [7, LEGACY_TESTS],
  'test/plans.test.js': [2, LEGACY_TESTS],
  'test/push.test.js': [4, LEGACY_TESTS],
  'test/release-flow.test.js': [13, LEGACY_TESTS],
  'test/repos.test.js': [40, LEGACY_TESTS],
  'test/review-agents.test.js': [2, LEGACY_TESTS],
  'test/routine-schedules.test.js': [1, LEGACY_TESTS],
  'test/routine-triggers.test.js': [9, LEGACY_TESTS],
  'test/routines.test.js': [2, LEGACY_TESTS],
  'test/stats.test.js': [7, LEGACY_TESTS],
  'test/wizard.test.js': [5, LEGACY_TESTS],
};

const SELF = 'scripts/lib/no-samewave.test.js';

const tracked = () =>
  execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);

/** Path → the lines naming it, for every tracked text file that does. */
function found() {
  const out = new Map();
  for (const path of tracked()) {
    if (path === SELF) continue;
    let text;
    try {
      text = readFileSync(new URL(path, ROOT), 'utf8');
    } catch {
      continue; // deleted in the working tree
    }
    if (text.includes('\0')) continue; // binary
    const lines = text
      .split('\n')
      .flatMap((line, i) => (NAMED.test(line) ? [`${i + 1}: ${line.trim().slice(0, 100)}`] : []));
    if (lines.length) out.set(path, lines);
  }
  return out;
}

const allowance = (path) =>
  ALLOWED[path] ?? Object.entries(ALLOWED).find(([k]) => k.endsWith('/') && path.startsWith(k))?.[1];

describe('nothing of samewave’s in this repository (BRK-4)', () => {
  const hits = found();

  it('names it only in files on the reviewed list', () => {
    const unlisted = [...hits]
      .filter(([path]) => !allowance(path))
      .map(([path, lines]) => `${path}\n  ${lines.slice(0, 3).join('\n  ')}`);
    expect(
      unlisted,
      'not on the reviewed list (use a made-up repository like acme/widgets, or review it into ALLOWED)',
    ).toEqual([]);
  });

  it('keeps each listed file to the lines it was reviewed with', () => {
    const grown = [...hits].filter(([path, lines]) => {
      const [max] = allowance(path) ?? [Infinity];
      return max > 0 && lines.length > max;
    });
    expect(grown.map(([path, lines]) => `${path}: ${lines.length}`)).toEqual([]);
  });

  it('lists only files that still need it', () => {
    const tracking = new Set(tracked());
    const stale = Object.keys(ALLOWED).filter((key) =>
      key.endsWith('/') ? ![...tracking].some((p) => p.startsWith(key) && hits.has(p)) : !hits.has(key),
    );
    expect(stale).toEqual([]);
  });
});
