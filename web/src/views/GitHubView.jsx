import { useEffect, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import {
  CircleCheck,
  CircleX,
  Copy,
  ExternalLink,
  GitCommitHorizontal,
  Hourglass,
  LoaderCircle,
  Package,
  RefreshCw,
  ShieldAlert,
  CircleDashed,
  Tag,
} from 'lucide-preact';
import { ago, plural, shortVersion } from '../lib/model.js';
import { checksOnMain, checksSummary, githubTabs, latestPackages, pickTab, runState } from '../lib/github-scope.js';
import { api } from '../lib/api.js';
import {
  actions,
  agents,
  github,
  githubConnect,
  githubPr,
  githubView,
  hashFor,
  installName,
  loadGitHub,
  multiRepo,
  navOrder,
  pullSettingsList,
  repoName,
  repoScope,
  repoSettingsHref,
  repos,
  toast,
} from '../lib/store.js';
import { Title } from '../lib/richtext.jsx';
import { PrRow } from '../components/GitHub.jsx';
import { RepoChip, Tabs } from '../components/ui.jsx';
import { PullPage } from '../components/PullPage.jsx';
import { ReleaseFlow, STATES, summary } from '../components/Release.jsx';
import { NextVersion } from '../components/NextVersion.jsx';
import { TurnOnDeploys } from '../components/TurnOnDeploys.jsx';

const ext = { target: '_blank', rel: 'noopener noreferrer' };

// The tab under the dashboard, remembered in this browser (WEB-17).
const TAB_KEY = 'tasks.githubTab';
const savedTab = (() => {
  try {
    return localStorage.getItem(TAB_KEY);
  } catch {
    return null;
  }
})();
const tabChoice = signal(savedTab);
function chooseTab(id) {
  tabChoice.value = id;
  try {
    localStorage.setItem(TAB_KEY, id);
  } catch {
    /* storage blocked: the tab lasts until reload */
  }
}

/**
 * Step 1: post the App's manifest to GitHub. Step 2 (after GitHub sends you back): the command.
 * @param {Record<string, any>} props
 */
function Setup({ repo }) {
  const form = useRef(null);
  const [manifest, setManifest] = useState(null);
  const code = githubConnect.value;
  const start = async () => {
    try {
      const setup = await api('github/setup', { method: 'POST' });
      setManifest(setup);
    } catch (error) {
      toast(error.message, 'error');
    }
  };
  useEffect(() => {
    if (manifest) form.current?.submit();
  }, [manifest]);
  const command = code && code !== 'failed' ? `npx breakaway github-connect ${code}` : null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast('Command copied.', 'success');
    } catch {
      toast('Couldn’t copy. Select the command and copy it yourself.', 'error');
    }
  };
  return (
    <section class="gh-setup" aria-labelledby="gh-setup-title">
      <h2 id="gh-setup-title">Connect GitHub</h2>
      <p class="muted">
        A private GitHub App, “{installName.value}”, lets the board read {repo}: pull requests, checks, reviews, CI
        runs, commits, and Dependabot alerts. It can’t change anything. Three steps, about two minutes.
      </p>
      <ol class="gh-steps">
        <li class={command ? 'is-done' : ''}>
          <strong>Create the App on GitHub.</strong> GitHub shows what it may read; keep the name or change it, then
          create it. You come back here.
          {!command && (
            <div>
              <button type="button" class="btn btn-primary btn-sm" onClick={start}>
                Create the App on GitHub
                <ExternalLink size={16} aria-hidden="true" />
              </button>
              {code === 'failed' && (
                <p class="field-error" role="alert">
                  That didn’t come back from GitHub as expected (the link is good for an hour). Start again.
                </p>
              )}
            </div>
          )}
        </li>
        <li class={command ? 'is-current' : ''}>
          <strong>Store its keys.</strong> On your machine, in your checkout of {repoName()} (wrangler logged in), run
          this within the hour. It puts the App’s key and webhook secret in the Secrets Store; they never pass through
          the board.
          {command && (
            <div class="gh-command">
              <code>{command}</code>
              <button type="button" class="btn btn-quiet btn-icon btn-sm" aria-label="Copy the command" onClick={copy}>
                <Copy size={16} aria-hidden="true" />
              </button>
            </div>
          )}
        </li>
        <li>
          <strong>Install it on {repo}.</strong> The command prints the install link. Pick “Only select repositories”
          and choose {repoName()}. The board fills in within a few seconds.
        </li>
      </ol>
      {manifest && (
        <form ref={form} method="post" action={manifest.action} hidden>
          <input type="hidden" name="manifest" value={JSON.stringify(manifest.manifest)} />
        </form>
      )}
    </section>
  );
}

const RUN_ICON = {
  success: CircleCheck,
  failure: CircleX,
  cancelled: CircleDashed,
  skipped: CircleDashed,
  timed_out: CircleX,
  startup_failure: CircleX,
};

function duration(r) {
  if (r.status !== 'completed' || !r.started) return '';
  const secs = Math.max(0, Math.round((Date.parse(r.updated) - Date.parse(r.started)) / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

/** @param {Record<string, any>} props */
function Runs({ runs }) {
  const [all, setAll] = useState(false);
  // Running first, then failures, then the rest, newest first within each.
  const order = (r) =>
    r.status !== 'completed' ? 0 : ['failure', 'timed_out', 'startup_failure'].includes(r.conclusion) ? 1 : 2;
  const sorted = [...runs].sort((a, b) => order(a) - order(b) || String(b.created).localeCompare(String(a.created)));
  const shown = all ? sorted : sorted.slice(0, 12);
  return (
    <>
      {runs.length ? (
        <ul class="gh-runs">
          {shown.map((r) => {
            const state = runState(r);
            const Icon = state === 'pending' ? LoaderCircle : (RUN_ICON[state] ?? CircleDashed);
            return (
              <li key={`${r.repo}-${r.id}`} class={`gh-run run-${state}`}>
                <Icon size={17} aria-hidden="true" class="run-icon" />
                <a class="gh-run-title" href={r.url} {...ext}>
                  <span class="gh-run-name">{r.name}</span>
                  <span class="visually-hidden">: {state === 'pending' ? 'running' : state}. </span>
                  <span class="gh-run-sub">
                    <Title text={r.title} />
                  </span>
                </a>
                <span class="gh-run-meta">
                  {r.repo && <RepoChip slug={r.repo} />}
                  <code class="gh-branch">{r.branch}</code>
                  {r.prs.length > 0 && <span class="meta">#{r.prs.join(', #')}</span>}
                  <span class="meta">{r.event === 'dynamic' ? 'Dependabot' : r.event.replace('_', ' ')}</span>
                  <span class="meta" title={r.created}>
                    {ago(r.created)}
                  </span>
                  {duration(r) && <span class="meta">{duration(r)}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p class="muted small">No runs yet.</p>
      )}
      {sorted.length > 12 && !all && (
        <p class="board-more">
          <button type="button" class="btn btn-quiet btn-sm" onClick={() => setAll(true)}>
            Show all {sorted.length}
          </button>
        </p>
      )}
    </>
  );
}

/**
 * Each deploy the Deploy workflow recorded as a GitHub Deployment, the tasks it shipped, and releases and tags.
 * @param {Record<string, any>} props
 */
function Deploys({ deploys = [], releases = [], tags = [] }) {
  return (
    <>
      {deploys.length ? (
        <ul class="gh-runs">
          {deploys.map((d) => {
            const state =
              d.state === 'success' ? 'success' : ['failure', 'error'].includes(d.state) ? 'failure' : 'pending';
            const Icon = state === 'success' ? CircleCheck : state === 'failure' ? CircleX : LoaderCircle;
            return (
              <li key={`${d.repo}-${d.id}`} class={`gh-run run-${state}`}>
                <Icon size={18} class="run-icon" aria-hidden="true" />
                <a class="gh-run-title" href={d.logUrl ?? '#'} {...ext}>
                  <span class="gh-run-name">
                    {d.env} {shortVersion(d)}
                    {d.task === 'rollback' ? ' (rollback)' : ''}
                  </span>
                  <span class="gh-run-sub">{d.description ?? d.state}</span>
                </a>
                <span class="gh-run-meta">
                  <span class="visually-hidden">
                    {state === 'success' ? 'Deployed' : state === 'failure' ? 'Failed' : 'In progress'}
                  </span>
                  {d.repo && <RepoChip slug={d.repo} />}
                  <span class="gh-sha">{d.sha.slice(0, 7)}</span>
                  {d.migrations && d.migrations !== 'none' && <span class="meta">migrations {d.migrations}</span>}
                  {d.shipped?.map((t) => (
                    <a key={t.wid} class="gh-task" href={hashFor({ task: t.wid })}>
                      <span class="wid">{t.wid}</span>
                    </a>
                  ))}
                  <span class="meta" title={d.updated}>
                    {ago(d.updated)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p class="muted small">
          No deploys recorded yet. They show up once the App can read Deployments and the Deploy workflow has run.
        </p>
      )}
      {(releases.length > 0 || tags.length > 0) && (
        <p class="meta gh-releases">
          <Tag size={14} aria-hidden="true" />
          {releases.length
            ? releases.map((r) => (
                <a key={r.tag} href={r.url} {...ext}>
                  {r.name}
                </a>
              ))
            : tags.map((t) => <span key={t.name}>{t.name}</span>)}
        </p>
      )}
    </>
  );
}

/** @param {Record<string, any>} props */
function Commits({ commits }) {
  return (
    <>
      {commits.length ? (
        <ul class="gh-commits">
          {commits.map((c) => (
            <li key={`${c.repo}-${c.sha}`} class="gh-commit">
              <GitCommitHorizontal size={16} aria-hidden="true" class="muted" />
              <a class="gh-sha" href={c.url} {...ext}>
                {c.sha.slice(0, 7)}
              </a>
              <span class="gh-commit-msg">
                <Title text={c.message} />
              </span>
              <span class="gh-commit-meta">
                {c.repo && <RepoChip slug={c.repo} />}
                {c.wids.map((w) => (
                  <a key={w} class="gh-task" href={hashFor({ task: w })}>
                    <span class="wid">{w}</span>
                  </a>
                ))}
                {c.author && <span class="meta">{c.author}</span>}
                <span class="meta" title={c.date}>
                  {ago(c.date)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p class="muted small">No commits yet.</p>
      )}
    </>
  );
}

/** @param {Record<string, any>} props */
function Alerts({ alerts }) {
  if (!alerts.length) {
    return (
      <p class="gh-ok">
        <CircleCheck size={16} aria-hidden="true" />
        No open Dependabot alerts.
      </p>
    );
  }
  const rank = { critical: 0, high: 1, medium: 2, moderate: 2, low: 3 };
  return (
    <section class="gh-section gh-alerts-section" aria-labelledby="gh-alerts">
      <h2 id="gh-alerts">
        <ShieldAlert size={18} aria-hidden="true" />
        Security alerts <span class="count">{alerts.length}</span>
      </h2>
      <ul class="gh-alerts">
        {[...alerts]
          .sort((a, b) => (rank[a.severity] ?? 4) - (rank[b.severity] ?? 4))
          .map((a) => (
            <li key={`${a.repo}-${a.number}`} class={`gh-alert sev-${a.severity}`}>
              <span class="sev">{a.severity}</span>
              {a.repo && <RepoChip slug={a.repo} />}
              <a href={a.url} {...ext}>
                <strong>{a.package}</strong> {a.summary}
              </a>
              <span class="meta">
                {a.fixedIn ? `Fixed in ${a.fixedIn}` : 'No fix yet'}
                {a.manifest ? ` · ${a.manifest}` : ''}
              </span>
              {a.task ? (
                <span class="alert-task">
                  <a href={hashFor({ task: a.task.wid })}>
                    <span class="wid">{a.task.wid}</span>
                  </a>
                  <span class="meta">{a.task.claim ? `${a.task.claim} is on it` : 'task made, no agent yet'}</span>
                  {a.task.session && (
                    <a class="meta" href={a.task.session} target="_blank" rel="noopener noreferrer">
                      session
                    </a>
                  )}
                </span>
              ) : agents.value.data?.connected ? (
                <button type="button" class="btn btn-outline btn-sm alert-fix" onClick={() => actions.fixAlert(a)}>
                  Fix with an agent
                </button>
              ) : null}
            </li>
          ))}
      </ul>
    </section>
  );
}

/** @param {Record<string, any>} props */
function ClosedPrs({ prs }) {
  const [all, setAll] = useState(false);
  const shown = all ? prs : prs.slice(0, 8);
  return (
    <>
      {prs.length ? (
        <ul class="gh-prs">
          {shown.map((p) => (
            <PrRow
              key={`${p.repo}#${p.number}`}
              pr={p}
              note={p.mergedAt ? `merged ${ago(p.mergedAt)}` : p.closedAt ? `closed ${ago(p.closedAt)}` : ''}
            />
          ))}
        </ul>
      ) : (
        <p class="muted small">Nothing yet.</p>
      )}
      {prs.length > 8 && !all && (
        <p class="board-more">
          <button type="button" class="btn btn-quiet btn-sm" onClick={() => setAll(true)}>
            Show all {prs.length}
          </button>
        </p>
      )}
    </>
  );
}

/** npm's command for approving a staged version, as the release flow's notice prints it; the id is on npm. */
const APPROVE = 'npm stage approve <id>';

/** How a staged version goes live: you approve it on npm with 2FA. The board never approves anything there. */
function ApproveHint({ url }) {
  return (
    <p class="meta gh-approve">
      Approve it on npm with 2FA: <code>{APPROVE}</code>, or in Staged Packages on{' '}
      <a href={url} {...ext}>
        its npm page
      </a>
      .
    </p>
  );
}

/** One package version's state: published, or staged and waiting for you on npm. */
function PackageState({ v }) {
  return v.state === 'published' ? (
    <span class="flow-state">
      <CircleCheck size={15} aria-hidden="true" />
      Published
    </span>
  ) : (
    <span class="flow-state">
      <Hourglass size={15} aria-hidden="true" />
      Waiting for your approval
    </span>
  );
}

/** A package's latest pre-release or release in a line, like a Live now line. */
function PackageLine({ name, v }) {
  if (!v) {
    return (
      <li class="gh-live flow-muted">
        <span class="gh-live-name">{name}</span>
        <span class="flow-state">None yet</span>
      </li>
    );
  }
  const when = v.published ?? v.staged;
  return (
    <li class={`gh-live ${v.state === 'published' ? 'flow-ok' : 'flow-warn'}`}>
      <span class="gh-live-name">{name}</span>
      <PackageState v={v} />
      <span class="gh-run-meta">
        <a href={v.url} {...ext}>
          <code>{v.version}</code>
        </a>
        <span class="meta">on {v.tag}</span>
        <span class="meta" title={when}>
          {ago(when)}
        </span>
      </span>
    </li>
  );
}

/**
 * Packages (WEB-18): each package's latest pre-release and release, a staged one marked as waiting for your approval
 * on npm. Not shown without packages.
 * @param {Record<string, any>} props
 */
function PackagesTile({ view, several }) {
  const latest = latestPackages(view);
  if (!latest.length) return null;
  const waiting = latest.reduce((n, p) => n + p.waiting, 0);
  return (
    <section class="gh-section gh-tile" aria-labelledby="gh-packages">
      <h2 id="gh-packages">
        <Package size={18} aria-hidden="true" />
        Packages
        {waiting > 0 && (
          <span class="gh-checks pkg-waiting">
            <Hourglass size={15} aria-hidden="true" />
            {waiting} waiting for you
          </span>
        )}
      </h2>
      {latest.map((p) => (
        <div key={`${p.repo}\n${p.name}`} class="gh-live-repo">
          <span class="gh-package-name">
            <a href={p.url} {...ext}>
              {p.name}
            </a>
            {several && p.repo && <RepoChip slug={p.repo} />}
          </span>
          <ul class="gh-lives">
            <PackageLine name="Pre-release" v={p.prerelease} />
            <PackageLine name="Release" v={p.release} />
          </ul>
          {p.waiting > 0 && <ApproveHint url={p.url} />}
        </div>
      ))}
    </section>
  );
}

/**
 * The Packages tab (WEB-18): every version the workflows staged or published, newest first, with its dist-tag and run.
 * @param {Record<string, any>} props
 */
function Packages({ versions, several }) {
  return (
    <ul class="gh-runs">
      {versions.map((v) => {
        const published = v.state === 'published';
        const Icon = published ? CircleCheck : Hourglass;
        return (
          <li key={`${v.repo}-${v.name}@${v.version}`} class={`gh-run ${published ? 'run-success' : 'pkg-staged'}`}>
            <Icon size={17} aria-hidden="true" class="run-icon" />
            <span class="gh-run-title">
              <a class="gh-run-name" href={v.url} {...ext}>
                {v.name}@{v.version}
              </a>
              <span class="gh-run-sub">
                {published ? (
                  <span title={v.published ?? undefined}>Published{v.published ? ` ${ago(v.published)}` : ''}</span>
                ) : (
                  'Staged, waiting for your approval'
                )}
              </span>
              {!published && <ApproveHint url={v.url} />}
            </span>
            <span class="gh-run-meta">
              {several && v.repo && <RepoChip slug={v.repo} />}
              <code class="gh-branch">
                <span class="visually-hidden">dist-tag </span>
                {v.tag}
              </code>
              {v.run?.url ? (
                <a class="meta" href={v.run.url} {...ext}>
                  {v.run.workflow ?? 'Run'}
                  {v.run.number ? ` #${v.run.number}` : ''}
                </a>
              ) : null}
              <span class="meta" title={v.staged}>
                staged {ago(v.staged)}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** A staging or production card in a line: its state, version, commit, and when it went live. */
function LiveLine({ name, card, commitUrl }) {
  const s = STATES[card.state];
  const b = card.build;
  return (
    <li class={`gh-live flow-${s.tone}`}>
      <span class="gh-live-name">{name}</span>
      <span class="flow-state">
        <s.Icon size={15} aria-hidden="true" class={card.state === 'deploying' ? 'spin' : ''} />
        {s.label}
        {card.state === 'deploying' && card.step ? `: ${card.step}` : ''}
      </span>
      {b && (
        <span class="gh-run-meta">
          <code>{shortVersion(b)}</code>
          {commitUrl ? (
            <a class="gh-sha" href={commitUrl} {...ext}>
              {b.sha7}
            </a>
          ) : (
            <span class="gh-sha">{b.sha7}</span>
          )}
          <span class="meta" title={b.at}>
            {ago(b.at)}
          </span>
        </span>
      )}
    </li>
  );
}

/**
 * What's live now: each pipeline's staging and production, from the release flow. Promote and Roll
 * back stay in the Releases tab; the button goes there.
 * @param {Record<string, any>} props
 */
function LiveNow({ flows, several, onReleases }) {
  return (
    <section class="gh-section gh-tile" aria-labelledby="gh-live">
      <h2 id="gh-live">Live now</h2>
      <p class="visually-hidden" aria-live="polite">
        {flows
          .map(
            (r) =>
              `${several ? `${r.name}: ` : ''}${summary('Staging', r.flow.staging)}. ${summary('Production', r.flow.production)}.`,
          )
          .join(' ')}
      </p>
      {flows.map((r) => (
        <div key={r.slug} class="gh-live-repo">
          {several && <RepoChip slug={r.slug} />}
          <ul class="gh-lives">
            <LiveLine name="Staging" card={r.flow.staging} commitUrl={r.flow.staging.commitUrl} />
            <LiveLine name="Production" card={r.flow.production} commitUrl={r.flow.production.commitUrl} />
          </ul>
        </div>
      ))}
      <p>
        <button type="button" class="btn btn-outline btn-sm" onClick={onReleases}>
          Promote or roll back
        </button>
      </p>
    </section>
  );
}

/**
 * Checks on main: each workflow's latest run on the default branch, failures first.
 * @param {Record<string, any>} props
 */
function ChecksOnMain({ view }) {
  const checks = checksOnMain(view);
  const sum = checksSummary(checks);
  const branch = view.branch ?? (view.all ? null : 'main');
  const words = [
    sum.failing && `${sum.failing} failing`,
    sum.running && `${sum.running} running`,
    sum.passing && `${sum.passing} passing`,
  ].filter(Boolean);
  return (
    <section class="gh-section gh-tile" aria-labelledby="gh-main-checks">
      <h2 id="gh-main-checks">
        {branch ? `Checks on ${branch}` : 'Checks on each default branch'}
        {words.length > 0 && (
          <span
            class={`gh-checks ${sum.failing ? 'checks-failure' : sum.running ? 'checks-pending' : 'checks-success'}`}
          >
            {sum.failing ? (
              <CircleX size={15} aria-hidden="true" />
            ) : sum.running ? null : (
              <CircleCheck size={15} aria-hidden="true" />
            )}
            {words.join(', ')}
          </span>
        )}
      </h2>
      {checks.length ? (
        <ul class="gh-runs gh-runs-main">
          {checks.map((r) => {
            const state = runState(r);
            const Icon = state === 'pending' ? LoaderCircle : (RUN_ICON[state] ?? CircleDashed);
            return (
              <li key={`${r.repo}-${r.id}`} class={`gh-run run-${state}`}>
                <Icon size={17} aria-hidden="true" class="run-icon" />
                <a class="gh-run-title" href={r.url} {...ext}>
                  <span class="gh-run-name">{r.name}</span>
                  <span class="visually-hidden">: {state === 'pending' ? 'running' : state}. </span>
                </a>
                <span class="gh-run-meta">
                  {r.repo && view.all && <RepoChip slug={r.repo} />}
                  <span class="meta" title={r.created}>
                    {ago(r.created)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p class="muted small">No runs on {branch ?? 'a default branch'} yet.</p>
      )}
    </section>
  );
}

/** "Keep branches up to date and Merge when green", for the repositories the view shows that have them on. */
function settingsLine(list) {
  const what = (r) =>
    [r.keep && 'Keep branches up to date', r.merge && 'Merge when green'].filter(Boolean).join(' and ');
  if (!multiRepo.value) return list.length ? what(list[0]) : null;
  const shown = list.filter((r) => !repoScope.value || r.slug === repoScope.value);
  if (!shown.length) return null;
  return shown.map((r) => `${what(r)} in ${repoName(r.slug)}`).join('; ');
}

async function copyCommand(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Command copied.', 'success');
  } catch {
    toast('Couldn’t copy. Select the command and copy it yourself.', 'error');
  }
}

export function GitHubView() {
  const state = github.value;
  useEffect(() => {
    navOrder.value = [];
    if (!state.loaded) loadGitHub();
  }, []);
  const d = githubView.value;
  if (githubPr.value) return <PullPage />;
  const sync = () =>
    loadGitHub({ sync: true }).then(() => {
      if (!github.value.error) toast('Synced with GitHub.', 'success');
    });
  const settings = d?.connected ? settingsLine(pullSettingsList.value) : null;
  // Every repository at once: the names, and the App to set up is the default repository's.
  const where = d?.repo ?? (d?.repos ?? []).map((r) => r.name).join(', ');
  const setupRepo = d?.repo ?? d?.repos?.find((r) => r.isDefault)?.repo;
  const tabs = d?.connected ? githubTabs(d) : [];
  const tab = pickTab(tabs, tabChoice.value);
  // The repository this page shows, for its settings link (WEB-30): the switcher's, or the only one.
  const shownSlug = repoScope.value ?? (repos.value.list.length === 1 ? repos.value.list[0].slug : null);

  return (
    <div class="github-view">
      <div class="view-intro gh-intro">
        <div>
          <h1>GitHub</h1>
          <p class="muted">
            {where || 'The repository'}
            {d?.connected && (d.lastSync ? ` · synced ${ago(d.lastSync)}` : ' · not synced yet')}
            {d?.connected && ' · updates by webhook, and every 5 minutes'}
          </p>
          {settings && <p class="meta">On in this browser: {settings} (in Settings)</p>}
          {shownSlug && (
            <p class="meta">
              <a href={repoSettingsHref(shownSlug)}>Settings for {repoName(shownSlug)}</a>
            </p>
          )}
        </div>
        {d?.connected && (
          <button type="button" class="btn btn-outline btn-sm" onClick={sync} disabled={state.loading}>
            <RefreshCw size={16} aria-hidden="true" class={state.loading ? 'spin' : ''} />
            {state.loading ? 'Syncing…' : 'Sync now'}
          </button>
        )}
      </div>
      {state.error && (
        <p class="field-error" role="alert">
          {state.error}
        </p>
      )}
      {!state.loaded && (
        <p class="muted" aria-busy="true">
          Loading GitHub…
        </p>
      )}
      {d && !d.connected && <Setup repo={setupRepo} />}
      {d?.connected && d.error && (
        <p class="field-error" role="alert">
          The last sync failed: {d.error}
        </p>
      )}
      {d?.connected && !d.lastSync && !d.error && (
        <p class="gh-ok">Connected. Install the App on {where} if you haven’t, then Sync now.</p>
      )}
      {d?.connected &&
        d.empties.map((r) => (
          <div key={r.slug} class="gh-empty" role="status">
            <p>
              <strong>{r.repo} has no commits yet</strong>, so there’s nothing to sync. Add the files the board’s agents
              need with:
            </p>
            <div class="gh-command">
              <code>{`npx breakaway repos init ${r.slug}`}</code>
              <button
                type="button"
                class="btn btn-quiet btn-icon btn-sm"
                aria-label="Copy the command"
                onClick={() => copyCommand(`npx breakaway repos init ${r.slug}`)}
              >
                <Copy size={16} aria-hidden="true" />
              </button>
            </div>
          </div>
        ))}
      {d?.connected &&
        d.pipelinesFound.map((r) => (
          <TurnOnDeploys key={r.slug} view={r} label={d.all && multiRepo.value ? r.name : null} />
        ))}
      {d?.connected && (
        <div class="gh-dash">
          <div class="gh-dash-tiles">
            {d.flows.length > 0 && (
              <LiveNow
                flows={d.flows}
                several={d.all && multiRepo.value}
                onReleases={() => {
                  chooseTab('releases');
                  requestAnimationFrame(() => document.getElementById('gh-tab-releases')?.focus());
                }}
              />
            )}
            <ChecksOnMain view={d} />
            <PackagesTile view={d} several={d.all && multiRepo.value} />
            <Alerts alerts={d.alerts} />
          </div>
          <section class="gh-section gh-dash-prs" aria-labelledby="gh-open">
            <h2 id="gh-open">
              Open pull requests <span class="count">{d.open.length}</span>
            </h2>
            {d.open.length ? (
              <ul class="gh-prs">
                {d.open.map((p) => (
                  <PrRow key={`${p.repo}#${p.number}`} pr={p} note={`updated ${ago(p.updated ?? p.created)}`} />
                ))}
              </ul>
            ) : (
              <p class="muted small">None open.</p>
            )}
          </section>
        </div>
      )}
      {d?.connected && tab && (
        <div class="gh-tabs">
          <Tabs label="GitHub lists" tabs={tabs} value={tab} onChange={chooseTab} idBase="gh" />
          <div
            id={`gh-panel-${tab}`}
            role="tabpanel"
            aria-labelledby={`gh-tab-${tab}`}
            class={tab === 'releases' ? 'gh-panel gh-panel-flows' : 'gh-section gh-panel'}
          >
            {tab === 'releases' &&
              d.nextVersions.map((r) => (
                <NextVersion key={r.slug} view={r} label={d.all && multiRepo.value ? r.name : null} />
              ))}
            {tab === 'releases' &&
              d.flows.map((r) => (
                <ReleaseFlow key={r.slug} view={r} label={d.all && multiRepo.value ? r.name : null} />
              ))}
            {tab === 'deploys' && <Deploys deploys={d.deploys} releases={d.releases} tags={d.tags} />}
            {tab === 'packages' && <Packages versions={d.packages} several={d.all && multiRepo.value} />}
            {tab === 'completed' && <ClosedPrs prs={d.closed} />}
            {tab === 'runs' && <Runs runs={d.runs} />}
            {tab === 'commits' && <Commits commits={d.commits} />}
          </div>
        </div>
      )}
      {d?.connected && (
        <p class="meta gh-foot">
          {plural(d.open.length + d.closed.length, 'pull request')} kept · the board writes to GitHub only when you
          press{' '}
          {d.pipeline
            ? 'Update branch, Merge, Merge when green, Promote, or Roll back'
            : 'Update branch, Merge, or Merge when green'}
          {settings && ', or when your settings in this browser say so'}
        </p>
      )}
    </div>
  );
}
