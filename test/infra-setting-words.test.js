import { describe, expect, it } from 'vitest';
import {
  bindingChanges,
  bindingLabels,
  bindingWords,
  keyWords,
  sameSetting,
  sameWords,
  settingWords,
  valueWords,
} from '../src/infra-setting-words.js';
import { applyEdits, MERGE_READ_MARGIN_MS, mergeOutcome, outcomeSummary, readHasMerge } from '../src/infra-changes.js';
import { cloudflare } from '../src/infra-cloudflare.js';

// Settings in words, and what a merged change became (WEB-110).
const LABELS = { queue: 'Queue', d1: 'D1 database', durable_object_namespace: 'Durable Object' };

describe('settings in words', () => {
  it('names a setting and its values without JSON', () => {
    expect(keyWords('usageModel')).toBe('usage model');
    expect(keyWords('usage_model')).toBe('usage model');
    expect(valueWords('standard')).toBe('standard');
    expect(valueWords(true)).toBe('yes');
    expect(valueWords(['nodejs_compat', 'streams'])).toBe('nodejs_compat, streams');
    expect(valueWords([])).toBe('none');
    expect(valueWords({ enabled: true })).toBe('on');
    expect(valueWords({ enabled: false, headSamplingRate: 1 })).toBe('off, head sampling rate 1');
    expect(valueWords(undefined)).toBe('unset');
    expect(valueWords('x'.repeat(80))).toHaveLength(60);
    expect(settingWords({ label: 'usage model', before: 'standard', after: 'bundled' })).toBe(
      'usage model standard → bundled',
    );
    expect(settingWords({ label: 'observability', before: undefined, after: { enabled: true } })).toBe(
      'observability → on',
    );
    expect(settingWords({ label: 'usage model', before: 'standard', after: 'standard' })).toBeNull();
  });

  it('reads bindings one at a time, and the same bindings in another order as no change', () => {
    const before = [
      { name: 'ASSETS', type: 'assets' },
      { name: 'OLD_QUEUE', type: 'queue', queue_name: 'acme-old' },
      { name: 'DB', type: 'd1', id: 'd1-1' },
    ];
    const after = [
      { name: 'DB', type: 'd1', id: 'd1-2' },
      { name: 'ASSETS', type: 'assets' },
      { name: 'CHAT', type: 'durable_object_namespace', class_name: 'Chat' },
    ];
    expect(bindingChanges(before, after, LABELS)).toEqual({
      added: ['+ CHAT (Durable Object)'],
      removed: ['− OLD_QUEUE'],
      changed: ['~ DB (D1 database)'],
      unchanged: ['ASSETS'],
    });
    expect(bindingWords(before, after, LABELS)).toBe(
      '+ CHAT (Durable Object), − OLD_QUEUE, ~ DB (D1 database); ASSETS unchanged',
    );
    expect(settingWords({ label: 'bindings', before, after, labels: LABELS })).toBe(
      'bindings + CHAT (Durable Object), − OLD_QUEUE, ~ DB (D1 database); ASSETS unchanged',
    );
    // A type the provider doesn't name reads from the type itself.
    expect(bindingWords([], [{ name: 'AI', type: 'ai_gateway' }])).toBe('+ AI (ai gateway)');
    // A binding that gives only its name and type keeps its target: that's no change.
    expect(bindingWords([{ name: 'DB', type: 'd1', id: 'd1-1' }], [{ name: 'DB', type: 'd1' }])).toBeNull();

    const reordered = [...before].reverse().map((b) => Object.fromEntries(Object.entries(b).reverse()));
    expect(sameSetting(before, reordered)).toBe(true);
    expect(sameSetting(before, after)).toBe(false);
    expect(sameSetting(before, before.slice(1))).toBe(false);
    expect(settingWords({ label: 'bindings', before, after: reordered })).toBeNull();
    expect(sameWords('acme-api', 'bindings', before)).toBe('acme-api’s bindings are the same in another order');
    expect(sameWords('acme-api', 'usage model', 'standard')).toBe('acme-api’s usage model is already standard');
  });

  it('takes a provider’s words for its binding types', () => {
    const field = cloudflare.editable('worker').fields.find((f) => f.type === 'bindings');
    const labels = bindingLabels(field);
    expect(labels).toMatchObject({ queue: 'Queue', durable_object_namespace: 'Durable Object' });
    expect(bindingLabels(null)).toEqual({});
  });

  it('words a change’s set edits with the provider’s labels, and drops one that changes nothing', () => {
    const fields = (kind) => cloudflare.editable(kind)?.fields;
    const file = {
      version: 1,
      provider: 'cloudflare',
      resources: [
        {
          id: 'worker:acme-api',
          kind: 'worker',
          name: 'acme-api',
          attrs: {
            usageModel: 'standard',
            bindings: [
              { name: 'ASSETS', type: 'assets' },
              { name: 'OLD_QUEUE', type: 'queue', queue_name: 'acme-old' },
            ],
          },
        },
      ],
    };
    const bindings = file.resources[0].attrs.bindings;
    const got = applyEdits({
      file,
      environment: 'acme-staging',
      templates: new Map(),
      fields,
      edits: [
        { op: 'set', resource: 'worker:acme-api', path: 'usageModel', value: 'bundled' },
        { op: 'set', resource: 'worker:acme-api', path: 'bindings', value: [...bindings].reverse() },
        {
          op: 'set',
          resource: 'worker:acme-api',
          path: 'bindings',
          value: [bindings[0], { name: 'CHAT', type: 'durable_object_namespace', class_name: 'Chat' }],
        },
      ],
    });
    expect(got.problems).toEqual([]);
    expect(got.lines).toEqual([
      '~ acme-api: usage model standard → bundled',
      '~ acme-api: bindings + CHAT (Durable Object), − OLD_QUEUE; ASSETS unchanged',
    ]);
    expect(got.dropped).toEqual([
      { edit: 1, line: 'acme-api’s bindings are the same in another order, so that edit changes nothing' },
    ]);
    expect(got.lines.join('\n')).not.toMatch(/[[{]/u);
  });
});

describe('what a merged change became', () => {
  const now = Date.now();
  const plan = (state, policy = null) => ({ id: 'plan-7', state, policy });

  it('says nothing applies, it waits, it’s refused, or follows its plan', () => {
    expect(mergeOutcome({ moved: true, empty: true, now })).toEqual({
      kind: 'nothing',
      plan: null,
      why: null,
      at: new Date(now).toISOString(),
    });
    expect(mergeOutcome({ moved: false, empty: false, plan: plan('waiting'), now })).toMatchObject({
      kind: 'nothing',
      why: 'the merge left the desired state as it was',
    });
    expect(mergeOutcome({ moved: true, empty: false, plan: plan('waiting'), now })).toMatchObject({
      kind: 'waits',
      plan: 'plan-7',
    });
    expect(mergeOutcome({ moved: true, empty: false, plan: plan('draft', { outcome: 'refused' }), now })).toMatchObject(
      { kind: 'refused', plan: 'plan-7' },
    );
    expect(mergeOutcome({ moved: true, empty: false, plan: plan('approved'), now })).toMatchObject({
      kind: 'planned',
      plan: 'plan-7',
    });
    expect(mergeOutcome({ moved: true, empty: false, held: 'acme-staging is frozen', now })).toMatchObject({
      kind: 'waits',
      plan: null,
      why: 'acme-staging is frozen',
    });
    expect(outcomeSummary('#253', mergeOutcome({ moved: true, empty: true, now }))).toBe(
      '#253: what runs already matches it',
    );
  });

  it('trusts a read of the default branch at the merge, or a while after it', () => {
    expect(readHasMerge({ sha: 'm1', readAt: now - 5_000 }, { mergeSha: 'm1', mergedAt: now })).toBe(true);
    expect(readHasMerge({ sha: 'h0', readAt: now - 5_000 }, { mergeSha: 'm1', mergedAt: now - 10_000 })).toBe(false);
    expect(readHasMerge({ sha: 'h2', readAt: now }, { mergeSha: 'm1', mergedAt: now - MERGE_READ_MARGIN_MS })).toBe(
      true,
    );
    expect(readHasMerge({ sha: 'h2', readAt: now }, { mergeSha: null, mergedAt: null })).toBe(false);
  });
});
