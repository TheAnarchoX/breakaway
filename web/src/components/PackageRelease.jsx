import { useState } from 'preact/hooks';
import { Hammer, TriangleAlert } from 'lucide-preact';
import { api } from '../lib/api.js';
import { releaseSetups } from '../lib/github-scope.js';
import { githubRepoFacts, loadGitHub, repoSettingsHref, toast } from '../lib/store.js';
import { Dialog } from './ui.jsx';

/*
 * Release on each of a package's pre-releases (WEB-39, IDEA-27 section 2b): the board starts the repository's
 * release.yml stable job with that pre-release and what the default branch works toward next, and npm waits for your
 * 2FA. The server works out what each one offers (`v.release`, src/release.js releaseOffer) and checks it again.
 */

const ext = { target: '_blank', rel: 'noopener noreferrer' };
const STEP_HINT = {
  patch: 'Counts by itself. Nothing else changes.',
  minor: 'Opens a pull request that sets package.json’s version.',
  major: 'Opens a pull request that sets package.json’s version.',
};

/** `1.3.1-main.4` as `main.4`, the way the superseded line names it. */
const shortPre = (version) => String(version).replace(/^\d+\.\d+\.\d+-/u, '');

/** "main.5 to main.7", or "main.5" alone. */
function span(versions) {
  if (versions.length === 1) return shortPre(versions[0]);
  return `${shortPre(versions[0])} to ${shortPre(versions[versions.length - 1])}`;
}

/** Why the next version is already set, in one sentence. */
function nextIsSet(next) {
  const version = next.version ? <code>{next.version}</code> : 'set';
  if (next.why === 'prerelease')
    return (
      <>
        Next is {version}: <code>{next.prerelease}</code> is already out.
      </>
    );
  const task = next.task?.wid ?? next.task?.short;
  return (
    <>
      Next is {version}: {task} is preparing it.
    </>
  );
}

/**
 * Build a pre-release (WEB-113): starts the release workflow's pre-release job on the default branch, with prerelease
 * empty. The owner's press only; the server checks again that main has something new and CI passed on it.
 * @param {string} repo
 */
async function buildPrerelease(repo) {
  await api('github/prerelease', { method: 'POST', body: { repo } });
  toast('Building a pre-release. It shows here once it’s staged.', 'success');
  loadGitHub({ sync: true });
}

/** "12 merges", or "at least 100 merges" when the pre-release is older than every commit the board keeps. */
const mergesText = (ahead) =>
  `${ahead.atLeast ? 'at least ' : ''}${ahead.merges} ${ahead.merges === 1 ? 'merge' : 'merges'}`;

/**
 * What main has since a pre-release, each pull request with its work IDs, folded under a line.
 * @param {{ ahead: any, summary: any }} props
 */
function AheadList({ ahead, summary }) {
  return (
    <details class="pkg-ahead">
      <summary>{summary}</summary>
      <ul class="pkg-ahead-list">
        {ahead.prs.map((p) => {
          const wids = p.wids.filter((w) => !String(p.title).includes(w));
          return (
            <li key={p.sha7 ?? p.number}>
              {p.url ? (
                <a href={p.url} {...ext}>
                  {p.number ? `#${p.number}` : p.sha7}
                </a>
              ) : (
                <code>{p.number ? `#${p.number}` : p.sha7}</code>
              )}{' '}
              {p.title}
              {wids.length > 0 && <span class="meta"> ({wids.join(', ')})</span>}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/** Where the press's run is, in a line, or nothing once it's old news. */
function BuildState({ build }) {
  if (!build) return null;
  const run = build.run?.url ? (
    <a href={build.run.url} {...ext}>
      run #{build.run.number}
    </a>
  ) : null;
  if (build.state === 'starting')
    return (
      <p class="meta" role="status">
        Starting the pre-release run.
      </p>
    );
  if (build.state === 'running')
    return (
      <p class="meta" role="status">
        Building a pre-release: {run}.
      </p>
    );
  if (build.state === 'finishing')
    return (
      <p class="meta" role="status">
        The run passed ({run}). The pre-release shows here once the board reads it.
      </p>
    );
  if (build.state === 'failed')
    return (
      <p class="flow-warning" role="status">
        <TriangleAlert size={16} aria-hidden="true" />
        <span>The pre-release run stopped: see {run} for why, then build again.</span>
      </p>
    );
  return (
    <p class="meta" role="status">
      Built <code>{build.version}</code>. Test it, then release it.
    </p>
  );
}

/**
 * Build a pre-release on a package's card (WEB-113): how far the default branch is ahead of the latest pre-release,
 * with its pull requests, the press that starts the pre-release job, and the run it started. Only for a repository
 * whose release workflow builds pre-releases by hand (`facts.releaseBuild`, from the server), and only for its package.
 * @param {{ repo: string, name: string }} props
 */
export function PrereleaseBuild({ repo, name }) {
  const facts = githubRepoFacts(repo);
  const b = facts?.releaseBuild;
  const [busy, setBusy] = useState(false);
  if (!b || b.package !== name) return null;
  const actions = facts?.access?.actions ?? { ok: true, reason: null };
  // While a run builds, its line above says so; the reason under the button would only repeat it.
  const building = ['starting', 'running', 'finishing'].includes(b.build?.state ?? '');
  const reason = !actions.ok ? actions.reason : building ? null : b.reason;
  const why = `pkg-build-why-${repo}-${name}`.replace(/[^\w-]/gu, '-');
  const press = async () => {
    setBusy(true);
    try {
      await buildPrerelease(repo);
    } catch (err) {
      toast(`Couldn’t start the pre-release: ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  const latest = b.latest?.version;
  return (
    <div class="pkg-build">
      {b.ahead && latest ? (
        b.ahead.merges > 0 ? (
          <AheadList
            ahead={b.ahead}
            summary={
              <>
                {b.branch} has {mergesText(b.ahead)} since <code>{latest}</code>
              </>
            }
          />
        ) : (
          <p class="meta">
            <code>{latest}</code> has everything on {b.branch}.
          </p>
        )
      ) : (
        <p class="meta">
          {latest ? `The board can’t tell what ${b.branch} has since ${latest}.` : 'No pre-release yet.'}
        </p>
      )}
      {b.build && (
        <div id={`${why}-build`}>
          <BuildState build={b.build} />
        </div>
      )}
      <span class="pkg-release">
        <button
          type="button"
          class="btn btn-outline btn-sm"
          disabled={busy || !actions.ok || !b.allowed}
          aria-busy={busy}
          aria-describedby={reason ? why : building ? `${why}-build` : undefined}
          onClick={press}
        >
          <Hammer size={15} aria-hidden="true" />
          Build a pre-release
        </button>
        {reason && (
          <span id={why} class="meta">
            {reason}
          </span>
        )}
      </span>
    </div>
  );
}

/** @param {Record<string, any>} props */
function ReleaseDialog({ v, onClose }) {
  const offer = v.release;
  const facts = githubRepoFacts(v.repo);
  const branch = facts?.branch ?? 'the default branch';
  const [next, setNext] = useState('patch');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const id = `pkg-release-${v.repo}-${v.version}`.replace(/[^\w-]/gu, '-');
  const later = offer.leavesOut;
  // What the default branch has since this pre-release (WEB-113), so a stable isn't cut from a stale one by accident.
  const build = facts?.releaseBuild;
  const behind = build?.package === v.name ? build.behind?.[v.version] : null;
  const buildFirst = async () => {
    setBusy(true);
    setError(null);
    try {
      await buildPrerelease(v.repo);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('github/release', {
        method: 'POST',
        body: { version: v.version, next: offer.next.ask ? next : 'patch', repo: v.repo },
      });
      toast(`Releasing ${offer.stable}. Approve it on npm once it’s staged.`, 'success');
      onClose();
      loadGitHub({ sync: true });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={() => !busy && onClose()} labelledBy={`${id}-title`} className="dialog-small">
      <form class="sheet" onSubmit={submit}>
        <h2 id={`${id}-title`}>
          Release {v.name}@{offer.stable}?
        </h2>
        <ul class="merge-facts">
          <li>
            Stages <code>{offer.stable}</code> on latest from <code>{v.version}</code>’s commit, the same files.
          </li>
          <li>It waits on npm until you approve it with 2FA. The board never publishes or approves anything there.</li>
        </ul>
        {behind && behind.merges > 0 && (
          <div class="flow-warning">
            <TriangleAlert size={16} aria-hidden="true" />
            <div>
              <AheadList
                ahead={behind}
                summary={
                  <>
                    {branch} has {mergesText(behind)} since <code>{v.version}</code>. They aren’t in {offer.stable}.
                  </>
                }
              />
              {build.allowed ? (
                <button type="button" class="btn btn-outline btn-sm" onClick={buildFirst} disabled={busy}>
                  <Hammer size={15} aria-hidden="true" />
                  Build a pre-release first
                </button>
              ) : (
                build.reason && <p class="meta">{build.reason}</p>
              )}
            </div>
          </div>
        )}
        {later.length > 0 && (
          <p class="flow-warning">
            <TriangleAlert size={16} aria-hidden="true" />
            <span>
              {span(later)} {later.length === 1 ? 'comes' : 'come'} after it, {later.length === 1 ? 'isn’t' : 'aren’t'}{' '}
              in {offer.stable}, and {later.length === 1 ? 'ships' : 'ship'} in the next version’s pre-releases, which
              are built from {branch}.
            </span>
          </p>
        )}
        {offer.next.ask ? (
          <fieldset class="flow-versions">
            <legend class="meta">What comes next</legend>
            {offer.next.choices.map((c) => (
              <label key={c.next} class="check-inline">
                <input type="radio" name={`${id}-next`} checked={next === c.next} onChange={() => setNext(c.next)} />
                <span class="pkg-next">
                  <span>
                    {c.next === 'patch' ? 'Patch' : c.next === 'minor' ? 'Minor' : 'Major'}: <code>{c.version}</code>
                  </span>
                  <span class="meta">{STEP_HINT[c.next]}</span>
                </span>
              </label>
            ))}
          </fieldset>
        ) : (
          <p class="meta">{nextIsSet(offer.next)} It releases with patch.</p>
        )}
        {error && (
          <p class="field-error" role="alert">
            {error}
          </p>
        )}
        <div class="sheet-actions">
          <button type="button" class="btn btn-quiet" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" class="btn btn-primary" disabled={busy} aria-busy={busy}>
            Release {offer.stable}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Release beside one pre-release (`v`, a Packages feed version with its `release` offer), or why it can't: its stable
 * is out (superseded, with a link to it), or the board's GitHub App can't start workflows. Nothing without an offer.
 * `versions` are the feed's, to link the stable.
 * @param {Record<string, any>} props
 */
export function PackageRelease({ v, versions = [] }) {
  const [open, setOpen] = useState(false);
  const offer = v.release;
  if (!offer) return null;
  if (offer.superseded) {
    const s = offer.superseded;
    const stable = versions.find((x) => x.repo === v.repo && x.name === v.name && x.version === s.version);
    return (
      <span class="meta pkg-superseded">
        Superseded:{' '}
        {stable?.url ? (
          <a href={stable.url} {...ext}>
            {s.version}
          </a>
        ) : (
          s.version
        )}{' '}
        is out{s.from ? `, from ${shortPre(s.from)}` : ''}
      </span>
    );
  }
  const actions = githubRepoFacts(v.repo)?.access?.actions ?? { ok: true, reason: null };
  const reason = `pkg-release-why-${v.repo}-${v.version}`.replace(/[^\w-]/gu, '-');
  return (
    <span class="pkg-release">
      <button
        type="button"
        class="btn btn-outline btn-sm"
        disabled={!actions.ok}
        aria-label={`Release ${v.name}@${v.version} as ${offer.stable}`}
        aria-describedby={actions.ok ? undefined : reason}
        onClick={() => setOpen(true)}
      >
        Release…
      </button>
      {!actions.ok && (
        <span id={reason} class="meta">
          {actions.reason}
        </span>
      )}
      {open && <ReleaseDialog v={v} onClose={() => setOpen(false)} />}
    </span>
  );
}

/**
 * Why pre-releases have no Release, and where to turn it on (WEB-81): one line for each repository in view whose
 * pipeline names no npm package, linking to its settings, where the release flow takes one. `view` is the GitHub
 * view's (scopeGitHub). Nothing when every repository in view has Release, or has no pre-release it would offer.
 * @param {Record<string, any>} props
 */
export function ReleaseSetup({ view }) {
  const setups = releaseSetups(view);
  if (!setups.length) return null;
  return setups.map((r) => (
    <p key={r.slug} class="meta pkg-setup">
      To release {r.packages.length === 1 ? 'a pre-release' : 'pre-releases'} of{' '}
      {r.packages.map((name, i) => (
        <span key={name}>
          {i > 0 && (i === r.packages.length - 1 ? ' or ' : ', ')}
          <code>{name}</code>
        </span>
      ))}{' '}
      as stable from here, name the npm package in the release flow in{' '}
      <a href={repoSettingsHref(r.slug)}>{r.name}’s settings</a>. Then each pre-release has Release.
    </p>
  ));
}
