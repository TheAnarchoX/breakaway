import { describe, expect, it } from 'vitest';
import {
  filterSpecs,
  inSpecsDir,
  markStep,
  readSpecParam,
  refiningSpec,
  shortTitle,
  specParam,
  specTaskCounts,
  specsDirOf,
  withoutTitle,
} from '../web/src/lib/specs.js';

// The Specs view (WEB-25, docs/specs/IDEA-31-specs-view.md section 3): what it works out without the page.

const spec = (wid, title, name = `${wid}-x.md`) => ({ wid, title, name, path: `docs/specs/${name}` });

describe('the spec in the address', () => {
  it('names the default repository’s spec by its path, and another’s with its slug', () => {
    expect(specParam('docs/specs/OPS-3-x.md', 'widgets', 'widgets')).toBe('docs/specs/OPS-3-x.md');
    expect(specParam('docs/specs/OPS-3-x.md', null, 'widgets')).toBe('docs/specs/OPS-3-x.md');
    expect(specParam('notes/OPS-3-x.md', 'gadgets', 'widgets')).toBe('gadgets:notes/OPS-3-x.md');
    expect(specParam(null, 'gadgets', 'widgets')).toBeNull();
  });

  it('reads it back, and refuses what can’t be a spec', () => {
    expect(readSpecParam('docs/specs/OPS-3-x.md')).toEqual({ slug: null, path: 'docs/specs/OPS-3-x.md' });
    expect(readSpecParam('gadgets:notes/OPS-3-x.md')).toEqual({ slug: 'gadgets', path: 'notes/OPS-3-x.md' });
    expect(readSpecParam('')).toBeNull();
    expect(readSpecParam(null)).toBeNull();
    expect(readSpecParam('docs/specs/x.txt')).toBeNull();
    expect(readSpecParam('../secrets.md')).toBeNull();
    expect(readSpecParam('Gadgets:docs/x.md')).toBeNull();
  });
});

describe('a repository’s specs directory', () => {
  it('is its setting, else docs/specs', () => {
    expect(specsDirOf({ settings: { specs: 'notes/specs' } })).toBe('notes/specs');
    expect(specsDirOf({ settings: null })).toBe('docs/specs');
    expect(specsDirOf(undefined)).toBe('docs/specs');
  });

  it('holds a Markdown file directly in it, not one deeper or elsewhere', () => {
    expect(inSpecsDir('docs/specs', 'docs/specs/OPS-3-x.md')).toBe(true);
    expect(inSpecsDir('docs/specs', './docs/specs/OPS-3-x.md')).toBe(true);
    expect(inSpecsDir('docs/specs', 'docs/specs/old/OPS-3-x.md')).toBe(false);
    expect(inSpecsDir('docs/specs', 'docs/OPS-3-x.md')).toBe(false);
    expect(inSpecsDir('docs/specs', 'docs/specs/notes.txt')).toBe(false);
    expect(inSpecsDir('docs/specs', 'https://example.com/docs/specs/x.md')).toBe(false);
    expect(inSpecsDir('docs/specs', null)).toBe(false);
  });
});

describe('the list', () => {
  const list = [spec('OPS-12', 'Sort the inbox'), spec('WEB-3', 'Dark mode'), spec(null, 'Notes', 'notes.md')];

  it('narrows by title, work ID, or file name, ignoring case', () => {
    expect(filterSpecs(list, '').map((s) => s.name)).toEqual(['OPS-12-x.md', 'WEB-3-x.md', 'notes.md']);
    expect(filterSpecs(list, '  inbox ').map((s) => s.wid)).toEqual(['OPS-12']);
    expect(filterSpecs(list, 'web-3').map((s) => s.wid)).toEqual(['WEB-3']);
    expect(filterSpecs(list, 'notes.md').map((s) => s.title)).toEqual(['Notes']);
    expect(filterSpecs(list, 'nothing like it')).toEqual([]);
  });

  it('counts a spec’s tasks and the open ones', () => {
    expect(
      specTaskCounts([{ status: 'pending' }, { status: 'waiting' }, { status: 'completed' }, { status: 'recurring' }]),
    ).toEqual({ total: 4, open: 3 });
    expect(specTaskCounts([])).toEqual({ total: 0, open: 0 });
    expect(specTaskCounts(undefined)).toEqual({ total: 0, open: 0 });
  });
});

describe('a spec’s text', () => {
  it('leaves out the first heading, which the view shows as the title', () => {
    expect(withoutTitle('# OPS-3 · Agents\n\nStatus: draft\n\n## Problem\nText')).toBe(
      '\nStatus: draft\n\n## Problem\nText',
    );
    expect(withoutTitle('<!-- a note -->\n# Title\nBody')).toBe('<!-- a note -->\nBody');
    expect(withoutTitle('No heading here.\n## Later')).toBe('No heading here.\n## Later');
  });
});

describe('a spec’s title beside its work ID', () => {
  it('drops the work ID the title starts with, and the mark after it', () => {
    expect(shortTitle('OPS-3 · Sort the inbox', 'OPS-3')).toBe('Sort the inbox');
    expect(shortTitle('OPS-3: Sort the inbox', 'OPS-3')).toBe('Sort the inbox');
    expect(shortTitle('OPS-3 — Sort the inbox', 'OPS-3')).toBe('Sort the inbox');
    expect(shortTitle('OPS-3 Sort the inbox', 'OPS-3')).toBe('Sort the inbox');
    expect(shortTitle('OPS-30 · Other', 'OPS-3')).toBe('OPS-30 · Other');
    expect(shortTitle('OPS-3', 'OPS-3')).toBe('OPS-3');
    expect(shortTitle('Sort the inbox', null)).toBe('Sort the inbox');
  });
});

describe('the agent on a spec', () => {
  const t = (over) => ({
    status: 'pending',
    who: 'agent',
    tags: ['general'],
    spec: 'docs/specs/OPS-3-x.md',
    repo: null,
    ...over,
  });

  it('finds the open general task that links it, in its repository', () => {
    const on = t({ uuid: 'a' });
    expect(
      refiningSpec([t({ uuid: 'b', status: 'completed' }), on], 'widgets', 'docs/specs/OPS-3-x.md', 'widgets'),
    ).toBe(on);
    expect(
      refiningSpec([t({ spec: './docs/specs/OPS-3-x.md' })], 'widgets', 'docs/specs/OPS-3-x.md', 'widgets'),
    ).not.toBeNull();
  });

  it('ignores another repository’s, another spec’s, and tasks that aren’t general agents', () => {
    const path = 'docs/specs/OPS-3-x.md';
    expect(refiningSpec([t({ repo: 'gadgets' })], 'widgets', path, 'widgets')).toBeNull();
    expect(refiningSpec([t({})], 'gadgets', path, 'widgets')).toBeNull();
    expect(refiningSpec([t({ repo: 'gadgets' })], 'gadgets', path, 'widgets')).not.toBeNull();
    expect(refiningSpec([t({ spec: 'docs/specs/OPS-4-y.md' })], 'widgets', path, 'widgets')).toBeNull();
    expect(refiningSpec([t({ tags: [] })], 'widgets', path, 'widgets')).toBeNull();
    expect(refiningSpec(null, 'widgets', path, 'widgets')).toBeNull();
  });
});

describe('the step a spec’s button takes (BRK-215)', () => {
  it('marks a draft approved and an approved spec built, and offers nothing for any other status', () => {
    expect(markStep('draft')).toEqual({ status: 'approved', label: 'Mark approved' });
    expect(markStep('approved')).toEqual({ status: 'built', label: 'Mark built' });
    for (const other of ['built', 'superseded', 'constructor', null, undefined, ''])
      expect(markStep(other), String(other)).toBeNull();
  });
});
