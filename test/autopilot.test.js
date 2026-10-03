import { describe, expect, it } from 'vitest';
import { actionKey, planPullActions } from '../web/src/lib/autopilot.js';

const open = (number, extra = {}) => ({
  number,
  state: 'open',
  draft: false,
  headSha: `sha${number}`,
  mergeable: true,
  mergeableState: 'blocked',
  verdict: 'running',
  autoMerge: null,
  ...extra,
});
const both = { keepUpdated: true, mergeWhenGreen: true, method: 'squash' };

describe('what the pull request settings do', () => {
  it('does nothing while both are off', () => {
    expect(
      planPullActions(
        [
          open(1, { mergeableState: 'behind', verdict: 'behind' }),
          open(2, { verdict: 'ready', mergeableState: 'clean' }),
        ],
        { keepUpdated: false, mergeWhenGreen: false },
      ),
    ).toEqual([]);
  });

  it('updates a branch that is behind main, but not one with conflicts or a draft', () => {
    const prs = [
      open(1, { mergeableState: 'behind', verdict: 'behind' }),
      open(2, { mergeableState: 'behind', verdict: 'failing' }), // failing and behind: main may hold the fix
      open(3, { mergeable: false, mergeableState: 'dirty', verdict: 'conflicts' }),
      open(4, { draft: true, mergeableState: 'behind', verdict: 'draft' }),
      open(5, { state: 'merged', mergeableState: 'behind' }),
    ];
    expect(planPullActions(prs, { keepUpdated: true })).toEqual([
      { action: 'update-branch', number: 1, sha: 'sha1' },
      { action: 'update-branch', number: 2, sha: 'sha2' },
    ]);
  });

  it('merges what is ready now and sets the rest to merge when green', () => {
    const prs = [
      open(1, { verdict: 'ready', mergeableState: 'clean' }),
      open(2, { verdict: 'running' }),
      open(3, { verdict: 'review' }),
      open(4, { verdict: 'failing' }),
      open(5, { verdict: 'unknown', mergeableState: null, mergeable: null }),
      open(6, { verdict: 'running', autoMerge: { method: 'SQUASH' } }), // already set
      open(7, { verdict: 'conflicts', mergeable: false, mergeableState: 'dirty' }),
      open(8, { verdict: 'draft', draft: true }),
    ];
    expect(planPullActions(prs, { mergeWhenGreen: true, method: 'merge' })).toEqual([
      { action: 'merge', number: 1, sha: 'sha1', method: 'merge' },
      { action: 'auto-merge', number: 2, sha: 'sha2', method: 'merge' },
      { action: 'auto-merge', number: 3, sha: 'sha3', method: 'merge' },
      { action: 'auto-merge', number: 4, sha: 'sha4', method: 'merge' },
      { action: 'auto-merge', number: 5, sha: 'sha5', method: 'merge' },
    ]);
  });

  it('sets merge when green before updating, since the update is a new head commit', () => {
    expect(planPullActions([open(1, { mergeableState: 'behind', verdict: 'behind' })], both)).toEqual([
      { action: 'auto-merge', number: 1, sha: 'sha1', method: 'squash' },
      { action: 'update-branch', number: 1, sha: 'sha1' },
    ]);
  });

  it('leaves alone the pull requests the owner turned merge when green off on', () => {
    const prs = [open(1, { verdict: 'ready', mergeableState: 'clean' }), open(2)];
    expect(planPullActions(prs, { ...both, skip: new Set([1, 2]) })).toEqual([]);
  });

  it('tries each action on a head commit once', () => {
    const prs = [open(1, { mergeableState: 'behind', verdict: 'behind' }), open(2)];
    const tried = new Set([
      actionKey({ action: 'update-branch', number: 1, sha: 'sha1' }),
      actionKey({ action: 'auto-merge', number: 2, sha: 'sha2' }),
    ]);
    expect(planPullActions(prs, { ...both, tried })).toEqual([
      { action: 'auto-merge', number: 1, sha: 'sha1', method: 'squash' },
    ]);
    // A new push is a new head commit: it gets its own try.
    expect(planPullActions([open(2, { headSha: 'newer' })], { ...both, tried })).toEqual([
      { action: 'auto-merge', number: 2, sha: 'newer', method: 'squash' },
    ]);
  });

  it('never acts without the head commit to send', () => {
    expect(planPullActions([open(1, { headSha: null, mergeableState: 'behind', verdict: 'behind' })], both)).toEqual(
      [],
    );
  });
});
