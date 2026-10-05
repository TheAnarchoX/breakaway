import { describe, expect, it } from 'vitest';
import {
  DECISION_TEMPLATE,
  PING_TEMPLATE,
  decisionField,
  decisionLines,
  pingLines,
  proposalField,
  structureLines,
  textFields,
} from './structure.js';

describe('textFields', () => {
  it('takes the description from --brief or a file, and done when from --done-when', () => {
    expect(textFields({ brief: 'Why' }, () => '')).toEqual({ brief: 'Why' });
    expect(textFields({ 'brief-file': 'b.md', 'done-when': 'It works' }, (p) => `from ${p}`)).toEqual({
      brief: 'from b.md',
      done_when: 'It works',
    });
    expect(textFields({}, () => '')).toEqual({});
  });

  it('refuses both --brief and --brief-file', () => {
    expect(() => textFields({ brief: 'a', 'brief-file': 'b' }, () => '')).toThrow(/not both/u);
  });
});

describe('structureLines', () => {
  const task = {
    brief: 'What and why',
    briefBy: 'owner',
    doneWhen: 'It works',
    relatedTasks: [{ wid: 'CLD-1', description: 'Other', status: 'pending' }],
    comments: [
      { by: null, at: '2026-09-01T10:00:00Z', text: 'old' },
      { by: 'claude-x', at: '2026-09-02T10:00:00Z', text: 'new\nline' },
    ],
  };

  it('prints the description, done when, related tasks, then comments with authors', () => {
    const text = structureLines(task).join('\n');
    expect(text.indexOf('Description (edited by owner)')).toBeLessThan(text.indexOf('Done when'));
    expect(text.indexOf('Done when')).toBeLessThan(text.indexOf('Related'));
    expect(text.indexOf('Related')).toBeLessThan(text.indexOf('Comments'));
    expect(text).toContain('CLD-1 Other [pending]');
    expect(text).toContain('2026-09-01  earlier note:');
    expect(text).toContain('2026-09-02  claude-x:');
    expect(text).toContain('      line');
  });

  it('prints nothing for a task with no structure', () => {
    expect(structureLines({ annotations: [] })).toEqual([]);
  });

  it('falls back to annotations from an older board', () => {
    expect(structureLines({ annotations: [{ entry: '2026-09-01T00:00:00Z', text: 'hi' }] }).join('\n')).toContain(
      'earlier note:',
    );
  });
});

describe('decisionField', () => {
  it('reads the questions from a JSON file, and nothing without the flag', () => {
    expect(decisionField({}, () => '')).toEqual({});
    expect(decisionField({ decision: 'd.json' }, () => '[{"id":"q1"}]')).toEqual({ decision: [{ id: 'q1' }] });
  });

  it('refuses a file that is not a JSON list', () => {
    expect(() => decisionField({ decision: 'd.json' }, () => 'nope')).toThrow(/must be a JSON file/u);
    expect(() => decisionField({ decision: 'd.json' }, () => '{}')).toThrow(/list of questions/u);
  });

  it('has a template that covers every type', () => {
    expect(new Set(DECISION_TEMPLATE.map((q) => q.type))).toEqual(
      new Set(['open', 'yesno', 'choice', 'multi', 'rank', 'scale', 'date']),
    );
  });
});

describe('decisionLines', () => {
  const decision = [
    {
      id: 'keeper',
      type: 'choice',
      prompt: 'Who?',
      options: [
        { id: 'a', label: 'Alice', note: 'now' },
        { id: 'b', label: 'Bob' },
      ],
      other: true,
    },
    { id: 'go', type: 'yesno', prompt: 'Go?', required: false },
  ];

  it('prints the questions and options before an answer', () => {
    const text = decisionLines({ decision }).join('\n');
    expect(text).toContain('Decision (not answered yet)');
    expect(text).toContain('1. [keeper] Who?  (choice)');
    expect(text).toContain('- a: Alice (now)');
    expect(text).toContain('2. [go] Go?  (yesno, optional)');
    expect(text).not.toContain('Answer:');
  });

  it('prints answers with labels and comments', () => {
    const text = decisionLines({
      decision,
      decisionAnswers: {
        by: 'owner',
        at: '2026-09-29T10:00:00Z',
        answers: { keeper: { value: 'other', other: 'Carol' }, go: { value: 'yes', comment: 'after OPS-8' } },
      },
    }).join('\n');
    expect(text).toContain('answered 2026-09-29 by owner');
    expect(text).toContain('Answer: something else: Carol');
    expect(text).toContain('Answer: yes (after OPS-8)');
  });

  it('prints nothing for a task without a decision', () => {
    expect(decisionLines({})).toEqual([]);
  });
});

describe('pings on the command line', () => {
  it('reads --proposal from a JSON file, and explains a bad file', () => {
    expect(proposalField({}, () => '')).toEqual({});
    expect(proposalField({ proposal: 'p.json' }, () => JSON.stringify(PING_TEMPLATE))).toEqual({
      proposal: PING_TEMPLATE,
    });
    expect(() => proposalField({ proposal: 'p.json' }, () => 'nope')).toThrow(
      /--proposal p\.json must be a JSON file/u,
    );
  });

  it("prints a task's pings in show, with what each proposes", () => {
    const lines = pingLines({
      pings: [
        {
          kind: 'blocked',
          by: 'claude-x',
          at: '2026-09-30T10:00:00Z',
          message: 'Needs you',
          resolved: null,
          warnings: ['CLD-1 would no longer wait for anything'],
          proposal: PING_TEMPLATE.changes,
        },
      ],
    }).join('\n');
    expect(lines).toContain('blocked by claude-x (open)');
    expect(lines).toContain('Proposes 6 changes');
    expect(lines).toContain('add n1: Create the Sentry project (ops, now)');
    expect(lines).toContain('CLD-111 waits for n1');
    expect(lines).toContain('finish CLD-113');
    expect(lines).toContain('delete CLD-114 (CLD-112 covers it now.)');
    expect(lines).toContain('Note: CLD-1 would no longer wait for anything');
    expect(pingLines({})).toEqual([]);
    expect(
      structureLines({
        pings: [{ kind: 'fyi', by: 'a', at: '2026-09-30', message: 'hi', resolved: { how: 'dismissed' } }],
      }).join('\n'),
    ).toContain('resolved: dismissed');
  });
});
