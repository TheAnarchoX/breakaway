import { useState } from 'preact/hooks';
import { Check, CircleX, GitMerge, RefreshCw } from 'lucide-preact';
import { api, enc } from '../lib/api.js';
import { confirmDialog, mergeMethod, toast } from '../lib/store.js';
import { PlanPreview } from './EnvironmentChange.jsx';
import { mergeEffect } from './PullPage.jsx';

/**
 * The owner's buttons on a change the board proposed (BRK-258, BRK-260): Approve, Reject, Propose again, and Merge for
 * a change that plans nothing, which Approve also offers when it finds the head plans nothing (BRK-286). The console's card and the board's pull request page (WEB-105) show the same ones, so a
 * press does the same thing from either. Apply is never a button: Approve is the owner's press, and the board applies.
 *
 * @param {{
 *   change: any,
 *   env: { id: number | string, name: string, frozen?: boolean | number },
 *   card: { approve: boolean, merge: boolean, reject: boolean, again: boolean },
 *   page?: any,
 *   merges?: boolean,
 *   onChanged: (change: any) => void,
 * }} props `page` is the pull request page's data, when it's at hand; otherwise Approve and Merge read it to say
 *   whether merging deploys. `merges` is false where the page's own Merge merges a change that plans nothing. `onChanged` gets the change the board answers with (merged, after a Merge).
 */
export function ChangeActions({ change, env, card, page = null, merges = true, onChanged }) {
  const [busy, setBusy] = useState(/** @type {string | null} */ (null));
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [moved, setMoved] = useState(/** @type {any} */ (null));
  const [nothing, setNothing] = useState(false);
  // A plan that moved since the change was proposed can't be approved: proposing again plans it on the current head.
  // A head that plans nothing has nothing to approve: it merges (BRK-286).
  const can = moved
    ? { ...card, approve: false, merge: false, again: true }
    : nothing
      ? { ...card, approve: false, merge: merges, again: false }
      : card;
  const number = change.pull?.number;

  // Approve and Merge merge into the default branch: when the repository's pipeline deploys on merge, say so, as Merge does.
  const deployLine = async () => {
    const read =
      page ?? (number ? await api(`github/pulls/${enc(number)}?repo=${enc(change.repo)}`).catch(() => null) : null);
    return read?.deploys ? mergeEffect(read) : null;
  };

  const approve = async () => {
    const deploys = await deployLine();
    const ok = await confirmDialog({
      title: `Approve this plan for ${env.name}?`,
      body: `The board merges its pull request, applies the plan, and rolls back if the health check fails.${deploys ? ` ${deploys}` : ''}`,
      confirmLabel: 'Approve',
    });
    if (!ok) return;
    setBusy('approve');
    setError(null);
    try {
      const res = await api(`infra/changes/${enc(change.n)}/approve`, {
        method: 'POST',
        body: { sha: change.commit, digest: change.digest },
      });
      setMoved(null);
      onChanged(res.change);
      toast(`Approved: the board merges #${number} and applies the plan.`, 'success');
    } catch (err) {
      if (err.data?.nothing) {
        setNothing(true);
        if (err.data.change) onChanged(err.data.change);
      } else {
        setError(err.message);
        if (err.data?.changed && err.data.preview) setMoved(err.data.preview);
      }
    } finally {
      setBusy(null);
    }
  };
  const merge = async () => {
    const deploys = await deployLine();
    const ok = await confirmDialog({
      title: `Merge #${number}?`,
      body: `Nothing changes in ${env.name}: merging records it as code.${deploys ? ` ${deploys}` : ''}`,
      confirmLabel: 'Merge',
    });
    if (!ok) return;
    setBusy('merge');
    setError(null);
    try {
      await api(`github/pulls/${enc(number)}/merge`, {
        method: 'POST',
        body: { sha: change.commit, method: mergeMethod.value, repo: change.repo },
      });
      // The board follows the merge at its next sync; until then the card says it merged.
      onChanged({ ...change, state: 'merged', updated: new Date().toISOString() });
      setNothing(false);
      toast(`Merged #${number}: ${env.name} is recorded as code.`, 'success');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };
  const reject = async () => {
    const ok = await confirmDialog({
      title: 'Reject this change?',
      body: 'The board closes its pull request. Nothing changes.',
      confirmLabel: 'Reject',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy('reject');
    setError(null);
    try {
      const res = await api(`infra/changes/${enc(change.n)}/reject`, { method: 'POST', body: {} });
      onChanged(res.change);
      toast(`Rejected: #${number} is closed and nothing changes.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };
  const proposeAgain = async () => {
    setBusy('again');
    setError(null);
    try {
      const res = await api(`infra/environments/${enc(env.id)}/changes`, {
        method: 'POST',
        body: { edits: change.edits, propose: true },
      });
      setMoved(null);
      setNothing(false);
      onChanged(res.change);
      toast(
        res.change?.changes === 0
          ? `Proposed again on the current head: it plans nothing, so merge it.`
          : `Proposed again on the current head: the new plan needs your approval.`,
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {can.approve && env.frozen && (
        <p class="meta change-frozen">
          {`${env.name[0].toUpperCase()}${env.name.slice(1)}`} is frozen: unfreeze it to approve.
        </p>
      )}
      {moved && (
        <div class="change-moved">
          <p class="change-policy-lead">What runs changed since you looked. Here’s the plan now.</p>
          <PlanPreview preview={moved} />
        </div>
      )}
      {nothing && <p class="meta">{`Nothing changes in ${env.name}: merging #${number} records it as code.`}</p>}
      {error && !moved && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
      {(can.approve || can.merge || can.reject || can.again) && (
        <div class="change-actions">
          {can.reject && (
            <button type="button" class="btn btn-quiet btn-sm" onClick={reject} disabled={busy !== null}>
              <CircleX size={14} aria-hidden="true" />
              {busy === 'reject' ? 'Rejecting…' : 'Reject'}
            </button>
          )}
          {can.again && (
            <button type="button" class="btn btn-quiet btn-sm" onClick={proposeAgain} disabled={busy !== null}>
              <RefreshCw size={14} aria-hidden="true" />
              {busy === 'again' ? 'Proposing…' : 'Propose again'}
            </button>
          )}
          {can.merge && (
            <button
              type="button"
              class="btn btn-primary btn-sm"
              onClick={merge}
              disabled={busy !== null}
              aria-busy={busy === 'merge'}
            >
              <GitMerge size={14} aria-hidden="true" />
              {busy === 'merge' ? 'Merging…' : 'Merge'}
            </button>
          )}
          {can.approve && (
            <button
              type="button"
              class="btn btn-primary btn-sm"
              onClick={approve}
              disabled={busy !== null || Boolean(env.frozen)}
              aria-busy={busy === 'approve'}
            >
              <Check size={14} aria-hidden="true" />
              {busy === 'approve' ? 'Approving…' : 'Approve'}
            </button>
          )}
        </div>
      )}
    </>
  );
}
