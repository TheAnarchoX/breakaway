import { useEffect, useState } from 'preact/hooks';
import { Footprints, TriangleAlert } from 'lucide-preact';
import { api, enc } from '../lib/api.js';
import { confirmDialog, toast } from '../lib/store.js';
import { KIND_WORDS, forgetFootprint, hitRateWords, pathMark, readFootprint } from '../lib/footprint.js';

/**
 * A task's footprint on its panel (IDEA-55 section 5): the paths it touches, each marked predicted, claimed (with when
 * the claim runs out), changed, or from the pull request, the shared files left out, any conflict, and the
 * repository's hit rate. You can release a claim from here; an agent's next edit claims the file again.
 */

/** How often an open task's footprint is read again while its panel is open: claims run out by the minute. */
const EVERY_MS = 60_000;

/** @param {{ task: any }} props */
export function FootprintSection({ task: t }) {
  const [fp, setFp] = useState(/** @type {any} */ (null));
  const [busy, setBusy] = useState('');
  const open = t.status === 'pending';
  const read = (again = false) => {
    let live = true;
    readFootprint(t.uuid, again).then(
      (body) => live && setFp(body),
      () => live && setFp(null),
    );
    return () => {
      live = false;
    };
  };
  useEffect(() => {
    if (!open || ['ideas', 'routines'].includes(t.project)) {
      setFp(null);
      return undefined;
    }
    setFp(null);
    let stop = read();
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      stop();
      stop = read(true);
    }, EVERY_MS);
    return () => {
      stop();
      clearInterval(id);
    };
  }, [t.uuid, t.modified, open]);

  if (!fp || fp.task === undefined) return null;
  const id = `fp-${t.uuid}`;
  const rate = hitRateWords(fp.hitRate);

  const release = async (/** @type {any} */ p) => {
    const ok = await confirmDialog({
      title: `Release ${p.pattern}?`,
      body: `${p.agent} stops holding it, and other agents can claim it. Its next edit there claims it again.`,
      confirmLabel: 'Release',
    });
    if (!ok) return;
    setBusy(p.pattern);
    try {
      await api(`tasks/${enc(t.uuid)}/paths`, { method: 'POST', body: { release: [p.pattern] } });
      toast('Released.');
      forgetFootprint(t.uuid);
      read(true);
    } catch (error) {
      toast(`Couldn’t release ${p.pattern}: ${error.message}`, 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <section class="panel-section fp-section" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>
        Footprint <span class="fp-kind">{KIND_WORDS[fp.kind] ?? fp.kind}</span>
      </h3>
      {fp.paths.length ? (
        <ul class="fp-list">
          {fp.paths.map((/** @type {any} */ p) => {
            const mark = pathMark(p);
            return (
              <li key={p.pattern} class={`fp-path fp-${p.state}`}>
                <code class="fp-pattern">{p.pattern}</code>
                <span class="fp-mark">
                  <span class="fp-label">{mark.label}</span>
                  {mark.detail && <span class="meta"> {mark.detail}</span>}
                </span>
                {p.state === 'claimed' && (
                  <button
                    type="button"
                    class="btn btn-quiet btn-sm fp-release"
                    disabled={busy === p.pattern}
                    aria-label={`Release ${p.pattern}, claimed by ${p.agent}`}
                    onClick={() => release(p)}
                  >
                    Release
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p class="muted small">
          Nothing names a path yet, so it’s scheduled by its area. Name the files it changes in its description, or its
          agent claims them as it works.
        </p>
      )}
      {fp.kind === 'predicted' && fp.trusted === false && (
        <p class="meta">Predictions miss too often in this repository, so this one holds nothing back.</p>
      )}
      {fp.pull && (
        <p class="meta">
          From pull request #{fp.pull.number}
          {fp.pull.partial ? ', which changes more files than GitHub lists' : ''}.
        </p>
      )}
      {(fp.conflicts ?? []).map((/** @type {any} */ c) => (
        <p key={`${c.path}-${c.task}`} class="fp-conflict">
          <TriangleAlert size={14} aria-hidden="true" />
          <span>
            Changed <code>{c.path}</code>, which {c.agent} claims on {c.task} (<code>{c.pattern}</code>). Agree who goes
            first on the peloton.
          </span>
        </p>
      ))}
      {fp.shared?.length > 0 && (
        <p class="meta">
          Left out, since most changes touch them:{' '}
          {fp.shared.map((/** @type {string} */ f, i) => (
            <span key={f}>
              {i ? ', ' : ''}
              <code>{f}</code>
            </span>
          ))}
          .
        </p>
      )}
      {rate && (
        <p class="meta fp-rate">
          <Footprints size={13} aria-hidden="true" /> {rate}
        </p>
      )}
    </section>
  );
}

/**
 * Why a held task waits, from a queue entry (the auto-start queue, agents next's skipped, the chase's queue): the
 * starter's words, with the file it would touch set as code when its footprint is what holds it.
 * @param {{ entry: { reason?: string | null, footprint?: { task: string, agent: string | null, path: string } | null } }} props
 */
export function HeldReason({ entry }) {
  const reason = entry.reason ?? '';
  const path = entry.footprint?.path;
  const at = path ? reason.indexOf(path) : -1;
  if (at < 0) return <>{reason}</>;
  return (
    <>
      {reason.slice(0, at)}
      <code class="fp-held">{path}</code>
      {reason.slice(at + path.length)}
    </>
  );
}

/**
 * The prediction's hit rate for each repository whose tasks a footprint holds (IDEA-55 section 5), read from one
 * held task's footprint per repository. Nothing until a merged task had a prediction to compare.
 * @param {{ entries: any[], repoLabel?: (slug: string) => string | null }} props
 */
export function HitRates({ entries, repoLabel }) {
  const held = new Map();
  for (const q of entries) if (q.footprint && q.repo && !held.has(q.repo)) held.set(q.repo, q.uuid);
  const key = [...held].map(([repo, uuid]) => `${repo}:${uuid}`).join(',');
  const [rates, setRates] = useState(/** @type {[string, string][]} */ ([]));
  useEffect(() => {
    let live = true;
    Promise.all(
      [...held].map(([repo, uuid]) =>
        readFootprint(uuid).then(
          (fp) => [repo, hitRateWords(fp?.hitRate)],
          () => [repo, null],
        ),
      ),
    ).then((list) => live && setRates(/** @type {[string, string][]} */ (list.filter(([, words]) => words))));
    return () => {
      live = false;
    };
  }, [key]);
  if (!rates.length) return null;
  return (
    <>
      {rates.map(([repo, words]) => {
        const label = repoLabel?.(repo);
        return (
          <p key={repo} class="meta fp-rate">
            <Footprints size={13} aria-hidden="true" /> {label ? `${label}: ${words}` : words}
          </p>
        );
      })}
    </>
  );
}
