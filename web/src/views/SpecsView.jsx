// The Specs view (WEB-25, docs/specs/IDEA-31-specs-view.md section 3): a repository's specs, read from GitHub on
// its default branch, each one readable beside the list with the tasks that link it. The board never stores a
// spec: the server reads it through the GitHub App and keeps it a minute.
import { useEffect, useRef } from 'preact/hooks';
import { signal } from '@preact/signals';
import { ArrowLeft, ExternalLink, GitPullRequest, ListFilter, RefreshCw, X } from 'lucide-preact';
import { api, enc } from '../lib/api.js';
import { ago, plural, ref, stateOf } from '../lib/model.js';
import { Markdown, Title } from '../lib/richtext.jsx';
import {
  filterSpecs,
  inSpecsDir,
  markStep,
  shortTitle,
  specTaskCounts,
  specsDirOf,
  withoutTitle,
} from '../lib/specs.js';
import {
  byUuid,
  closeSpec,
  hashFor,
  multiRepo,
  navOrder,
  repoBySlug,
  repoName,
  repoScope,
  repos,
  selectedSpec,
  specHref,
  tasks,
  toast,
} from '../lib/store.js';
import { RepoChip } from '../components/ui.jsx';
import { RefineSpec } from '../components/RefineSpec.jsx';

/** Each repository's list, by slug: `{ loading, data, error, status }`. */
const lists = signal(/** @type {Record<string, any>} */ ({}));
/** Each open spec, by `<slug>\n<path>`: `{ loading, data, error, status }`. */
const docs = signal(/** @type {Record<string, any>} */ ({}));
/** Each spec's Mark approved or Mark built press, by `<slug>\n<path>`: `{ busy, pull, error }`. */
const marks = signal(/** @type {Record<string, any>} */ ({}));
/** What the filter field says, kept while the view is left and come back to. */
const query = signal('');

async function loadList(slug) {
  lists.value = { ...lists.value, [slug]: { ...lists.value[slug], loading: true } };
  try {
    const data = await api(`specs?repo=${enc(slug)}`);
    lists.value = { ...lists.value, [slug]: { loading: false, data, error: null, status: 200 } };
  } catch (error) {
    lists.value = {
      ...lists.value,
      [slug]: { loading: false, data: null, error: error.message, status: error.status },
    };
  }
}

async function loadDoc(slug, path) {
  const key = `${slug}\n${path}`;
  docs.value = { ...docs.value, [key]: { ...docs.value[key], loading: true } };
  try {
    const data = await api(`specs/${path.split('/').map(enc).join('/')}?repo=${enc(slug)}`);
    docs.value = { ...docs.value, [key]: { loading: false, data, error: null, status: 200 } };
  } catch (error) {
    docs.value = { ...docs.value, [key]: { loading: false, data: null, error: error.message, status: error.status } };
  }
}

/** The repositories the view shows: the switcher's, or every one under All. */
function shownSlugs() {
  const list = repos.value.list;
  if (repoScope.value) return [repoScope.value];
  if (multiRepo.value) return list.map((r) => r.slug);
  return repos.value.default ? [repos.value.default] : list.slice(0, 1).map((r) => r.slug);
}

const taskHref = (wid) => (tasks.value.some((t) => t.wid === wid) ? hashFor({ task: wid }) : null);

/** "4 tasks, 2 open", or "No tasks". */
function countLine(list) {
  const { total, open } = specTaskCounts(list);
  if (!total) return 'No tasks';
  return open === total ? `${plural(total, 'task')}, all open` : `${plural(total, 'task')}, ${open} open`;
}

/** @param {Record<string, any>} props */
function Status({ status }) {
  if (!status) return null;
  return <span class={`spec-status spec-status-${/^[a-z-]+$/u.test(status) ? status : 'other'}`}>{status}</span>;
}

/** @param {Record<string, any>} props */
function SpecRow({ s, slug, open }) {
  return (
    <li class={`spec-row ${open ? 'is-open' : ''}`}>
      <a
        class="spec-row-link"
        data-spec={`${slug}:${s.path}`}
        href={specHref(s.path, slug)}
        aria-current={open ? 'true' : undefined}
      >
        {s.wid && <span class="wid">{s.wid}</span>}
        <span class="spec-row-title">
          <Title text={shortTitle(s.title, s.wid)} />
        </span>
      </a>
      <span class="spec-row-meta">
        <Status status={s.status} />
        <span class="meta">{countLine(s.tasks)}</span>
        {s.tooLarge && <span class="meta">over 1 MB</span>}
      </span>
    </li>
  );
}

/** One repository's specs, or why there are none. @param {Record<string, any>} props */
function RepoSpecs({ slug, heading }) {
  const state = lists.value[slug];
  const q = query.value;
  const open = selectedSpec.value;
  const isOpen = (path) => Boolean(open) && open.path === path && (open.slug ?? repos.value.default) === slug;
  const d = state?.data;
  const dir = d?.dir ?? specsDirOf(repoBySlug.value.get(slug));
  let body;
  if (!state || (state.loading && !d && !state.error))
    body = (
      <p class="muted small" aria-busy="true">
        Loading the specs…
      </p>
    );
  else if (state.status === 409)
    body = (
      <p class="small">
        Connect GitHub to read the specs: the board reads them from the repository through the GitHub App.{' '}
        <a href={hashFor({ view: 'connections', task: null, spec: null })}>Open Connections</a>
      </p>
    );
  else if (state.error)
    body = (
      <div class="spec-error" role="alert">
        <p class="field-error">Couldn’t read the specs. {state.error}</p>
        <button type="button" class="btn btn-outline btn-sm" onClick={() => loadList(slug)} disabled={state.loading}>
          <RefreshCw size={16} aria-hidden="true" class={state.loading ? 'spin' : ''} />
          Try again
        </button>
      </div>
    );
  else if (d.missing || !d.specs.length)
    body = (
      <div class="spec-none">
        <p>
          No specs in <code>{dir}</code> yet.
        </p>
        <p class="muted small">
          A spec is a Markdown file in that directory, one for each piece of work that needs a plan first. To read them
          from another directory, run <code>{`npx breakaway repos modify ${slug} --specs <dir>`}</code>.
        </p>
      </div>
    );
  else {
    const shown = filterSpecs(d.specs, q);
    body = (
      <>
        {d.readme && (
          <p class="spec-readme small">
            <a href={specHref(d.readme.path, slug)}>About these specs</a> <span class="meta">({d.readme.path})</span>
          </p>
        )}
        {shown.length ? (
          <ul class="spec-rows">
            {shown.map((s) => (
              <SpecRow key={s.path} s={s} slug={slug} open={isOpen(s.path)} />
            ))}
          </ul>
        ) : (
          <p class="muted small">No specs match “{q.trim()}”.</p>
        )}
      </>
    );
  }
  return (
    <section class="spec-group" aria-label={heading ? `Specs in ${repoName(slug)}` : 'Specs'}>
      {heading && (
        <h2 class="spec-group-head">
          {repoName(slug)}
          {d && !d.missing && <span class="count">{d.specs.length}</span>}
        </h2>
      )}
      {body}
    </section>
  );
}

/**
 * Mark approved or Mark built (BRK-215): the board opens a pull request that moves the spec one step and changes only
 * its status line. Once it's open, the button gives way to a link to it; the spec shows its new status when it merges.
 * @param {Record<string, any>} props
 */
function MarkSpec({ slug, path, status }) {
  const step = markStep(status);
  if (!step) return null;
  const key = `${slug}\n${path}`;
  const state = marks.value[key];
  if (state?.pull && state.pull.status === step.status)
    return (
      <a class="btn btn-outline btn-sm" href={state.pull.url} target="_blank" rel="noopener noreferrer">
        <GitPullRequest size={16} aria-hidden="true" />
        Pull request #{state.pull.number}
      </a>
    );
  const press = async () => {
    marks.value = { ...marks.value, [key]: { busy: true } };
    try {
      const res = await api(`specs/${path.split('/').map(enc).join('/')}?repo=${enc(slug)}`, {
        method: 'POST',
        body: { status: step.status },
      });
      marks.value = { ...marks.value, [key]: { pull: { ...res.pull, status: step.status } } };
      toast(
        res.existing ? `Pull request #${res.pull.number} is already open.` : `Pull request #${res.pull.number} opened.`,
      );
    } catch (error) {
      marks.value = { ...marks.value, [key]: { error: error.message } };
    }
  };
  return (
    <button
      type="button"
      class="btn btn-outline btn-sm"
      onClick={press}
      disabled={state?.busy}
      aria-busy={state?.busy ? 'true' : undefined}
    >
      <GitPullRequest size={16} aria-hidden="true" />
      {state?.busy ? 'Opening…' : step.label}
    </button>
  );
}

/** Why Mark approved or Mark built couldn't open its pull request, under the spec's buttons. @param {Record<string, any>} props */
function MarkSpecError({ slug, path }) {
  const error = marks.value[`${slug}\n${path}`]?.error;
  if (!error) return null;
  return (
    <p class="field-error" role="alert">
      Couldn’t open the pull request. {error}
    </p>
  );
}

/** The tasks that link a spec, each opening in the task panel. @param {Record<string, any>} props */
function SpecTasks({ list, path }) {
  return (
    <section class="panel-section" aria-labelledby="spec-tasks">
      <h3 id="spec-tasks">
        Tasks <span class="count">{list.length}</span>
      </h3>
      {list.length ? (
        <ul class="dep-list">
          {list.map((t) => {
            const known = byUuid.value.get(t.uuid);
            const id = known ? ref(known) : (t.wid ?? t.uuid.slice(0, 8));
            return (
              <li key={t.uuid} class="dep-row">
                <span
                  class={`state-dot dot-${known ? stateOf(known) : t.status === 'completed' ? 'done' : 'ready'}`}
                  aria-hidden="true"
                />
                <a href={hashFor({ task: id })}>
                  <span class="wid">{id}</span> <Title text={known?.description ?? t.description} />
                </a>
                {t.status === 'completed' && <span class="meta">done</span>}
              </li>
            );
          })}
        </ul>
      ) : (
        <p class="muted small">
          No tasks link this spec yet. A task links it when its Spec field is <code>{path}</code>.
        </p>
      )}
    </section>
  );
}

/** The open spec, beside the list (or in its place where there's no room). @param {Record<string, any>} props */
function SpecPane({ slug, path }) {
  const key = `${slug}\n${path}`;
  const state = docs.value[key];
  const heading = useRef(null);
  // The server keeps a spec a minute, so reading it again on each open is cheap and catches a change.
  useEffect(() => {
    loadDoc(slug, path);
  }, [key]);
  const d = state?.data;
  useEffect(() => {
    if (d) heading.current?.focus({ preventScroll: true });
  }, [key, Boolean(d)]);
  // j and k step through the spec's tasks.
  useEffect(() => {
    navOrder.value = (d?.tasks ?? []).map((t) => t.uuid).filter((u) => byUuid.value.has(u));
  }, [d]);
  const list = lists.value[slug]?.data;
  const repo = repoBySlug.value.get(slug);
  const dir = d?.dir ?? list?.dir ?? specsDirOf(repo);
  const back = () => {
    const row = document.querySelector(`[data-spec="${CSS.escape(`${slug}:${path}`)}"]`);
    closeSpec();
    requestAnimationFrame(() => /** @type {HTMLElement | null} */ (row)?.focus());
  };
  const top = (
    <div class="panel-top">
      <button type="button" class="btn btn-quiet btn-sm spec-back" onClick={back}>
        <ArrowLeft size={16} aria-hidden="true" />
        All specs
      </button>
      {d?.wid && <span class="wid wid-lg">{d.wid}</span>}
      {d && <Status status={d.status} />}
      <RepoChip slug={slug} />
      <span class="panel-nav spec-close">
        <button type="button" class="btn btn-quiet btn-icon btn-sm" aria-label="Close the spec" onClick={back}>
          <X size={18} aria-hidden="true" />
        </button>
      </span>
    </div>
  );
  let body;
  if (!d && (!state || state.loading))
    body = (
      <p class="muted" aria-busy="true">
        Loading the spec…
      </p>
    );
  else if (!d && state.status === 404)
    body = (
      <p class="muted">
        There’s no spec at <code>{path}</code> on the default branch. It may have moved or been renamed, or the link is
        off.
      </p>
    );
  else if (!d && state.status === 400)
    body = (
      <p class="muted">
        <code>{path}</code> isn’t in <code>{dir}</code>, where the board reads {repoName(slug)}’s specs, so it opens on
        GitHub instead.
        {repo?.github && (
          <>
            {' '}
            <a href={`https://github.com/${repo.github}/blob/HEAD/${path}`} target="_blank" rel="noopener noreferrer">
              Open on GitHub
            </a>
          </>
        )}
      </p>
    );
  else if (!d)
    body = (
      <div class="spec-error" role="alert">
        <p class="field-error">Couldn’t read the spec. {state.error}</p>
        <button
          type="button"
          class="btn btn-outline btn-sm"
          onClick={() => loadDoc(slug, path)}
          disabled={state.loading}
        >
          <RefreshCw size={16} aria-hidden="true" class={state.loading ? 'spin' : ''} />
          Try again
        </button>
      </div>
    );
  else
    body = (
      <>
        <div class="spec-head">
          <h2 class="spec-title" ref={heading} tabIndex={-1}>
            <Title text={shortTitle(d.title, d.wid)} />
          </h2>
          <p class="meta">
            {d.commit ? (
              <>
                Changed {ago(d.commit.date)}
                {d.commit.message && (
                  <>
                    {' in '}
                    {d.commit.url ? (
                      <a href={d.commit.url} target="_blank" rel="noopener noreferrer" title={d.commit.message}>
                        <code>{d.commit.sha.slice(0, 7)}</code>
                      </a>
                    ) : (
                      <code>{d.commit.sha.slice(0, 7)}</code>
                    )}
                    : <Title text={d.commit.message} />
                  </>
                )}
              </>
            ) : (
              <code>{d.path}</code>
            )}
          </p>
          <div class="panel-actions">
            <a class="btn btn-outline btn-sm" href={d.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={16} aria-hidden="true" />
              Open on GitHub
            </a>
            <MarkSpec slug={slug} path={d.path} status={d.status} />
            <RefineSpec slug={slug} path={d.path} title={shortTitle(d.title, d.wid)} />
          </div>
          <MarkSpecError slug={slug} path={d.path} />
        </div>
        {d.tooLarge || d.text === null ? (
          <p class="muted">This spec is over 1 MB, too large to show here. Read it on GitHub.</p>
        ) : (
          <Markdown
            text={withoutTitle(d.text)}
            base={repo?.github ? `https://github.com/${repo.github}` : undefined}
            branch={list?.branch ?? 'HEAD'}
            dir={dir}
            local={(p) => (inSpecsDir(dir, p) ? specHref(p, slug) : null)}
            task={taskHref}
          />
        )}
        <SpecTasks list={d.tasks} path={d.path} />
      </>
    );
  return (
    <article class="spec-pane" aria-label={d ? `Spec ${d.title}` : 'Spec'}>
      <div class="panel-body">
        {top}
        {body}
      </div>
    </article>
  );
}

export function SpecsView() {
  const slugs = shownSlugs();
  const loaded = repos.value.loaded;
  useEffect(() => {
    navOrder.value = [];
  }, []);
  useEffect(() => {
    for (const slug of slugs) if (!lists.value[slug]?.loading) loadList(slug);
  }, [loaded, slugs.join(',')]);
  const open = selectedSpec.value;
  const openSlug = open ? (open.slug ?? repos.value.default) : null;
  const several = slugs.length > 1;
  const one = !several && slugs[0] ? lists.value[slugs[0]]?.data : null;
  const total = slugs.reduce((n, s) => n + (lists.value[s]?.data?.specs.length ?? 0), 0);
  return (
    <div class="specs-view">
      <div class={`specs-layout ${open && openSlug ? 'has-spec' : ''}`}>
        <div class="specs-list">
          <div class="view-intro">
            <h1>Specs</h1>
            <p class="muted">
              {one
                ? `The plans in ${one.dir}, read from ${repoName(slugs[0])} on ${one.branch}, with the tasks that link each one.`
                : 'The plans in each repository’s specs directory, read from GitHub, with the tasks that link each one.'}
            </p>
          </div>
          {total > 0 && (
            <label class="spec-filter">
              <span class="visually-hidden">Filter the specs</span>
              <ListFilter size={18} aria-hidden="true" class="muted" />
              <input
                class="input input-sm"
                type="search"
                placeholder="Filter by title or work ID"
                value={query.value}
                onInput={(e) => {
                  query.value = e.currentTarget.value;
                }}
              />
            </label>
          )}
          {!loaded ? (
            <p class="muted small" aria-busy="true">
              Loading the specs…
            </p>
          ) : slugs.length ? (
            slugs.map((slug) => <RepoSpecs key={slug} slug={slug} heading={several} />)
          ) : (
            <p class="muted">Register a repository in Connections, and its specs show here.</p>
          )}
        </div>
        {open && openSlug && <SpecPane key={`${openSlug}\n${open.path}`} slug={openSlug} path={open.path} />}
      </div>
    </div>
  );
}
