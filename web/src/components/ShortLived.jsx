import { useEffect, useState } from 'preact/hooks';
import { Server } from 'lucide-preact';
import { ago, ref } from '../lib/model.js';
import { api, enc } from '../lib/api.js';
import { confirmDialog, hashFor, toast } from '../lib/store.js';

/**
 * A task's short-lived environment on its panel (WEB-95; BRK-200): the one it has, with its state and plan, or
 * **Give it an environment** where its repository has a template for them. Asking is the owner's, from the signed-in
 * board only (agents tag their task +environment instead), and it only adds the environment and makes the plan that
 * makes it, which waits for you under the default policy.
 */

/** A request's state (src/infra-short-lived.js's SHORT_LIVED_STATES), in words. */
const STATE = {
  creating: 'Being made',
  ready: 'Ready',
  removing: 'Being removed',
  removed: 'Removed',
  refused: 'Refused',
};

/** How long one repository's read stays fresh, so opening task after task doesn't read it each time. */
const FRESH_MS = 30_000;
/** @type {Map<string, { at: number, read: Promise<any> }>} */
const reads = new Map();

/** The repository's requests and template, read once per FRESH_MS; `again` reads now. */
function readShortLived(/** @type {string} */ repo, again = false) {
  const had = reads.get(repo);
  if (!again && had && Date.now() - had.at < FRESH_MS) return had.read;
  const read = api(`infra/short-lived?repo=${enc(repo)}`);
  reads.set(repo, { at: Date.now(), read });
  read.catch(() => reads.delete(repo));
  return read;
}

/** @param {{ task: any }} props */
export function ShortLivedSection({ task: t }) {
  const repo = t.repo ?? '';
  const [state, setState] = useState(/** @type {{ request: any, template: any } | null} */ (null));
  const [busy, setBusy] = useState(false);
  const show = (/** @type {any} */ body) =>
    setState({
      request: body.shortLived.find((/** @type {any} */ r) => r.task?.uuid === t.uuid) ?? null,
      template: body.templates.find((/** @type {any} */ x) => x.repo === repo)?.template ?? null,
    });
  useEffect(() => {
    if (!repo) return undefined;
    let live = true;
    setState(null);
    // A board without Architect's routes, or a read that fails, leaves the section away: it's never in the way.
    readShortLived(repo).then(
      (body) => live && show(body),
      () => live && setState(null),
    );
    return () => {
      live = false;
    };
  }, [t.uuid, repo, t.modified]);

  if (!state || ['ideas', 'routines'].includes(t.project)) return null;
  const r = state.request;
  const has = r && !['refused', 'removed'].includes(r.state);
  const canAsk = t.status === 'pending' && Boolean(state.template);
  if (!r && !canAsk) return null;

  const ask = async () => {
    const ok = await confirmDialog({
      title: `Give ${ref(t)} an environment?`,
      body: 'The board adds a short-lived environment named after the task, from the repository’s template, and makes the plan that makes it. The plan waits for you unless the policy lets it through. It goes when the task closes.',
      confirmLabel: 'Give it an environment',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const { shortLived } = await api(`infra/short-lived/${enc(t.uuid)}`, { method: 'POST', body: { by: 'owner' } });
      toast(
        shortLived.createPlan
          ? `Added ${shortLived.name}. ${shortLived.createPlan} makes it.`
          : `Added ${shortLived.name}.`,
        'success',
      );
      show(await readShortLived(repo, true));
    } catch (error) {
      toast(error.message, 'error');
      readShortLived(repo, true).then(show, () => {});
    } finally {
      setBusy(false);
    }
  };

  const envLink = (/** @type {string | null} */ plan = null) =>
    hashFor({ view: 'infrastructure', environment: String(r.environment), plan, task: null });
  return (
    <section class="panel-section" aria-labelledby={`short-lived-${t.uuid}`}>
      <h3 id={`short-lived-${t.uuid}`}>
        <Server size={14} aria-hidden="true" /> Environment
      </h3>
      {has ? (
        <p class="meta">
          {r.environment !== null ? <a href={envLink()}>{r.name}</a> : <code>{r.name}</code>}
          {' · '}
          {STATE[r.state] ?? r.state}
          {r.state === 'creating' && r.createPlan && r.environment !== null && (
            <>
              {', by '}
              <a href={envLink(r.createPlan)}>{r.createPlan}</a>
            </>
          )}
          {r.state === 'removing' && r.removePlan && r.environment !== null && (
            <>
              {', by '}
              <a href={envLink(r.removePlan)}>{r.removePlan}</a>
            </>
          )}
          {r.created && <> · asked {ago(r.created)}</>}
        </p>
      ) : (
        <>
          {r?.state === 'refused' && r.error && (
            <p class="meta">
              Last asked {ago(r.updated)}: refused. {r.error}.
            </p>
          )}
          {r?.state === 'removed' && <p class="meta">Its environment, {r.name}, was removed.</p>}
          {!r && <p class="meta">No environment of its own.</p>}
          {canAsk && (
            <div class="conn-buttons">
              <button type="button" class="btn btn-quiet btn-sm" onClick={ask} disabled={busy} aria-busy={busy}>
                <Server size={16} aria-hidden="true" />
                {busy ? 'Asking…' : 'Give it an environment'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
