import { describe, expect, it } from 'vitest';
import { lint } from './brand-lint.js';

const run = (text) => lint([{ path: 'a.md', text }]).map((f) => f.rule);

describe('brand lint', () => {
  it('passes the copy the guide approves', () => {
    expect(
      run(
        'breakaway is a task board for you and your coding agents.\nFree to run. `npx breakaway` works.\nSet BREAKAWAY_TOKEN. if (!ok) return;',
      ),
    ).toEqual([]);
  });

  it('catches the name in any other case', () => {
    for (const bad of [
      'Breakaway is a board.',
      'The BREAKAWAY board',
      'BreakAway',
      'Break Away',
      'the break-away board',
    ]) {
      expect(run(bad), bad).toEqual(['name']);
    }
    expect(run('github.com/acme/breakaway and a Break away from the pack')).toEqual([]);
  });

  it('catches the never-words', () => {
    for (const bad of [
      'A revolutionary board',
      'Next-gen',
      'Seamless sync',
      'Supercharge it',
      'Ship 10x faster',
      'AI-powered',
      'blazing fast',
      'blazing-fast',
      'Unlock more',
    ]) {
      expect(run(bad), bad).toEqual(['never-word']);
    }
    expect(run('A seamlessly-named file? No: the word seam, the 100x100 icon.')).toEqual(['never-word']);
    expect(run('The 100x100 icon, a magician.')).toEqual([]);
  });

  it('catches exclamation marks in prose, not in code', () => {
    expect(run('Welcome!')).toEqual(['exclamation']);
    expect(run('if (a !== b) return !x; <!-- note --> ![alt](x.svg)')).toEqual([]);
  });

  it('catches "open source" but not talk about the term', () => {
    expect(run('breakaway is open source.')).toEqual(['open-source']);
    expect(run('Open-source licence')).toEqual(['open-source']);
    expect(run('Apache 2.0 makes a release open source.')).toEqual([]);
  });

  it('catches the licence words PolyForm Noncommercial rules out', () => {
    expect(run('breakaway is fair source.')).toEqual(['fair-source']);
    expect(run('An ethical licence, ethical-source.')).toEqual(['fair-source', 'fair-source']);
    expect(run('Free to change. Apache 2.0 in two years.')).toEqual(['apache-later']);
    expect(run('Each release becomes Apache 2.0 later.')).toEqual(['apache-later']);
    expect(run('Free for everyone.')).toEqual(['free-for-all']);
    expect(run('Free for commercial use, and free to use commercially.')).toEqual(['free-for-all', 'free-for-all']);
  });

  it('lets the old licence be named for releases before 2.0.0', () => {
    expect(run('1.4.0 is fair source (FSL-1.1-Apache-2.0) and becomes Apache 2.0 two years after it ships.')).toEqual(
      [],
    );
    expect(run('Releases before 2.0.0 were fair source.')).toEqual([]);
    expect(run('Free for personal and noncommercial use. A free commercial licence is by exception.')).toEqual([]);
  });

  it('reports the line and column', () => {
    const [f] = lint([{ path: 'x.md', text: 'one\nthe Breakaway board' }]);
    expect(f).toMatchObject({ path: 'x.md', line: 2, column: 5, rule: 'name' });
  });

  it('opts a line out with a comment', () => {
    expect(run('Breakaway <!-- brand-lint-ignore name -->')).toEqual([]);
    expect(run('Breakaway seamless <!-- brand-lint-ignore name -->')).toEqual(['never-word']);
    expect(run('Breakaway seamless // brand-lint-ignore name, never-word')).toEqual([]);
    expect(run('Breakaway seamless // brand-lint-ignore')).toEqual([]);
    expect(run('<!-- brand-lint-ignore-next-line name -->\nBreakaway\nBreakaway')).toEqual(['name']);
    expect(run('<!-- brand-lint-ignore-next-line -->\nBreakaway seamless')).toEqual([]);
    expect(run('Breakaway\n<!-- brand-lint-ignore-file name -->\nBreakaway seamless')).toEqual(['never-word']);
  });
});
