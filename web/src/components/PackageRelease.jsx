import { useState } from 'preact/hooks';
import { TriangleAlert } from 'lucide-preact';
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
