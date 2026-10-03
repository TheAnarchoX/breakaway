import { describe, expect, it } from 'vitest';
import { fitDraft, isAnswered, missing, startingDraft, toAnswers } from '../web/src/lib/decision.js';

const questions = [
  {
    id: 'a',
    type: 'choice',
    prompt: 'A?',
    options: [
      { id: 'x', label: 'X' },
      { id: 'y', label: 'Y' },
    ],
    other: true,
  },
  {
    id: 'b',
    type: 'multi',
    prompt: 'B?',
    options: [
      { id: 'x', label: 'X' },
      { id: 'y', label: 'Y' },
    ],
    required: false,
  },
  {
    id: 'c',
    type: 'rank',
    prompt: 'C?',
    options: [
      { id: 'x', label: 'X' },
      { id: 'y', label: 'Y' },
    ],
  },
];

describe('the answer form', () => {
  it('needs required answers, and text for "something else"', () => {
    const draft = startingDraft(questions);
    expect(missing(questions, draft).map((q) => q.id)).toEqual(['a']);
    expect(isAnswered(questions[0], { value: 'other', other: '' })).toBe(false);
    expect(isAnswered(questions[0], { value: 'other', other: 'z' })).toBe(true);
  });

  it('sends only what was answered', () => {
    const draft = { ...startingDraft(questions), a: { value: 'y', comment: ' fine ' } };
    expect(toAnswers(questions, draft)).toEqual({ a: { value: 'y', comment: 'fine' }, c: { value: ['x', 'y'] } });
  });

  it('drops saved answers the questions no longer fit', () => {
    const fit = fitDraft(questions, { a: { value: 'gone' }, c: { value: ['y', 'x'] } });
    expect(Object.keys(fit)).toEqual(['c']);
  });
});
