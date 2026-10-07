import { useEffect, useRef, useState } from 'preact/hooks';
import { CircleCheck, ExternalLink, Play, X } from 'lucide-preact';
import { fieldOf, inputsToSend } from '../../../src/workflows.js';
import { api, enc } from '../lib/api.js';
import { githubRepoFacts, loadGitHub, repoName } from '../lib/store.js';
import { Dialog } from './ui.jsx';

/*
 * Run workflow… on the GitHub view's runs tab (WEB-82, docs/specs/BRK-223-run-workflows.md), and Run on each of its
 * runs (WEB-83): pick a repository's workflow that runs by hand, where it runs, and its inputs, and the board starts it through
 * POST /api/github/workflows/run. The Worker reads the workflows (GET /api/github/workflows) and checks everything again.
 */

const ext = { target: '_blank', rel: 'noopener noreferrer' };
const DISPATCH_DOCS =
  'https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#workflow_dispatch';

/** What Promote's App may do in `slug`: start workflows, or why not. Allowed while nothing's been checked. */
const actionsIn = (slug) => githubRepoFacts(slug)?.access?.actions ?? { ok: true, reason: null };

/** Whether `workflow` (one the Worker listed) is the one run `run` ran: by its id, its file, or (a run synced before
 * the board kept those) its name. */
const ranBy = (workflow, run) =>
  run.workflow != null || run.path
    ? String(workflow.id) === String(run.workflow) || workflow.path === run.path
    : workflow.name === run.name;

/** Each repository's workflows that run by hand, as GET /api/github/workflows answered, kept for 5 minutes. */
const known = new Map();
const KEEP_MS = 5 * 60 * 1000;

/**
 * Run on a run (WEB-83): for each run in `runs`, the workflow it ran when that one runs by hand and the App may start
 * it, else null. It reads each repository's workflows once, when its runs show. `slugOf(run)` names a run's repository.
 * @param {any[]} runs
 * @param {(run: any) => string | null} slugOf
 */
export function useRunnable(runs, slugOf) {
  const slugs = [...new Set(runs.map(slugOf).filter(Boolean))].sort();
  const [, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    for (const slug of slugs) {
      const kept = known.get(slug);
      if (kept && (kept.loading || Date.now() - kept.at < KEEP_MS)) continue;
      known.set(slug, { loading: true, at: Date.now(), data: null });
      api(`github/workflows?repo=${enc(slug)}`)
        .then((data) => known.set(slug, { loading: false, at: Date.now(), data }))
        // Not read (GitHub refused, or the App can't): no Run on its runs; Run workflow… still says why.
        .catch(() => known.set(slug, { loading: false, at: Date.now(), data: null }))
        .finally(() => live && setTick((n) => n + 1));
    }
    return () => {
      live = false;
    };
  }, [slugs.join(' ')]);
  return (run) => {
    const data = known.get(slugOf(run) ?? '')?.data;
    if (!data?.actions?.ok) return null;
    return (data.workflows ?? []).find((w) => ranBy(w, run)) ?? null;
  };
}

/** Each input's starting value (fieldOf): its default, a required choice's first option, a switch off, else empty. */
function startValues(workflow) {
  /** @type {Record<string, string | boolean>} */
  const values = {};
  for (const input of workflow?.inputs ?? []) values[input.name] = fieldOf(input).start;
  return values;
}

/** The environments the board has seen deploys to in `slug`, for an `environment` input. */
function environmentsOf(deploys, slug) {
  return [...new Set(deploys.filter((d) => !d.repo || d.repo === slug).map((d) => d.env))].filter(Boolean).sort();
}

/** @param {Record<string, any>} props */
function InputField({ input, value, onChange, idBase, environments }) {
  const id = `${idBase}-${input.name}`.replace(/[^\w-]/gu, '-');
  const hint = input.description ? `${id}-hint` : undefined;
  const label = (
    <span class="field-label">
      {input.name}
      {input.required && <span class="meta"> (required)</span>}
    </span>
  );
  const help = input.description && (
    <span class="field-hint" id={hint}>
      {input.description}
    </span>
  );
  if (input.type === 'boolean')
    return (
      <div class="field">
        <label class="check-row run-wf-switch">
          <input
            type="checkbox"
            role="switch"
            checked={value === true}
            aria-checked={value === true}
            aria-describedby={hint}
            onChange={(e) => onChange(e.currentTarget.checked)}
          />
          {label}
        </label>
        {help}
      </div>
    );
  const { empty } = fieldOf(input);
  if (input.type === 'choice')
    return (
      <label class="field">
        {label}
        <select
          class="select"
          value={String(value)}
          required={input.required}
          aria-describedby={hint}
          onChange={(e) => onChange(e.currentTarget.value)}
        >
          {empty !== null && <option value="">{empty}</option>}
          {(input.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        {help}
      </label>
    );
  const list = input.type === 'environment' && environments.length ? `${id}-envs` : undefined;
  return (
    <label class="field">
      {label}
      <input
        class="input"
        type={input.type === 'number' ? 'number' : 'text'}
        step={input.type === 'number' ? 'any' : undefined}
        value={String(value)}
        required={input.required && (input.default === null || input.default === undefined)}
        maxLength={1000}
        list={list}
        aria-describedby={hint}
        autocomplete="off"
        spellcheck={false}
        onInput={(e) => onChange(e.currentTarget.value)}
      />
      {list && (
        <datalist id={list}>
          {environments.map((env) => (
            <option key={env} value={env} />
          ))}
        </datalist>
      )}
      {help}
    </label>
  );
}

/**
 * The dialog: the repository (when the view shows all of them), the workflow, where it runs, and its inputs.
 * `repos` are the repositories it offers ({ slug, name }), `slug` the one picked first, `run` the run whose Run opened
 * it (its workflow is picked first), and `deploys` the view's.
 * @param {Record<string, any>} props
 */
function RunWorkflowDialog({ repos, slug: first, run, deploys, onClose, onStarted }) {
  const [slug, setSlug] = useState(first);
  const [load, setLoad] = useState(
    /** @type {{ loading: boolean, data: any, error: string | null }} */ ({ loading: true, data: null, error: null }),
  );
  const [chosen, setChosen] = useState(/** @type {string | null} */ (null));
  const [ref, setRef] = useState('');
  const [values, setValues] = useState(/** @type {Record<string, string | boolean>} */ ({}));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const listRef = useRef(/** @type {HTMLFieldSetElement | null} */ (null));
  const several = repos.length > 1;

  useEffect(() => {
    let live = true;
    setLoad({ loading: true, data: null, error: null });
    setChosen(null);
    setError(null);
    api(`github/workflows?repo=${enc(slug)}`)
      .then((data) => {
        if (!live) return;
        setLoad({ loading: false, data, error: null });
        setRef(data.branch ?? '');
        // From a run's Run, its workflow is picked (in its own repository only); else the first.
        const ran = run && slug === first ? data.workflows?.find((w) => ranBy(w, run)) : null;
        const firstOne = ran ?? data.workflows?.[0] ?? null;
        setChosen(firstOne ? String(firstOne.id) : null);
        setValues(startValues(firstOne));
      })
      .catch((err) => live && setLoad({ loading: false, data: null, error: err.message }));
    return () => {
      live = false;
    };
  }, [slug]);

  // Focus on the workflow list once it's there (the repository list first, in the all-repositories view).
  useEffect(() => {
    if (load.loading || several) return;
    const checked = listRef.current?.querySelector('input:checked');
    if (checked instanceof HTMLElement) checked.focus();
  }, [load.loading]);

  const workflows = load.data?.workflows ?? [];
  const workflow = workflows.find((w) => String(w.id) === chosen) ?? null;
  const actions = load.data?.actions ?? actionsIn(slug);
  const name = repoName(slug);
  const idBase = `run-wf-${slug}`.replace(/[^\w-]/gu, '-');

  const pick = (w) => {
    setChosen(String(w.id));
    setValues(startValues(w));
    setError(null);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!workflow?.readable || !actions.ok) return;
    setBusy(true);
    setError(null);
    const inputs = inputsToSend(workflow.inputs, values);
    const on = ref.trim() || load.data.branch;
    try {
      const done = await api('github/workflows/run', {
        method: 'POST',
        body: { repo: slug, workflow: String(workflow.id), ref: on, inputs },
      });
      onStarted({ name: done.name ?? workflow.name, ref: done.ref ?? on, url: done.url ?? workflow.url, slug });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const canRun = Boolean(workflow?.readable) && actions.ok && !busy;

  return (
    <Dialog open onClose={() => !busy && onClose()} labelledBy={`${idBase}-title`}>
      <form class="sheet" onSubmit={submit}>
        <h2 id={`${idBase}-title`}>Run a workflow</h2>
        {several && (
          <label class="field">
            <span class="field-label">Repository</span>
            <select
              class="select"
              value={slug}
              disabled={busy}
              // biome-ignore lint/a11y/noAutofocus: the dialog's first field takes focus when it opens.
              autoFocus
              onChange={(e) => setSlug(e.currentTarget.value)}
            >
              {repos.map((r) => (
                <option key={r.slug} value={r.slug}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {load.loading && (
          <p class="muted" aria-busy="true">
            Reading the workflows in {name}…
          </p>
        )}
        {load.error && (
          <p class="field-error" role="alert">
            {load.error}
          </p>
        )}
        {load.data && !workflows.length && (
          <p class="run-wf-empty">
            None of the workflows in {name} run by hand. Add a <code>workflow_dispatch</code> trigger to one, and it
            shows here.{' '}
            <a href={DISPATCH_DOCS} {...ext}>
              How to add one
              <ExternalLink size={14} aria-hidden="true" />
            </a>
          </p>
        )}
        {workflows.length > 0 && (
          <fieldset class="run-wf-list" ref={listRef}>
            <legend class="field-label">Workflow</legend>
            {workflows.map((w) => (
              <label key={w.id} class="check-row run-wf-option">
                <input
                  type="radio"
                  name={`${idBase}-workflow`}
                  checked={String(w.id) === chosen}
                  disabled={busy}
                  onChange={() => pick(w)}
                />
                <span class="run-wf-name">
                  <span>{w.name}</span>
                  <code class="meta">{w.path}</code>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {workflow && !workflow.readable && (
          <div class="run-wf-unreadable" role="status">
            <p>The board can’t read this file’s inputs, so it doesn’t guess them.</p>
            <p>
              <a class="btn btn-outline btn-sm" href={workflow.url} {...ext}>
                Run it on GitHub
                <ExternalLink size={14} aria-hidden="true" />
              </a>
            </p>
          </div>
        )}
        {workflow?.readable && (
          <>
            <label class="field">
              <span class="field-label">Run on</span>
              <input
                class="input"
                value={ref}
                list={`${idBase}-branches`}
                maxLength={255}
                autocomplete="off"
                spellcheck={false}
                disabled={busy}
                aria-describedby={`${idBase}-ref-hint`}
                onInput={(e) => setRef(e.currentTarget.value)}
              />
              <datalist id={`${idBase}-branches`}>
                {(load.data.branches ?? []).map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
              <span class="field-hint" id={`${idBase}-ref-hint`}>
                A branch or tag. The workflow’s file has to be on it.
              </span>
            </label>
            {workflow.inputs.length > 0 && (
              <fieldset class="run-wf-inputs" disabled={busy}>
                <legend class="field-label">Inputs</legend>
                {workflow.inputs.map((input) => (
                  <InputField
                    key={input.name}
                    input={input}
                    idBase={`${idBase}-${workflow.id}`}
                    value={values[input.name] ?? ''}
                    environments={environmentsOf(deploys, slug)}
                    onChange={(v) => setValues((old) => ({ ...old, [input.name]: v }))}
                  />
                ))}
              </fieldset>
            )}
          </>
        )}
        {load.data && !actions.ok && <p class="meta">{actions.reason}</p>}
        {error && (
          <p class="field-error" role="alert">
            {error}
          </p>
        )}
        <div class="sheet-actions">
          <button type="button" class="btn btn-quiet" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {workflow?.readable && (
            <button type="submit" class="btn btn-primary" disabled={!canRun} aria-busy={busy}>
              <Play size={16} aria-hidden="true" />
              {busy ? 'Starting…' : 'Run workflow'}
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Run workflow… above the runs list, and the note that one started. `view` is the GitHub view's (scopeGitHub).
 * In the all-repositories view the dialog asks which; scoped to one, it's that one. A run's Run sets `ask`
 * ({ slug, run, from }: its repository, the run, and the button to focus again), and the dialog opens with them.
 * Without `bar`, only that: no Run workflow… button, just the dialog and the note that one started (Checks on main).
 * @param {Record<string, any>} props
 */
export function RunWorkflow({ view, ask = null, onAsked = () => {}, bar = true }) {
  const [open, setOpen] = useState(/** @type {false | { slug?: string, run?: any }} */ (false));
  const [started, setStarted] = useState(/** @type {Record<string, string> | null} */ (null));
  const button = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const back = useRef(/** @type {HTMLElement | null} */ (null));
  useEffect(() => {
    if (!ask) return;
    back.current = ask.from ?? null;
    setStarted(null);
    setOpen({ slug: ask.slug, run: ask.run });
    onAsked();
  }, [ask]);
  const repos = view.all
    ? (view.repos ?? []).filter((r) => !r.empty).map((r) => ({ slug: r.slug, name: r.name }))
    : view.slug && !view.empty
      ? [{ slug: view.slug, name: view.name ?? repoName(view.slug) }]
      : [];
  if (!repos.length) return null;
  const first = repos.find((r) => r.slug === (view.repos?.find((x) => x.isDefault)?.slug ?? null)) ?? repos[0];
  // Scoped to one repository, the button says before it's pressed that the App can't start workflows there.
  const actions = repos.length === 1 ? actionsIn(repos[0].slug) : { ok: true, reason: null };
  const why = `run-wf-why-${repos[0].slug}`.replace(/[^\w-]/gu, '-');
  // Focus goes back on the button once the dialog is gone (while it's open, the page behind it is inert).
  const close = () => {
    setOpen(false);
    const to = back.current?.isConnected ? back.current : button.current;
    back.current = null;
    requestAnimationFrame(() => to?.focus());
  };
  const onStarted = (s) => {
    close();
    setStarted(s);
    // The Worker syncs 5 seconds after it starts one; read the runs again just after.
    setTimeout(() => loadGitHub(), 7000);
  };
  return (
    <div class={bar ? 'run-wf' : 'run-wf run-wf-quiet'}>
      {bar && (
        <div class="run-wf-bar">
          <button
            ref={button}
            type="button"
            class="btn btn-outline btn-sm"
            disabled={!actions.ok}
            aria-describedby={actions.ok ? undefined : why}
            onClick={() => {
              setStarted(null);
              setOpen({});
            }}
          >
            <Play size={16} aria-hidden="true" />
            Run workflow…
          </button>
          {!actions.ok && (
            <span id={why} class="meta">
              {actions.reason}
            </span>
          )}
        </div>
      )}
      {started && (
        <div class="gh-ok run-wf-started" role="status">
          <CircleCheck size={16} aria-hidden="true" />
          <span>
            Started {started.name} on <code>{started.ref}</code>
            {repos.length > 1 ? ` in ${repoName(started.slug)}` : ''}. It shows under Runs in a few seconds.{' '}
            <a href={started.url} {...ext}>
              Its runs on GitHub
              <ExternalLink size={14} aria-hidden="true" />
            </a>
          </span>
          <button
            type="button"
            class="btn btn-quiet btn-icon btn-sm"
            aria-label="Dismiss"
            onClick={() => {
              setStarted(null);
              button.current?.focus();
            }}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}
      {open && (
        <RunWorkflowDialog
          repos={repos}
          slug={open.slug && repos.some((r) => r.slug === open.slug) ? open.slug : first.slug}
          run={open.run ?? null}
          deploys={view.deploys ?? []}
          onClose={close}
          onStarted={onStarted}
        />
      )}
    </div>
  );
}
