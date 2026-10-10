import { useEffect, useRef, useState } from 'preact/hooks';
import {
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Copy,
  ExternalLink,
  FolderGit2,
  Package,
  Plug,
  PowerOff,
  RotateCcw,
  Server,
  Trash2,
  TriangleAlert,
} from 'lucide-preact';
import { api, enc } from '../lib/api.js';
import { AREAS, plural } from '../lib/model.js';
import { RepoPullSettings } from '../components/PullSettings.jsx';
import { DeployCard } from '../components/DeployCard.jsx';
import { InfraSettings } from '../components/InfraSettings.jsx';
import { KickoffSummary } from '../components/KickoffRunIt.jsx';
import { WORKFLOWS, deployField, missingOf, pipelineForm, pipelineOf } from '../lib/pipeline-form.js';
import { ago, isOwner, loadPeople, people } from '../lib/people.js';
import { stubFor } from '../components/YourClaude.jsx';
import { LENT_CAPS } from '../../../src/person-claude.js';
import {
  agents,
  confirmDialog,
  github,
  githubRepoFacts,
  hashFor,
  loadAgents,
  loadGitHub,
  multiRepo,
  loadRepos,
  navOrder,
  openAddRepo,
  repoSettingsHref,
  repos,
  settingsSlug,
  toast,
} from '../lib/store.js';

/**
 * A repository's settings page (docs/specs/IDEA-29-settings.md, sections 2 and 5; WEB-30, WEB-31): General, Areas,
 * Agents, and Deploys, everything `repos modify` changes; Infrastructure, its policy, envelopes, and freeze (WEB-64); Pull requests, this browser's; and Take it off the board,
 * the CLI command to copy. It reads GET /api/repos/<slug> and saves each section on its own
 * through PATCH /api/repos/<slug>, with the row's last-changed time it loaded (`edited`), so a change made
 * somewhere else since is shown instead of overwritten. The server's checks are the CLI's (`checkRepo`), so a
 * refusal shows under the field that caused it, and the edit stays.
 */

/** Where a repository keeps its agent prompt when it doesn't say (src/repos.js, DEFAULT_PROMPT_PATH). */
const DEFAULT_PROMPT_PATH = 'tools/tasks/routine-prompt.md';
const ROUTINES_URL = 'https://claude.ai/code/routines';
const SHARED = AREAS.filter((a) => ['ideas', 'routines'].includes(a.id));
const CHANGED_ELSEWHERE = 'Changed somewhere else. Here’s what it is now.';
/** The server's refusal of a specs directory, in the page's words rather than the setting's key. */
const SPECS_REFUSED = 'Use a folder in the repository, from its root and without .., like docs/specs.';

/** A saved row with each area's counts carried over from the last read; a new area has no tasks yet. */
const withCounts = (repo, before) =>
  repo.areas.map((a) => {
    const old = before.find((b) => b.project === a.project);
    return { ...a, open: old?.open ?? 0, total: old?.total ?? 0 };
  });

/**
 * One PATCH for one section: its fields, the row's `edited`, and nothing else.
 * @returns {Promise<{ repo?: any, error?: string, conflict?: any }>}
 */
async function patch(slug, edited, fields) {
  try {
    const { repo } = await api(`repos/${enc(slug)}`, { method: 'PATCH', body: { ...fields, edited } });
    return { repo };
  } catch (error) {
    if (error.status === 409 && error.data?.repo) return { conflict: error.data.repo };
    return { error: error.message };
  }
}

/** @param {Record<string, any>} props */
function RepoList({ except = null }) {
  const list = repos.value.list.filter((r) => r.slug !== except);
  if (!repos.value.loaded) return null;
  if (!list.length)
    return (
      <p class="muted">
        This board has no repository yet.{' '}
        <button type="button" class="link-button" onClick={() => openAddRepo(null)}>
          Add a repository
        </button>{' '}
        to start.
      </p>
    );
  return (
    <ul class="rs-repos">
      {list.map((r) => (
        <li key={r.slug}>
          <a href={repoSettingsHref(r.slug)}>{r.name}</a>
          <span class="meta">
            {r.slug} · {r.github}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** @param {Record<string, any>} props */
function NotFound({ slug }) {
  return (
    <div class="repo-settings">
      <div class="view-intro">
        <h1>No repository called {slug}.</h1>
        <p class="muted">Check the address, or pick one of the board’s repositories.</p>
      </div>
      <RepoList />
      <p>
        <a href={repoSettingsHref(null)}>Open Settings</a>
      </p>
    </div>
  );
}

/**
 * The "now" line under a field after a 409: what the repository says now, beside the edit that was kept.
 * @param {Record<string, any>} props
 */
function Now({ show, value }) {
  if (!show) return null;
  return (
    <span class="field-hint rs-now">
      Now: <strong>{value || 'empty'}</strong>
    </span>
  );
}

/** @param {Record<string, any>} props */
function FieldError({ id, text }) {
  if (!text) return null;
  return (
    <span class="field-error" id={id} role="alert">
      {text}
    </span>
  );
}

/** Which General field a refusal is about, from the server's words; the name when nothing else fits. */
function generalField(message, sent) {
  const text = message.toLowerCase();
  if ('specs' in sent && /settings\.specs|spec/u.test(text)) return 'specs';
  if ('github' in sent && /github|registered as|owner\/name/u.test(text)) return 'github';
  if ('defaultBranch' in sent && /branch/u.test(text)) return 'defaultBranch';
  if ('name' in sent) return 'name';
  return Object.keys(sent)[0] ?? 'name';
}

/**
 * The PATCH body for General's changes: the specs directory goes in `settings`, which is saved whole, so the rest
 * of the repository's settings go with it, as `repos modify --specs` does. Empty means the default, docs/specs.
 */
function generalBody(changed, settings) {
  const { specs, ...rest } = changed;
  return 'specs' in changed ? { ...rest, settings: { ...settings, specs: specs || null } } : rest;
}

/**
 * General: the name, the GitHub repository (asked first), the default branch with GitHub's beside it, the specs
 * directory, and the slug.
 * @param {Record<string, any>} props
 */
function General({ data, onSaved, readOnly }) {
  const repo = data.repo;
  const [draft, setDraft] = useState(/** @type {Record<string, string>} */ ({}));
  const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const saved = {
    name: repo.name ?? '',
    github: repo.github ?? '',
    defaultBranch: repo.defaultBranch ?? '',
    specs: repo.settings?.specs ?? '',
  };
  const value = (k) => draft[k] ?? saved[k];
  const changed = Object.fromEntries(
    Object.keys(saved)
      .filter((k) => k in draft && draft[k].trim() !== saved[k])
      .map((k) => [k, draft[k].trim()]),
  );
  const dirty = Object.keys(changed).length > 0;
  const set = (k) => (e) => {
    const next = e.currentTarget.value;
    setDraft((d) => ({ ...d, [k]: next }));
    setErrors((x) => ({ ...x, [k]: null }));
  };
  const hub = data.githubDefaultBranch;
  const submit = async (e) => {
    e.preventDefault();
    if (!dirty || busy) return;
    if (
      'github' in changed &&
      !(await confirmDialog({
        title: `Move ${repo.name} to ${changed.github}?`,
        body: 'Webhooks, pull requests, and the GitHub App’s access follow the new repository. Tasks and work IDs stay.',
        confirmLabel: 'Change the repository',
      }))
    )
      return;
    setBusy(true);
    const result = await patch(repo.slug, repo.edited, generalBody(changed, repo.settings));
    setBusy(false);
    if (result.repo) {
      setDraft({});
      setErrors({});
      setConflict(false);
      onSaved(result.repo);
      toast('General saved.', 'success');
    } else if (result.conflict) {
      setConflict(true);
      onSaved(result.conflict);
    } else {
      const k = generalField(result.error, changed);
      setErrors({ [k]: k === 'specs' && /settings\.specs/iu.test(result.error) ? SPECS_REFUSED : result.error });
    }
  };
  const field = (k) => ({
    'aria-invalid': errors[k] ? true : undefined,
    'aria-describedby': errors[k] ? `rs-${k}-error` : `rs-${k}-hint`,
  });
  return (
    <section class="rs-section" aria-labelledby="rs-general">
      <h2 id="rs-general">General</h2>
      {conflict && (
        <p class="rs-conflict" role="alert">
          <TriangleAlert size={16} aria-hidden="true" />
          {CHANGED_ELSEWHERE} Your edits are kept: check them, then save again.
        </p>
      )}
      <form class="rs-form" onSubmit={submit}>
        <div class="rs-fields">
          <label class="field">
            <span class="field-label">Name</span>
            <input
              class="input"
              maxLength={60}
              autoComplete="off"
              placeholder={repo.slug}
              value={value('name')}
              readOnly={readOnly}
              onInput={set('name')}
              {...field('name')}
            />
            {!readOnly && (
              <span class="field-hint" id="rs-name-hint">
                What the board calls it. Empty means its short name, {repo.slug}.
              </span>
            )}
            <Now show={conflict && 'name' in changed} value={saved.name} />
            <FieldError id="rs-name-error" text={errors.name} />
          </label>
          <label class="field">
            <span class="field-label">GitHub repository</span>
            <input
              class="input"
              autoComplete="off"
              spellcheck={false}
              placeholder="owner/name"
              value={value('github')}
              readOnly={readOnly}
              onInput={set('github')}
              {...field('github')}
            />
            {!readOnly && (
              <span class="field-hint" id="rs-github-hint">
                As owner/name. Changing it asks first.
              </span>
            )}
            <Now show={conflict && 'github' in changed} value={saved.github} />
            <FieldError id="rs-github-error" text={errors.github} />
          </label>
          {(!readOnly || saved.defaultBranch) && (
            <label class="field">
              <span class="field-label">Default branch</span>
              <input
                class="input"
                autoComplete="off"
                spellcheck={false}
                placeholder="main"
                value={value('defaultBranch')}
                readOnly={readOnly}
                onInput={set('defaultBranch')}
                {...field('defaultBranch')}
              />
              <span class="field-hint" id="rs-defaultBranch-hint">
                Where pull requests merge and agents branch from.
              </span>
              {!readOnly && hub && hub !== value('defaultBranch').trim() && (
                <span class="field-hint rs-hub">
                  GitHub says <code>{hub}</code>.{' '}
                  <button
                    type="button"
                    class="link-button"
                    onClick={() => {
                      setDraft((d) => ({ ...d, defaultBranch: hub }));
                      setErrors((x) => ({ ...x, defaultBranch: null }));
                    }}
                  >
                    Use it
                  </button>
                </span>
              )}
              <Now show={conflict && 'defaultBranch' in changed} value={saved.defaultBranch} />
              <FieldError id="rs-defaultBranch-error" text={errors.defaultBranch} />
            </label>
          )}
          {(!readOnly || saved.specs) && (
            <label class="field">
              <span class="field-label">Specs directory</span>
              <input
                class="input"
                maxLength={200}
                autoComplete="off"
                spellcheck={false}
                placeholder="docs/specs"
                value={value('specs')}
                readOnly={readOnly}
                onInput={set('specs')}
                {...field('specs')}
              />
              <span class="field-hint" id="rs-specs-hint">
                Where the repository keeps its specs, from its root. Empty means docs/specs.
              </span>
              <Now show={conflict && 'specs' in changed} value={saved.specs || 'docs/specs'} />
              <FieldError id="rs-specs-error" text={errors.specs} />
            </label>
          )}
          <div class="field">
            <span class="field-label">Short name</span>
            <code class="rs-readonly">{repo.slug}</code>
            <span class="field-hint">A repository keeps its short name, in tasks, links, and commands.</span>
          </div>
        </div>
        {!readOnly && (
          <div class="rs-actions">
            {dirty && (
              <button
                type="button"
                class="btn btn-quiet btn-sm"
                onClick={() => {
                  setDraft({});
                  setErrors({});
                  setConflict(false);
                }}
              >
                Undo changes
              </button>
            )}
            <button type="submit" class="btn btn-primary btn-sm" disabled={!dirty || busy} aria-busy={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </form>
    </section>
  );
}

/**
 * One area's row: its display name, renamed inline; its project and prefix, read only; its counts; and Remove,
 * only when no task was ever in it and it isn't the last.
 * @param {Record<string, any>} props
 */
function AreaRow({ area, last, readOnly, onSave, onRemove }) {
  const [name, setName] = useState(/** @type {string | null} */ (null));
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [busy, setBusy] = useState(false);
  const shown = name ?? area.name;
  const dirty = name !== null && name.trim() !== area.name;
  const id = `rs-area-${area.project}`;
  const rename = async (e) => {
    e.preventDefault();
    if (!dirty || busy) return;
    setBusy(true);
    const result = await onSave(area, name.trim());
    setBusy(false);
    if (result.repo) {
      setName(null);
      setError(null);
    } else setError(result.conflict ? `${CHANGED_ELSEWHERE} Its name is ${result.conflictName}.` : result.error);
  };
  const remove = async () => {
    setBusy(true);
    const result = await onRemove(area);
    setBusy(false);
    if (result && !result.repo) setError(result.conflict ? CHANGED_ELSEWHERE : result.error);
  };
  const why = area.total
    ? `${area.total === 1 ? '1 task is' : `${area.total} tasks are`} in this area, so it stays.`
    : last
      ? 'A repository keeps at least one area.'
      : null;
  return (
    <tr>
      <td data-label="Name">
        {readOnly ? (
          area.name
        ) : (
          <form class="rs-rename" onSubmit={rename}>
            <input
              class="input input-sm"
              maxLength={40}
              autoComplete="off"
              aria-label={`Name of ${area.project}`}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              value={shown}
              onInput={(e) => {
                setName(e.currentTarget.value);
                setError(null);
              }}
            />
            {dirty && (
              <>
                <button type="submit" class="btn btn-primary btn-sm" disabled={busy} aria-busy={busy}>
                  {busy ? 'Saving…' : 'Rename'}
                </button>
                <button
                  type="button"
                  class="btn btn-quiet btn-sm"
                  onClick={() => {
                    setName(null);
                    setError(null);
                  }}
                >
                  Undo
                </button>
              </>
            )}
          </form>
        )}
        {error && (
          <span class="field-error" id={`${id}-error`} role="alert">
            {error}
          </span>
        )}
      </td>
      <td data-label="Area">
        <code>{area.project}</code>
      </td>
      <td data-label="Prefix">
        <code>{area.prefix}</code>
      </td>
      <td data-label="Open" class="rs-num">
        {area.open}
      </td>
      <td data-label="All tasks" class="rs-num">
        {area.total}
      </td>
      {!readOnly && (
        <td class="rs-area-remove">
          <button
            type="button"
            class="btn btn-quiet btn-sm"
            disabled={Boolean(why) || busy}
            aria-describedby={why ? `${id}-why` : undefined}
            onClick={remove}
          >
            <Trash2 size={15} aria-hidden="true" />
            Remove<span class="visually-hidden"> {area.name}</span>
          </button>
          {why && (
            <span class="meta" id={`${id}-why`}>
              {why}
            </span>
          )}
        </td>
      )}
    </tr>
  );
}

/** Which Add an area field a refusal is about: the area's name for its own checks, else the prefix. */
const addField = (message) => (/isn.t an area name|already has the prefix/u.test(message) ? 'project' : 'prefix');

/**
 * Add an area: checked as it's typed with a dry run, so a clash shows under its field before Add.
 * @param {Record<string, any>} props
 */
function AddArea({ repo, onAdd }) {
  const [form, setForm] = useState({ project: '', prefix: '', name: '' });
  const [check, setCheck] = useState(/** @type {{ field: string, text: string } | null} */ (null));
  const [busy, setBusy] = useState(false);
  const timer = useRef(/** @type {any} */ (null));
  const area = () => ({
    project: form.project.trim(),
    prefix: form.prefix.trim().toUpperCase(),
    ...(form.name.trim() ? { name: form.name.trim() } : {}),
  });
  const ready = form.project.trim() && form.prefix.trim();
  useEffect(() => {
    clearTimeout(timer.current);
    setCheck(null);
    if (!ready) return undefined;
    timer.current = setTimeout(async () => {
      try {
        await api(`repos/${enc(repo.slug)}`, { method: 'PATCH', body: { addAreas: [area()], dryRun: true } });
        setCheck(null);
      } catch (error) {
        // Offline while typing: Add says so when it's pressed.
        if (error.status) setCheck({ field: addField(error.message), text: error.message });
      }
    }, 400);
    return () => clearTimeout(timer.current);
  }, [form.project, form.prefix, repo.slug]);
  const set = (k) => (e) => {
    const next = e.currentTarget.value;
    setForm((f) => ({ ...f, [k]: next }));
  };
  const submit = async (e) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    const result = await onAdd(area());
    setBusy(false);
    if (result.repo) {
      setForm({ project: '', prefix: '', name: '' });
      setCheck(null);
    } else
      setCheck(
        result.conflict
          ? { field: 'project', text: `${CHANGED_ELSEWHERE} Check the areas above, then add it again.` }
          : { field: addField(result.error), text: result.error },
      );
  };
  const describe = (k) => (check?.field === k ? `rs-add-${k}-error` : `rs-add-${k}-hint`);
  return (
    <form class="rs-add" onSubmit={submit} aria-labelledby="rs-add-title">
      <h3 id="rs-add-title">Add an area</h3>
      <div class="rs-fields rs-fields-3">
        <label class="field">
          <span class="field-label">Area</span>
          <input
            class="input"
            required
            autoComplete="off"
            spellcheck={false}
            placeholder="docs"
            value={form.project}
            onInput={set('project')}
            aria-invalid={check?.field === 'project' ? true : undefined}
            aria-describedby={describe('project')}
          />
          <span class="field-hint" id="rs-add-project-hint">
            Lowercase, as Taskwarrior’s project. It never changes.
          </span>
          {check?.field === 'project' && <FieldError id="rs-add-project-error" text={check.text} />}
        </label>
        <label class="field">
          <span class="field-label">Prefix</span>
          <input
            class="input"
            required
            autoComplete="off"
            spellcheck={false}
            placeholder="DOC"
            value={form.prefix}
            onInput={set('prefix')}
            aria-invalid={check?.field === 'prefix' ? true : undefined}
            aria-describedby={describe('prefix')}
          />
          <span class="field-hint" id="rs-add-prefix-hint">
            2 to 8 capital letters, this repository’s only. It never changes.
          </span>
          {check?.field === 'prefix' && <FieldError id="rs-add-prefix-error" text={check.text} />}
        </label>
        <label class="field">
          <span class="field-label">Name</span>
          <input
            class="input"
            maxLength={40}
            autoComplete="off"
            placeholder={form.project.trim() || 'Docs'}
            value={form.name}
            onInput={set('name')}
            aria-describedby="rs-add-name-hint"
          />
          <span class="field-hint" id="rs-add-name-hint">
            What the board calls it. Empty means the area.
          </span>
        </label>
      </div>
      <div class="rs-actions">
        <button type="submit" class="btn btn-primary btn-sm" disabled={!ready || busy} aria-busy={busy}>
          {busy ? 'Adding…' : 'Add area'}
        </button>
      </div>
    </form>
  );
}

/**
 * Areas: each with its counts, renamed inline, removed only when it never had a task; then Add an area, and the
 * areas every repository shares.
 * @param {Record<string, any>} props
 */
function Areas({ data, onSaved, readOnly }) {
  const repo = data.repo;
  const save = async (fields, done) => {
    const result = await patch(repo.slug, repo.edited, fields);
    if (result.repo) {
      onSaved(result.repo);
      toast(done, 'success');
    } else if (result.conflict) onSaved(result.conflict);
    return result;
  };
  const rename = async (area, name) => {
    const result = await save({ addAreas: [{ project: area.project, prefix: area.prefix, name }] }, 'Area renamed.');
    const now = result.conflict?.areas.find((a) => a.project === area.project);
    return { ...result, conflictName: now?.name ?? area.name };
  };
  const remove = async (area) => {
    const sure = await confirmDialog({
      title: `Remove ${area.name}?`,
      body: `No task was ever in it. Its prefix ${area.prefix} stays ${repo.name}’s, so it can come back, but it’s never given to another area.`,
      confirmLabel: 'Remove area',
      tone: 'danger',
    });
    if (!sure) return null;
    return save({ removeAreas: [area.project] }, `Removed ${area.name}.`);
  };
  return (
    <section class="rs-section" aria-labelledby="rs-areas">
      <h2 id="rs-areas">Areas</h2>
      <p class="muted small">
        Each task belongs to one area, and its work ID starts with the area’s prefix. A prefix never changes, so a work
        ID means one task forever: only an area’s name can.
      </p>
      <div class="rs-table-wrap">
        <table class="table rs-areas">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Area</th>
              <th scope="col">Prefix</th>
              <th scope="col" class="rs-num">
                Open
              </th>
              <th scope="col" class="rs-num">
                All tasks
              </th>
              {!readOnly && (
                <th scope="col">
                  <span class="visually-hidden">Remove</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {data.areas.map((a) => (
              <AreaRow
                key={a.project}
                area={a}
                last={data.areas.length === 1}
                readOnly={readOnly}
                onSave={rename}
                onRemove={remove}
              />
            ))}
          </tbody>
        </table>
      </div>
      {!readOnly && <AddArea repo={repo} onAdd={(area) => save({ addAreas: [area] }, `Added ${area.prefix}.`)} />}
      <p class="meta rs-shared">
        Shared by every repository on the board, so they have no settings here:{' '}
        {SHARED.map((a, i) => (
          <span key={a.id}>
            {i > 0 && ', '}
            {a.label} <code>{a.prefix}</code>
          </span>
        ))}
        .
      </p>
    </section>
  );
}

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied.`, 'success');
  } catch {
    toast('Couldn’t copy. Select it and copy it yourself.', 'error');
  }
}

/**
 * A command to run in the CLI, with a button that copies it.
 * @param {Record<string, any>} props
 */
function Command({ text, label = 'Copy the command' }) {
  return (
    <div class="gh-command">
      <code>{text}</code>
      <button
        type="button"
        class="btn btn-quiet btn-icon btn-sm"
        aria-label={label}
        onClick={() => copy(text, 'Command')}
      >
        <Copy size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

/** @param {Record<string, any>} props */
function Conflict({ show }) {
  if (!show) return null;
  return (
    <p class="rs-conflict" role="alert">
      <TriangleAlert size={16} aria-hidden="true" />
      {CHANGED_ELSEWHERE} Your edits are kept: check them, then save again.
    </p>
  );
}

/**
 * A section's Undo changes and Save.
 * @param {Record<string, any>} props
 */
function Actions({ dirty, busy, onUndo, children = null }) {
  return (
    <div class="rs-actions">
      {children}
      {dirty && (
        <button type="button" class="btn btn-quiet btn-sm" onClick={onUndo}>
          Undo changes
        </button>
      )}
      <button type="submit" class="btn btn-primary btn-sm" disabled={!dirty || busy} aria-busy={busy}>
        {busy ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}

/** No cap, then 1 to `most`; a saved cap above `most` (the board's limits went down since) stays choosable. */
const capOptions = (most, saved) => [
  { id: '', label: 'No cap' },
  ...Array.from({ length: Math.max(most, saved ?? 0) }, (_, i) => ({ id: String(i + 1), label: String(i + 1) })),
];

/** Which Agents field a refusal is about: routine.max, routine.hourly, or routine.prompt. */
const agentsField = (message) =>
  /routine\.max/u.test(message) ? 'max' : /routine\.hourly/u.test(message) ? 'hourly' : 'prompt';

/** Routines narrowed to one repository; with one repository, Routines as it is. */
const routinesHref = (slug) => `#/routines${multiRepo.value ? `?repo=${enc(slug)}` : ''}`;

/**
 * Agents: the repository's caps under the board's shared limits (the same choices as Agents, Repositories), where
 * its agent prompt is, whether its routine is connected, and its saved routines.
 * @param {Record<string, any>} props
 */
function Agents({ data, onSaved, readOnly }) {
  const repo = data.repo;
  const board = agents.value.data;
  useEffect(() => {
    if (!agents.peek().loaded) loadAgents();
  }, []);
  const saved = {
    max: repo.routine?.max ? String(repo.routine.max) : '',
    hourly: repo.routine?.hourly ? String(repo.routine.hourly) : '',
    prompt: repo.routine?.prompt ?? '',
  };
  const [draft, setDraft] = useState(/** @type {Record<string, string>} */ ({}));
  const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const value = (k) => draft[k] ?? saved[k];
  const dirty = Object.keys(saved).some((k) => k in draft && draft[k].trim() !== saved[k]);
  const set = (k) => (e) => {
    const next = e.currentTarget.value;
    setDraft((d) => ({ ...d, [k]: next }));
    setErrors((x) => ({ ...x, [k]: null }));
  };
  const most = {
    max: board?.settings?.max ?? 6,
    hourly: Math.min(board?.settings?.hourly ?? 30, board?.limits?.routineHourly ?? 30),
  };
  const undo = () => {
    setDraft({});
    setErrors({});
    setConflict(false);
  };
  const submit = async (e) => {
    e.preventDefault();
    if (!dirty || busy) return;
    const number = (k) => (value(k) ? Number(value(k)) : null);
    // The routine settings save as one: the caps and the prompt, beside anything else the row keeps there.
    const routine = {
      ...repo.routine,
      max: number('max'),
      hourly: number('hourly'),
      prompt: value('prompt').trim() || null,
    };
    setBusy(true);
    const result = await patch(repo.slug, repo.edited, { routine });
    setBusy(false);
    if (result.repo) {
      undo();
      onSaved(result.repo);
      loadAgents();
      toast('Agents saved.', 'success');
    } else if (result.conflict) {
      setConflict(true);
      onSaved(result.conflict);
    } else setErrors({ [agentsField(result.error)]: result.error });
  };
  const field = (k) => ({
    'aria-invalid': errors[k] ? true : undefined,
    'aria-describedby': errors[k] ? `rs-${k}-error` : `rs-${k}-hint`,
  });
  const caps = (k, label, hint) => (
    <label class="field">
      <span class="field-label">{label}</span>
      <select class="select" value={value(k)} disabled={readOnly} onChange={set(k)} {...field(k)}>
        {capOptions(most[k], Number(saved[k]) || null).map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <span class="field-hint" id={`rs-${k}-hint`}>
        {hint}
      </span>
      <Now show={conflict && value(k) !== saved[k]} value={saved[k] || 'No cap'} />
      <FieldError id={`rs-${k}-error`} text={errors[k]} />
    </label>
  );
  const connect = repo.isDefault ? 'npx breakaway agents-connect' : `npx breakaway agents-connect --repo ${repo.slug}`;
  return (
    <section class="rs-section" aria-labelledby="rs-agents">
      <h2 id="rs-agents">Agents</h2>
      <p class="muted small">
        Every repository shares the board’s {most.max} agents at once and {board?.settings?.hourly ?? most.hourly}{' '}
        starts an hour. Cap this one so it can’t take them all.
      </p>
      <Conflict show={conflict} />
      <form class="rs-form" onSubmit={submit}>
        <div class="rs-fields">
          {caps('max', 'At once', `Most agents running in ${repo.name} at a time, up to the board’s ${most.max}.`)}
          {caps(
            'hourly',
            'Starts an hour',
            `Most agents started in ${repo.name} in an hour, up to ${most.hourly}: the lower of the board’s and Claude’s limit for one routine.`,
          )}
          <label class="field rs-field-wide">
            <span class="field-label">Agent prompt</span>
            <input
              class="input"
              autoComplete="off"
              spellcheck={false}
              placeholder={DEFAULT_PROMPT_PATH}
              value={value('prompt')}
              readOnly={readOnly}
              onInput={set('prompt')}
              {...field('prompt')}
            />
            <span class="field-hint" id="rs-prompt-hint">
              The Markdown file in {repo.github} its agents follow. Empty means {DEFAULT_PROMPT_PATH}.
            </span>
            <Now
              show={conflict && value('prompt').trim() !== saved.prompt}
              value={saved.prompt || DEFAULT_PROMPT_PATH}
            />
            <FieldError id="rs-prompt-error" text={errors.prompt} />
          </label>
        </div>
        {!readOnly && <Actions dirty={dirty} busy={busy} onUndo={undo} />}
      </form>
      <div class="rs-facts">
        <div class="field">
          <span class="field-label">Routine</span>
          {data.routineConnected ? (
            <span class="rs-state is-ok">
              <CircleCheck size={16} aria-hidden="true" />
              <span>Connected: the board can start agents in {repo.name}.</span>
            </span>
          ) : (
            <>
              <span class="rs-state">
                <CircleSlash size={16} aria-hidden="true" />
                <span>Not connected, so the board can’t start agents here.</span>
              </span>
              {!readOnly && (
                <>
                  <span class="field-hint">
                    Make a routine on claude.ai for {repo.github}, then store it with this command. It holds a secret,
                    so only the CLI does it.
                  </span>
                  <Command text={connect} />
                </>
              )}
            </>
          )}
        </div>
        {isOwner.value && <Lend data={data} />}
        <div class="field">
          <span class="field-label">Saved routines</span>
          <span>
            {data.routines ? plural(data.routines, 'saved routine') : 'No saved routines'} run in {repo.name}.{' '}
            <a href={routinesHref(repo.slug)}>Open Routines</a>
          </span>
        </div>
      </div>
    </section>
  );
}

/**
 * Lend a routine (WEB-136, BRK-324, docs/specs/BRK-299-people-and-roles.md, point 5): the owner's second routine for
 * the repository, in a cloud environment without the board's token, which people with no routine of their own here
 * start agents on, within the lent caps. Each of those agents gets a run key with its person's rights and nothing
 * more, and the key is its only way in. Off by default: it spends the owner's plan. It shows once someone is invited,
 * since nobody else starts agents before that, or while a repository lent before BRK-324 waits for its routine.
 * @param {Record<string, any>} props
 */
function Lend({ data }) {
  const [lend, setLend] = useState(/** @type {Record<string, any>} */ (data.lend ?? {}));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!people.peek().loaded) loadPeople();
  }, []);
  useEffect(() => setLend(data.lend ?? {}), [data.lend]);
  if (!people.value.data?.people?.some((p) => !p.removed) && !lend.lent && !lend.waits) return null;
  const repo = data.repo;
  const stop = async () => {
    const sure = await confirmDialog({
      title: `Stop lending in ${repo.name}?`,
      body: 'The board forgets the lent routine. Agents running on it carry on until their run ends; nothing new starts on it. People with a routine of their own aren’t affected.',
      confirmLabel: 'Stop lending',
      tone: 'danger',
    });
    if (!sure) return;
    setBusy(true);
    try {
      setLend(await api(`repos/${enc(repo.slug)}/routine/lend`, { method: 'DELETE', body: {} }));
      toast('No longer lent.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
    setBusy(false);
  };
  const state = lend.broken ? (
    <span class="rs-state is-bad">
      <CircleAlert size={16} aria-hidden="true" />
      <span>Can’t be read any more: the board’s key changed. Connect it again.</span>
    </span>
  ) : lend.lent ? (
    <span class="rs-state is-ok">
      <CircleCheck size={16} aria-hidden="true" />
      <span>
        Lent, connected {ago(lend.connectedAt) ?? 'today'}. People with no routine of their own start agents in{' '}
        {repo.name} on it, {LENT_CAPS.max} at once and {LENT_CAPS.hourly} an hour each.
      </span>
    </span>
  ) : (
    <span class="rs-state">
      <CircleSlash size={16} aria-hidden="true" />
      <span>Not lent. People start agents in {repo.name} only on their own Claude routine.</span>
    </span>
  );
  return (
    <div class="field">
      <span class="field-label">Lend a routine</span>
      {state}
      <span class="field-hint">
        A second routine of yours, on your Claude plan, in a cloud environment without the board’s token. Each agent on
        it gets a run key with its person’s role and nothing more: the key is its only way in, and it ends with the
        run’s claim.
      </span>
      {lend.waits && !lend.lent && (
        <span class="rs-state is-bad">
          <TriangleAlert size={16} aria-hidden="true" />
          <span>
            You lent {repo.name}’s routine before. Lending now needs a routine of its own, so it’s off until you connect
            one.
          </span>
        </span>
      )}
      {lend.tokenSeenAt && !lend.broken && (
        <span class="rs-state is-bad" role="status">
          <TriangleAlert size={16} aria-hidden="true" />
          <span>
            A lent agent came with the board’s token too ({ago(lend.tokenSeenAt)}): its environment adds it. Its run key
            still held it to its person. Take BREAKAWAY_TOKEN out of that environment on claude.ai, then connect the
            routine again.
          </span>
        </span>
      )}
      {!open && (
        <div class="claude-routine-actions">
          <button type="button" class="btn btn-outline btn-sm" disabled={busy} onClick={() => setOpen(true)}>
            <Plug size={16} aria-hidden="true" />
            {lend.lent ? 'Replace' : 'Lend a routine'}
          </button>
          {lend.lent && (
            <button type="button" class="btn btn-quiet btn-sm" disabled={busy} onClick={stop}>
              Stop lending
            </button>
          )}
        </div>
      )}
      {open && (
        <LendConnect
          repo={repo}
          replace={Boolean(lend.lent)}
          onClose={() => setOpen(false)}
          onSaved={(next) => {
            setLend(next);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

/** The steps for a lent routine on claude.ai, then its URL and token. */
function LendConnect({ repo, replace, onClose, onSaved }) {
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const id = `lend-${repo.slug}`;
  const submit = async (e) => {
    e.preventDefault();
    if (!replace) {
      const sure = await confirmDialog({
        title: `Lend a routine in ${repo.name}?`,
        body: `People who can start agents here and have no routine of their own start them on it: on your Claude plan, ${LENT_CAPS.max} at once and ${LENT_CAPS.hourly} an hour each unless you lower it on People. Each agent can do only what its person’s role allows.`,
        confirmLabel: 'Lend it',
      });
      if (!sure) return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api(`repos/${enc(repo.slug)}/routine/lend`, {
        method: 'PUT',
        body: { url: url.trim(), token: token.trim() },
      });
      toast(res.replaced ? 'Replaced.' : 'Lent.', 'success');
      onSaved(res);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <div class="claude-connect">
      <ol class="claude-steps">
        <li>
          On claude.ai, make a cloud environment that allows <code>{location.host}</code> and has{' '}
          <strong>no BREAKAWAY_TOKEN</strong>, and no other credential for this board. Never use the environment of{' '}
          {repo.name}’s own routine: it holds the board’s token.
        </li>
        <li>
          Make a second routine for <strong>{repo.github}</strong> in that environment, with the stub as its
          instructions and an API trigger.
          <div class="wiz-actions">
            <button type="button" class="btn btn-outline btn-sm" onClick={() => copy(stubFor(repo.slug), 'Stub')}>
              <Copy size={16} aria-hidden="true" />
              Copy stub
            </button>
            <a class="btn btn-outline btn-sm" href={ROUTINES_URL} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={16} aria-hidden="true" />
              Open routines on claude.ai
            </a>
          </div>
        </li>
        <li>Paste the URL and token from its API trigger here.</li>
      </ol>
      <form class="setup-register" onSubmit={submit} aria-describedby={error ? `${id}-error` : undefined}>
        <label class="field">
          <span class="field-label">Routine URL</span>
          <input
            class="input"
            type="url"
            required
            autoComplete="off"
            spellcheck={false}
            placeholder="https://api.anthropic.com/v1/claude_code/routines/trig_…/fire"
            value={url}
            onInput={(e) => setUrl(e.currentTarget.value)}
            aria-describedby={`${id}-url-hint`}
          />
          <span class="field-hint" id={`${id}-url-hint`}>
            The URL of the lent routine’s API trigger, not {repo.name}’s own routine’s.
          </span>
        </label>
        <label class="field">
          <span class="field-label">Token</span>
          <input
            class="input"
            type="password"
            required
            autoComplete="off"
            spellcheck={false}
            placeholder="sk-ant-oat01-…"
            value={token}
            onInput={(e) => setToken(e.currentTarget.value)}
            aria-describedby={`${id}-token-hint`}
          />
          <span class="field-hint" id={`${id}-token-hint`}>
            Generate one in the same API trigger. The board keeps it encrypted and never shows it again.
          </span>
        </label>
        {error && (
          <p class="field-error" id={`${id}-error`} role="alert">
            {error}
          </p>
        )}
        <div class="routine-connect-actions">
          <button type="submit" class="btn btn-primary btn-sm" disabled={busy} aria-busy={busy}>
            {busy ? (replace ? 'Replacing…' : 'Lending…') : replace ? 'Replace' : 'Lend it'}
          </button>
          <button type="button" class="btn btn-quiet btn-sm" disabled={busy} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

/** What the pipeline does, in a sentence, or what having none means; the two flows below say the rest. */
function deploysIntro(repo) {
  if (!repo.pipeline)
    return `Merging to ${repo.defaultBranch} deploys nothing yet, and the board shows no releases for ${repo.name}. breakaway has two flows: turn on either, or both.`;
  return 'The Releases card on GitHub shows where each version is.';
}

/**
 * One of the two flows (WEB-72): its name, whether it's on, and what it does, over the fields that turn it on.
 * @param {Record<string, any>} props
 */
function Flow({ id, icon: Icon, title, on, what, children }) {
  return (
    <fieldset class="rs-flow" aria-describedby={`${id}-what`}>
      <legend class="rs-flow-head">
        <Icon size={16} aria-hidden="true" />
        <span>{title}</span>
        <span class={`rs-flow-state${on ? ' is-on' : ''}`}>{on ? 'On' : 'Off'}</span>
      </legend>
      <p class="small muted" id={`${id}-what`}>
        {what}
      </p>
      {children}
    </fieldset>
  );
}

/**
 * Deploys: for a repository without a pipeline whose move to the deploy flow is on its default branch, the GitHub
 * page's Turn on deploys card (IDEA-27, WEB-13), with Set it by hand opening the form below it. The form is the
 * pipeline: both Workers, an npm package, or both (BRK-103), checked as it's typed with a dry run; Copy as JSON for
 * the CLI; and Turn off deploys, which clears it after asking.
 * @param {Record<string, any>} props
 */
function Deploys({ data, onSaved, onReload, readOnly }) {
  const repo = data.repo;
  const gh = github.value;
  useEffect(() => {
    if (!readOnly && !repo.pipeline && !github.peek().loaded && !github.peek().loading) loadGitHub();
  }, []);
  // The GitHub page's facts for this repository; hidden while GitHub isn't connected, and the form still saves.
  const facts = gh.data?.connected ? githubRepoFacts(repo.slug) : null;
  const mine = !readOnly && !repo.pipeline && (facts?.slug ?? repo.slug) === repo.slug;
  const card = mine && facts?.pipelineFound;
  // Before the move merged, the same card offers it and follows it (WEB-12).
  const offer = mine && facts && !facts.empty && (facts.pipelineFound || facts.move);
  const [byHand, setByHand] = useState(false);
  const saved = pipelineForm(repo.pipeline);
  const [draft, setDraft] = useState(/** @type {Record<string, string>} */ ({}));
  const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef(/** @type {any} */ (null));
  const form = { ...saved, ...draft };
  const dirty = Object.keys(saved).some((k) => k in draft && draft[k].trim() !== saved[k]);
  const missing = missingOf(form);
  const complete = !missing;
  const set = (k) => (e) => {
    const next = e.currentTarget.value;
    setDraft((d) => ({ ...d, [k]: next }));
    setErrors({});
  };
  const undo = () => {
    setDraft({});
    setErrors({});
    setConflict(false);
  };
  // Checked as it's typed, once both Workers or a package are named: the refusal shows under its field before Save.
  useEffect(() => {
    clearTimeout(timer.current);
    if (readOnly || !dirty || !complete) return undefined;
    timer.current = setTimeout(async () => {
      try {
        await api(`repos/${enc(repo.slug)}`, {
          method: 'PATCH',
          body: { pipeline: pipelineOf(form, repo.pipeline), dryRun: true },
        });
        setErrors({});
      } catch (error) {
        // Offline while typing: Save says so when it's pressed.
        if (error.status && error.status !== 409) setErrors({ [deployField(error.message)]: error.message });
      }
    }, 400);
    return () => clearTimeout(timer.current);
  }, [JSON.stringify(form), repo.slug, repo.edited]);
  const save = async (pipeline, done) => {
    setBusy(true);
    const result = await patch(repo.slug, repo.edited, { pipeline });
    setBusy(false);
    if (result.repo) {
      undo();
      onSaved(result.repo);
      toast(done, 'success');
    } else if (result.conflict) {
      setConflict(true);
      onSaved(result.conflict);
    } else setErrors({ [deployField(result.error)]: result.error });
  };
  const submit = async (e) => {
    e.preventDefault();
    if (!dirty || busy) return;
    if (missing) {
      setErrors(missing);
      return;
    }
    await save(pipelineOf(form, repo.pipeline), repo.pipeline ? 'Deploys saved.' : `Deploys are on for ${repo.name}.`);
  };
  const turnOff = async () => {
    const sure = await confirmDialog({
      title: `Turn off deploys for ${repo.name}?`,
      body: `The Releases card, Promote, and Roll back go away for ${repo.name}. Its workflows on GitHub don’t change.`,
      confirmLabel: 'Turn off deploys',
      tone: 'danger',
    });
    if (sure) await save(null, `Deploys are off for ${repo.name}.`);
  };
  const field = (k) => ({
    'aria-invalid': errors[k] ? true : undefined,
    'aria-describedby': errors[k] ? `rs-${k}-error` : `rs-${k}-hint`,
  });
  const input = (k, label, placeholder, hint) => (
    <label class="field">
      <span class="field-label">{label}</span>
      <input
        class="input"
        autoComplete="off"
        spellcheck={false}
        placeholder={placeholder}
        value={form[k]}
        readOnly={readOnly}
        onInput={set(k)}
        {...field(k)}
      />
      <span class="field-hint" id={`rs-${k}-hint`}>
        {hint}
      </span>
      <Now show={conflict && form[k].trim() !== saved[k]} value={saved[k]} />
      <FieldError id={`rs-${k}-error`} text={errors[k]} />
    </label>
  );
  const flowsOpen = WORKFLOWS.some(([k]) => form[k] || errors[k]);
  const deployForm = (
    <>
      <form class="rs-form" onSubmit={submit}>
        <div class="rs-flows">
          <Flow
            id="rs-flow-deploy"
            icon={Server}
            title="Deploy flow"
            on={Boolean(repo.pipeline?.workers)}
            what={`${repo.pipeline?.workers ? 'Every' : 'Name two Workers: every'} merge to ${repo.defaultBranch} deploys to staging, and Promote and Roll back move production.`}
          >
            <div class="rs-fields">
              {input('staging', 'Staging Worker', 'my-app-staging', 'Where every merge deploys.')}
              {input('production', 'Production Worker', 'my-app', 'Where Promote sends a version.')}
              {input(
                'deployPaths',
                'Deploy paths',
                '.github/deploy-paths.json',
                'A JSON file in the repository listing the paths that need a deploy. Empty means every change does.',
              )}
            </div>
          </Flow>
          <Flow
            id="rs-flow-release"
            icon={Package}
            title="Release flow"
            on={Boolean(repo.pipeline?.package)}
            what={`${repo.pipeline?.package ? 'Every' : 'Name an npm package: every'} merge to ${repo.defaultBranch} publishes a pre-release, and Release on the GitHub page publishes a stable one.`}
          >
            <div class="rs-fields">
              {input('package', 'npm package', '@acme/widgets', 'The name in its package.json.')}
            </div>
          </Flow>
        </div>
        <details class="rs-details" open={flowsOpen}>
          <summary>Workflow files</summary>
          <p class="field-hint">The GitHub Actions workflows the board runs. Blank means the default name.</p>
          <div class="rs-fields rs-fields-3">
            {WORKFLOWS.map(([k, label, file]) => input(k, label, file, `In .github/workflows. Empty means ${file}.`))}
          </div>
        </details>
        {!readOnly && (
          <Actions dirty={dirty} busy={busy} onUndo={undo}>
            {complete && (
              <button
                type="button"
                class="btn btn-quiet btn-sm"
                onClick={() => copy(JSON.stringify(pipelineOf(form, repo.pipeline), null, 2), 'Pipeline')}
              >
                <Copy size={15} aria-hidden="true" />
                Copy as JSON
              </button>
            )}
          </Actions>
        )}
      </form>
      {!readOnly && complete && (
        <p class="meta">
          Copy as JSON gives what <code>npx breakaway repos modify {repo.slug} --pipeline &lt;file&gt;</code> takes,
          saved as a file.
        </p>
      )}
    </>
  );
  return (
    <section class="rs-section" aria-labelledby="rs-deploys">
      <h2 id="rs-deploys">Deploys</h2>
      <p class="muted small">{deploysIntro(repo)}</p>
      {offer && <DeployCard view={facts} heading="h3" skippable={false} onDone={onReload} />}
      {card && !byHand && !dirty ? (
        <p class="rs-by-hand">
          <button type="button" class="btn btn-quiet btn-sm" onClick={() => setByHand(true)}>
            Set it by hand
          </button>
          <span class="meta">Name the Workers or the package yourself instead of what’s on {facts.branch}.</span>
        </p>
      ) : (
        <>
          {offer && <h3 class="rs-by-hand-head">Or set it by hand</h3>}
          <Conflict show={conflict} />
          {deployForm}
        </>
      )}{' '}
      {!readOnly && repo.pipeline && (
        <div class="rs-off">
          <button type="button" class="btn btn-outline btn-sm" onClick={turnOff} disabled={busy}>
            <PowerOff size={16} aria-hidden="true" />
            Turn off deploys
          </button>
          <span class="meta">Clears the pipeline. Its workflows on GitHub stay as they are.</span>
        </div>
      )}
    </section>
  );
}

/**
 * Pull requests: Keep branches up to date and Merge when green for this repository, which stay this browser's.
 * @param {Record<string, any>} props
 */
function PullRequests({ repo }) {
  const gh = github.value;
  useEffect(() => {
    if (!github.peek().loaded && !github.peek().loading) loadGitHub();
  }, []);
  const facts = githubRepoFacts(repo.slug);
  const own = gh.data && (!gh.data.all || facts);
  return (
    <section class="rs-section" aria-labelledby="rs-pulls">
      <h2 id="rs-pulls">Pull requests</h2>
      <p class="muted small">Only in this browser, and only while the board is open in it.</p>
      {!gh.loaded ? (
        <p class="muted" aria-busy="true">
          Loading…
        </p>
      ) : !gh.data?.connected ? (
        <p class="meta">
          These need the board’s GitHub App.{' '}
          <a href={hashFor({ view: 'connections', task: null, pr: null, ping: null })}>Open Connections</a> to set it
          up.
        </p>
      ) : own ? (
        <div class="rs-fields">
          <RepoPullSettings data={gh.data} slug={repo.slug} name={multiRepo.value ? repo.name : null} />
        </div>
      ) : (
        <p class="meta">The board hasn’t read {repo.github} from GitHub yet. Its settings show here once it has.</p>
      )}
    </section>
  );
}

/**
 * Take it off the board: what removing does, what's still open, and the CLI command, since removing also drops its
 * routine's secret from the Secrets Store (WEB-29). The page sends no DELETE.
 * @param {Record<string, any>} props
 */
function TakeOff({ data }) {
  const repo = data.repo;
  if (repo.isDefault)
    return (
      <section class="rs-section rs-danger" aria-labelledby="rs-takeoff">
        <h2 id="rs-takeoff">Take it off the board</h2>
        <p class="muted small">
          {repo.name} is the default repository: tasks without a repository are its, so it stays on the board.
        </p>
      </section>
    );
  const busy = [
    data.open && plural(data.open, 'open task'),
    data.running && plural(data.running, 'running agent'),
  ].filter(Boolean);
  return (
    <section class="rs-section rs-danger" aria-labelledby="rs-takeoff">
      <h2 id="rs-takeoff">Take it off the board</h2>
      <ul class="rs-list small">
        <li>Its sync, webhooks, agents, and saved routines stop.</li>
        <li>
          Its tasks stay, readable, and its short name and prefixes stay its own, so a work ID still means one task.
        </li>
        <li>
          Its routine’s secret leaves the Secrets Store, which only the CLI can do, so it’s a command, not a button.
        </li>
      </ul>
      {busy.length ? (
        <p class="rs-state">
          <TriangleAlert size={16} aria-hidden="true" />
          <span>
            {repo.name} has {busy.join(' and ')}. The command refuses until{' '}
            {data.open + data.running === 1 ? 'it’s' : 'they’re'} finished, or removes it anyway with{' '}
            <code>--force</code>.
          </span>
        </p>
      ) : (
        <p class="meta">No open tasks and no running agents.</p>
      )}
      <Command text={`npx breakaway repos remove ${repo.slug}`} />
      <p class="muted small">
        Then, by hand: delete its routine on claude.ai, with its API trigger, since the board can’t. Made it only for a
        rehearsal? Delete {repo.github} on GitHub too, and your local clone.{' '}
        <a href={ROUTINES_URL} target="_blank" rel="noopener noreferrer">
          Open routines on claude.ai
        </a>
      </p>
    </section>
  );
}

/**
 * A repository taken off the board: its page is read only, and it says whether its slug and prefixes can be
 * released (the wizard's Release, CLD-205).
 * @param {Record<string, any>} props
 */
function Removed({ data, onReleased }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const release = async () => {
    setBusy(true);
    try {
      await api(`repos/${enc(data.repo.slug)}/release`, { method: 'POST', body: { by: 'owner' } });
      toast(`Released ${data.repo.slug}. Its short name and prefixes are free again.`, 'success');
      onReleased();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <div class="rs-removed" role="status">
      <p>
        <strong>Taken off the board {new Date(data.removed).toLocaleDateString()}.</strong> Its tasks stay, and its
        short name and prefixes stay its own, so nothing here can change.
      </p>
      {data.releaseBlocker ? (
        <p class="meta">It can’t be released: {data.releaseBlocker}.</p>
      ) : (
        <p>
          <button type="button" class="btn btn-outline btn-sm" onClick={release} disabled={busy} aria-busy={busy}>
            <RotateCcw size={16} aria-hidden="true" />
            {busy ? 'Releasing…' : 'Release its short name and prefixes'}
          </button>
        </p>
      )}
      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function RepoSettingsView() {
  const slug = settingsSlug.value;
  const [state, setState] = useState({ loading: true, data: null, error: null, missing: false });
  const load = async () => {
    try {
      const data = await api(`repos/${enc(slug)}`);
      setState({ loading: false, data, error: null, missing: false });
    } catch (error) {
      setState({ loading: false, data: null, error: error.message, missing: error.status === 404 });
    }
  };
  useEffect(() => {
    navOrder.value = [];
    if (!slug) return;
    setState({ loading: true, data: null, error: null, missing: false });
    load();
  }, [slug]);
  if (state.missing) return <NotFound slug={slug} />;
  const { data } = state;
  // A save (or a 409's current row) replaces the row; the counts stay from the last read.
  const onSaved = (repo) => {
    setState((s) => (s.data ? { ...s, data: { ...s.data, repo, areas: withCounts(repo, s.data.areas) } } : s));
    loadRepos();
  };
  const readOnly = Boolean(data?.removed);
  return (
    <div class="repo-settings">
      <div class="view-intro">
        <p class="kicker">
          <FolderGit2 size={14} aria-hidden="true" /> Repository settings
        </p>
        <h1>{data?.repo.name ?? slug}</h1>
        {data && (
          <p class="muted">
            {data.repo.github}
            {data.repo.isDefault && ' · the default: tasks without a repository are its'}
          </p>
        )}
      </div>
      {state.loading && (
        <p class="muted" aria-busy="true">
          Loading {slug}’s settings…
        </p>
      )}
      {state.error && (
        <div class="rs-load-error">
          <p class="field-error" role="alert">
            {state.error}
          </p>
          <button type="button" class="btn btn-outline btn-sm" onClick={load}>
            Try again
          </button>
        </div>
      )}
      {data && (
        <>
          {readOnly && (
            <Removed
              data={data}
              onReleased={() => {
                loadRepos();
                load();
              }}
            />
          )}
          <General key={`general:${data.repo.slug}`} data={data} onSaved={onSaved} readOnly={readOnly} />
          <Areas data={data} onSaved={onSaved} readOnly={readOnly} />
          <Agents key={`agents:${data.repo.slug}`} data={data} onSaved={onSaved} readOnly={readOnly} />
          <Deploys
            key={`deploys:${data.repo.slug}`}
            data={data}
            onSaved={onSaved}
            onReload={load}
            readOnly={readOnly}
          />
          {!readOnly && <KickoffSummary slug={data.repo.slug} />}
          {!readOnly && <InfraSettings key={`infra:${data.repo.slug}`} repo={data.repo} />}
          {!readOnly && <PullRequests repo={data.repo} />}
          {!readOnly && <TakeOff data={data} />}
          {repos.value.list.length > 1 && (
            <nav class="rs-others" aria-label="Other repositories">
              <h2 class="kicker">Other repositories</h2>
              <RepoList except={data.repo.slug} />
            </nav>
          )}
        </>
      )}
    </div>
  );
}
