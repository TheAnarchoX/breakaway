// Renders the tokens from links.js and the blocks from markdown.js. Everything becomes elements; nothing is inserted as HTML.
// A fenced code block is highlighted by its tag (WEB-86).
import { Square, SquareCheck } from 'lucide-preact';
import { blocks, splitWids, tokenize } from './links.js';
import { markdown } from './markdown.js';
import { CodeBlock } from './highlight.jsx';

const out = { target: '_blank', rel: 'noopener noreferrer' };

/**
 * What a document's links may open on the board instead of GitHub: `local(path)` is the board's address for a
 * repository file (another spec), and `task(wid)` a task's, each null when the board doesn't have it.
 * @typedef {{ local?: (path: string) => string | null, task?: (wid: string) => string | null }} Here
 */

/** Plain text, with each work ID the board has as a link to its task. */
function withWids(value, key, here) {
  if (!here.task) return value;
  const parts = splitWids(value, (wid) => Boolean(here.task(wid)));
  if (parts.length === 1 && typeof parts[0] === 'string') return value;
  return (
    <span key={key}>
      {parts.map((part, j) =>
        typeof part === 'string' ? (
          part
        ) : (
          <a key={j} href={here.task(part.wid)} class="md-wid">
            {part.wid}
          </a>
        ),
      )}
    </span>
  );
}

/**
 * @param {any[]} tokens
 * @param {Here} [here]
 */
function render(tokens, here = {}) {
  return tokens.map((t, i) => {
    switch (t.type) {
      case 'code':
        return t.href ? (
          <a key={i} href={t.href} {...out}>
            <code>{t.text}</code>
          </a>
        ) : (
          <code key={i}>{t.text}</code>
        );
      case 'link': {
        const local = t.path && here.local ? here.local(t.path) : null;
        if (local)
          return (
            <a key={i} href={local}>
              {render(t.label)}
            </a>
          );
        return t.href ? (
          <a key={i} href={t.href} {...out}>
            {render(t.label)}
          </a>
        ) : (
          <span key={i}>{render(t.label, here)}</span>
        );
      }
      case 'url':
        return (
          <a key={i} href={t.href} {...out} class="url">
            {t.text}
          </a>
        );
      case 'image':
        return t.href ? (
          <a key={i} href={t.href} {...out}>
            {t.alt || 'Image'}
          </a>
        ) : (
          <span key={i}>{t.alt}</span>
        );
      case 'bold':
        return <strong key={i}>{render(t.children, here)}</strong>;
      case 'em':
        return <em key={i}>{render(t.children, here)}</em>;
      default:
        return withWids(t.text, i, here);
    }
  });
}

/**
 * A title: inline Markdown without links, so the card or row around it stays one link.
 * @param {Record<string, any>} props
 */
export function Title({ text }) {
  return <>{render(tokenize(text, { links: false }))}</>;
}

/**
 * Inline Markdown with links, for one-line notes.
 * @param {Record<string, any>} props
 */
export function Inline({ text }) {
  return <>{render(tokenize(text))}</>;
}

/**
 * A note: paragraphs, "- " lists, and inline Markdown with links.
 * @param {Record<string, any>} props
 */
export function RichText({ text }) {
  return (
    <div class="rich">
      {blocks(text).map((b, i) =>
        b.type === 'ul' ? (
          <ul key={i}>
            {b.items.map((item, j) => (
              <li key={j}>{render(item)}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>{b.lines.map((line, j) => [j > 0 && <br key={`br${j}`} />, ...render(line)])}</p>
        ),
      )}
    </div>
  );
}

const lines = (list, here) => list.map((line, j) => [j > 0 && <br key={`br${j}`} />, ...render(line, here)]);
const ALIGN = { left: 'md-left', center: 'md-center', right: 'md-right' };

/**
 * Blocks from markdown.js → elements. Headings sit two levels under the page's own, since they're inside a section.
 * @param {any[]} list
 * @param {Here} here
 */
function renderBlocks(list, here) {
  return list.map((b, i) => {
    switch (b.type) {
      case 'h': {
        const Tag = /** @type {'h3' | 'h4' | 'h5' | 'h6'} */ (`h${Math.min(b.level + 2, 6)}`);
        return (
          <Tag key={i} class={`md-h md-h${b.level}`}>
            {render(b.tokens, here)}
          </Tag>
        );
      }
      case 'hr':
        return <hr key={i} />;
      case 'code':
        return <CodeBlock key={i} code={b.text} lang={b.lang} />;
      case 'quote':
        return <blockquote key={i}>{renderBlocks(b.blocks, here)}</blockquote>;
      case 'table':
        return (
          <div key={i} class="md-table">
            <table>
              <thead>
                <tr>
                  {b.head.map((cell, k) => (
                    <th key={k} class={ALIGN[b.align[k]]}>
                      {render(cell, here)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, k) => (
                      <td key={k} class={ALIGN[b.align[k]]}>
                        {render(cell, here)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case 'list': {
        const Tag = b.ordered ? 'ol' : 'ul';
        return (
          <Tag key={i} start={b.ordered && b.start !== 1 ? b.start : undefined}>
            {b.items.map((item, j) => {
              // An item's first paragraph sits on the marker's line, as in a tight list; the rest are blocks.
              const [lead, ...rest] = item.blocks[0]?.type === 'p' ? item.blocks : [null, ...item.blocks];
              return (
                <li key={j} class={item.task === null ? undefined : `md-task${item.task ? ' is-done' : ''}`}>
                  {item.task !== null && (
                    <>
                      {item.task ? (
                        <SquareCheck size={16} aria-hidden="true" />
                      ) : (
                        <Square size={16} aria-hidden="true" />
                      )}
                      <span class="visually-hidden">{item.task ? 'Done: ' : 'Not done: '}</span>
                    </>
                  )}
                  {lead && lines(lead.lines, here)}
                  {renderBlocks(rest, here)}
                </li>
              );
            })}
          </Tag>
        );
      }
      default:
        return <p key={i}>{lines(b.lines, here)}</p>;
    }
  });
}

/**
 * A document in Markdown, as GitHub renders a pull request's description: headings, lists and task lists, code,
 * quotes, tables, and inline Markdown. `base` is the repository its relative links point into, and `branch` its
 * branch. A spec (WEB-25) also passes `dir`, its own directory, which its relative links resolve against;
 * `local(path)`, the board's address for a file it opens itself; and `task(wid)`, a task's address, so its work IDs
 * open their tasks.
 * @param {Record<string, any>} props
 */
export function Markdown({ text: source, base = undefined, branch = undefined, dir = undefined, local, task }) {
  const opts = { ...(base ? { base } : {}), ...(branch ? { branch } : {}), ...(dir ? { dir } : {}) };
  return <div class="md">{renderBlocks(markdown(source, opts), { local, task })}</div>;
}
