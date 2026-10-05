import { useEffect, useRef, useState } from 'preact/hooks';
import { ArrowDown, ArrowUp, CircleCheck, RotateCcw } from 'lucide-preact';
import { actions, isKickoffIdea } from '../lib/store.js';
import {
  clearDraft,
  describe,
  fitDraft,
  loadDraft,
  missing,
  saveDraft,
  startingDraft,
  toAnswers,
  typeOf,
} from '../lib/decision.js';
import { RichText, Title } from '../lib/richtext.jsx';
import { useAutosize } from './ui.jsx';
import { RefineFromAnswers } from './RefineFromAnswers.jsx';

/** @param {Record<string, any>} props */
function Comment({ id, value, onInput }) {
  return (
    <div class="decision-comment">
      <label class="meta" for={id}>
        Comment (optional)
      </label>
      <input
        id={id}
        class="input input-sm"
        maxLength={1000}
        value={value}
        onInput={(e) => onInput(e.currentTarget.value)}
      />
    </div>
  );
}

/** @param {Record<string, any>} props */
function OtherText({ id, q, value, onInput }) {
  return (
    <div class="decision-other">
      <label class="visually-hidden" for={id}>
        Something else, for “{q.prompt}”
      </label>
      <input
        id={id}
        class="input input-sm"
        maxLength={500}
        placeholder="What, then?"
        value={value}
        onInput={(e) => onInput(e.currentTarget.value)}
      />
    </div>
  );
}

/** @param {Record<string, any>} props */
function Options({ q, uuid, d, set }) {
  const multi = typeOf(q) === 'multi';
  const name = `${uuid}-${q.id}`;
  const picked = multi ? (d.value ?? []) : [d.value];
  const options = q.other ? [...q.options, { id: 'other', label: 'Something else' }] : q.options;
  const toggle = (id, on) => {
    if (!multi) return set({ value: id });
    set({ value: on ? [...(d.value ?? []), id] : (d.value ?? []).filter((x) => x !== id) });
  };
  return (
    <>
      {options.map((o) => (
        <label key={o.id} class="decision-option">
          <input
            type={multi ? 'checkbox' : 'radio'}
            name={name}
            checked={picked.includes(o.id)}
            onChange={(e) => toggle(o.id, e.currentTarget.checked)}
          />
          <span>
            {o.label}
            {o.note && <span class="meta decision-note">{o.note}</span>}
          </span>
        </label>
      ))}
      {q.other && picked.includes('other') && (
        <OtherText id={`${name}-other`} q={q} value={d.other ?? ''} onInput={(other) => set({ other })} />
      )}
    </>
  );
}

/** @param {Record<string, any>} props */
function Rank({ q, d, set }) {
  const order = d.value ?? q.options.map((o) => o.id);
  const move = (i, delta) => {
    const next = [...order];
    [next[i], next[i + delta]] = [next[i + delta], next[i]];
    set({ value: next });
  };
  const label = (id) => q.options.find((o) => o.id === id)?.label ?? id;
  return (
    <ol class="decision-rank">
      {order.map((id, i) => (
        <li key={id}>
          <span class="decision-rank-label">
            <span class="meta">{i + 1}.</span> {label(id)}
          </span>
          <button
            type="button"
            class="btn btn-quiet btn-icon btn-sm"
            aria-label={`Move ${label(id)} up`}
            disabled={i === 0}
            onClick={() => move(i, -1)}
          >
            <ArrowUp size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            class="btn btn-quiet btn-icon btn-sm"
            aria-label={`Move ${label(id)} down`}
            disabled={i === order.length - 1}
            onClick={() => move(i, 1)}
          >
            <ArrowDown size={16} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ol>
  );
}

/** @param {Record<string, any>} props */
function Scale({ q, uuid, d, set }) {
  const numbers = [];
  for (let n = q.min; n <= q.max && numbers.length < 21; n += 1) numbers.push(n);
  return (
    <div class="decision-scale">
      <div class="decision-scale-row">
        {numbers.map((n) => (
          <label key={n} class="decision-scale-n">
            <input type="radio" name={`${uuid}-${q.id}`} checked={d.value === n} onChange={() => set({ value: n })} />
            <span>{n}</span>
          </label>
        ))}
      </div>
      {(q.minLabel || q.maxLabel) && (
        <p class="meta decision-scale-ends">
          <span>{q.minLabel}</span>
          <span>{q.maxLabel}</span>
        </p>
      )}
    </div>
  );
}

/** @param {Record<string, any>} props */
function Open({ id, d, set, label }) {
  const ref = useRef(null);
  useAutosize(ref, d.value ?? '');
  return (
    <textarea
      id={id}
      ref={ref}
      class="textarea"
      rows={3}
      maxLength={10000}
      aria-label={label}
      value={d.value ?? ''}
      onInput={(e) => set({ value: e.currentTarget.value })}
    />
  );
}

/** @param {Record<string, any>} props */
function Question({ q, index, uuid, d, set }) {
  const type = typeOf(q);
  const id = `${uuid}-${q.id}`;
  const required = q.required !== false;
  return (
    <fieldset class="decision-q">
      <legend>
        <span class="meta">{index + 1}.</span> <Title text={q.prompt} />
        {!required && <span class="meta"> (optional)</span>}
      </legend>
      {q.help && (
        <div class="meta decision-help">
          <RichText text={q.help} />
        </div>
      )}
      {type === 'open' && <Open id={`${id}-v`} d={d} set={set} label={q.prompt} />}
      {type === 'yesno' && (
        <div class="decision-row">
          {['yes', 'no'].map((v) => (
            <label key={v} class="decision-option">
              <input type="radio" name={id} checked={d.value === v} onChange={() => set({ value: v })} />
              <span>{v === 'yes' ? 'Yes' : 'No'}</span>
            </label>
          ))}
        </div>
      )}
      {(type === 'choice' || type === 'multi') && <Options q={q} uuid={uuid} d={d} set={set} />}
      {type === 'rank' && <Rank q={q} d={d} set={set} />}
      {type === 'scale' && <Scale q={q} uuid={uuid} d={d} set={set} />}
      {type === 'date' && (
        <input
          type="date"
          class="input input-sm decision-date"
          aria-label={q.prompt}
          value={d.value ?? ''}
          onInput={(e) => set({ value: e.currentTarget.value })}
        />
      )}
      {type === 'multi' && (q.min !== undefined || q.max !== undefined) && (
        <p class="meta">
          {q.min !== undefined && q.max !== undefined
            ? `Pick ${q.min} to ${q.max}.`
            : q.min !== undefined
              ? `Pick at least ${q.min}.`
              : `Pick up to ${q.max}.`}
        </p>
      )}
      <Comment id={`${id}-c`} value={d.comment ?? ''} onInput={(comment) => set({ comment })} />
    </fieldset>
  );
}

/**
 * The submitted answers, read-only, with a way to change them.
 * @param {Record<string, any>} props
 */
function Answered({ task: t }) {
  const { answers, at } = t.decisionAnswers;
  return (
    <>
      <dl class="decision-answers">
        {t.decision.map((q) => (
          <div key={q.id}>
            <dt>{q.prompt}</dt>
            <dd>
              {describe(q, answers[q.id])}
              {answers[q.id]?.comment && <span class="meta decision-note">{answers[q.id].comment}</span>}
            </dd>
          </div>
        ))}
      </dl>
      <div class="note-actions">
        <span class="meta">
          <CircleCheck size={14} aria-hidden="true" /> Decided{' '}
          {at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : ''}
        </span>
        <button type="button" class="btn btn-outline btn-sm" onClick={() => actions.reopenDecision(t)}>
          <RotateCcw size={16} aria-hidden="true" />
          Change my answers
        </button>
      </div>
      <RefineFromAnswers task={t} />
    </>
  );
}

/** @param {Record<string, any>} props */
function Form({ task: t }) {
  const questions = t.decision;
  const [draft, setDraft] = useState(() => ({
    ...startingDraft(questions, t.decisionAnswers?.answers),
    ...fitDraft(questions, loadDraft(t.uuid)),
  }));
  const [busy, setBusy] = useState(false);
  // A different task or new questions start over from what the browser kept for them.
  const shape = JSON.stringify(questions);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setDraft({ ...startingDraft(questions, t.decisionAnswers?.answers), ...fitDraft(questions, loadDraft(t.uuid)) });
  }, [t.uuid, shape]);
  useEffect(() => {
    saveDraft(t.uuid, draft);
  }, [t.uuid, draft]);
  const set = (id) => (patch) =>
    setDraft((old) => ({ ...old, [id]: { value: undefined, other: '', comment: '', ...old[id], ...patch } }));
  const todo = missing(questions, draft);
  // A kickoff's IDEA stays open once answered (BRK-134), and can start its next run in the same press.
  const kickoff = isKickoffIdea(t);
  const send = async (carryOn) => {
    if (todo.length || busy) return;
    setBusy(true);
    const result = await actions.submitDecision(t, toAnswers(questions, draft), { carryOn });
    setBusy(false);
    if (result) clearDraft(t.uuid);
  };
  const submit = (e) => {
    e.preventDefault();
    send(kickoff);
  };
  return (
    <form class="decision-form" onSubmit={submit}>
      {questions.map((q, i) => (
        <Question key={q.id} q={q} index={i} uuid={t.uuid} d={draft[q.id] ?? {}} set={set(q.id)} />
      ))}
      <div class="note-actions">
        <span class="meta" role="status">
          {todo.length
            ? `Still to answer: ${todo.map((q) => questions.indexOf(q) + 1).join(', ')}.`
            : kickoff
              ? 'Everything is answered. Carry on starts the next run, which plans it or asks a little more.'
              : 'Everything is answered. Sending them finishes this task.'}
        </span>
        {kickoff ? (
          <span class="row-gap">
            <button
              type="button"
              class="btn btn-outline btn-sm"
              disabled={todo.length > 0 || busy}
              onClick={() => send(false)}
            >
              Send answers
            </button>
            <button type="submit" class="btn btn-primary btn-sm" disabled={todo.length > 0 || busy} aria-busy={busy}>
              Send answers and carry on
            </button>
          </span>
        ) : (
          <button type="submit" class="btn btn-primary btn-sm" disabled={todo.length > 0 || busy}>
            Send answers
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * A +decide task without questions: one note that resolves it.
 * @param {Record<string, any>} props
 */
function Decide({ task: t }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const area = useRef(null);
  useAutosize(area, text);
  useEffect(() => {
    if (open) area.current?.focus();
  }, [open]);
  const submit = async (e) => {
    e?.preventDefault();
    if (!text.trim()) return;
    if (await actions.decide(t, text.trim())) {
      setText('');
      setOpen(false);
    }
  };
  if (!open) {
    return (
      <div class="note-actions">
        <span class="meta">Write what you decided. That finishes the task.</span>
        <button type="button" class="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
          Decide…
        </button>
      </div>
    );
  }
  return (
    <form class="note-add" onSubmit={submit}>
      <label class="visually-hidden" for={`decide-${t.uuid}`}>
        What you decided
      </label>
      <textarea
        id={`decide-${t.uuid}`}
        ref={area}
        class="textarea"
        rows={3}
        maxLength={10000}
        value={text}
        placeholder="What you decided, and why if it helps"
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      <div class="note-actions">
        <span class="meta">Ctrl + Enter decides it</span>
        <span class="row-gap">
          <button type="button" class="btn btn-quiet btn-sm" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button type="submit" class="btn btn-primary btn-sm" disabled={!text.trim()}>
            Decide
          </button>
        </span>
      </div>
    </form>
  );
}

/**
 * The owner's answer form on a decision task (sidebar and modal). Nothing shows on other tasks.
 * @param {Record<string, any>} props
 */
export function DecisionSection({ task: t }) {
  const structured = Array.isArray(t.decision) && t.decision.length > 0;
  // A kickoff's IDEA stays pending once answered: its answers stand while +decide is off it.
  const answered =
    structured &&
    Boolean(t.decisionAnswers) &&
    (t.status === 'completed' || (isKickoffIdea(t) && t.status === 'pending' && !t.tags.includes('decide')));
  const pending = t.status === 'pending';
  if (!structured && !(pending && t.tags.includes('decide'))) return null;
  if (structured && !answered && !pending) return null;
  return (
    <section class="panel-section decision" aria-labelledby={`decision-${t.uuid}`}>
      <h3 id={`decision-${t.uuid}`}>{answered ? 'Decision' : 'Needs your decision'}</h3>
      {answered ? <Answered task={t} /> : structured ? <Form task={t} /> : <Decide task={t} />}
    </section>
  );
}
