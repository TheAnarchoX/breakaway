import { useState } from 'preact/hooks';
import {
  Activity,
  ArrowRight,
  CircleCheck,
  CircleX,
  FileDiff,
  History,
  Radio,
  Siren,
  TriangleAlert,
} from 'lucide-preact';
import { ago } from '../lib/model.js';
import { hashFor } from '../lib/store.js';
import { AuditSummary } from './AuditSummary.jsx';

/**
 * An environment's stream (WEB-94; docs/specs/WEB-94-environment-console.md): signals, plan moves, runs and their
 * steps, agents' and envelopes' acts, and every audit entry, newest first, each linking to its source. The console
 * polls; what's new since the last poll slides in from the left. The audit trail pages back with Show older, so every
 * entry WEB-61's Recent changes showed is still here.
 */

/** Entries a phone shows before Show more. */
const PHONE_SHOWN = 8;

/** An entry's icon, by what it is: status colors always come with words. */
function Icon({ item }) {
  const size = 14;
  if (item.type === 'incident') return <Siren size={size} aria-hidden="true" />;
  if (item.type === 'run') return <Activity size={size} aria-hidden="true" />;
  if (item.type === 'audit')
    return item.plan ? <FileDiff size={size} aria-hidden="true" /> : <History size={size} aria-hidden="true" />;
  if (item.level === 'critical') return <CircleX size={size} aria-hidden="true" />;
  if (item.level === 'warning') return <TriangleAlert size={size} aria-hidden="true" />;
  return <CircleCheck size={size} aria-hidden="true" />;
}

/**
 * @param {{ item: import('../lib/env-stream.js').StreamItem, fresh: boolean, env: { id: number }, nameOf: (id: string) => string, onResource: (id: string) => void }} props
 */
function Entry({ item, fresh, env, nameOf, onResource }) {
  const iso = new Date(item.at).toISOString();
  // A summary that already links its plan (WEB-96) doesn't link it again.
  const planLink =
    item.plan && !item.parts?.some((p) => typeof p !== 'string')
      ? hashFor({ view: 'infrastructure', environment: String(env.id), plan: item.plan, task: null })
      : null;
  return (
    <li
      class={`stream-entry stream-${item.type} ${item.level ? `stream-level-${item.level}` : ''} ${fresh ? 'is-new' : ''} ${item.live ? 'is-live' : ''}`}
    >
      <span class="stream-icon">
        <Icon item={item} />
      </span>
      <div class="stream-body">
        <p class="stream-head">
          <span class="stream-label">{item.label}</span>
          {item.outcome && item.outcome !== 'now' && <span class="stream-outcome">{item.outcome}</span>}
          {item.live && <span class="stream-outcome stream-now">now</span>}
          <span class="meta stream-when">
            <time dateTime={iso} title={new Date(item.at).toLocaleString()}>
              {ago(iso)}
            </time>
          </span>
        </p>
        {item.parts ? (
          <AuditSummary parts={item.parts} environment={env.id} class="stream-text" />
        ) : (
          item.text && <p class="stream-text">{item.text}</p>
        )}
        <p class="meta stream-from">
          {item.who && <>By {item.who}</>}
          {item.resource && (
            <>
              {item.who ? ' · ' : ''}
              <button type="button" class="infra-rel-link" onClick={() => onResource(item.resource)}>
                {nameOf(item.resource)}
              </button>
            </>
          )}
          {planLink && (
            <>
              {item.who || item.resource ? ' · ' : ''}
              <a href={planLink}>{item.plan}</a>
            </>
          )}
          {item.envelope && (
            <>
              {' · envelope '}
              <code>{item.envelope}</code>
            </>
          )}
          {item.task && (
            <>
              {item.who || item.resource ? ' · ' : ''}
              <a href={hashFor({ task: item.task.wid ?? item.task.uuid })}>{item.task.wid ?? item.task.description}</a>
            </>
          )}
        </p>
      </div>
    </li>
  );
}

/**
 * @param {{ items: import('../lib/env-stream.js').StreamItem[], fresh: Set<string>, env: { id: number }, nameOf: (id: string) => string, onResource: (id: string) => void, more: boolean, older: boolean, onOlder: () => void, updated: number | null, error: string | null }} props
 */
export function StreamRail({ items, fresh, env, nameOf, onResource, more, older, onOlder, updated, error }) {
  const [all, setAll] = useState(false);
  const phone = typeof matchMedia === 'function' && matchMedia('(max-width: 720px)').matches;
  const shown = phone && !all ? items.slice(0, PHONE_SHOWN) : items;
  const newCount = items.filter((i) => fresh.has(i.key)).length;
  return (
    <section class="console-panel stream" aria-labelledby="infra-stream">
      <header class="console-panel-head">
        <h2 id="infra-stream">
          <Radio size={16} aria-hidden="true" />
          Stream
        </h2>
        <span class="meta stream-live" title="The board checks every 15 seconds while this page is open">
          <span class={`live-dot ${error ? 'is-off' : ''}`} aria-hidden="true" />
          {error ? 'Not updating' : 'Live'}
          {updated && !error && (
            <>
              {' · '}
              <time dateTime={new Date(updated).toISOString()}>{ago(new Date(updated).toISOString())}</time>
            </>
          )}
        </span>
      </header>
      <p class="visually-hidden" aria-live="polite">
        {newCount > 0 ? `${newCount} new in the stream.` : ''}
      </p>
      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
      {items.length ? (
        <>
          <ol class="stream-list">
            {shown.map((item) => (
              <Entry
                key={item.key}
                item={item}
                fresh={fresh.has(item.key)}
                env={env}
                nameOf={nameOf}
                onResource={onResource}
              />
            ))}
          </ol>
          {shown.length < items.length ? (
            <button type="button" class="btn btn-quiet btn-sm stream-more" onClick={() => setAll(true)}>
              Show more
              <ArrowRight size={14} aria-hidden="true" />
            </button>
          ) : (
            more && (
              <button
                type="button"
                class="btn btn-quiet btn-sm stream-more"
                onClick={onOlder}
                disabled={older}
                aria-busy={older}
              >
                {older ? 'Loading…' : 'Show older'}
              </button>
            )
          )}
        </>
      ) : (
        <p class="console-quiet">Quiet so far. Signals, plans, runs, and every change show here as they happen.</p>
      )}
    </section>
  );
}
