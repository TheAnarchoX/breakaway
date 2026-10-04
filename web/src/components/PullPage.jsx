import { useEffect, useState } from 'preact/hooks';
import {
  ArrowLeft,
  ChevronRight,
  CircleCheck,
  CircleX,
  ExternalLink,
  LoaderCircle,
  MessageSquare,
} from 'lucide-preact';
import { ago, plural } from '../lib/model.js';
import { api } from '../lib/api.js';
import {
  actions,
  agents,
  confirmDialog,
  github,
  hashFor,
  loadGitHub,
  mergeMethod,
  mergeSkip,
  openPull,
  pullRef,
  pullSetting,
  repos,
  skipKey,
  skipMergeWhenGreen,
  toast,
} from '../lib/store.js';
import { Markdown, Title } from '../lib/richtext.jsx';
import { RepoChip } from './ui.jsx';
import { Checks, PrIcon, Review, VERDICT, Verdict, prStateLabel } from './GitHub.jsx';
import { useMedia } from '../lib/media.js';
import { Dialog } from './ui.jsx';

const ext = { target: '_blank', rel: 'noopener noreferrer' };

/** A patch as rows: old and new line numbers, a marker as text (not colour alone), and the code. */
function parsePatch(patch) {
  const rows = [];
  let a = 0;
  let b = 0;
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/u.exec(line);
    if (hunk) {
      a = Number(hunk[1]);
      b = Number(hunk[2]);
      rows.push({ kind: 'hunk', text: line });
    } else if (line.startsWith('\\')) {
      rows.push({ kind: 'note', text: line.slice(2) });
    } else if (line.startsWith('+')) {
      rows.push({ kind: 'added', b, text: line.slice(1) });
      b += 1;
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'removed', a, text: line.slice(1) });
      a += 1;
    } else {
      rows.push({ kind: 'context', a, b, text: line.slice(1) });
      a += 1;
      b += 1;
    }
  }
  return rows;
}

const SIGN = { added: '+', removed: '−', context: ' ' };
const WORD = { added: 'added', removed: 'removed', context: 'unchanged' };

/** @param {Record<string, any>} props */
function Unified({ rows }) {
  return (
    <table class="diff" role="table">
      <tbody>
        {rows.map((r, i) =>
          r.kind === 'hunk' || r.kind === 'note' ? (
            <tr key={i} class={`diff-${r.kind}`}>
              <td colSpan={4}>{r.text}</td>
            </tr>
          ) : (
            <tr key={i} class={`diff-${r.kind}`}>
              <td class="diff-n" aria-hidden="true">
                {r.a ?? ''}
              </td>
              <td class="diff-n" aria-hidden="true">
                {r.b ?? ''}
              </td>
              <td class="diff-sign">
                <span aria-hidden="true">{SIGN[r.kind]}</span>
                <span class="visually-hidden">{WORD[r.kind]}: </span>
              </td>
              <td class="diff-code">
                <code>{r.text || ' '}</code>
              </td>
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

/**
 * Two columns: removed lines on the left, added on the right, paired in order within each change.
 * @param {Record<string, any>} props
 */
function Split({ rows }) {
  const out = [];
  for (let i = 0; i < rows.length; ) {
    const r = rows[i];
    if (r.kind === 'hunk' || r.kind === 'note') {
      out.push({ span: r });
      i += 1;
      continue;
    }
    if (r.kind === 'context') {
      out.push({ left: r, right: r });
      i += 1;
      continue;
    }
    const removed = [];
    const added = [];
    while (rows[i]?.kind === 'removed') {
      removed.push(rows[i]);
      i += 1;
    }
    while (rows[i]?.kind === 'added') {
      added.push(rows[i]);
      i += 1;
    }
    for (let k = 0; k < Math.max(removed.length, added.length); k += 1) out.push({ left: removed[k], right: added[k] });
  }
  const cell = (r, side) =>
    r ? (
      <>
        <td class={`diff-n diff-${r.kind}`} aria-hidden="true">
          {side === 'left' ? (r.a ?? '') : (r.b ?? '')}
        </td>
        <td class={`diff-code diff-${r.kind}`}>
          {r.kind !== 'context' && <span class="visually-hidden">{WORD[r.kind]}: </span>}
          <code>{r.text || ' '}</code>
        </td>
      </>
    ) : (
      <>
        <td class="diff-n" />
        <td class="diff-code diff-empty" />
      </>
    );
  // The columns' widths are set here, not by the first row: that's often a hunk spanning all four (WEB-7).
  return (
    <table class="diff diff-split" role="table">
      <colgroup>
        <col class="diff-col-n" />
        <col />
        <col class="diff-col-n" />
        <col />
      </colgroup>
      <tbody>
        {out.map((row, i) =>
          row.span ? (
            <tr key={i} class={`diff-${row.span.kind}`}>
              <td colSpan={4}>{row.span.text}</td>
            </tr>
          ) : (
            <tr key={i}>
              {cell(row.left, 'left')}
              {cell(row.right, 'right')}
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

/** @param {Record<string, any>} props */
function FileDiffView({ file, split, url, open: startOpen }) {
  const [open, setOpen] = useState(startOpen);
  const id = `file-${file.name.replace(/[^\w-]/gu, '-')}`;
  const rows = open && file.patch ? parsePatch(file.patch) : null;
  return (
    <section class="diff-file" aria-labelledby={id}>
      <h3 id={id}>
        <button type="button" class="diff-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRight size={16} aria-hidden="true" class={open ? 'turned' : ''} />
          <code>{file.from ? `${file.from} → ${file.name}` : file.name}</code>
        </button>
        <span class="diff-stat">
          <span class="stat-added">
            +{file.added}
            <span class="visually-hidden"> lines added</span>
          </span>
          <span class="stat-removed">
            −{file.removed}
            <span class="visually-hidden"> lines removed</span>
          </span>
          {file.status !== 'modified' && <span class="meta">{file.status}</span>}
          {file.worker && <span class="chip">runs in a Worker</span>}
        </span>
      </h3>
      {open &&
        (file.patch ? (
          split ? (
            <Split rows={rows} />
          ) : (
            <Unified rows={rows} />
          )
        ) : (
          <p class="muted small diff-none">
            Too large or binary to show here.{' '}
            <a href={`${url}/files`} {...ext}>
              See it on GitHub
              <ExternalLink size={13} aria-hidden="true" />
            </a>
          </p>
        ))}
    </section>
  );
}

/** @param {Record<string, any>} props */
function Diff({ page }) {
  const wide = useMedia('(min-width: 1100px)');
  const [split, setSplit] = useState(false);
  const [onlyWorkers, setOnlyWorkers] = useState(false);
  const files = page.files.filter((f) => !onlyWorkers || f.worker);
  const many = page.files.length > 20;
  return (
    <section class="gh-section" aria-labelledby="pr-files">
      <div class="pr-files-head">
        <h2 id="pr-files">
          Files changed <span class="count">{page.files.length}</span>
        </h2>
        <div class="pr-files-tools">
          {/* Only where the repository has a pipeline whose deploy paths are known: elsewhere no file runs in a Worker. */}
          {page.pipeline !== null && page.pipeline?.known !== false && (
            <label class="check-inline">
              <input type="checkbox" checked={onlyWorkers} onChange={(e) => setOnlyWorkers(e.currentTarget.checked)} />{' '}
              Only files that run in a Worker
            </label>
          )}
          {wide && (
            <button type="button" class="btn btn-outline btn-sm" aria-pressed={split} onClick={() => setSplit(!split)}>
              {split ? 'Unified view' : 'Split view'}
            </button>
          )}
        </div>
      </div>
      {page.filesTruncated && (
        <p class="muted small">
          GitHub lists at most 300 files here.{' '}
          <a href={`${page.url}/files`} {...ext}>
            See the rest on GitHub
          </a>
          .
        </p>
      )}
      {files.length ? (
        files.map((f) => <FileDiffView key={f.name} file={f} split={split && wide} url={page.url} open={!many} />)
      ) : (
        <p class="muted small">No files match.</p>
      )}
    </section>
  );
}

/** @param {Record<string, any>} props */
function Conversation({ page }) {
  const reviews = page.reviews.filter((r) => r.body);
  if (!reviews.length && !page.threads.length) return null;
  return (
    <section class="gh-section" aria-labelledby="pr-talk">
      <h2 id="pr-talk">
        <MessageSquare size={18} aria-hidden="true" />
        Conversation <span class="count">{reviews.length + page.threads.length}</span>
      </h2>
      <p class="meta">
        Read-only. Reply on{' '}
        <a href={page.url} {...ext}>
          GitHub
        </a>{' '}
        for now.
      </p>
      <ul class="pr-talk">
        {reviews.map((r, i) => (
          <li key={`r${i}`}>
            <span class="meta">
              <strong>{r.by}</strong> {r.state.toLowerCase().replace('_', ' ')} · {ago(r.at)}
            </span>
            <p>{r.body}</p>
          </li>
        ))}
        {page.threads.map((t) => (
          <li key={t.comments[0].id} class="pr-thread">
            {t.path && <code class="gh-branch">{t.path}</code>}
            {t.comments.map((c) => (
              <div key={c.id}>
                <span class="meta">
                  <strong>{c.by}</strong> ·{' '}
                  <a href={c.url} {...ext}>
                    {ago(c.at)}
                  </a>
                </span>
                <p>{c.body}</p>
              </div>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * What merging does now, from the Workers the pull request's files match in its repository's pipeline: a staging
 * Worker waits for Promote, any other deploys itself. Without a pipeline, or when its deploy paths can't be read,
 * nothing is said (null).
 */
function mergeEffect(page) {
  if (page.pipeline === null || (page.pipeline && page.pipeline.known === false)) return null;
  if (!page.deploys) return 'Docs or tooling only: it deploys nothing.';
  const staged = page.pipeline && page.workers.includes(page.pipeline.staging);
  const direct = page.workers.filter((w) => !page.pipeline || w !== page.pipeline.staging);
  const parts = [];
  if (staged) parts.push('Merging deploys to staging. Promote it from the GitHub view to put it live.');
  if (direct.length) parts.push(`Merging deploys ${direct.join(' and ')}.`);
  return parts.join(' ');
}

/** The repository on the board's calls for this page: none for the default repository's, as before. */
const repoBody = (page) => (page.isDefault === false ? { repo: page.repo } : {});

const METHODS = { squash: 'Squash', merge: 'Merge commit' };

/**
 * Merge or Merge when green: the method, what closes, and whether it deploys, before anything happens.
 * @param {Record<string, any>} props
 */
function MergeDialog({ page, mode, onClose, onDone }) {
  const [method, setMethod] = useState(mergeMethod.value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const later = mode === 'auto';
  const closes = page.tasks.filter((t) => t.closes);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`github/pulls/${page.number}/${later ? 'auto-merge' : 'merge'}`, {
        method: 'POST',
        body: { sha: page.headSha, method, ...repoBody(page) },
      });
      mergeMethod.value = method;
      if (later) skipMergeWhenGreen(page.number, false, page.repo); // turned back on by hand: the setting looks after it again
      toast(later ? `#${page.number} will merge when its checks pass.` : `Merged #${page.number}.`);
      onDone();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} labelledBy="merge-title" className="dialog-small">
      <div class="sheet">
        <h2 id="merge-title">
          {later ? 'Merge when green' : 'Merge'} #{page.number}?
        </h2>
        <p>
          <Title text={page.title} />
        </p>
        <fieldset class="merge-methods">
          <legend class="meta">How</legend>
          {Object.entries(METHODS).map(([id, label]) => (
            <label key={id} class="check-inline">
              <input type="radio" name="merge-method" checked={method === id} onChange={() => setMethod(id)} /> {label}
            </label>
          ))}
        </fieldset>
        <ul class="merge-facts">
          {closes.length > 0 && <li>Finishes {closes.map((t) => t.wid).join(', ')}.</li>}
          {mergeEffect(page) && <li>{mergeEffect(page)}</li>}
          <li>The commit takes the pull request’s title and description.</li>
          {later && <li>GitHub merges it once every required check passes, if nothing new is pushed first.</li>}
        </ul>
        {error && (
          <p class="field-error" role="alert">
            {error}
          </p>
        )}
        <div class="sheet-actions">
          <button type="button" class="btn btn-quiet" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" class="btn btn-primary" onClick={submit} disabled={busy} aria-busy={busy}>
            {later ? 'Merge when green' : 'Merge'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Publish (on a draft), Update branch, Merge, and Merge when green. The server refuses anything but a signed-in browser.
 * @param {Record<string, any>} props
 */
function PrActions({ page, reload }) {
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  if (page.state !== 'open') return null;
  const done = () => {
    setDialog(null);
    reload();
    loadGitHub();
  };
  const publish = async () => {
    const closes = page.tasks.filter((t) => t.closes).map((t) => t.wid);
    const ok = await confirmDialog({
      title: `Publish #${page.number}?`,
      body: [
        'This marks it ready for review and runs its checks as a normal pull request.',
        closes.length ? `Merging it finishes ${closes.join(', ')}.` : null,
        pullSetting(page.repo, 'merge')
          ? 'Your Merge when green setting is on, so it merges as soon as its checks pass.'
          : null,
      ]
        .filter(Boolean)
        .join(' '),
      confirmLabel: 'Publish',
    });
    if (!ok) return;
    setBusy(true);
    setProblem(null);
    try {
      await api(`github/pulls/${page.number}/publish`, {
        method: 'POST',
        body: { sha: page.headSha, ...repoBody(page) },
      });
      toast(`Published #${page.number}. It’s ready for review.`);
      done();
    } catch (e) {
      setProblem(e.message);
    }
    setBusy(false);
  };
  // A button that can't work says why (from the last Connections check), instead of failing when pressed.
  const write = page.access?.write ?? { ok: true, reason: null };
  const autoMerge = page.access?.autoMerge ?? { ok: true, reason: null };
  const why = !write.ok ? write.reason : !autoMerge.ok ? autoMerge.reason : null;
  const whyId = `pr-why-${page.repo}-${page.number}`;
  if (page.draft) {
    return (
      <div class="pr-actions">
        <button
          type="button"
          class="btn btn-primary btn-sm"
          onClick={publish}
          disabled={busy || !write.ok}
          aria-describedby={!write.ok ? whyId : undefined}
        >
          Publish…
        </button>
        {!write.ok && (
          <p class="meta" id={whyId}>
            {write.reason}
          </p>
        )}
        {problem && (
          <p class="field-error" role="alert">
            {problem}
          </p>
        )}
      </div>
    );
  }
  const updateBranch = async () => {
    const ok = await confirmDialog({
      title: `Update #${page.number} with main?`,
      body: 'This adds a merge commit from main to the branch. Its checks run again.',
      confirmLabel: 'Update branch',
    });
    if (!ok) return;
    setBusy(true);
    setProblem(null);
    try {
      await api(`github/pulls/${page.number}/update-branch`, {
        method: 'POST',
        body: { sha: page.headSha, ...repoBody(page) },
      });
      toast(`Updated #${page.number} with main. Its checks are running again.`);
      done();
    } catch (e) {
      setProblem(e.message);
    }
    setBusy(false);
  };
  const turnOff = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await api(`github/pulls/${page.number}/auto-merge`, {
        method: 'POST',
        body: { sha: page.headSha, enable: false, ...repoBody(page) },
      });
      skipMergeWhenGreen(page.number, true, page.repo); // so the Merge when green setting doesn't turn it straight back on
      toast(`Merge when green is off for #${page.number}.`);
      done();
    } catch (e) {
      setProblem(e.message);
    }
    setBusy(false);
  };
  const dependabot = /^dependabot(\[bot\])?$/iu.test(page.author ?? '');
  const review = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const r = await api(`github/pulls/${page.number}/review`, { method: 'POST', body: repoBody(page) });
      toast(
        r.run
          ? `Started an agent to test #${page.number}. Its answer comes as a note and a comment.`
          : `${r.task.wid} already has it: ${r.already}.`,
      );
      done();
    } catch (e) {
      setProblem(e.message);
    }
    setBusy(false);
  };
  const waiting = ['running', 'review', 'failing', 'behind'].includes(page.verdict);
  return (
    <div class="pr-actions">
      {page.verdict === 'behind' && (
        <button
          type="button"
          class="btn btn-primary btn-sm"
          onClick={updateBranch}
          disabled={busy || !write.ok}
          aria-describedby={!write.ok ? whyId : undefined}
        >
          Update branch
        </button>
      )}
      {page.verdict === 'ready' && (
        <button
          type="button"
          class="btn btn-primary btn-sm"
          onClick={() => setDialog('merge')}
          disabled={busy || !write.ok}
          aria-describedby={!write.ok ? whyId : undefined}
        >
          Merge…
        </button>
      )}
      {dependabot && (
        <button type="button" class="btn btn-outline btn-sm" onClick={review} disabled={busy}>
          Safe to merge?
        </button>
      )}
      {waiting && !page.autoMerge && (
        <button
          type="button"
          class="btn btn-outline btn-sm"
          onClick={() => setDialog('auto')}
          disabled={busy || !autoMerge.ok}
          aria-describedby={!autoMerge.ok ? whyId : undefined}
        >
          Merge when green…
        </button>
      )}
      {page.autoMerge && (
        <>
          <span class="meta">
            Will merge when green ({METHODS[page.autoMerge.method?.toLowerCase()] ?? 'as chosen'}).
          </span>
          <button type="button" class="btn btn-quiet btn-sm" onClick={turnOff} disabled={busy}>
            Turn off
          </button>
        </>
      )}
      {pullSetting(page.repo, 'merge') && mergeSkip.value.has(skipKey(page.number, page.repo)) && !page.autoMerge && (
        <p class="meta">Your Merge when green setting leaves this one alone, because you turned it off here.</p>
      )}
      {why && (page.verdict === 'behind' || page.verdict === 'ready' || (waiting && !page.autoMerge)) && (
        <p class="meta" id={whyId}>
          {why}
        </p>
      )}
      {problem && (
        <p class="field-error" role="alert">
          {problem}
        </p>
      )}
      {dialog && <MergeDialog page={page} mode={dialog} onClose={() => setDialog(null)} onDone={done} />}
    </div>
  );
}

/** What an agent could fix on this PR, in the order the status strip cares about. */
function fixesFor(page) {
  if (page.state !== 'open' || page.draft) return [];
  const list = [];
  if (page.verdict === 'conflicts') list.push({ problem: 'conflicts', label: 'Fix conflicts with an agent' });
  if (page.verdict === 'failing') list.push({ problem: 'failing', label: 'Fix failing checks with an agent' });
  if (page.review.decision === 'changes_requested' || page.review.comments > 0)
    list.push({ problem: 'review', label: 'Address review comments with an agent' });
  return list;
}

/** @param {Record<string, any>} props */
function FixWithAgent({ page, reload }) {
  const [busy, setBusy] = useState(false);
  const fixes = fixesFor(page);
  if (!fixes.length) return null;
  // Someone's on its task already (WEB-6): say who, instead of offering to start another.
  if (page.agent) {
    const { wid, busy: what, session } = page.agent;
    return (
      <div class="pr-fix">
        <p class="meta" role="status">
          <a href={hashFor({ view: 'board', task: wid, pr: null })}>
            <span class="wid">{wid}</span>
          </a>
          : {what}.
          {session && (
            <>
              {' '}
              <a href={session} {...ext}>
                Open its session
                <ExternalLink size={13} aria-hidden="true" />
              </a>
            </>
          )}
        </p>
      </div>
    );
  }
  const connected = agents.value.data?.connected;
  const reason = agents.value.loaded && !connected ? 'the agent routine isn’t connected yet' : null;
  const run = async (problem) => {
    setBusy(true);
    await actions.fixPull(page, problem);
    setBusy(false);
    reload();
  };
  return (
    <div class="pr-fix">
      {fixes.map((f) => (
        <button
          key={f.problem}
          type="button"
          class="btn btn-outline btn-sm"
          disabled={busy || Boolean(reason)}
          aria-describedby={reason ? 'pr-fix-hint' : undefined}
          onClick={() => run(f.problem)}
        >
          {f.label}
        </button>
      ))}
      <p class="meta" id="pr-fix-hint">
        {reason
          ? `Can’t start one: ${reason}.`
          : 'The agent pushes a fix to this branch, or leaves a note. It never merges: that stays with you.'}
      </p>
    </div>
  );
}

/**
 * The pull request's description, as GitHub renders it, or its raw Markdown (WEB-8). Relative links point into
 * the pull request's own repository.
 * @param {Record<string, any>} props
 */
function Description({ page }) {
  const [raw, setRaw] = useState(false);
  const base = String(page.url ?? '').replace(/\/pull\/\d+$/u, '') || undefined;
  return (
    <section class="gh-section" aria-labelledby="pr-desc">
      <div class="pr-files-head">
        <h2 id="pr-desc">Description</h2>
        <button type="button" class="btn btn-outline btn-sm" onClick={() => setRaw(!raw)}>
          {raw ? 'Show formatted' : 'Show raw'}
        </button>
      </div>
      {raw ? (
        <pre class="pr-body">{page.body}</pre>
      ) : (
        <div class="pr-body pr-body-md">
          <Markdown text={page.body} base={base} />
        </div>
      )}
    </section>
  );
}

export function PullPage() {
  const { number, repo } = pullRef.value ?? { number: null, repo: null };
  const [state, setState] = useState({ page: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((prev) => (tick ? { ...prev, error: null } : { page: null, error: null, loading: true }));
    api(`github/pulls/${number}${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`)
      .then((page) => {
        if (live) setState({ page, error: null, loading: false });
      })
      .catch((error) => {
        if (live) setState({ page: null, error: error.message, loading: false });
      });
    return () => {
      live = false;
    };
  }, [number, repo, tick]);

  const { page, error, loading } = state;
  // While an agent is on its task, look again each minute, so the page follows it and Fix with an agent comes back after.
  const onIt = page?.agent?.busy ?? null;
  useEffect(() => {
    if (!onIt) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') setTick((n) => n + 1);
    }, 60_000);
    return () => clearInterval(timer);
  }, [onIt]);
  // While offline or failing, the last synced summary still says what it can.
  const known = [...(github.value.data?.open ?? []), ...(github.value.data?.closed ?? [])].find(
    (p) => String(p.number) === String(number) && (repo ? p.repo === repo : !p.repo || p.repo === repos.value.default),
  );
  const back = (
    <a
      class="btn btn-quiet btn-sm pr-back"
      href={hashFor({ view: 'github', task: null, pr: null })}
      onClick={(e) => {
        e.preventDefault();
        openPull(null);
      }}
    >
      <ArrowLeft size={16} aria-hidden="true" />
      All pull requests
    </a>
  );
  if (loading)
    return (
      <div class="github-view pr-page">
        {back}
        <p class="muted" aria-busy="true">
          Reading #{number} from GitHub…
        </p>
      </div>
    );
  if (error) {
    return (
      <div class="github-view pr-page">
        {back}
        <p class="field-error" role="alert">
          Couldn’t read #{number} from GitHub: {error}
        </p>
        {known && (
          <p class="muted">
            Last synced {ago(github.value.data.lastSync)} (may be out of date): <Title text={known.title} />
            {known.verdict && (
              <>
                {' '}
                · <Verdict verdict={known.verdict} />
              </>
            )}
          </p>
        )}
      </div>
    );
  }
  const v = VERDICT[page.verdict];
  return (
    <div class="github-view pr-page">
      {back}
      <div class="pr-top">
        <header class="pr-head">
          <h1>
            <PrIcon pr={page} size={22} /> <span class="gh-num">#{page.number}</span> <Title text={page.title} />
          </h1>
          <p class="meta">
            <RepoChip slug={page.repo} />
            <span class={`gh-state gh-state-${page.state}${page.draft ? ' gh-state-draft' : ''}`}>
              {prStateLabel(page)}
            </span>{' '}
            <code class="gh-branch">{page.branch}</code> into <code class="gh-branch">{page.base}</code>
            {page.author && ` · by ${page.author}`} · {plural(page.commits, 'commit')} · updated {ago(page.updated)} ·{' '}
            <a href={page.url} {...ext}>
              Open on GitHub
              <ExternalLink size={13} aria-hidden="true" />
            </a>
          </p>
          {page.tasks.length > 0 && (
            <p class="gh-pr-tasks">
              {page.tasks.map((t) => (
                <a
                  key={t.uuid}
                  class={`gh-task ${t.closes ? 'gh-task-closes' : ''}`}
                  href={hashFor({ view: 'board', task: t.wid, pr: null })}
                >
                  <span class="wid">{t.wid}</span>
                  <span class="gh-task-kind">
                    {t.closes ? 'closes' : t.elsewhere ? `mentions, it belongs to ${t.elsewhere}` : 'mentions'}
                  </span>
                </a>
              ))}
            </p>
          )}
        </header>

        <section class={`pr-status ${v ? `pr-status-${v.tone}` : ''}`} aria-labelledby="pr-status-title">
          <h2 id="pr-status-title" class="visually-hidden">
            Status
          </h2>
          {page.state !== 'open' ? (
            <p>
              <strong>{prStateLabel(page)}</strong>
              {page.state === 'merged' ? ` into ${page.base ?? 'main'}.` : '.'}
            </p>
          ) : (
            <>
              <p class="pr-verdict">
                <Verdict verdict={page.verdict} />
              </p>
              <p class="meta">
                {v?.hint}
                {page.verdict === 'ready' && mergeEffect(page) && ` ${mergeEffect(page)}`}
              </p>
            </>
          )}
          <div class="pr-status-row">
            <Checks checks={page.checks} />
            <Review decision={page.review.decision} />
            {page.review.comments > 0 && <span class="meta">{plural(page.review.comments, 'review comment')}</span>}
          </div>
          {page.checks.runs.length > 0 && (
            <ul class="pr-checks">
              {page.checks.runs.map((r) => {
                const failed = [
                  'failure',
                  'timed_out',
                  'cancelled',
                  'action_required',
                  'startup_failure',
                  'error',
                ].includes(r.state);
                const passed = ['success', 'neutral', 'skipped'].includes(r.state);
                const Icon = failed ? CircleX : passed ? CircleCheck : LoaderCircle;
                return (
                  <li key={r.name} class={failed ? 'run-failure' : passed ? 'run-success' : 'run-pending'}>
                    <Icon size={15} aria-hidden="true" />
                    {r.url ? (
                      <a href={r.url} {...ext}>
                        {r.name}
                      </a>
                    ) : (
                      <span>{r.name}</span>
                    )}
                    <span class="meta">{failed ? 'failed' : passed ? 'passed' : 'running'}</span>
                  </li>
                );
              })}
            </ul>
          )}
          <PrActions page={page} reload={() => setTick((n) => n + 1)} />
          <FixWithAgent page={page} reload={() => setTick((n) => n + 1)} />
        </section>
      </div>

      {page.body && <Description page={page} />}
      <Conversation page={page} />
      <Diff page={page} />
    </div>
  );
}
