import { describe, expect, it } from 'vitest';
import { dictationError, dictationText, transcriptOf } from '../web/src/lib/dictation.js';

/** A SpeechRecognitionResultList's shape: a list of results, each a list of alternatives. */
const results = (...texts) => texts.map((transcript) => [{ transcript }]);

describe('transcriptOf', () => {
  it('joins every result’s best guess and tidies the spaces', () => {
    expect(transcriptOf(results('fix the', ' inbox  sort', ' order '))).toBe('fix the inbox sort order');
  });

  it('is empty before anything was heard', () => {
    expect(transcriptOf(results())).toBe('');
    expect(transcriptOf(results('   '))).toBe('');
  });
});

describe('dictationText', () => {
  it('puts a space between what was typed and what was said', () => {
    expect(dictationText({ value: 'Sort the inbox', start: 14, shown: 0, text: 'by age' })).toBe(' by age');
  });

  it('adds no space at the start, after a space, or after a new line', () => {
    expect(dictationText({ value: '', start: 0, shown: 0, text: 'hello' })).toBe('hello');
    expect(dictationText({ value: 'one ', start: 4, shown: 0, text: 'two' })).toBe('two');
    expect(dictationText({ value: 'one\n', start: 4, shown: 0, text: 'two' })).toBe('two');
  });

  it('replaces what it showed before, so the words update as they’re heard', () => {
    // "Hi" then " ther" was shown at 2; the browser now hears "there".
    expect(dictationText({ value: 'Hi ther', start: 2, shown: 5, text: 'there' })).toBe(' there');
  });

  it('keeps inside the field’s limit', () => {
    expect(dictationText({ value: 'abcdef', start: 6, shown: 0, text: 'ghijk', maxLength: 9 })).toBe(' gh');
    expect(dictationText({ value: 'abc gh', start: 3, shown: 3, text: 'ghijk', maxLength: 9 })).toBe(' ghijk');
    expect(dictationText({ value: 'full', start: 4, shown: 0, text: 'more', maxLength: 4 })).toBe('');
  });

  it('ignores a missing limit', () => {
    expect(dictationText({ value: 'a', start: 1, shown: 0, text: 'b', maxLength: -1 })).toBe(' b');
  });
});

describe('dictationError', () => {
  it('says what to do when the microphone is blocked or missing', () => {
    expect(dictationError('not-allowed')).toContain('Allow the microphone');
    expect(dictationError('service-not-allowed')).toContain('Allow the microphone');
    expect(dictationError('audio-capture')).toContain('No microphone');
  });

  it('names the language the browser can’t dictate', () => {
    expect(dictationError('language-not-supported', 'nl-NL')).toContain('nl-NL');
  });

  it('stays quiet when the person stopped it or said nothing', () => {
    expect(dictationError('aborted')).toBeNull();
    expect(dictationError('no-speech')).toBeNull();
  });

  it('falls back to a plain message', () => {
    expect(dictationError('network')).toContain('speech service');
    expect(dictationError('something-new')).toBe('Dictation stopped. Try again.');
  });
});
