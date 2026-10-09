import { describe, expect, it } from 'vitest';
import { clearDraft, draftOf, fillDraft, readDraft, writeDraft } from '../web/src/lib/drafts.js';

// Drafts of the New task, New idea, and New agent forms (WEB-84).

const memory = () => {
  const map = new Map();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
};

const text = (name, value = '') => ({ tagName: 'INPUT', type: 'text', name, value });
const area = (name, value = '') => ({ tagName: 'TEXTAREA', type: 'textarea', name, value });
const select = (name, value, options) => ({
  tagName: 'SELECT',
  type: 'select-one',
  name,
  value,
  options: options.map((o) => ({ value: o })),
});
const box = (name, value, checked = false) => ({ tagName: 'INPUT', type: 'checkbox', name, value, checked });
const radio = (name, value, checked = false) => ({ tagName: 'INPUT', type: 'radio', name, value, checked });

const taskForm = () => [
  text('description'),
  select('project', 'web', ['web', 'docs']),
  box('tags', 'agent', true),
  box('tags', 'owner'),
  radio('horizon', 'now'),
  radio('horizon', 'auto', true),
  area('brief'),
  { tagName: 'INPUT', type: 'file', name: '', value: '' },
  { tagName: 'BUTTON', type: 'submit', name: '', value: '' },
];

describe('draftOf', () => {
  it('reads every kind of field, and says nothing was typed on a fresh form', () => {
    expect(draftOf(taskForm())).toEqual({
      fields: { description: '', project: 'web', who: 'agent', horizon: 'auto', brief: '' },
      typed: false,
    });
  });

  it('counts text, not spaces, as typed', () => {
    const form = taskForm();
    form[6].value = '   ';
    expect(draftOf(form).typed).toBe(false);
    form[6].value = 'Why it matters';
    expect(draftOf(form).typed).toBe(true);
  });

  it('keeps a checkbox group with nothing checked as an empty list', () => {
    const form = [box('force', 'on')];
    expect(draftOf(form).fields).toEqual({ force: [] });
  });
});

describe('fillDraft', () => {
  it('puts a draft back into a fresh form', () => {
    const before = taskForm();
    before[0].value = 'Sort the inbox';
    before[1].value = 'docs';
    before[3].checked = true;
    before[4].checked = true;
    before[5].checked = false;
    const { fields } = draftOf(before);

    const after = taskForm();
    fillDraft(after, fields);
    expect(draftOf(after).fields).toEqual(fields);
    expect(after[2].checked && after[3].checked).toBe(true);
  });

  it('leaves a select alone when the saved choice is gone, and fields the draft does not name', () => {
    const form = taskForm();
    fillDraft(form, { project: 'launch', description: 'Kept' });
    expect(form[1].value).toBe('web');
    expect(form[0].value).toBe('Kept');
    expect(form[2].checked).toBe(true);
  });
});

describe('readDraft and writeDraft', () => {
  it('keeps a typed draft and forgets one with nothing typed', () => {
    const storage = memory();
    writeDraft('idea', { fields: { idea: 'A dark mode' }, typed: true }, storage);
    expect(readDraft('idea', storage)).toEqual({ idea: 'A dark mode' });
    expect(readDraft('agent', storage)).toBeNull();
    writeDraft('idea', { fields: { idea: '' }, typed: false }, storage);
    expect(readDraft('idea', storage)).toBeNull();
  });

  it('clears a draft', () => {
    const storage = memory();
    writeDraft('task', { fields: { description: 'x' }, typed: true }, storage);
    clearDraft('task', storage);
    expect(storage.map.size).toBe(0);
  });

  it('shrugs off broken JSON and blocked storage', () => {
    const storage = memory();
    storage.setItem('tasks.draft.task', '{nope');
    expect(readDraft('task', storage)).toBeNull();
    storage.setItem('tasks.draft.task', '["a"]');
    expect(readDraft('task', storage)).toBeNull();
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {},
    };
    expect(readDraft('task', blocked)).toBeNull();
    expect(() => writeDraft('task', { fields: {}, typed: true }, blocked)).not.toThrow();
    expect(readDraft('task', null)).toBeNull();
  });
});
