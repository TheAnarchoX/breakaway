import { useEffect, useRef, useState } from 'preact/hooks';
import {
  Circle,
  CircleCheck,
  CircleDot,
  Copy,
  ExternalLink,
  Flag,
  GitMerge,
  Globe,
  Play,
  Rocket,
  RefreshCw,
  Terminal,
  TriangleAlert,
} from 'lucide-preact';
import { api, enc, uploadKickoffImage } from '../lib/api.js';
import { copy } from '../lib/clipboard.js';
import { MAX_IMAGES } from '../lib/images.js';
import { ago, ref } from '../lib/model.js';
import {
  agents,
  byUuid,
  confirmDialog,
  go,
  loadAgents,
  loadConnections,
  loadRepos,
  loadTasks,
  navOrder,
  openAddRepo,
  openFeature,
  openKickoff,
  openPull,
  openTask,
  kickoffId,
  repos,
  toast,
} from '../lib/store.js';
import { useDraftImages } from '../components/NewTask.jsx';
import { ImagePicker, Thumbnails } from '../components/Attachments.jsx';
import { DecisionSection } from '../components/Decision.jsx';
import { RoutineConnect } from '../components/RoutineConnect.jsx';
import { useAutosize } from '../components/ui.jsx';
import { Markdown } from '../lib/richtext.jsx';
import STUB from '../../../prompts/stub.md?raw';

/**
 * Kickoff (WEB-35, docs/specs/IDEA-26-kickoff.md, sections 1 to 4): a new project from a pitch, on the board. #/kickoff
 * lists the kickoffs in progress and starts one; #/kickoff/<id> walks one through its steps in plain words (the Add a
 * repository wizard's own ticks, from GET /api/kickoffs/<id>), then the interview on its IDEA, the plan's pull
 * request, and Start building. Every step that creates, registers, writes, or starts something is a press here.
 */

const ext = { target: '_blank', rel: 'noopener noreferrer' };
const POLL_MS = 20_000;
const ROUTINES_URL = 'https://claude.ai/code/routines';
const MAX_PITCH = 4000;

/** @param {Record<string, any>} props */
function ExtLink({ href, children, primary = false }) {
  return (
    <a class={`btn ${primary ? 'btn-primary' : 'btn-outline'} btn-sm`} href={href} {...ext}>
      {children}
      <ExternalLink size={15} aria-hidden="true" />
      <span class="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

/**
 * One thing to copy into claude.ai, with what it is.
 * @param {Record<string, any>} props
 */
function CopyRow({ label, text, what, multiline = false }) {
  return (
    <div class="wiz-cmd ko-copy">
      <p class="meta">{label}</p>
      <div class="wiz-cmd-row">
        {multiline ? <pre class="ko-copy-text">{text}</pre> : <code>{text}</code>}
        <button
          type="button"
          class="btn btn-outline btn-sm ko-copy-button"
          aria-label={`Copy ${what}`}
          onClick={() => copy(text, what)}
        >
          <Copy size={16} aria-hidden="true" />
          <span aria-hidden="true">Copy</span>
        </button>
      </div>
    </div>
  );
}

/** @param {{ text: string }} props */
function Command({ text }) {
  return (
    <div class="wiz-cmd">
      <div class="wiz-cmd-row">
        <code>{text}</code>
        <button
          type="button"
          class="btn btn-quiet btn-icon btn-sm"
          aria-label={`Copy ${text}`}
          onClick={() => copy(text, 'Command')}
        >
          <Copy size={16} aria-hidden="true" />
        </button>
      </div>
      <p class="meta">
        <span class="wiz-terminal">
          <Terminal size={14} aria-hidden="true" />
          In your own terminal
        </span>
      </p>
    </div>
  );
}

const prefixOf = (k) => k?.areas?.[0]?.prefix ?? '';

/**
 * The name, the short name, and the work-ID prefix, checked against the board as they're typed (a dry run). The
 * name is suggested from the pitch; the short name and prefix from the name, and they're shown, not asked, unless
 * More options is open. `onCheck` gets the board's answer: `{ kickoff }` or `{ error }`.
 * @param {Record<string, any>} props
 */
function NameFields({ pitch, values, setValues, check, path, method }) {
  const timer = useRef(null);
  const { name, slug, prefix } = values;
  useEffect(() => {
    clearTimeout(timer.current);
    if (!pitch.trim()) {
      check.set({ kickoff: null, error: null });
      return undefined;
    }
    timer.current = setTimeout(async () => {
      const body = { pitch, dryRun: true, by: 'owner' };
      if (name.trim()) body.name = name.trim();
      if (slug.trim()) body.slug = slug.trim();
      if (prefix.trim()) body.areas = [{ project: 'app', prefix: prefix.trim().toUpperCase(), name: 'app' }];
      try {
        const { kickoff } = await api(path, { method, body });
        check.set({ kickoff, error: null });
      } catch (error) {
        check.set({ kickoff: null, error: error.message });
      }
    }, 400);
    return () => clearTimeout(timer.current);
  }, [pitch, name, slug, prefix]);
  const k = check.value.kickoff;
  return (
    <>
      <label class="field">
        <span class="field-label">What should it be called?</span>
        <input
          class="input"
          name="name"
          autoComplete="off"
          spellcheck={false}
          maxLength={100}
          placeholder={k?.name ?? 'plant-diary'}
          value={name}
          onInput={(e) => setValues({ ...values, name: e.currentTarget.value })}
          aria-describedby="ko-name-hint ko-check"
        />
        <span class="field-hint" id="ko-name-hint">
          It becomes the repository’s name on GitHub. Leave it empty to take the suggestion from your first line.
        </span>
      </label>
      <p class="meta" id="ko-check" role="status">
        {check.value.error ? (
          <span class="field-error">{check.value.error}</span>
        ) : k ? (
          <>
            It’ll be <strong>{k.name}</strong> on GitHub, <strong>{k.slug}</strong> on the board, and its tasks get work
            IDs like <strong>{prefixOf(k)}-1</strong>.
          </>
        ) : null}
      </p>
      <details class="ko-more">
        <summary>More options</summary>
        <div class="field-row">
          <label class="field">
            <span class="field-label">Short name on the board</span>
            <input
              class="input"
              name="slug"
              autoComplete="off"
              spellcheck={false}
              placeholder={k?.slug ?? ''}
              value={slug}
              onInput={(e) => setValues({ ...values, slug: e.currentTarget.value })}
              aria-describedby="ko-slug-hint"
            />
            <span class="field-hint" id="ko-slug-hint">
              Lowercase letters, digits, and hyphens. It never changes once it’s on the board.
            </span>
          </label>
          <label class="field">
            <span class="field-label">Work-ID prefix</span>
            <input
              class="input"
              name="prefix"
              autoComplete="off"
              spellcheck={false}
              placeholder={prefixOf(k)}
              value={prefix}
              onInput={(e) => setValues({ ...values, prefix: e.currentTarget.value })}
              aria-describedby="ko-prefix-hint"
            />
            <span class="field-hint" id="ko-prefix-hint">
              2 to 8 capital letters, its own for good. Its tasks start in one area, app.
            </span>
          </label>
        </div>
      </details>
    </>
  );
}

/** A small signal-like pair for NameFields' check. */
function useCheck() {
  const [value, set] = useState({ kickoff: null, error: null });
  return { value, set };
}

/** @param {{ app: boolean | null }} props */
function NoApp({ app }) {
  if (app !== false) return null;
  return (
    <div class="conn-fix ko-noapp" role="status">
      <p>
        <TriangleAlert size={15} aria-hidden="true" class="wiz-warn" />{' '}
        <strong>The board isn’t connected to GitHub yet.</strong> You can save your idea now, but setting it up needs
        the board’s GitHub App first.
      </p>
      <p>
        <button type="button" class="btn btn-outline btn-sm" onClick={() => go('connections')}>
          Open Connections
        </button>
      </p>
    </div>
  );
}

/** #/kickoff: the kickoffs in progress, and the form that starts one. */
function KickoffStart() {
  const [list, setList] = useState({ kickoffs: null, app: null, error: null });
  const [pitch, setPitch] = useState('');
  const [values, setValues] = useState({ name: '', slug: '', prefix: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const check = useCheck();
  const area = useRef(null);
  useAutosize(area, pitch);
  const { images, pick, drop, dropZone } = useDraftImages();
  useEffect(() => {
    navOrder.value = [];
    api('kickoffs')
      .then((data) => setList({ kickoffs: data.kickoffs, app: data.app, error: null }))
      .catch((e) => setList({ kickoffs: [], app: null, error: e.message }));
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!pitch.trim()) {
      setError('Say what you want to make first, in your own words.');
      return;
    }
    setBusy(true);
    try {
      const body = { pitch, by: 'owner' };
      if (values.name.trim()) body.name = values.name.trim();
      if (values.slug.trim()) body.slug = values.slug.trim();
      if (values.prefix.trim())
        body.areas = [{ project: 'app', prefix: values.prefix.trim().toUpperCase(), name: 'app' }];
      const { kickoff } = await api('kickoffs', { method: 'POST', body });
      let failed = 0;
      for (const image of images) {
        try {
          await uploadKickoffImage(kickoff.id, image.blob, { name: image.name });
        } catch {
          failed += 1;
        }
      }
      for (const image of images) URL.revokeObjectURL(image.url);
      if (failed) toast('Some images didn’t attach. Add them again from its page.', 'error');
      openKickoff(kickoff.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="connections-view wizard kickoff">
      <div class="view-intro">
        <h1>Kick off a project.</h1>
        <p class="muted">
          Say what you want to make. The board sets up a private home for it on GitHub and an agent to work there, then
          the agent asks you a few plain questions and turns your answers into a plan. You press every button that
          creates or starts something.
        </p>
      </div>
      {list.error && (
        <p class="field-error" role="alert">
          {list.error}
        </p>
      )}
      {list.kickoffs?.length > 0 && (
        <section class="conn-group" aria-labelledby="ko-progress">
          <h2 id="ko-progress">In progress</h2>
          <ul class="wiz-repos">
            {list.kickoffs.map((k) => (
              <li key={k.id}>
                <a class="btn btn-outline btn-sm" href={`#/kickoff/${k.id}`}>
                  <Flag size={16} aria-hidden="true" />
                  {k.name}
                </a>
                <span class="meta">
                  {k.registered ? `On the board as ${k.slug}` : 'Not on the board yet'}, started{' '}
                  <time dateTime={k.created}>{ago(k.created)}</time>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <NoApp app={list.app} />
      <form {...dropZone('ko-start')} onSubmit={submit} noValidate>
        <h2 class="visually-hidden">Start a new one</h2>
        <label class="field">
          <span class="field-label">What do you want to make?</span>
          <textarea
            ref={area}
            name="pitch"
            class="textarea"
            rows={6}
            maxLength={MAX_PITCH}
            value={pitch}
            placeholder="A diary for my plants. I keep forgetting when I watered the fern."
            onInput={(e) => {
              setPitch(e.currentTarget.value);
              setError(null);
            }}
            aria-describedby={error ? 'ko-pitch-error ko-pitch-hint' : 'ko-pitch-hint'}
          />
          {error && (
            <span class="field-error" id="ko-pitch-error" role="alert">
              {error}
            </span>
          )}
          <span class="field-hint" id="ko-pitch-hint">
            In your own words, as long as you like. Who it’s for, what it does, what it looks like. Rough is fine: the
            agent asks about the rest.
          </span>
        </label>
        <div class="field">
          <span class="field-label">Images (optional)</span>
          <Thumbnails images={images} onRemove={drop} />
          <div class="attach-actions">
            <ImagePicker
              onFiles={pick}
              disabled={busy || images.length >= MAX_IMAGES}
              full={images.length >= MAX_IMAGES}
            />
          </div>
        </div>
        <NameFields pitch={pitch} values={values} setValues={setValues} check={check} path="kickoffs" method="POST" />
        <div class="ko-submit">
          <button type="submit" class="btn btn-primary" disabled={busy || Boolean(check.value.error)} aria-busy={busy}>
            <Rocket size={18} aria-hidden="true" />
            {busy ? 'Saving…' : 'Kick it off'}
          </button>
          <span class="meta">It’s saved on your board only, until you create its repository.</span>
        </div>
      </form>
    </div>
  );
}

/** The "In short" section of a plan's pull request description, if it has one. */
export function inShortOf(body) {
  const lines = String(body ?? '').split('\n');
  const start = lines.findIndex((l) => /^#{1,4}\s*In short\b/iu.test(l.trim()) || /^\*\*In short\*\*/iu.test(l.trim()));
  if (start < 0) return null;
  const first = lines[start].trim().replace(/^\*\*In short\*\*[:.]?\s*/iu, '');
  const rest = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,4}\s/u.test(line.trim())) break;
    rest.push(line);
  }
  const text = [/^#/u.test(first) ? '' : first, ...rest].join('\n').trim();
  return text || null;
}

/**
 * Read the plan, Merge, and Start building: the IDEA's pull request, with its In short quoted, and the board's own
 * pull request page for Merge. Kickoff never merges or starts the chase.
 * @param {Record<string, any>} props
 */
function Plan({ idea, slug }) {
  const number = /^\d+$/u.test(String(idea?.pr ?? ''))
    ? String(idea.pr)
    : (/\/pull\/(\d+)/u.exec(idea?.pr ?? '')?.[1] ?? null);
  const [page, setPage] = useState({ data: null, error: null });
  useEffect(() => {
    if (!number) return;
    api(`github/pulls/${number}?repo=${enc(slug)}`)
      .then((data) => setPage({ data, error: null }))
      .catch((error) => setPage({ data: null, error: error.message }));
  }, [number, slug, idea?.status]);
  if (!number) return null;
  const p = page.data;
  const short = p ? inShortOf(p.body) : null;
  return (
    <div class="ko-plan">
      {page.error && <p class="field-error">{page.error}</p>}
      {p && (
        <>
          <p>
            <strong>#{p.number}</strong> {p.title}
          </p>
          {short ? (
            <blockquote class="ko-inshort">
              <p class="meta">In short</p>
              <Markdown text={short} />
            </blockquote>
          ) : (
            <p class="muted">
              Its spec opens with In short: a few plain sentences to check against what you asked for.
            </p>
          )}
        </>
      )}
      <div class="wiz-actions">
        <button type="button" class="btn btn-primary btn-sm" onClick={() => openPull(Number(number), slug)}>
          <GitMerge size={16} aria-hidden="true" />
          {p?.state === 'merged' ? 'Open the pull request' : 'Read it and merge'}
        </button>
        {p?.url && <ExtLink href={p.url}>Open on GitHub</ExtLink>}
      </div>
    </div>
  );
}

/**
 * Start the interview, or the next run: an agent on the IDEA, which the board starts in the kickoff mode. At the
 * board's limits it waits for room instead, started by the same press once there is.
 */
async function startRun(idea) {
  try {
    await api('agents/start', { method: 'POST', body: { ref: idea.uuid } });
    toast(`Started an agent on ${ref(idea)}.`, 'success');
  } catch (error) {
    if (error.data?.forceable || error.status === 429) {
      try {
        await api(`tasks/${enc(idea.uuid)}`, { method: 'PATCH', body: { autostart: 'yes' } });
        toast(`It starts when there’s room: ${error.message}`, 'info');
      } catch (err) {
        toast(err.message, 'error');
      }
    } else toast(error.message, 'error');
  }
  await loadTasks();
  loadAgents();
}

/** @param {Record<string, any>} props */
function StepIcon({ done, now }) {
  if (done) return <CircleCheck size={20} aria-hidden="true" class="wiz-icon is-done" />;
  if (now) return <CircleDot size={20} aria-hidden="true" class="wiz-icon is-now" />;
  return <Circle size={20} aria-hidden="true" class="wiz-icon" />;
}

/** @param {Record<string, any>} props */
function Problem({ problem }) {
  if (!problem) return null;
  return (
    <div class="conn-fix">
      <p>
        <TriangleAlert size={15} aria-hidden="true" class="wiz-warn" /> <strong>{problem.name}:</strong>{' '}
        {problem.detail}
      </p>
      <p>
        <strong>To fix it:</strong> {problem.fix}
      </p>
      {problem.link && <ExtLink href={problem.link}>Open</ExtLink>}
    </div>
  );
}

/** @param {Record<string, any>} props */
function Checks({ checks }) {
  if (!checks?.length) return null;
  return (
    <ul class="wiz-checks">
      {checks.map((c) => (
        <li key={c.id} class={c.done ? 'is-done' : ''}>
          {c.done ? <CircleCheck size={16} aria-hidden="true" /> : <Circle size={16} aria-hidden="true" />}
          <span>
            {c.name}
            <span class="visually-hidden">{c.done ? ', done' : ', not yet'}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** @param {Record<string, any>} props */
function Step({ id, index, name, done, now, open = now, detail, children }) {
  return (
    <li class={`wiz-step ${done ? 'is-done' : ''} ${now ? 'is-now' : ''}`} aria-current={now ? 'step' : undefined}>
      <details open={open}>
        <summary>
          <StepIcon done={done} now={now} />
          <span class="wiz-step-name" id={`ko-step-${id}`}>
            <span class="wiz-step-n">{index}.</span> {name}
            <span class="visually-hidden">{done ? ', done' : now ? ', to do now' : ', to do'}</span>
          </span>
          {detail && <span class="meta wiz-step-detail">{detail}</span>}
        </summary>
        <div class="wiz-body">{children}</div>
      </details>
    </li>
  );
}

/**
 * Where it is on GitHub, once the person pressed Create there: owner/name, saved on the kickoff so the board can
 * look for it. Prefilled with the owner of the board's other repositories and the kickoff's name.
 * @param {Record<string, any>} props
 */
function WhereOnGitHub({ k, onSaved }) {
  const guess = () => {
    const owner = repos.value.list[0]?.github.split('/')[0];
    return k.github ?? (owner ? `${owner}/${k.name}` : '');
  };
  const [value, setValue] = useState(guess);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`kickoffs/${enc(k.id)}`, { method: 'PATCH', body: { github: value.trim(), by: 'owner' } });
      toast('Saved.', 'success');
      await onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="setup-register ko-where" onSubmit={submit}>
      <label class="field">
        <span class="field-label">Where is it on GitHub?</span>
        <input
          class="input"
          required
          autoComplete="off"
          spellcheck={false}
          placeholder="your-name/plant-diary"
          value={value}
          onInput={(e) => {
            setValue(e.currentTarget.value);
            setError(null);
          }}
          aria-describedby={error ? 'ko-where-error' : 'ko-where-hint'}
        />
        <span class="field-hint" id="ko-where-hint">
          As owner/name, the way it shows at the top of its page on github.com, or its link.
        </span>
      </label>
      {error && (
        <p class="field-error" id="ko-where-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" class="btn btn-outline btn-sm" disabled={busy || !value.trim()} aria-busy={busy}>
        {k.github ? 'Change it' : 'Save it'}
      </button>
    </form>
  );
}

/**
 * The name and prefix, changeable until it's on the board; after that, its settings page holds them.
 * @param {Record<string, any>} props
 */
function Rename({ k, onSaved }) {
  const [values, setValues] = useState({ name: k.name, slug: '', prefix: '' });
  const [busy, setBusy] = useState(false);
  const check = useCheck();
  const changed = values.name.trim() !== k.name || values.slug.trim() || values.prefix.trim();
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { by: 'owner', name: values.name.trim() || k.name };
      if (values.slug.trim()) body.slug = values.slug.trim();
      if (values.prefix.trim())
        body.areas = [{ project: 'app', prefix: values.prefix.trim().toUpperCase(), name: 'app' }];
      await api(`kickoffs/${enc(k.id)}`, { method: 'PATCH', body });
      toast('Saved.', 'success');
      setValues({ name: body.name, slug: '', prefix: '' });
      await onSaved();
    } catch (err) {
      check.set({ kickoff: null, error: err.message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="setup-register" onSubmit={submit}>
      <NameFields
        pitch={k.pitch}
        values={values}
        setValues={setValues}
        check={check}
        path={`kickoffs/${enc(k.id)}`}
        method="PATCH"
      />
      <button
        type="submit"
        class="btn btn-outline btn-sm"
        disabled={busy || !changed || Boolean(check.value.error)}
        aria-busy={busy}
      >
        Save the name
      </button>
    </form>
  );
}

/** #/kickoff/<id>: one kickoff, from its private home on GitHub to Start building. */
function KickoffPage({ id }) {
  const [state, setState] = useState({ data: null, error: null, checking: false, gone: false });
  const [busy, setBusy] = useState(null);
  const [initCommand, setInitCommand] = useState(null);
  const load = async (quiet = false) => {
    if (!quiet) setState((s) => ({ ...s, checking: true }));
    try {
      const data = await api(`kickoffs/${enc(id)}?check=1`);
      setState({ data, error: null, checking: false, gone: false });
    } catch (error) {
      setState((s) => ({ ...s, error: error.message, checking: false, gone: error.status === 404 }));
    }
  };
  useEffect(() => {
    navOrder.value = [];
    setState({ data: null, error: null, checking: false, gone: false });
    setInitCommand(null);
    load();
    if (!agents.value.loaded) loadAgents();
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') {
        load(true);
        loadTasks();
      }
    }, POLL_MS);
    return () => clearInterval(poll);
  }, [id]);

  const d = state.data;
  if (!d)
    return (
      <div class="connections-view wizard kickoff">
        <BackLink />
        {state.error ? (
          <p class="field-error" role="alert">
            {state.gone ? 'There’s no kickoff here any more: it was stopped, or the link is wrong.' : state.error}
          </p>
        ) : (
          <p class="muted" aria-busy="true">
            Checking…
          </p>
        )}
      </div>
    );

  const k = d.kickoff;
  const step = Object.fromEntries(d.steps.map((s) => [s.id, s]));
  const idea = k.idea ? byUuid.value.get(k.idea.uuid) : null;
  const connected = Boolean(d.routine?.connected);
  const filesDone = step.init.done && step.prompt.done;
  const decisionOpen = Boolean(idea?.decision?.length) && idea.tags.includes('decide');
  const answered = Boolean(idea?.decisionAnswers) && !decisionOpen;
  const planned = Boolean(idea?.pr);
  const merged = idea?.status === 'completed';
  const appInstall = d.app?.slug
    ? `https://github.com/apps/${d.app.slug}/installations/new`
    : 'https://github.com/settings/installations';
  const feature = `${k.slug}-v1`;

  const run = async (what, fn) => {
    setBusy(what);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };
  const register = () =>
    run('register', async () => {
      try {
        await api(`kickoffs/${enc(k.id)}/register`, { method: 'POST', body: { by: 'owner' } });
        await Promise.all([loadRepos(), loadConnections(), loadTasks()]);
        toast(`${k.name} is on the board.`, 'success');
      } catch (error) {
        toast(error.message, 'error');
      }
      await load(true);
    });
  const addFiles = () =>
    run('init', async () => {
      try {
        await api(`repos/${enc(k.slug)}/init`, { method: 'POST', body: { by: 'owner' } });
        toast('Added.', 'success');
      } catch (error) {
        if (error.data?.command) setInitCommand(error.data.command);
        toast(error.message, 'error');
      }
      await load(true);
    });
  const stop = async () => {
    const ok = await confirmDialog({
      title: `Stop ${k.name}?`,
      body: k.registered
        ? `This kickoff’s page goes. ${k.slug} stays on the board with its idea; take it off from Add a repository if you don’t want it.`
        : 'Your pitch and its images on this board go. Nothing was written anywhere else.',
      confirmLabel: 'Stop it',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api(`kickoffs/${enc(k.id)}`, { method: 'DELETE', body: { by: 'owner' } });
      toast('Stopped.', 'success');
      openKickoff(null);
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  // Kickoff's steps, in its own words: the wizard's ticks, then the interview, the plan, and building.
  const steps = [
    { id: 'create', name: 'Make a private home for it on GitHub', done: step.create.done },
    { id: 'install', name: 'Let the board see it', done: step.install.done, problem: step.install.problem },
    { id: 'register', name: 'Add it to the board', done: k.registered },
    { id: 'files', name: 'Add the board’s files', done: filesDone, problem: step.init.problem },
    { id: 'routine', name: 'Make its agent routine on claude.ai', done: connected },
    { id: 'connect', name: 'Connect the routine', done: connected, problem: step.agent.problem },
    { id: 'interview', name: 'Tell it what you want', done: planned || merged },
    { id: 'plan', name: 'Read the plan and merge it', done: merged },
    { id: 'build', name: 'Start building', done: false },
    // The wizard's optional Deploys step (WEB-14, WEB-36): offered last, and never the step to do now.
    { id: 'online', name: 'Put it online', done: Boolean(step.deploys?.done), optional: true },
  ];
  const now = steps.find((s) => !s.done && !s.optional)?.id ?? null;
  const n = steps.findIndex((s) => s.id === now);
  const stub = STUB.replaceAll('<prompt path>', d.promptPath ?? 'AGENTS.md');

  const content = {
    create: (
      <>
        <p>
          GitHub’s own form opens filled in: the name <strong>{k.name}</strong>, private, and your first line as its
          description. Press <strong>Create repository</strong> there, and leave the README, licence, and .gitignore
          off.
        </p>
        <p class="muted">
          <strong>Why private:</strong> your idea isn’t public until you choose. You can make it public later, on
          GitHub.
        </p>
        <div class="wiz-actions">
          <ExtLink href={k.links.create} primary={!k.github}>
            Open GitHub’s form
          </ExtLink>
        </div>
        <WhereOnGitHub k={k} onSaved={() => load(true)} />
        <p class="wiz-expect">
          <strong>When it worked:</strong> this ticks with the next step, once the board’s GitHub App can see it. If
          GitHub says the name is taken, pick another there and change it here.
        </p>
      </>
    ),
    install: (
      <>
        <p>
          Give the board’s GitHub App access to <strong>{k.github ?? k.name}</strong>, then turn on{' '}
          <strong>Allow auto-merge</strong> in its settings (General, then Pull Requests).
        </p>
        <p class="muted">
          <strong>Why:</strong> the App is how the board reads the repository, writes its first files, and links pull
          requests to tasks.
        </p>
        <div class="wiz-actions">
          <ExtLink href={appInstall}>Give the App access</ExtLink>
          {k.github && <ExtLink href={`https://github.com/${k.github}/settings`}>Open its settings</ExtLink>}
        </div>
        <Checks checks={step.install.checks} />
        <Problem problem={step.install.problem} />
      </>
    ),
    register: k.registered ? (
      <p>
        It’s on the board as <strong>{k.slug}</strong>, with work IDs like <strong>{prefixOf(k)}-1</strong>
        {idea && (
          <>
            , and your idea is{' '}
            <button type="button" class="link-button" onClick={() => openTask(idea.uuid)}>
              {ref(idea)}
            </button>
          </>
        )}
        . Its settings are on{' '}
        <a href={k.links.settings}>
          its settings page<span class="visually-hidden"> for {k.slug}</span>
        </a>
        .
      </p>
    ) : (
      <>
        <p>
          One press adds <strong>{k.github ?? k.name}</strong> to the board as <strong>{k.slug}</strong>, with work IDs
          like <strong>{prefixOf(k)}-1</strong>. Your pitch becomes its first idea, word for word.
        </p>
        <div class="wiz-actions">
          <button
            type="button"
            class="btn btn-primary btn-sm"
            disabled={!k.github || busy === 'register'}
            aria-busy={busy === 'register'}
            onClick={register}
          >
            {busy === 'register' ? 'Adding…' : 'Add it to the board'}
          </button>
        </div>
        {!k.github && <p class="meta">Say where it is on GitHub first, in step 1.</p>}
        <details class="ko-more">
          <summary>Change the name or prefix</summary>
          <Rename k={k} onSaved={() => load(true)} />
        </details>
      </>
    ),
    files: (
      <>
        <p>
          One press writes the first commit: the instructions the board’s agents follow there, its command line, and a
          starter AGENTS.md. The interview’s plan fills them in for what you’re making.
        </p>
        {step.init.detail && <p class="meta">{step.init.detail}</p>}
        {step.prompt.detail && <p class="meta">{step.prompt.detail}</p>}
        {!filesDone && (
          <div class="wiz-actions">
            <button
              type="button"
              class="btn btn-primary btn-sm"
              disabled={!k.registered || busy === 'init'}
              aria-busy={busy === 'init'}
              onClick={addFiles}
            >
              {busy === 'init' ? 'Adding…' : 'Add the board’s files'}
            </button>
          </div>
        )}
        {initCommand && (
          <>
            <p class="meta">It already has files, so they go in through a pull request for you to merge instead:</p>
            <Command text={initCommand} />
          </>
        )}
        <Problem problem={step.init.problem} />
      </>
    ),
    routine: (
      <>
        <p>
          On claude.ai, make a routine: it’s how the board starts an agent in <strong>{k.github ?? k.name}</strong>.
          claude.ai has no way for the board to make one, so copy each of these in.
        </p>
        <ol class="ko-guide">
          <li>
            <CopyRow label="Name it:" text={`${k.name} agent`} what="Name" />
          </li>
          <li>
            <CopyRow label="Pick this repository:" text={k.github ?? k.name} what="Repository" />
          </li>
          <li>
            <CopyRow label="Paste this as its instructions:" text={stub} what="Instructions" multiline />
          </li>
          <li>
            <CopyRow
              label="In its cloud environment, allow this host, and add the board’s token as BREAKAWAY_TOKEN:"
              text={location.host}
              what="Host"
            />
          </li>
          <li>
            <p class="meta">Add an API trigger, and keep its page open: the next step needs its URL and a token.</p>
          </li>
        </ol>
        <div class="wiz-actions">
          <ExtLink href={ROUTINES_URL}>Open routines on claude.ai</ExtLink>
        </div>
        <p class="wiz-expect">
          <strong>When it worked:</strong> the board can’t see claude.ai, so this ticks with the next step.
        </p>
      </>
    ),
    connect: k.registered ? (
      <>
        <p>
          Paste the routine’s URL and token from its API trigger. The board checks them, keeps them encrypted, and never
          shows them again.
        </p>
        {!connected && (
          <RoutineConnect slug={k.slug} source={d.routine?.source ?? null} open onDone={() => load(true)} />
        )}
        {connected && <p class="meta">Connected. The board can start agents there.</p>}
        <Problem problem={step.agent.problem} />
      </>
    ) : (
      <p class="muted">Once it’s on the board, paste the routine’s URL and token here.</p>
    ),
    interview: (
      <>
        <p>
          An agent reads your pitch and asks a few plain questions: what it is, how it’s built, and how it runs. Answer
          them here; then it asks a little more, or plans it.
        </p>
        {!idea && <p class="muted">Your idea shows here once it’s on the board.</p>}
        {idea?.claim && (
          <p class="meta" role="status">
            <CircleDot size={14} aria-hidden="true" /> {idea.claim} is on it. Its questions show here when it’s done.
          </p>
        )}
        {idea && !idea.claim && idea.autostart === 'yes' && (
          <p class="meta" role="status">
            Waiting for room to start. It starts by itself as soon as there is.
          </p>
        )}
        {idea && !idea.claim && !planned && !decisionOpen && idea.autostart !== 'yes' && (
          <div class="wiz-actions">
            <button
              type="button"
              class="btn btn-primary btn-sm"
              disabled={!connected || busy === 'start'}
              aria-busy={busy === 'start'}
              onClick={() => run('start', () => startRun(idea))}
            >
              <Play size={16} aria-hidden="true" />
              {answered ? 'Start the next run' : 'Start the interview'}
            </button>
            {!connected && <span class="meta">Connect the routine first.</span>}
          </div>
        )}
        {idea && (decisionOpen || answered) && (
          <div class="ko-decision">
            <DecisionSection task={idea} />
          </div>
        )}
      </>
    ),
    plan: (
      <>
        <p>
          The plan is a pull request in {k.github ?? k.name}: a spec that opens with In short, how to build it, and the
          first tasks, waiting for it to merge. Read it, and merge it from the board when it says what you asked for.
        </p>
        {!planned && <p class="muted">It shows here once the agent opens it.</p>}
        {planned && idea && <Plan idea={idea} slug={k.slug} />}
      </>
    ),
    build: (
      <>
        <p>
          The first version’s tasks are a feature, <strong>{feature}</strong>. Open it and press Chase when you’re
          ready: agents build it task by task, and every pull request is still yours to merge.
        </p>
        <div class="wiz-actions">
          <button type="button" class="btn btn-primary btn-sm" disabled={!merged} onClick={() => openFeature(feature)}>
            <Rocket size={16} aria-hidden="true" />
            Start building
          </button>
          {!merged && <span class="meta">Once the plan is merged.</span>}
        </div>
      </>
    ),
    online: step.deploys?.done ? (
      <p>
        It’s online: deploys are on. Releases on the{' '}
        <button type="button" class="link-button" onClick={() => go('github')}>
          GitHub page
        </button>{' '}
        shows what shipped where.
      </p>
    ) : (
      <>
        <p>
          When there’s something to try, the board can put it online. An agent moves {k.github ?? k.name} to breakaway’s
          deploy flow in a pull request; you merge it, then turn deploys on.
        </p>
        <p class="muted">
          <strong>Where it goes:</strong> a website or an app goes on your Cloudflare account, beside the board. Every
          merge updates a test copy, and Promote puts it live. A package goes on npm the same way. For anything else,
          the step says what it can do.
        </p>
        <p class="muted">
          <strong>Why it’s optional:</strong> agents build it either way. Do it now, later, or not at all.
        </p>
        <div class="wiz-actions">
          <button
            type="button"
            class="btn btn-outline btn-sm"
            disabled={!merged}
            onClick={() => openAddRepo({ slug: k.slug }, 'deploys')}
          >
            <Globe size={16} aria-hidden="true" />
            Put it online
          </button>
          {!merged && <span class="meta">Once the plan is merged.</span>}
        </div>
      </>
    ),
  };

  return (
    <div class="connections-view wizard kickoff">
      <BackLink />
      <div class="conn-top">
        <div class="view-intro">
          <h1>{k.name}</h1>
          <p class="muted">
            Each step ticks itself once the board can see it’s done. Close the page whenever you like: everything is
            saved, and it picks up where you were.
          </p>
        </div>
        <div class="conn-check">
          <button
            type="button"
            class="btn btn-outline btn-sm"
            onClick={() => load()}
            disabled={state.checking}
            aria-busy={state.checking}
          >
            <RefreshCw size={16} aria-hidden="true" class={state.checking ? 'spin' : ''} />
            {state.checking ? 'Checking…' : 'Check now'}
          </button>
          <span class="meta">
            {d.checked ? (
              <>
                GitHub checked <time dateTime={d.checked}>{ago(d.checked)}</time>
              </>
            ) : (
              'GitHub not checked yet'
            )}
          </span>
        </div>
      </div>
      {state.error && (
        <p class="field-error" role="alert">
          {state.error}
        </p>
      )}
      <details class="ko-pitch">
        <summary>Your pitch</summary>
        <div class="ko-pitch-text">
          <Markdown text={k.pitch} />
        </div>
      </details>
      <p class={`conn-summary ${now ? 'is-next' : ''}`} role="status">
        {now ? <CircleDot size={18} aria-hidden="true" /> : <CircleCheck size={18} aria-hidden="true" />}
        {merged
          ? `${k.name}’s plan is merged. Its first tasks are waiting.`
          : `Step ${n + 1} of ${steps.length}: ${steps[n].name.charAt(0).toLowerCase()}${steps[n].name.slice(1)}.`}
      </p>
      <ol class="wiz-steps">
        {steps.map((s, i) => (
          <Step
            key={s.id}
            id={s.id}
            index={i + 1}
            name={s.name}
            done={s.done}
            now={now === s.id || (merged && s.id === 'build')}
            open={now === s.id || (merged && (s.id === 'build' || s.id === 'online'))}
            detail={s.optional && !s.done ? 'Optional' : null}
          >
            {content[s.id]}
          </Step>
        ))}
      </ol>
      <section class="conn-group wiz-out" aria-labelledby="ko-out">
        <h2 id="ko-out">Changed your mind?</h2>
        <p class="muted small">
          {k.registered
            ? `Stopping removes this page. ${k.slug} stays on the board with its idea until you take it off.`
            : 'Stopping removes your pitch and its images from the board. Nothing was written anywhere else.'}
        </p>
        <div class="wiz-actions">
          <button type="button" class="btn btn-outline btn-sm" onClick={stop}>
            Stop this kickoff
          </button>
          {k.registered && (
            <button type="button" class="btn btn-quiet btn-sm" onClick={() => openAddRepo({ slug: k.slug })}>
              Take {k.slug} off the board
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function BackLink() {
  return (
    <p class="meta">
      <button type="button" class="link-button" onClick={() => openKickoff(null)}>
        All kickoffs
      </button>
    </p>
  );
}

export function KickoffView() {
  const id = kickoffId.value;
  return id ? <KickoffPage id={id} /> : <KickoffStart />;
}
