import { useEffect, useState } from 'preact/hooks';
import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleOff,
  ExternalLink,
  FolderPlus,
  CirclePause,
  Plug,
  RefreshCw,
  Settings,
  TriangleAlert,
} from 'lucide-preact';
import { ago } from '../lib/model.js';
import {
  checkConnections,
  confirmDialog,
  connections,
  go,
  hashFor,
  inScope,
  loadConnections,
  navOrder,
  noRepos,
  openAddRepo,
  openKickoff,
  overrideGitHubStatus,
  registerRepo,
  repoName,
  repoScope,
  repoSettingsHref,
  repos,
} from '../lib/store.js';
import { ProviderConnect } from '../components/ProviderConnect.jsx';
import { RoutineConnect } from '../components/RoutineConnect.jsx';
import { SelfUpdate } from '../components/SelfUpdate.jsx';
import { RepoChip } from '../components/ui.jsx';

const ext = { target: '_blank', rel: 'noopener noreferrer' };

/** The groups the view shows, in order; the CLI, Taskwarrior, and push share one. */
const GROUPS = [
  { id: 'repos', label: 'Repositories', of: ['repos'] },
  { id: 'board', label: 'Board', of: ['board'] },
  { id: 'cloudflare', label: 'Cloudflare', of: ['cloudflare'] },
  { id: 'github', label: 'GitHub', of: ['github'] },
  { id: 'npm', label: 'npm', of: ['npm'] },
  { id: 'claude', label: 'Claude', of: ['claude'] },
  { id: 'providers', label: 'Providers', of: ['providers'] },
  { id: 'sync', label: 'CLI, sync, and push', of: ['cli', 'taskwarrior', 'push'] },
];

export const STATE = {
  working: { label: 'Working', Icon: CircleCheck },
  attention: { label: 'Needs attention', Icon: TriangleAlert },
  off: { label: 'Not connected', Icon: CircleOff },
};

/** A routine's row says whether a session it started has reported back (BRK-142); it stays `working` for the rest. */
const READING = {
  verified: { label: 'Verified', Icon: CircleCheck },
  unverified: { label: 'Not verified yet', Icon: CircleDashed },
};

/**
 * The repository a row is about, or null for one the whole install shares (Cloudflare, the App, the
 * webhook, the budget, sync, and push). The default repository's live output row has no `repo`, as it
 * always had, so its state and inbox notes carry on.
 */
const rowRepo = (c) => c.repo ?? (c.id === 'claude.output' ? repos.value.default : null);

/** Whether a row shows under the repository switcher: install-wide rows always do. */
const shown = (c) => {
  const repo = rowRepo(c);
  return !repo || inScope(repo);
};

/** What a fix link opens, in words. */
function linkLabel(href) {
  try {
    const url = new URL(href);
    if (url.host === 'claude.ai') return 'Open routines on claude.ai';
    if (url.host === 'dash.cloudflare.com') return 'Open Cloudflare';
    if (url.host === 'github.com' && url.pathname.includes('/blob/')) return 'Read how in the docs';
    if (url.host === 'github.com') return 'Open on GitHub';
    return `Open ${url.host}`;
  } catch {
    return 'Open';
  }
}

/** @param {Record<string, any>} props */
function When({ iso, prefix }) {
  if (!iso) return null;
  return (
    <span>
      {prefix}{' '}
      <time dateTime={iso} title={new Date(iso).toLocaleString()}>
        {ago(iso)}
      </time>
    </span>
  );
}

/**
 * The secrets or permissions behind a connection, one line each.
 * @param {Record<string, any>} props
 */
function Items({ c }) {
  if (!c.items?.length) return null;
  const secrets = c.id === 'cloudflare.secrets';
  return (
    <details class="conn-items">
      <summary>{secrets ? 'Each binding' : 'Each permission'}</summary>
      <ul>
        {c.items.map((i) => {
          const ok = secrets ? i.state === 'set' : i.ok;
          return (
            <li key={i.name} class={ok ? '' : 'is-bad'}>
              {ok ? <CircleCheck size={15} aria-hidden="true" /> : <TriangleAlert size={15} aria-hidden="true" />}
              {secrets ? (
                <span>
                  <code>{i.name}</code> {i.state}
                  {i.required ? '' : ' (optional)'}
                  <span class="muted">, for {i.for}</span>
                </span>
              ) : (
                <span>
                  {i.label}: needs {i.need}, has {i.has}
                  <span class="muted">, for {i.for}</span>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/**
 * Treat as working, or Hold again, on GitHub's status row (BRK-218): for when an incident is over but the status
 * page still shows it open.
 * @param {{ on: boolean }} props
 */
function StatusOverride({ on }) {
  const [busy, setBusy] = useState(false);
  const press = async () => {
    if (!on) {
      const ok = await confirmDialog({
        title: 'Treat GitHub as working?',
        body: 'Chases start agents again, and Keep branches up to date and Merge when green carry on. Do it once you’ve seen pushes go through and checks run. The board holds again if the status page reports something new.',
        confirmLabel: 'Treat as working',
      });
      if (!ok) return;
    }
    setBusy(true);
    await overrideGitHubStatus(!on);
    setBusy(false);
  };
  return (
    <p class="conn-meta">
      <button type="button" class="btn btn-outline btn-sm" disabled={busy} aria-busy={busy} onClick={press}>
        {on ? <CirclePause size={15} aria-hidden="true" /> : <CircleCheck size={15} aria-hidden="true" />}
        {on ? 'Hold again' : 'Treat as working'}
      </button>
    </p>
  );
}

/** @param {Record<string, any>} props */
function Row({ c }) {
  const reading = c.state === 'working' ? READING[c.reading] : null;
  const { label, Icon } = reading ?? STATE[c.state] ?? STATE.off;
  return (
    <li class={`conn conn-${c.state}`}>
      <div class="conn-head">
        <span class={`conn-state conn-state-${reading && c.reading === 'unverified' ? 'unverified' : c.state}`}>
          <Icon size={15} aria-hidden="true" />
          {label}
        </span>
        <h3 class="conn-name">{c.name}</h3>
        {rowRepo(c) && <RepoChip slug={rowRepo(c)} />}
      </div>
      {c.detail && <p class="conn-detail">{c.detail}</p>}
      {c.update?.newer && !c.fix && c.link && (
        <p class="conn-meta">
          <a href={c.link} {...ext}>
            {c.update.pullRequest ? 'Open the update pull request' : 'Read the release notes'}
            <ExternalLink size={15} aria-hidden="true" />
            <span class="visually-hidden"> (opens in a new tab)</span>
          </a>
        </p>
      )}
      {c.provider ? (
        (c.provider.discovery || c.provider.signal) && (
          <p class="conn-meta meta">
            <When
              iso={c.provider.discovery?.at}
              prefix={`Last discovery${c.provider.discovery?.ok ? '' : ' failed'}`}
            />
            {c.provider.discovery && c.provider.signal && ' · '}
            <When
              iso={c.provider.signal?.at}
              prefix={`${c.provider.discovery ? 'l' : 'L'}ast signal${c.provider.signal?.ok ? '' : ' failed'}`}
            />
          </p>
        )
      ) : c.verified ? (
        <p class="conn-meta meta">
          <When iso={c.verified.at} prefix={`Verified by ${c.verified.task}`} />
          {c.at && ' · '}
          <When iso={c.at} prefix="last start" />
        </p>
      ) : (
        (c.at || c.since) && (
          <p class="conn-meta meta">
            <When iso={c.at} prefix="Seen" />
            {c.at && c.since && ' · '}
            <When iso={c.since} prefix={`${label} since`} />
          </p>
        )
      )}
      {c.fix && (
        <div class="conn-fix">
          <p>
            <strong>To fix it:</strong> {c.fix}
          </p>
          {c.link && (
            <a class="btn btn-outline btn-sm" href={c.link} {...ext}>
              {linkLabel(c.link)}
              <ExternalLink size={15} aria-hidden="true" />
              <span class="visually-hidden"> (opens in a new tab)</span>
            </a>
          )}
        </div>
      )}
      {c.override && <StatusOverride on={c.override.on} />}
      {c.id === 'board.version' && <SelfUpdate />}
      {c.id === 'claude.routine' && c.repo && 'source' in c && (
        <RoutineConnect slug={c.repo} source={c.source} onDone={loadConnections} />
      )}
      {c.provider && (
        <ProviderConnect id={c.provider.id} name={c.name} connected={c.provider.connected} onDone={loadConnections} />
      )}
      <Items c={c} />
    </li>
  );
}

/** Each registered repository the switcher shows, with a link to its settings (WEB-30). */
function RepoRows() {
  const list = repos.value.list.filter((r) => inScope(r.slug));
  if (!list.length) return null;
  return (
    <ul class="conn-repos">
      {list.map((r) => (
        <li key={r.slug}>
          <span>
            <strong>{r.name}</strong> <span class="meta">{r.github}</span>
          </span>
          <a class="btn btn-outline btn-sm" href={repoSettingsHref(r.slug)}>
            <Settings size={15} aria-hidden="true" />
            Settings<span class="visually-hidden"> for {r.name}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Registering the first repository, on a fresh install (CLD-131). The CLI's repos add does the same. */
function RegisterRepo() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const areas = String(form.get('areas') ?? '')
      .split(/[\s,]+/u)
      .filter(Boolean);
    setBusy(true);
    setError(null);
    try {
      await registerRepo({
        slug: String(form.get('slug') ?? '').trim(),
        github: String(form.get('github') ?? '').trim(),
        areas,
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="setup-register" onSubmit={submit} aria-describedby={error ? 'register-error' : undefined}>
      <div class="field-row">
        <label class="field">
          <span class="field-label">Short name</span>
          <input
            name="slug"
            required
            autoComplete="off"
            spellcheck={false}
            placeholder="breakaway"
            aria-describedby="register-slug-hint"
          />
          <span class="field-hint" id="register-slug-hint">
            Lowercase letters, digits, and hyphens. It never changes.
          </span>
        </label>
        <label class="field">
          <span class="field-label">GitHub repository</span>
          <input
            name="github"
            required
            autoComplete="off"
            spellcheck={false}
            placeholder="owner/name"
            aria-describedby="register-github-hint"
          />
          <span class="field-hint" id="register-github-hint">
            As owner/name, or its github.com link.
          </span>
        </label>
      </div>
      <label class="field">
        <span class="field-label">Areas</span>
        <input
          name="areas"
          required
          autoComplete="off"
          spellcheck={false}
          placeholder="product:PRD cloud:CLD"
          aria-describedby="register-areas-hint"
        />
        <span class="field-hint" id="register-areas-hint">
          Each area and its work-ID prefix, as area:PREFIX, separated by spaces. A prefix is 2 to 8 capital letters and
          never changes. Ideas and routines are already there.
        </span>
      </label>
      {error && (
        <p class="field-error" id="register-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" class="btn btn-primary btn-sm" disabled={busy} aria-busy={busy}>
        {busy ? 'Registering…' : 'Register repository'}
      </button>
    </form>
  );
}

/**
 * A fresh install's steps, in order, until they're all done (CLD-131). Each row below says how to do it.
 * @param {Record<string, any>} props
 */
function Setup({ setup }) {
  if (!setup || setup.done) return null;
  // An optional step (Taskwarrior) is never the one to do now.
  const next = setup.steps.find((s) => !s.done && !s.optional);
  return (
    <section class="conn-group setup" aria-labelledby="setup-title">
      <h2 id="setup-title">Set up the board</h2>
      <p class="muted">
        A new board needs a few things before agents can work on it, and it’s set up once a first task is closed by its
        merged pull request. Each step’s connection below says how to finish it, and the last one starts an agent and
        follows it to that pull request.
      </p>
      <ol class="setup-steps">
        {setup.steps.map((s) => (
          <li key={s.id} class={s.done ? 'is-done' : s === next ? 'is-next' : ''}>
            {s.done ? <CircleCheck size={16} aria-hidden="true" /> : <Circle size={16} aria-hidden="true" />}
            <span>
              {s.name}
              <span class="visually-hidden">{s.done ? ', done' : ', to do'}</span>
              {/* The last step is the wizard's agent step: Start is there, and its checks tick to merged (WEB-40). */}
              {s.id === 'first' && setup.repo && !s.done && (
                <>
                  {' · '}
                  <button type="button" class="link-button" onClick={() => openAddRepo({ slug: setup.repo }, 'agent')}>
                    Start the first agent
                  </button>
                </>
              )}
            </span>
          </li>
        ))}
      </ol>
      {next?.id === 'repo' && <RegisterRepo />}
      <p class="muted small">
        Or follow every step, through to a first agent’s merged pull request, in{' '}
        <button type="button" class="link-button" onClick={() => openAddRepo(null)}>
          Add a repository
        </button>
        . Starting something new?{' '}
        <button type="button" class="link-button" onClick={() => openKickoff(null)}>
          Kick off a project
        </button>
        .
      </p>
    </section>
  );
}

/** On every other view while the board has no repository: where to start (CLD-131). */
export function FirstRunNotice() {
  if (!noRepos.value) return null;
  return (
    <div class="first-run" role="status">
      <Plug size={18} aria-hidden="true" />
      <p>
        <strong>This board has no repository yet.</strong> Register one on Connections to start adding tasks.
      </p>
      <button type="button" class="btn btn-outline btn-sm" onClick={() => go('connections')}>
        Set up the board
      </button>
    </div>
  );
}

export function ConnectionsView() {
  const { loaded, data, error, checking } = connections.value;
  useEffect(() => {
    navOrder.value = [];
    loadConnections();
  }, []);
  const all = data?.connections ?? [];
  const list = all.filter(shown);
  const scope = repoScope.value;
  // The whole install's count, as the nav shows it; with one repository picked, what's shown here.
  const n = scope ? list.filter((c) => c.state === 'attention').length : (data?.attention ?? 0);
  return (
    <div class="connections-view">
      <div class="conn-top">
        <div class="view-intro">
          <h1>Connections</h1>
          <p class="muted">
            Everything the board leans on, whether it’s working, and what to do when it isn’t. Checking only reads: it
            never writes to GitHub, starts an agent, or uses a Claude start.
          </p>
        </div>
        <div class="conn-check">
          <div class="conn-buttons">
            <button type="button" class="btn btn-outline btn-sm" onClick={() => openAddRepo(null)}>
              <FolderPlus size={16} aria-hidden="true" />
              Add a repository
            </button>
            <button
              type="button"
              class="btn btn-primary btn-sm"
              onClick={checkConnections}
              disabled={checking}
              aria-busy={checking}
            >
              <RefreshCw size={16} aria-hidden="true" class={checking ? 'spin' : ''} />
              {checking ? 'Checking…' : 'Check now'}
            </button>
          </div>
          <span class="meta" role="status">
            {data &&
              (data.checked ? (
                <>
                  GitHub checked <time dateTime={data.checked}>{ago(data.checked)}</time>
                </>
              ) : (
                'GitHub not checked yet'
              ))}
          </span>
        </div>
      </div>
      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
      {!loaded && !error && (
        <p class="muted" aria-busy="true">
          Checking connections…
        </p>
      )}
      {data && (
        <p class={`conn-summary ${n ? 'is-bad' : ''}`}>
          {n ? <TriangleAlert size={18} aria-hidden="true" /> : <CircleCheck size={18} aria-hidden="true" />}
          {n
            ? `${n === 1 ? '1 connection needs' : `${n} connections need`} attention${scope ? `, counting ${repoName(scope)}’s and the ones every repository shares` : ''}.`
            : scope
              ? `Every connection that’s set up for ${repoName(scope)}, and every one the repositories share, is working.`
              : 'Every connection that’s set up is working.'}
        </p>
      )}
      <Setup setup={data?.setup} />
      {GROUPS.map((g) => {
        const rows = list.filter((c) => g.of.includes(c.group));
        // Repositories always lists the ones registered, each with a link to its settings (WEB-30).
        const repoRows = g.id === 'repos' && repos.value.list.some((r) => inScope(r.slug));
        if (!rows.length && !repoRows) return null;
        return (
          <section key={g.id} class="conn-group" aria-labelledby={`conn-${g.id}`}>
            <h2 id={`conn-${g.id}`}>{g.label}</h2>
            {rows.length > 0 && (
              <ul class="conn-list">
                {rows.map((c) => (
                  <Row key={`${c.id}:${c.repo ?? ''}`} c={c} />
                ))}
              </ul>
            )}
            {repoRows && <RepoRows />}
          </section>
        );
      })}
      <p class="muted small">
        Apps you connected through MCP, and how to connect another, are on{' '}
        <a href={hashFor({ view: 'mcp', task: null, pr: null, ping: null })}>MCP</a>.
      </p>
      {data?.cannotCheck?.length > 0 && (
        <section class="conn-group" aria-labelledby="conn-cannot">
          <h2 id="conn-cannot">What the board can’t check</h2>
          <ul class="conn-list">
            {data.cannotCheck.map((x) => (
              <li key={x.name} class="conn conn-unknown">
                <h3 class="conn-name">{x.name}</h3>
                <p class="conn-detail">{x.why}</p>
                {x.link && (
                  <p>
                    <a href={x.link} {...ext}>
                      {linkLabel(x.link)}
                      <span class="visually-hidden"> (opens in a new tab)</span>
                    </a>
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {loaded && !all.length && !error && (
        <div class="empty">
          <Plug size={28} aria-hidden="true" />
          <h2>No connections to show</h2>
          <p class="muted">The board didn’t report any. Try Check now.</p>
        </div>
      )}
    </div>
  );
}
