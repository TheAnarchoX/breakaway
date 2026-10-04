import {
  FileText,
  GitPullRequest,
  Hourglass,
  Link2,
  MessageSquare,
  MessageCircleQuestion,
  Rocket,
  TriangleAlert,
} from 'lucide-preact';
import {
  HORIZON_LABEL,
  PICKS_AREA,
  PRIORITY_LABEL,
  day,
  mainPr,
  picksArea,
  ref,
  shipState,
  shortVersion,
} from '../lib/model.js';
import { PrBadge } from './GitHub.jsx';
import { AgentBadge } from './Agents.jsx';
import { areaLabel, byUuid, current, hashFor } from '../lib/store.js';
import { ClaimChip, RepoChip, RoleTags, widClass } from './ui.jsx';
import { Title } from '../lib/richtext.jsx';

/**
 * One task as a link that opens it. `hide` drops meta the surrounding view already shows
 * (the swimlane's horizon or area).
 * @param {Record<string, any>} props
 */
export function TaskCard({ task: t, hide = [], compact = false }) {
  const open = current.value?.uuid === t.uuid;
  const waits = t.blockedBy.length;
  const holds = t.blocking.length;
  const blockers = t.blockedBy
    .map((u) => byUuid.value.get(u))
    .filter(Boolean)
    .map(ref)
    .join(', ');
  return (
    <a
      class={`card-task ${open ? 'is-open' : ''} ${t.status === 'completed' ? 'is-done' : ''}`}
      href={hashFor({ task: ref(t) })}
      aria-current={open ? 'true' : undefined}
      data-task={t.uuid}
      data-task-menu={t.uuid}
    >
      <span class="card-top">
        <span class={widClass(t)}>{ref(t)}</span>
        <RepoChip slug={t.repo} />
        {t.priority && (
          <span class={`prio prio-${t.priority}`}>
            {PRIORITY_LABEL[t.priority]}
            <span class="visually-hidden"> priority</span>
          </span>
        )}
        <AgentBadge task={t} />
        <ClaimChip task={t} compact />
      </span>
      <span class="card-title">
        <Title text={t.description} />
      </span>
      {!compact && (
        <span class="card-meta">
          {!hide.includes('area') && t.project && <span class="meta">{areaLabel(t.project)}</span>}
          {!hide.includes('area') && picksArea(t) && <span class="meta">{PICKS_AREA}</span>}
          {!hide.includes('horizon') && t.horizon && <span class="meta">{HORIZON_LABEL[t.horizon]}</span>}
          <RoleTags tags={t.tags} />
        </span>
      )}
      {!compact &&
      (waits ||
        holds ||
        t.comments.length ||
        t.spec ||
        t.pr ||
        t.waiting ||
        mainPr(t) ||
        shipState(t) ||
        t.decision) ? (
        <span class="card-foot">
          <PrBadge pr={mainPr(t)} />
          {t.shipped && (
            <span class="foot-item" title={`Live in ${t.shipped.env} ${t.shipped.version ?? t.shipped.sha}`}>
              <Rocket size={14} aria-hidden="true" />
              Live {shortVersion(t.shipped)}
            </span>
          )}
          {shipState(t) === 'staged' && (
            <span class="foot-item" title={`On staging in ${t.staged.version ?? t.staged.sha}; not live yet`}>
              <Rocket size={14} aria-hidden="true" />
              On staging {shortVersion(t.staged)}
            </span>
          )}
          {shipState(t) === 'unshipped' && (
            <span class="foot-item" title="Merged; staging doesn't run it yet">
              <Rocket size={14} aria-hidden="true" />
              Merged
            </span>
          )}
          {shipState(t) === 'nodeploy' && (
            <span class="foot-item" title="Merged; it changes nothing that runs in production, so no deploy is needed">
              <Rocket size={14} aria-hidden="true" />
              No deploy needed
            </span>
          )}
          {t.decision && (
            <span
              class="foot-item"
              title={
                t.decisionAnswers && t.status === 'completed'
                  ? 'Decided'
                  : `${t.decision.length} question${t.decision.length === 1 ? '' : 's'} for the owner`
              }
            >
              <MessageCircleQuestion size={14} aria-hidden="true" />
              {t.decisionAnswers && t.status === 'completed'
                ? 'Decided'
                : `${t.decision.length} question${t.decision.length === 1 ? '' : 's'}`}
            </span>
          )}
          {waits > 0 && (
            <span class="foot-item foot-warn" title={`Waits for ${blockers}`}>
              <TriangleAlert size={14} aria-hidden="true" />
              Waits for {blockers}
            </span>
          )}
          {t.waiting && (
            <span class="foot-item" title="Waiting for a date">
              <Hourglass size={14} aria-hidden="true" />
              Until {day(t.wait)}
            </span>
          )}
          {holds > 0 && (
            <span class="foot-item" title="Other tasks wait for this one">
              <Link2 size={14} aria-hidden="true" />
              Holds up {holds}
            </span>
          )}
          {t.comments.length > 0 && (
            <span class="foot-item" title={`${t.comments.length} comments`}>
              <MessageSquare size={14} aria-hidden="true" />
              {t.comments.length}
              <span class="visually-hidden"> comments</span>
            </span>
          )}
          {t.spec && (
            <span class="foot-item" title="Has a spec">
              <FileText size={14} aria-hidden="true" />
              <span class="visually-hidden">Spec</span>
            </span>
          )}
          {t.pr && !mainPr(t) && (
            <span class="foot-item" title="Has a pull request">
              <GitPullRequest size={14} aria-hidden="true" />
              <span class="visually-hidden">Pull request</span>
            </span>
          )}
        </span>
      ) : null}
    </a>
  );
}
