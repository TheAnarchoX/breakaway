import { useEffect, useState } from 'preact/hooks';
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  ExternalLink,
  ListTodo,
  LoaderCircle,
  MessageSquare,
} from 'lucide-preact';
import { ago, canAgentReview, isDependabot, plural } from '../lib/model.js';
import { api, enc } from '../lib/api.js';
import {
  actions,
  agents,
  byUuid,
  confirmDialog,
  diffWrap,
  github,
  hashFor,
  isKickoffIdea,
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
import { diffPieces, previewOf } from '../lib/code.js';
import { CodeBlock, tokensOf, useHighlightAll } from '../lib/highlight.jsx';
import { FilePreview } from './FilePreview.jsx';
import { RepoChip } from './ui.jsx';
import { Checks, PrIcon, Review, VERDICT, Verdict, prStateLabel } from './GitHub.jsx';
import { costWords, policyWords, targetWords } from '../../../src/infra-pulls.js';
import { useMedia } from '../lib/media.js';
import { CARD, cardState, plansNothing } from '../lib/infra-change.js';
import { ChangeActions } from './ChangeActions.jsx';
import { Dialog, Segmented } from './ui.jsx';

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

/** A row's code: highlighted once its language loads (WEB-86), plain until then. */
const codeOf = (r) => (r.tokens?.length ? tokensOf(r.tokens) : r.text || ' ');

const SIGN = { added: '+', removed: '−', context: ' ' };
const WORD = { added: 'added', removed: 'removed', context: 'unchanged' };

/** @param {Record<string, any>} props */
function Unified({ rows, wrap }) {
  return (
    <table class={wrap ? 'diff diff-wrap' : 'diff'} role="table">
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
                <code>{codeOf(r)}</code>
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
          <code>{codeOf(r)}</code>
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

/**
 * A patch's rows with their code highlighted (WEB-86), each hunk's old and new sides as a whole; the plain rows until
 * the language loads.
 * @param {any[] | null} rows
 * @param {string} path
 */
function useHighlightedRows(rows, path) {
  const { pieces, at } = rows ? diffPieces(rows) : { pieces: null, at: [] };
  const lit = useHighlightAll(pieces, path);
  if (!rows || !lit) return rows;
  return rows.map((r, i) => (at[i] ? { ...r, tokens: lit[at[i][0]]?.[at[i][1]] ?? null } : r));
}

/** @param {Record<string, any>} props */
function FileDiffView({ page, file, split, wrap, url, open: startOpen }) {
  const [open, setOpen] = useState(startOpen);
  const preview = previewOf(file.name);
  // Diff or Preview, per file; a file with no patch (an image, a large file) opens on Preview when it has one.
  const [mode, setMode] = useState(preview && !file.patch ? 'preview' : 'diff');
  const id = `file-${file.name.replace(/[^\w-]/gu, '-')}`;
  const rows = useHighlightedRows(open && file.patch ? parsePatch(file.patch) : null, file.name);
  const showPreview = open && preview && mode === 'preview';
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
          {open && preview && (
            <Segmented
              label={`Show ${file.name} as`}
              size="xs"
              options={[
                { id: 'diff', label: 'Diff' },
                { id: 'preview', label: 'Preview' },
              ]}
              value={mode}
              onChange={setMode}
            />
          )}
        </span>
      </h3>
      {showPreview ? (
        <FilePreview page={page} file={file} kind={preview} split={split} />
      ) : (
        open &&
        (file.patch ? (
          split ? (
            <Split rows={rows} />
          ) : (
            <Unified rows={rows} wrap={wrap} />
          )
        ) : (
          <p class="muted small diff-none">
            Too large or binary to show here.{' '}
            <a href={`${url}/files`} {...ext}>
              See it on GitHub
              <ExternalLink size={13} aria-hidden="true" />
            </a>
          </p>
        ))
      )}
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
          {/* Split view always wraps, each side in its own column. */}
          {!(split && wide) && (
            <label class="check-inline">
              <input
                type="checkbox"
                checked={diffWrap.value}
                onChange={(e) => {
                  diffWrap.value = e.currentTarget.checked;
                }}
              />{' '}
              Wrap long lines
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
        files.map((f) => (
          <FileDiffView
            key={f.name}
            page={page}
            file={f}
            split={split && wide}
            wrap={diffWrap.value}
            url={page.url}
            open={!many}
          />
        ))
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
 * nothing is said (null). An approved change's confirm on the console says the same (WEB-99).
 */
export function mergeEffect(page) {
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
  const dependabot = isDependabot(page.author);
  const review = async () => {
    setBusy(true);
    setProblem(null);
    if (await actions.reviewPull(page, done)) done();
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
  // An agent's review that needs changes, of the branch as it is, counts as review comments (BRK-111).
  const agentChanges = page.agentReview?.verdict === 'changes' && !page.agentReview.moved;
  if (page.review.decision === 'changes_requested' || page.review.comments > 0 || agentChanges)
    list.push({ problem: 'review', label: 'Address review comments with an agent' });
  return list;
}

/** Review with an agent (WEB-23): a pull request that can merge as it stands and closes an open task. */
const reviewable = (page) => canAgentReview(page) && page.tasks.some((t) => t.closes && t.status === 'pending');

/**
 * Fix with an agent and Review with an agent: the buttons, or who's on the task already.
 * @param {Record<string, any>} props
 */
function AgentActions({ page, reload }) {
  const [busy, setBusy] = useState(false);
  const fixes = fixesFor(page);
  const review = reviewable(page);
  if (!fixes.length && !review) return null;
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
    await actions.fixPull(page, problem, reload);
    setBusy(false);
    reload();
  };
  const startReview = async () => {
    setBusy(true);
    await actions.reviewPull(page, reload);
    setBusy(false);
    reload();
  };
  const hint = [
    fixes.length ? 'The agent pushes a fix to this branch, or leaves a note.' : null,
    review ? 'A review checks the branch against its task and answers below the description.' : null,
    fixes.length ? 'It never merges: that stays with you.' : 'It never pushes or merges.',
  ]
    .filter(Boolean)
    .join(' ');
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
      {review && (
        <button
          type="button"
          class="btn btn-outline btn-sm"
          disabled={busy || Boolean(reason)}
          aria-describedby="pr-fix-hint"
          onClick={startReview}
        >
          Review with an agent
        </button>
      )}
      <p class="meta" id="pr-fix-hint">
        {reason ? `Can’t start one: ${reason}.` : hint}
      </p>
    </div>
  );
}

const REVIEW_ICON = { ready: CircleCheck, 'follow-up': ListTodo, changes: CircleX };

/**
 * The latest agent's review (WEB-23): its verdict, who, when, and the commit it reviewed, marked when the branch
 * has moved since, with the note as Markdown. Earlier ones stay as comments on the task.
 * @param {Record<string, any>} props
 */
function AgentReview({ page }) {
  const r = page.agentReview;
  if (!r) return null;
  const Icon = REVIEW_ICON[r.verdict] ?? CircleCheck;
  const base = String(page.url ?? '').replace(/\/pull\/\d+$/u, '') || undefined;
  const sha = r.sha ? r.sha.slice(0, 7) : null;
  return (
    <section class="gh-section agent-review" aria-labelledby="pr-agent-review">
      <h2 id="pr-agent-review">Agent review</h2>
      <p class="agent-review-head">
        <span class={`agent-review-verdict agent-review-${r.verdict}`}>
          <Icon size={16} aria-hidden="true" />
          {r.label}
        </span>
        <span class="meta">
          {r.agent} · <time dateTime={r.at}>{ago(r.at)}</time>
          {sha && (
            <>
              {' · of '}
              <a href={`${page.url}/commits/${r.sha}`} {...ext} aria-label={`commit ${sha}`}>
                <code>{sha}</code>
              </a>
            </>
          )}
          {r.task && (
            <>
              {' · on '}
              <a href={hashFor({ view: 'board', task: r.task, pr: null })}>
                <span class="wid">{r.task}</span>
              </a>
            </>
          )}
        </span>
      </p>
      {r.moved && (
        <p class="agent-review-moved">
          The branch has moved since this review: it’s of an earlier commit, not what would merge now.
        </p>
      )}
      <div class="pr-body pr-body-md">
        <Markdown text={r.note} base={base} />
      </div>
    </section>
  );
}

const INFRA_ICON = { success: CircleCheck, neutral: CircleAlert, failure: CircleX };
const INFRA_WORDS = { success: 'Passes', neutral: 'Couldn’t plan it all', failure: 'Fails' };
/** How many of a plan's changes the page lists before it says how many more. */
const INFRA_CHANGES = 10;

/** A policy reason's words, with its `names` as code. */
const withCode = (text) =>
  String(text)
    .split('`')
    .map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));

/** One environment's part of the infrastructure check. */
function InfraEnvironment({ e }) {
  const p = e.preview;
  let body;
  if (e.state === 'invalid')
    body = (
      <p>
        <code>{e.path}</code> doesn’t check{e.error?.line ? ` on line ${e.error.line}` : ''}.{' '}
        {e.error?.field && <code>{e.error.field}</code>}
        {e.error?.field && ': '}
        {e.error?.message}
      </p>
    );
  else if (e.state !== 'planned') body = <p>{e.problem}</p>;
  else if (!p?.changes)
    body = (
      <p>
        Nothing to change: {e.environment} already matches <code>{e.path}</code>.
      </p>
    );
  else
    body = (
      <>
        <p class="meta">
          {plural(p.changes, 'change')} · {costWords(p.cost)} · {p.reversible ? 'can be undone' : 'can’t all be undone'}
          {p.blastRadius?.affected ? ` · touches ${plural(p.blastRadius.affected, 'other resource')}` : ''}
        </p>
        <ul class="infra-pr-changes">
          {p.diff.changes.slice(0, INFRA_CHANGES).map((c) => (
            <li key={`${c.op}:${c.resource}`}>
              <span class="infra-pr-op">{c.op}</span> {c.name} <span class="meta">{c.kind}</span>
            </li>
          ))}
        </ul>
        {p.changes > INFRA_CHANGES && <p class="meta">And {plural(p.changes - INFRA_CHANGES, 'more change')}.</p>}
        {p.policy && (
          <>
            <p>
              <strong>{policyWords(p.policy)}</strong>
            </p>
            <ul class="infra-pr-reasons">
              {p.policy.reasons.map((r) => (
                <li key={r}>{withCode(r)}</li>
              ))}
            </ul>
          </>
        )}
      </>
    );
  return (
    <div class="infra-pr-env">
      <h3>{e.environment}</h3>
      {e.state === 'planned' && e.target && <p class="meta">{targetWords(e)}</p>}
      {body}
    </div>
  );
}

/**
 * The plan a pull request's infrastructure files would make (BRK-185): what its check on GitHub says, from what the
 * board kept when it looked at the head. Merging applies nothing; the plan made from the default branch waits for you.
 * @param {Record<string, any>} props
 */
function InfraPlan({ page }) {
  const r = page.infra;
  if (!r) return null;
  const Icon = INFRA_ICON[r.conclusion] ?? CircleAlert;
  const sha = r.sha ? r.sha.slice(0, 7) : null;
  return (
    <section class="gh-section infra-pr" aria-labelledby="pr-infra">
      <h2 id="pr-infra">Infrastructure plan</h2>
      <p class="agent-review-head">
        <span class={`agent-review-verdict infra-pr-${r.conclusion}`}>
          <Icon size={16} aria-hidden="true" />
          {INFRA_WORDS[r.conclusion] ?? r.conclusion}: {r.title}
        </span>
        <span class="meta">
          <time dateTime={r.checkedAt}>{ago(r.checkedAt)}</time>
          {sha && (
            <>
              {' · of '}
              <a href={`${page.url}/commits/${r.sha}`} {...ext} aria-label={`commit ${sha}`}>
                <code>{sha}</code>
              </a>
            </>
          )}
          {r.check?.url && (
            <>
              {' · '}
              <a href={r.check.url} {...ext}>
                the check on GitHub
              </a>
            </>
          )}
        </span>
      </p>
      {page.headSha && r.sha !== page.headSha && (
        <p class="agent-review-moved">
          The branch has moved since: this is of an earlier commit. The board looks again on its next sync.
        </p>
      )}
      {r.error && <p class="agent-review-moved">{r.error}. The plan still shows here.</p>}
      {(r.problems ?? []).map((x) => (
        <p key={x.path}>
          <code>{x.path}</code>: {x.message}
        </p>
      ))}
      {r.policy && !r.policy.ok && (
        <p>
          <code>{r.policy.path}</code> doesn’t check{r.policy.error?.line ? ` on line ${r.policy.error.line}` : ''}:{' '}
          {r.policy.error?.message} Until it’s fixed, the default policy decides.
        </p>
      )}
      {(r.environments ?? []).map((e) => (
        <InfraEnvironment key={e.environment} e={e} />
      ))}
      {r.skipped > 0 && (
        <p class="meta">{plural(r.skipped, 'more environment')} not planned: split the pull request to see them.</p>
      )}
      <p class="meta">
        Merging applies nothing. Once it’s merged, the board plans from the default branch, and the plan waits for you
        on the board unless the policy lets it through.
      </p>
    </section>
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
        <CodeBlock code={page.body} lang="md" class="pr-body" />
      ) : (
        <div class="pr-body pr-body-md">
          <Markdown text={page.body} base={base} />
        </div>
      )}
    </section>
  );
}

/**
 * The kickoff whose plan this pull request is (WEB-48): the one whose IDEA it closes, finished or not, or null. An IDEA
 * the board hasn't loaded is asked about by its work ID alone.
 */
function useKickoff(page) {
  const idea = page?.tasks.find((t) => {
    if (!t.closes) return false;
    const known = byUuid.value.get(t.uuid);
    return known ? isKickoffIdea(known) : t.wid.startsWith('IDEA-');
  });
  const uuid = idea?.uuid ?? null;
  const [kickoff, setKickoff] = useState(null);
  useEffect(() => {
    setKickoff(null);
    if (!uuid) return;
    let live = true;
    api(`kickoffs?idea=${encodeURIComponent(uuid)}`)
      .then((data) => {
        if (live) setKickoff(data.kickoffs?.[0] ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [uuid]);
  return kickoff;
}

/** The way back to the kickoff: alongside Merge while it's open, and the next thing to do once it's merged. */
function BackToKickoff({ kickoff, page }) {
  const merged = page.state === 'merged';
  const href = hashFor({ view: 'kickoff', kickoff: kickoff.id, task: null, pr: null, ping: null });
  return (
    <div class="pr-actions pr-kickoff">
      <p class="meta">
        {merged
          ? `${kickoff.name}’s plan is in. Its first tasks are waiting on its kickoff page.`
          : `This is ${kickoff.name}’s plan. Once it’s merged, you start building from its kickoff page.`}
      </p>
      <a class={`btn ${merged ? 'btn-primary' : 'btn-outline'} btn-sm`} href={href}>
        {merged ? (
          <>
            Back to {kickoff.name}: start building
            <ArrowRight size={16} aria-hidden="true" />
          </>
        ) : (
          <>
            <ArrowLeft size={16} aria-hidden="true" />
            Back to {kickoff.name}’s kickoff
          </>
        )}
      </a>
    </div>
  );
}

/**
 * The change the board proposed with this pull request (BRK-259), if it's one: only the board's own branches are asked
 * about. Answers `{ change, environment }` or null, and reads again when the page does.
 * @param {any} page
 * @param {number} tick
 */
function useBoardChange(page, tick) {
  const [found, setFound] = useState(/** @type {any} */ (null));
  const ours = Boolean(page?.branch?.startsWith('breakaway/infra/'));
  useEffect(() => {
    if (!ours) {
      setFound(null);
      return undefined;
    }
    let live = true;
    api(`infra/changes?repo=${enc(page.repo)}&pull=${enc(page.number)}`)
      .then((got) => {
        if (live) setFound(got.change ? got : null);
      })
      .catch(() => {
        if (live) setFound(null);
      });
    return () => {
      live = false;
    };
  }, [ours, page?.repo, page?.number, tick]);
  return found;
}

/** Whether the board's change is still its to approve or reject: open, or approved and not merged yet. */
const liveChange = (/** @type {any} */ found) => Boolean(found && ['open', 'approved'].includes(found.change.state));

/**
 * Approve and Reject on the board's change pull request (WEB-105), the same buttons as the change's card on the
 * environment's console. A change that plans nothing merges with the page's Merge, as any pull request does, so only
 * Reject is here for it; Approve finding the head plans nothing reloads the change, and the page's Merge shows.
 * @param {{ page: any, found: any, reload: () => void }} props
 */
function BoardChange({ page, found, reload }) {
  const { change, environment: env } = found;
  if (page.state !== 'open' || !liveChange(found)) return null;
  const card = cardState(change, { checks: page.checks?.state ?? null });
  const nothing = plansNothing(change);
  const word = CARD[card.state] ?? card.state;
  const consoleHref = hashFor({ view: 'infrastructure', environment: String(env.id), task: null });
  return (
    <div class="pr-change">
      <p class="meta">
        The board opened it for a change to{' '}
        <a href={consoleHref}>
          <strong>{env.name}</strong>
        </a>
        : {word.toLowerCase()}.{' '}
        {nothing
          ? `Nothing changes in ${env.name}: merging records it as code.`
          : card.state === 'merging'
            ? change.approval?.merge === 'auto' || change.approval?.merge === 'sync'
              ? 'Approved: it merges once its checks pass, then the board applies the plan.'
              : 'Approved: the board is merging it, then applies the plan.'
            : card.state === 'cant'
              ? ''
              : 'Approve merges it and applies its plan; nothing applies before.'}
      </p>
      {card.state === 'cant' && change.why && (
        <p class="field-error" role="alert">
          {change.why}
        </p>
      )}
      <ChangeActions
        change={change}
        env={env}
        card={{ ...card, merge: false }}
        page={page}
        merges={false}
        onChanged={() => {
          reload();
          loadGitHub();
        }}
      />
    </div>
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
  const kickoff = useKickoff(page);
  const boardChange = useBoardChange(page, tick);
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
          {boardChange && <BoardChange page={page} found={boardChange} reload={() => setTick((n) => n + 1)} />}
          {/* A change that plans something merges by Approve, so its plan is the one you approved. */}
          {!(liveChange(boardChange) && !plansNothing(boardChange.change)) && (
            <PrActions page={page} reload={() => setTick((n) => n + 1)} />
          )}
          <AgentActions page={page} reload={() => setTick((n) => n + 1)} />
          {kickoff && page.state !== 'closed' && <BackToKickoff kickoff={kickoff} page={page} />}
        </section>
      </div>

      {page.body && <Description page={page} />}
      <AgentReview page={page} />
      <InfraPlan page={page} />
      <Conversation page={page} />
      <Diff page={page} />
    </div>
  );
}
