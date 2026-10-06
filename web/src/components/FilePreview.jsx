// Preview on the pull request page (WEB-86): a changed file as it reads, not as lines. A Markdown or text file shows as
// a rendered diff, block by block, unified or side by side; a CSV or TSV file as a table; an image or an SVG as itself,
// before and after. The board reads the file whole from GitHub at the pull request's base and head.
import { useEffect, useState } from 'preact/hooks';
import { ExternalLink, LoaderCircle } from 'lucide-preact';
import { api } from '../lib/api.js';
import { diffBlocks, pairBlocks, parseTable } from '../lib/code.js';
import { Markdown } from '../lib/richtext.jsx';

const ext = { target: '_blank', rel: 'noopener noreferrer' };

/** Unchanged runs longer than this fold into a button, keeping a block of context on each side of a change. */
const FOLD = 4;

/**
 * Both sides of a file, read once when Preview first opens: `base` and `head` are its text (or image), null where the
 * pull request adds or removes it.
 * @param {{ page: Record<string, any>, file: Record<string, any> }} props
 */
function useSides({ page, file }) {
  const [state, setState] = useState(/** @type {Record<string, any>} */ ({ loading: true }));
  useEffect(() => {
    let live = true;
    const read = (side) =>
      api(
        `github/pulls/${page.number}/file?${new URLSearchParams({ path: file.name, side, ...(page.repo ? { repo: page.repo } : {}) })}`,
      );
    Promise.all([file.status === 'added' ? null : read('base'), file.status === 'removed' ? null : read('head')]).then(
      ([base, head]) => live && setState({ base, head }),
      (error) => live && setState({ error: error.message }),
    );
    return () => {
      live = false;
    };
  }, [page.number, page.repo, file.name, file.status]);
  return state;
}

/**
 * One block of a document: Markdown as the board renders it, or plain text as written.
 * @param {{ text: string, kind: 'markdown' | 'text', base?: string }} props
 */
function Doc({ text, kind, base }) {
  return kind === 'markdown' ? <Markdown text={text} base={base} /> : <p class="preview-text">{text}</p>;
}

const LABEL = { removed: 'Removed', added: 'Added' };

/**
 * A rendered diff: unchanged blocks plain, removed and added ones marked with a bar and a word (never color alone),
 * long unchanged runs folded.
 * @param {{ before: string | null, after: string | null, kind: 'markdown' | 'text', split: boolean, base?: string }} props
 */
function RenderedDiff({ before, after, kind, split, base }) {
  const [unfolded, setUnfolded] = useState(/** @type {Set<number>} */ (new Set()));
  const blocks = diffBlocks(before, after);
  // Split rows pair a removed block with the added one; unified rows are the blocks themselves.
  const rows = /** @type {Record<string, any>[]} */ (split ? pairBlocks(blocks) : blocks);
  const changed = rows.map((r) => r.kind !== 'same');
  if (!changed.some(Boolean))
    return <p class="muted small preview-none">No change to the text: only spacing or line endings.</p>;
  // A run of unchanged rows folds, keeping one on each side of a change.
  const near = (i) => changed[i - 1] || changed[i + 1];
  const out = [];
  for (let i = 0; i < rows.length; ) {
    if (rows[i].kind === 'same' && !near(i)) {
      let end = i;
      while (end < rows.length && rows[end].kind === 'same' && !near(end)) end += 1;
      if (end - i > FOLD && !unfolded.has(i)) {
        const at = i;
        out.push(
          <button
            key={`fold${i}`}
            type="button"
            class="preview-fold"
            onClick={() => setUnfolded(new Set([...unfolded, at]))}
          >
            Show {end - i} unchanged {kind === 'markdown' ? 'blocks' : 'paragraphs'}
          </button>,
        );
        i = end;
        continue;
      }
    }
    const r = rows[i];
    if (split)
      out.push(
        <div key={i} class={`preview-row${r.kind === 'same' ? '' : ' is-changed'}`}>
          {[
            ['removed', r.left],
            ['added', r.right],
          ].map(([side, text]) =>
            text === null ? (
              <div key={side} class="preview-block preview-empty" />
            ) : (
              <div key={side} class={`preview-block${r.kind === 'same' ? '' : ` preview-${side}`}`}>
                {r.kind !== 'same' && <span class="visually-hidden">{LABEL[side]}: </span>}
                <Doc text={text} kind={kind} base={base} />
              </div>
            ),
          )}
        </div>,
      );
    else
      out.push(
        <div key={i} class={`preview-block${r.kind === 'same' ? '' : ` preview-${r.kind}`}`}>
          {r.kind !== 'same' && <span class="visually-hidden">{LABEL[r.kind]}: </span>}
          <Doc text={r.text} kind={kind} base={base} />
        </div>,
      );
    i += 1;
  }
  return (
    <div class={split ? 'preview-diff preview-split' : 'preview-diff'}>
      {split && (
        <div class="preview-row preview-heads" aria-hidden="true">
          <span>Before</span>
          <span>After</span>
        </div>
      )}
      {out}
    </div>
  );
}

/** @param {{ text: string, delimiter: ',' | '\t' }} props */
function Table({ text, delimiter }) {
  const [head, ...rows] = parseTable(text, delimiter);
  const shown = rows.slice(0, 500);
  return (
    <div class="md-table preview-table">
      <table>
        <thead>
          <tr>
            {(head ?? []).map((cell, k) => (
              <th key={k}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, r) => (
            <tr key={r}>
              {row.map((cell, k) => (
                <td key={k}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && <p class="muted small">The first 500 of {rows.length} rows.</p>}
    </div>
  );
}

/**
 * What one side shows when it isn't text to diff: an image, a table, or why there's nothing.
 * @param {{ side: Record<string, any> | null, kind: string, name: string }} props
 */
function Side({ side, kind, name }) {
  if (!side) return null;
  if (side.tooLarge) return <p class="muted small">Over 1 MB, too large to preview here.</p>;
  if (kind === 'image')
    return side.image ? (
      <img class="preview-image" src={side.image} alt={`${name}, ${side.side === 'base' ? 'before' : 'after'}`} />
    ) : (
      <p class="muted small">This image can’t be shown here.</p>
    );
  if (side.text === null) return <p class="muted small">This file isn’t text, so there’s nothing to preview.</p>;
  if (kind === 'svg')
    return (
      <img
        class="preview-image"
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(side.text)}`}
        alt={`${name}, ${side.side === 'base' ? 'before' : 'after'}`}
      />
    );
  if (kind === 'csv' || kind === 'tsv') return <Table text={side.text} delimiter={kind === 'csv' ? ',' : '\t'} />;
  return null;
}

/**
 * Preview of one changed file. `kind` is what previewOf in code.js says it is.
 * @param {{ page: Record<string, any>, file: Record<string, any>, kind: string, split: boolean }} props
 */
export function FilePreview({ page, file, kind, split }) {
  const sides = useSides({ page, file });
  const base = String(page.url ?? '').replace(/\/pull\/\d+$/u, '') || undefined;
  if (sides.loading)
    return (
      <p class="muted small preview-none" aria-busy="true">
        <LoaderCircle size={14} class="spin" aria-hidden="true" /> Reading {file.name}…
      </p>
    );
  if (sides.error)
    return (
      <p class="field-error preview-none" role="alert">
        Couldn’t read the file for a preview: {sides.error}{' '}
        <a href={`${page.url}/files`} {...ext}>
          See it on GitHub
          <ExternalLink size={13} aria-hidden="true" />
        </a>
      </p>
    );
  const { base: before, head: after } = sides;
  if (kind === 'markdown' || kind === 'text') {
    const big = [before, after].find((s) => s && (s.tooLarge || s.text === null));
    if (big)
      return (
        <p class="muted small preview-none">
          {big.tooLarge
            ? 'Over 1 MB, too large to preview here.'
            : 'This file isn’t text, so there’s nothing to preview.'}
        </p>
      );
    return (
      <div class="preview">
        <RenderedDiff
          before={before ? before.text : null}
          after={after ? after.text : null}
          kind={kind}
          split={split && Boolean(before) && Boolean(after)}
          base={base}
        />
      </div>
    );
  }
  // Images, SVGs, and tables: before and after, side by side in split view, one above the other otherwise.
  return (
    <div class={`preview preview-pair${split && before && after ? ' preview-split' : ''}`}>
      {before && (
        <figure class="preview-side">
          {after && <figcaption class="meta">Before</figcaption>}
          <Side side={before} kind={kind} name={file.name} />
        </figure>
      )}
      {after && (
        <figure class="preview-side">
          {before && <figcaption class="meta">After</figcaption>}
          <Side side={after} kind={kind} name={file.name} />
        </figure>
      )}
    </div>
  );
}
