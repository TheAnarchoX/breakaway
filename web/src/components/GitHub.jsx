import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  FileDiff,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  LoaderCircle,
  MessageSquare,
  MessageSquareWarning,
  ThumbsUp,
} from 'lucide-preact';
import { hashFor, openPull, pullParam } from '../lib/store.js';
import { Title } from '../lib/richtext.jsx';
import { RepoChip } from './ui.jsx';

export function prStateLabel(p) {
  if (p.state === 'merged') return 'Merged';
  if (p.state === 'closed') return 'Closed';
  return p.draft ? 'Draft' : 'Open';
}

/** @param {Record<string, any>} props */
export function PrIcon({ pr, size = 16 }) {
  const Icon =
    pr.state === 'merged'
      ? GitMerge
      : pr.state === 'closed'
        ? GitPullRequestClosed
        : pr.draft
          ? GitPullRequestDraft
          : GitPullRequest;
  return <Icon size={size} aria-hidden="true" class={`pr-icon pr-${pr.state}${pr.draft ? ' pr-draft' : ''}`} />;
}

/** GitHub's own words for what the verdict means, and what the owner can do about it. */
export const VERDICT = {
  ready: { label: 'Ready to merge', hint: 'Checks pass and the branch is up to date with main.', tone: 'ok' },
  conflicts: {
    label: 'Has conflicts',
    hint: 'It can’t merge into main until the conflicts are resolved.',
    tone: 'bad',
  },
  failing: { label: 'Checks failing', hint: 'At least one check failed.', tone: 'bad' },
  behind: {
    label: 'Behind main',
    hint: 'main has moved on; the branch needs updating before it can merge.',
    tone: 'warn',
  },
  running: { label: 'Checks running', hint: 'Waiting for the checks to finish.', tone: 'warn' },
  review: { label: 'Waiting on review', hint: 'GitHub is holding it for a review or a required rule.', tone: 'warn' },
  unknown: {
    label: 'Checking with GitHub',
    hint: 'GitHub is still working out whether it can merge. Reload in a moment.',
    tone: 'warn',
  },
  draft: { label: 'Draft', hint: 'A draft can’t be merged until it’s marked ready.', tone: 'muted' },
};

/** @param {Record<string, any>} props */
export function Verdict({ verdict, compact = false }) {
  const v = VERDICT[verdict];
  if (!v) return null;
  const Icon = v.tone === 'ok' ? CircleCheck : v.tone === 'bad' ? CircleX : v.tone === 'warn' ? LoaderCircle : FileDiff;
  return (
    <span class={`verdict verdict-${v.tone}`} title={v.hint}>
      <Icon size={compact ? 14 : 16} aria-hidden="true" />
      <span>{v.label}</span>
    </span>
  );
}

const CHECK_TEXT = {
  success: 'Checks passed',
  failure: 'Checks failing',
  pending: 'Checks running',
  none: 'No checks',
};

/**
 * The checks roll-up: an icon and, unless compact, "3 of 4 passed".
 * @param {Record<string, any>} props
 */
export function Checks({ checks, compact = false }) {
  if (!checks || checks.state === 'none') return compact ? null : <span class="gh-checks muted">No checks</span>;
  const Icon =
    checks.state === 'success'
      ? CircleCheck
      : checks.state === 'failure'
        ? CircleX
        : checks.state === 'pending'
          ? LoaderCircle
          : CircleDashed;
  const detail = `${checks.passed} of ${checks.total} passed`;
  return (
    <span class={`gh-checks checks-${checks.state}`} title={`${CHECK_TEXT[checks.state]}: ${detail}`}>
      <Icon size={compact ? 14 : 15} aria-hidden="true" />
      {compact ? <span class="visually-hidden">{CHECK_TEXT[checks.state]}</span> : <span>{detail}</span>}
    </span>
  );
}

const REVIEW = {
  approved: { icon: ThumbsUp, text: 'Approved' },
  changes_requested: { icon: MessageSquareWarning, text: 'Changes requested' },
  commented: { icon: MessageSquare, text: 'Commented' },
};

/** @param {Record<string, any>} props */
export function Review({ decision, compact = false }) {
  const r = REVIEW[decision];
  if (!r) return null;
  const Icon = r.icon;
  return (
    <span class={`gh-review review-${decision}`} title={r.text}>
      <Icon size={compact ? 14 : 15} aria-hidden="true" />
      {compact ? <span class="visually-hidden">{r.text}</span> : <span>{r.text}</span>}
    </span>
  );
}

/**
 * The card's mark for each verdict: an icon, and a word when it's something to act on, so a pull request with
 * conflicts never reads as green because its checks passed. A draft has none: the PR icon already says it.
 */
const CARD_VERDICT = {
  ready: { icon: CircleCheck },
  conflicts: { icon: CircleX, word: 'Conflicts' },
  failing: { icon: CircleX, word: 'Failing' },
  behind: { icon: CircleAlert, word: 'Behind' },
  running: { icon: LoaderCircle, spin: true },
  review: { icon: CircleAlert, word: 'Review' },
  unknown: { icon: CircleDashed, word: 'Checking' },
};

/**
 * What GitHub says about merging an open pull request, small enough for a card: the same verdict the GitHub page shows.
 * @param {Record<string, any>} props
 */
export function CardVerdict({ verdict }) {
  const mark = CARD_VERDICT[verdict];
  if (!mark) return null;
  const Icon = mark.icon;
  return (
    <span class={`card-verdict card-verdict-${VERDICT[verdict].tone}${mark.spin ? ' card-verdict-spin' : ''}`}>
      <Icon size={14} aria-hidden="true" />
      {mark.word ? <span>{mark.word}</span> : <span class="visually-hidden">{VERDICT[verdict].label}</span>}
    </span>
  );
}

/**
 * A task card's small PR mark: state, number, whether it can merge (or, without a verdict, its checks), and review.
 * Not a link (the card is one).
 * @param {Record<string, any>} props
 */
export function PrBadge({ pr }) {
  if (!pr) return null;
  const open = pr.state === 'open';
  const verdict = open ? VERDICT[pr.verdict] : null;
  return (
    <span
      class={`pr-badge pr-badge-${pr.state}${pr.draft ? ' pr-badge-draft' : ''}`}
      title={`Pull request #${pr.number}, ${prStateLabel(pr).toLowerCase()}${verdict && pr.verdict !== 'draft' ? `: ${verdict.label.toLowerCase()}. ${verdict.hint}` : ''}`}
    >
      <PrIcon pr={pr} size={14} />
      <span>#{pr.number}</span>
      {open && (pr.verdict ? <CardVerdict verdict={pr.verdict} /> : <Checks checks={pr.checks} compact />)}
      {pr.state === 'open' && <Review decision={pr.review?.decision ?? pr.review} compact />}
    </span>
  );
}

/**
 * One pull request as a row: state, title, branch, author, checks, review, and its tasks (and its repository, when there are several).
 * @param {Record<string, any>} props
 */
export function PrRow({ pr, showTasks = true, note }) {
  const decision = pr.review?.decision ?? pr.review;
  return (
    <li class="gh-pr">
      <PrIcon pr={pr} size={18} />
      <div class="gh-pr-main">
        <a
          class="gh-pr-title"
          href={hashFor({ view: 'github', task: null, pr: pullParam(pr.number, pr.repo) })}
          onClick={(e) => {
            if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
              e.preventDefault();
              openPull(pr.number, pr.repo);
            }
          }}
        >
          <span class="gh-num">#{pr.number}</span> <Title text={pr.title} />
        </a>
        <span class="gh-pr-meta">
          {pr.repo && <RepoChip slug={pr.repo} />}
          {pr.state === 'open' && pr.verdict ? (
            <Verdict verdict={pr.verdict} compact />
          ) : (
            <span class={`gh-state gh-state-${pr.state}${pr.draft ? ' gh-state-draft' : ''}`}>{prStateLabel(pr)}</span>
          )}
          {pr.branch && <code class="gh-branch">{pr.branch}</code>}
          {pr.author && <span class="meta">by {pr.author}</span>}
          {note && <span class="meta">{note}</span>}
        </span>
        {(pr.state === 'open' || pr.checks?.state === 'failure') && (
          <span class="gh-pr-status">
            <Checks checks={pr.checks} />
            <Review decision={decision} />
          </span>
        )}
        {showTasks && pr.tasks?.length > 0 && (
          <span class="gh-pr-tasks">
            {pr.tasks.map((t) => (
              <a
                key={t.uuid}
                class={`gh-task ${t.closes ? 'gh-task-closes' : ''}`}
                href={hashFor({ task: t.wid ?? t.uuid.slice(0, 8) })}
                title={t.closes ? `Closes ${t.wid}` : `Mentions ${t.wid}`}
              >
                <span class="wid">{t.wid}</span>
                <span class="gh-task-kind">{t.closes ? 'closes' : 'mentions'}</span>
              </a>
            ))}
          </span>
        )}
      </div>
    </li>
  );
}
