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
import { STREAM_KINDS, STREAM_LEVELS, filterStream, groupStream } from '../lib/env-stream.js';
import { AuditSummary } from './AuditSummary.jsx';
import { AccountAlerts } from './AccountAlerts.jsx';
import { NoneYet } from './ui.jsx';

/**
 * An environment's stream (WEB-94; docs/specs/WEB-94-environment-console.md): signals, plan moves, runs and their
 * steps, agents' and envelopes' acts, and every audit entry, newest first, each linking to its source. The console
 * polls; what's new since the last poll slides in from the left. The audit trail pages back with Show older, so every
 * entry WEB-61's Recent changes showed is still here. An alert that repeats folds into one row with a count and when
 * it was last seen, and the stream filters by kind and level (WEB-97).
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
  const repeats = (item.count ?? 1) > 1;
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
          {repeats && (
            <span class="stream-count" title={`${item.count} times`}>
              ×{item.count}
            </span>
          )}
          <span class="meta stream-when">
            {repeats && 'last '}
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
          {repeats && item.firstAt && (
            <>
              {item.who ? ' · ' : ''}
              {'first '}
              <time dateTime={new Date(item.firstAt).toISOString()}>{ago(new Date(item.firstAt).toISOString())}</time>
            </>
          )}
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
          {item.link && (
            <>
              {item.who || item.resource || planLink ? ' · ' : ''}
              <a href={item.link.url} target="_blank" rel="noopener noreferrer">
                {item.link.text}
              </a>
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
 * The provider's account-wide alerts (BRK-255) sit at the top as one collapsed row, kept once, not in the stream.
 * @param {{ items: import('../lib/env-stream.js').StreamItem[], fresh: Set<string>, env: { id: number, provider?: string | null }, nameOf: (id: string) => string, onResource: (id: string) => void, more: boolean, older: boolean, onOlder: () => void, updated: number | null, error: string | null }} props
 */
export function StreamRail({ items, fresh, env, nameOf, onResource, more, older, onOlder, updated, error }) {
  const [all, setAll] = useState(false);
  const [kind, setKind] = useState(/** @type {keyof typeof STREAM_KINDS | 'all'} */ ('all'));
  const [level, setLevel] = useState(/** @type {keyof typeof STREAM_LEVELS} */ ('all'));
  const phone = typeof matchMedia === 'function' && matchMedia('(max-width: 720px)').matches;
  const rows = groupStream(filterStream(items, { kind, level }));
  const shown = phone && !all ? rows.slice(0, PHONE_SHOWN) : rows;
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
      {items.length > 0 && (
        <div class="stream-filters">
          <div class="segmented segmented-xs" role="group" aria-label="Show in the stream">
            {[['all', 'All'], ...Object.entries(STREAM_KINDS)].map(([k, label]) => (
              <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(/** @type {any} */ (k))}>
                {label}
              </button>
            ))}
          </div>
          <select
            class="select select-xs"
            aria-label="Level"
            value={level}
            onChange={(e) => setLevel(/** @type {any} */ (e.currentTarget.value))}
          >
            {Object.entries(STREAM_LEVELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>
      )}
      {env.provider && <AccountAlerts source={env.provider} reload={updated} />}
      {items.length && !rows.length ? (
        <p class="console-quiet">
          Nothing here matches.{' '}
          <button
            type="button"
            class="infra-rel-link"
            onClick={() => {
              setKind('all');
              setLevel('all');
            }}
          >
            Show everything
          </button>
        </p>
      ) : items.length ? (
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
          {shown.length < rows.length ? (
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
        <NoneYet>Signals, plans, runs, and every change show here as they happen.</NoneYet>
      )}
    </section>
  );
}
