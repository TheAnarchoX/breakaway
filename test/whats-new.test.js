import { describe, expect, it } from 'vitest';
import { notesFor, showFor } from '../web/src/lib/whats-new.js';

// whats-new.json as the release workflow writes it for a pre-release (scripts/release/lib.js, whatsNewOf).
const file = {
  version: '1.5.0-main.38',
  repository: 'acme/widgets',
  main: { notes: '### Web\n\n- Sort the inbox by age (WEB-12, #40)', changes: 1 },
  stable: {
    version: '1.5.0',
    from: '1.4.0',
    notes: '### Board\n\n- Keep claims (BRK-3, #31)\n\n### Web\n\n- Sort the inbox by age (WEB-12, #40)',
    changes: 2,
  },
};

describe('notesFor', () => {
  it("gives a pre-release this pre-release's notes", () => {
    expect(notesFor('1.5.0-main.38', file)).toEqual({
      channel: 'main',
      version: '1.5.0-main.38',
      from: null,
      notes: file.main.notes,
      changes: 1,
      url: 'https://github.com/acme/widgets/releases/tag/v1.5.0-main.38',
    });
  });
  it('gives the stable it was promoted to the notes since the last stable', () => {
    expect(notesFor('1.5.0', file)).toMatchObject({
      channel: 'stable',
      version: '1.5.0',
      from: '1.4.0',
      notes: file.stable.notes,
      changes: 2,
      url: 'https://github.com/acme/widgets/releases/tag/v1.5.0',
    });
  });
  it("has none for another build's file, a missing or malformed one, or one with no changes", () => {
    expect(notesFor('1.5.0-main.39', file)).toBeNull();
    expect(notesFor('1.6.0', file)).toBeNull();
    expect(notesFor('1.5.0', null)).toBeNull();
    expect(notesFor('1.5.0', '<!doctype html>')).toBeNull();
    expect(notesFor('1.5.0', { ...file, version: '1.5.0' })).toBeNull();
    expect(notesFor(null, file)).toBeNull();
    expect(notesFor('1.5.0-main.38', { ...file, main: { notes: 'No merged pull requests.', changes: 0 } })).toBeNull();
  });
  it('links nothing when the file names no repository, or one that is not owner/name', () => {
    expect(notesFor('1.5.0', { ...file, repository: undefined })?.url).toBeNull();
    expect(notesFor('1.5.0', { ...file, repository: 'evil.example/x/../y' })?.url).toBeNull();
  });
});

describe('showFor', () => {
  it('shows a dialog after an update to a stable, and a note after an update on the main channel', () => {
    expect(showFor({ running: '1.5.0', seen: '1.4.0', file })).toBe('dialog');
    expect(showFor({ running: '1.5.0', seen: '1.5.0-main.37', file })).toBe('dialog');
    expect(showFor({ running: '1.5.0-main.38', seen: '1.5.0-main.37', file })).toBe('note');
  });
  it('shows nothing on the first visit, for the release already seen, or after a roll back', () => {
    expect(showFor({ running: '1.5.0', seen: null, file })).toBeNull();
    expect(showFor({ running: '1.5.0', seen: '1.5.0', file })).toBeNull();
    expect(showFor({ running: '1.5.0-main.38', seen: '1.5.0-main.40', file })).toBeNull();
    expect(showFor({ running: '1.5.0', seen: 'not a version', file })).toBeNull();
  });
  it('shows nothing when the bundle has no notes for the release', () => {
    expect(showFor({ running: '1.5.0', seen: '1.4.0', file: null })).toBeNull();
  });
});
