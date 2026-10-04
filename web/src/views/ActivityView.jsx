import { useEffect, useRef, useState } from 'preact/hooks';
import {
  Activity,
  Archive,
  CircleCheck,
  CirclePlus,
  Hand,
  MessageSquare,
  Pencil,
  RotateCcw,
  Terminal,
  Trash2,
  Undo2,
  Globe,
  Hash,
  CircleAlert,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  CircleX,
  Repeat,
  Rocket,
  ShieldAlert,
  ShieldCheck,
  ThumbsUp,
  MessageSquareWarning,
  Bot,
} from 'lucide-preact';
import { TRIGGER_LABEL } from '../components/Agents.jsx';
import {
  BarList,
  Columns,
  DailyChart,
  DeployStrip,
  Delta,
  Gauge,
  Heatmap,
  Sparkline,
  SplitBar,
  dayName,
  duration,
  percent,
  useCountUp,
} from '../components/Charts.jsx';
import { RepoChip, Segmented } from '../components/ui.jsx';
import { AREA_LABEL, ago, day, plural, time } from '../lib/model.js';
import {
  activity,
  hashFor,
  inScope,
  loadActivity,
  loadStats,
  multiRepo,
  navOrder,
  repoName,
  repoScope,
  stats,
  statsDays,
} from '../lib/store.js';
import { Inline, Title } from '../lib/richtext.jsx';

const ICONS = {
  created: CirclePlus,
  done: CircleCheck,
  reopened: RotateCcw,
  deleted: Trash2,
  purged: Trash2,
  claimed: Hand,
  released: Undo2,
  note: MessageSquare,
  changed: Pencil,
  numbered: Hash,
  'horizon-closed': Archive,
  unreadable: CircleAlert,
  pr_opened: GitPullRequest,
  pr_ready: GitPullRequest,
  pr_merged: GitMerge,
  pr_closed: GitPullRequestClosed,
  pr_published: GitPullRequest,
  pr_branch_updated: GitPullRequest,
  pr_merged_by_owner: GitMerge,
  pr_auto_merge_on: GitMerge,
  pr_auto_merge_off: GitPullRequestClosed,
  promote_started: Rocket,
  rollback_started: Undo2,
  release_started: Rocket,
  ci_failed: CircleX,
  ci_fixed: CircleCheck,
  main_failed: CircleX,
  dependabot_failed: CircleX,
  review_approved: ThumbsUp,
  review_changes: MessageSquareWarning,
  alert_opened: ShieldAlert,
  alert_closed: ShieldCheck,
  deployed: Rocket,
  rolled_back: Undo2,
  deploy_failed: CircleX,
  agent_started: Bot,
  agent_failed: CircleX,
  trigger_refused: CircleX,
  trigger_noted: MessageSquare,
  trigger_waiting: Repeat,
  chase_started: Bot,
  chase_stopped: Bot,
  chase_stalled: CircleAlert,
  chase_ended: CircleCheck,
};

const SOURCES = {
  taskwarrior: { icon: Terminal, text: 'From Taskwarrior (task sync)' },
  github: { icon: GitPullRequest, text: 'From GitHub' },
  agents: { icon: Bot, text: 'From the board’s agents' },
  routines: { icon: Repeat, text: 'From a routine’s trigger' },
  api: { icon: Globe, text: 'From the board or the API' },
};

function list(words) {
  if (words.length < 2) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

function describe(change) {
  switch (change.kind) {
    case 'created':
      return 'Added';
    case 'done':
      return 'Finished';
    case 'reopened':
      return 'Opened again';
    case 'deleted':
      return 'Deleted';
    case 'purged':
      return 'Removed from the history';
    case 'claimed':
      return `Claimed by ${change.by}`;
    case 'released':
      return 'Released';
    case 'note':
      return 'Note';
    case 'changed':
      return `Changed the ${list(change.fields)}`;
    case 'horizon-closed':
      return `You closed now: ${change.archived} archived, ${change.movedUp} moved up`;
    case 'numbered':
      return `Got its work ID, ${change.wid}`;
    case 'agent_started':
      return `Agent ${change.by ?? ''} ${TRIGGER_LABEL[change.trigger] ?? 'started'}${change.forced ? ', forced past the board’s limits' : ''}`.replace(
        '  ',
        ' ',
      );
    case 'agent_failed':
      return `Couldn’t start an agent: ${change.error ?? 'unknown error'}`;
    case 'trigger_refused':
      return `A trigger for ${change.routine} was turned away: ${change.detail ?? 'refused'}`;
    case 'trigger_noted':
      return `A trigger for ${change.routine} was noted on its open run`;
    case 'trigger_waiting':
      return `A trigger for ${change.routine} made a run that waits for your Start`;
    case 'chase_started':
      return `You started a chase on ${change.feature}`;
    case 'chase_stopped':
      return `You stopped the chase on ${change.feature}`;
    case 'chase_stalled':
      return change.detail ?? `The chase on ${change.feature} waits for you`;
    case 'chase_ended':
      return `The chase on ${change.feature} ended: ${change.detail ?? 'every task is done or in review'}`;
    case 'pr_opened':
      return `${change.draft ? 'Draft pull request' : 'Pull request'} #${change.number} opened${change.by ? ` by ${change.by}` : ''}`;
    case 'pr_ready':
      return `#${change.number} is ready for review`;
    case 'pr_merged':
      return `#${change.number} merged`;
    case 'pr_published':
      return `You published #${change.number} for review`;
    case 'pr_branch_updated':
      return change.setting
        ? `Keep branches up to date updated #${change.number} with main`
        : `You updated #${change.number} with main`;
    case 'pr_merged_by_owner':
      return `${change.setting ? 'Merge when green (your setting) merged' : 'You merged'} #${change.number} (${change.method === 'squash' ? 'squash' : 'merge commit'})`;
    case 'pr_auto_merge_on':
      return `${change.setting ? 'Merge when green (your setting) set' : 'You set'} #${change.number} to merge when green (${change.method === 'squash' ? 'squash' : 'merge commit'})`;
    case 'pr_auto_merge_off':
      return `You turned off merge when green on #${change.number}`;
    case 'promote_started':
      return `You promoted ${change.sha7} to production${change.tasks?.length ? ` (${change.tasks.join(', ')})` : ''}`;
    case 'rollback_started':
      return `You rolled production back${change.version ? ` to ${change.version.slice(0, 8)}` : ''}: ${change.reason}`;
    case 'release_started':
      return `You released ${change.package}@${change.prerelease} as ${change.version}: it waits on npm for your approval`;
    case 'pr_closed':
      return `#${change.number} closed without merging`;
    case 'ci_failed':
      return `Checks failing on #${change.number}${change.failing?.length ? `: ${change.failing.join(', ')}` : ''}`;
    case 'ci_fixed':
      return `Checks passing again on #${change.number}`;
    case 'review_approved':
      return `#${change.number} approved`;
    case 'review_changes':
      return `Changes requested on #${change.number}`;
    case 'deployed':
    case 'rolled_back':
    case 'deploy_failed':
    case 'main_failed':
    case 'dependabot_failed':
    case 'alert_opened':
    case 'alert_closed':
      return change.title;
    default:
      return 'A change the server can’t read';
  }
}

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return day(iso);
}

// ---- the dashboard -------------------------------------------------------------------------------

const PERIODS = [
  { id: '7', label: '7 days' },
  { id: '30', label: '30 days' },
  { id: '90', label: '90 days' },
];
const KIND_LABEL = {
  build: 'Builds',
  refine: 'Refines',
  review: 'Reviews',
  'fix-pr': 'Pull request fixes',
  'pr-review': 'Pull request reviews',
  routine: 'Routine runs',
};
const WHO = [
  { key: 'claude', label: 'Claude agents' },
  { key: 'owner', label: 'You' },
  { key: 'other', label: 'Others' },
  { key: 'none', label: 'Unclaimed' },
];

const decimal = (n) => (n >= 10 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/u, ''));

/** @param {Record<string, any>} props */
function Card({ title, kicker, className = '', children, aside }) {
  return (
    <section class={`dash-card ${className}`} aria-label={title}>
      <header class="dash-card-head">
        <div>
          {kicker && <p class="kicker">{kicker}</p>}
          <h2>{title}</h2>
        </div>
        {aside}
      </header>
      {children}
    </section>
  );
}

/** @param {Record<string, any>} props */
function Tile({ label, value, before, days, spark, foot, better }) {
  const shown = useCountUp(value);
  return (
    <section class="tile" aria-label={label}>
      <h2 class="tile-label">{label}</h2>
      <div class="tile-number">
        <span class="tile-value">{Math.round(shown)}</span>
        <Delta now={value} before={before} days={days} better={better} />
      </div>
      <Sparkline values={spark} />
      {foot && <p class="tile-foot">{foot}</p>}
    </section>
  );
}

/** @param {Record<string, any>} props */
function Fact({ label, value, children }) {
  return (
    <div class="pace-fact">
      <dt>{label}</dt>
      <dd>
        <strong>{value}</strong>
        {children}
      </dd>
    </div>
  );
}

/** @param {Record<string, any>} props */
function Dashboard({ data }) {
  const days = data.period.days;
  const covered = data.period.covered ?? days;
  const t = data.totals;
  const series = (key) => data.daily.map((d) => d[key]);
  const nowH = data.open.horizons.now;
  const nowTotal = nowH.open + nowH.done;
  const ran = data.agents.runs - data.agents.failed;
  const ci = data.checks.passed + data.checks.failed;
  const main = data.checks.main.passed + data.checks.main.failed;
  const deploys = ['staging', 'production'].reduce(
    (n, env) => n + data.deploys[env].landed + data.deploys[env].failed + data.deploys[env].rollbacks,
    0,
  );
  const deploysOk = deploys - data.deploys.staging.failed - data.deploys.production.failed;
  return (
    <div class="dash">
      {!data.github && (
        <p class="dash-note">
          GitHub isn’t connected, so pull requests, checks, and deploys show nothing yet. Connect it on the GitHub view.
        </p>
      )}
      <div class="tiles">
        <Tile
          label="Tasks finished"
          value={t.finished.now}
          before={t.finished.before}
          days={days}
          spark={series('finished')}
          foot={`${decimal(data.pace.perDay)} a day`}
        />
        <Tile
          label="Pull requests merged"
          value={t.merged.now}
          before={t.merged.before}
          days={days}
          spark={series('merged')}
          foot={
            data.mergeTime.median !== null
              ? `${duration(data.mergeTime.median)} to merge, typically`
              : 'None merged yet'
          }
        />
        <Tile
          label="Production deploys"
          value={t.deploys.now}
          before={t.deploys.before}
          days={days}
          spark={series('deploys')}
          foot={data.deploys.lastProduction ? `Last one ${ago(data.deploys.lastProduction)}` : 'None recorded yet'}
        />
        <Tile
          label="Agent runs"
          value={t.agentRuns.now}
          before={t.agentRuns.before}
          days={days}
          spark={series('agentRuns')}
          foot={`${plural(data.agents.finished, 'task')} finished from them`}
        />
        <Tile
          label="Tasks added"
          value={t.added.now}
          before={t.added.before}
          days={days}
          spark={series('added')}
          foot={`${data.open.open} open now`}
        />
      </div>

      <div class="dash-grid">
        <Card title="Every day" className="span-8">
          <DailyChart daily={data.daily} />
        </Card>

        <Card title="Pace" className="span-4">
          <div class="pace">
            <div class="pace-big">
              <span class="pace-value">{decimal(data.pace.perDay)}</span>
              <span class="pace-unit">tasks a day</span>
              <Delta now={data.pace.perDay} before={data.pace.perDayBefore} days={days} />
            </div>
            <dl class="pace-facts">
              <Fact label="Days in a row with a finished task" value={data.pace.streak} />
              <Fact label="Longest run in the period" value={plural(data.pace.bestStreak, 'day')} />
              <Fact label="Busiest day" value={data.pace.busiest ? dayName(data.pace.busiest.day) : '–'}>
                {data.pace.busiest && <span class="muted"> · {plural(data.pace.busiest.finished, 'task')}</span>}
              </Fact>
              <Fact label="Days with a finished task" value={`${data.pace.activeDays} of ${covered}`} />
            </dl>
          </div>
        </Card>

        <Card title="How it’s running" className="span-12">
          <div class="gauges">
            <Gauge
              rate={data.checks.rate}
              label="Checks passing"
              detail={ci ? `${data.checks.passed} of ${plural(ci, 'run')}` : 'No runs yet'}
            />
            <Gauge
              rate={data.checks.main.rate}
              label="Main passing"
              detail={main ? `${data.checks.main.passed} of ${plural(main, 'run')}` : 'No runs yet'}
            />
            <Gauge
              rate={data.deploys.rate}
              label="Deploys landed"
              detail={deploys ? `${deploysOk} of ${deploys}` : 'None yet'}
            />
            <Gauge
              rate={data.agents.startRate}
              label="Agents started"
              detail={data.agents.runs ? `${ran} of ${plural(data.agents.runs, 'run')}` : 'No runs yet'}
            />
            <Gauge
              rate={data.agents.finishRate}
              tone="neutral"
              label="Agent builds finished"
              detail={data.agents.builds ? `${data.agents.finished} of ${data.agents.builds} tasks` : 'No builds yet'}
            />
            <Gauge
              rate={data.routines.rate}
              label="Routines ran"
              detail={
                data.routines.runs
                  ? `${data.routines.runs - data.routines.failed} of ${plural(data.routines.runs, 'run')}`
                  : 'No runs yet'
              }
            />
          </div>
        </Card>

        <Card title="How long it takes" className="span-7">
          <dl class="durations">
            <div>
              <dt>Added to done</dt>
              <dd>
                <strong>{duration(data.leadTime.median)}</strong>{' '}
                <Delta
                  now={data.leadTime.median}
                  before={data.leadTime.medianBefore}
                  days={days}
                  better="down"
                  unit="time"
                />
              </dd>
              <dd class="muted">
                {data.leadTime.p90 !== null ? `9 in 10 within ${duration(data.leadTime.p90)}` : 'Nothing finished yet'}
              </dd>
            </div>
            <div>
              <dt>Pull request to merge</dt>
              <dd>
                <strong>{duration(data.mergeTime.median)}</strong>{' '}
                <Delta
                  now={data.mergeTime.median}
                  before={data.mergeTime.medianBefore}
                  days={days}
                  better="down"
                  unit="time"
                />
              </dd>
              <dd class="muted">
                {plural(data.mergeTime.count, 'pull request')}
                {data.mergeTime.authors.dependabot ? `, ${data.mergeTime.authors.dependabot} from Dependabot` : ''}
              </dd>
            </div>
            <div>
              <dt>Done to production</dt>
              <dd>
                <strong>{duration(data.shipTime.median)}</strong>
              </dd>
              <dd class="muted">{plural(data.shipTime.count, 'task')} shipped</dd>
            </div>
          </dl>
          <Columns buckets={data.leadTime.buckets} label="Tasks by how long they took from added to done" />
        </Card>

        <Card title="Open now" className="span-5">
          <div class="open-now">
            <Gauge
              rate={nowTotal ? nowH.done / nowTotal : null}
              tone="neutral"
              label="Now horizon"
              detail={nowTotal ? `${nowH.done} of ${nowTotal} done` : 'Nothing in now'}
            />
            <dl class="counts">
              <div>
                <dt>Ready</dt>
                <dd>{data.open.ready}</dd>
              </div>
              <div>
                <dt>In progress</dt>
                <dd>{data.open.claimed}</dd>
              </div>
              <div>
                <dt>Blocked</dt>
                <dd>{data.open.blocked}</dd>
              </div>
              <div>
                <dt>Need a decision</dt>
                <dd>{data.open.decide}</dd>
              </div>
              <div>
                <dt>Pull requests open</dt>
                <dd>
                  {data.open.prs}
                  {data.open.drafts ? <span class="muted"> + {data.open.drafts} drafts</span> : null}
                </dd>
              </div>
              <div>
                <dt>Security alerts</dt>
                <dd>{data.open.alerts}</dd>
              </div>
              <div>
                <dt>Next</dt>
                <dd>{data.open.horizons.next.open}</dd>
              </div>
              <div>
                <dt>Later</dt>
                <dd>{data.open.horizons.later.open}</dd>
              </div>
            </dl>
          </div>
        </Card>

        <Card title="Who finished the work" className="span-6">
          <SplitBar
            label="Tasks finished, by who had them"
            parts={WHO.map((w) => ({ ...w, value: data.who[w.key] }))}
          />
          {data.agents.runs > 0 && (
            <>
              <h3 class="dash-sub">Agent runs, by kind</h3>
              <ul class="chips">
                {Object.entries(data.agents.kinds)
                  .sort((a, b) => b[1] - a[1])
                  .map(([kind, n]) => (
                    <li key={kind}>
                      <span>{KIND_LABEL[kind] ?? kind}</span>
                      <strong>{n}</strong>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </Card>

        <Card title="By area" className="span-6">
          {data.areas.length ? (
            <BarList
              label="Tasks finished, by area"
              rows={data.areas.map((a) => ({
                key: a.project,
                label: AREA_LABEL[a.project] ?? 'No area',
                value: a.finished,
                note: a.open ? `${a.open} open` : null,
              }))}
            />
          ) : (
            <p class="muted">No tasks yet.</p>
          )}
        </Card>

        <Card title="When work lands" className="span-6">
          <Heatmap punch={data.punch} />
        </Card>

        <Card
          title="Deploys"
          className="span-6"
          aside={data.deploys.lastProduction && <span class="meta">Production {ago(data.deploys.lastProduction)}</span>}
        >
          <DeployStrip recent={data.deploys.recent} from={data.period.from} to={data.period.to} />
          <dl class="counts counts-row">
            <div>
              <dt>To staging</dt>
              <dd>
                {data.deploys.staging.landed}
                {data.deploys.staging.failed ? (
                  <span class="tone-bad"> · {data.deploys.staging.failed} failed</span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>To production</dt>
              <dd>
                {data.deploys.production.landed}
                {data.deploys.production.failed ? (
                  <span class="tone-bad"> · {data.deploys.production.failed} failed</span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>Rollbacks</dt>
              <dd>{data.deploys.production.rollbacks + data.deploys.staging.rollbacks}</dd>
            </div>
          </dl>
        </Card>

        <Card title="Checks by workflow" className="span-7">
          {data.checks.workflows.length ? (
            <table class="table wf-table">
              <thead>
                <tr>
                  <th scope="col">Workflow</th>
                  <th scope="col">Runs</th>
                  <th scope="col">Passing</th>
                  <th scope="col">Typical time</th>
                </tr>
              </thead>
              <tbody>
                {data.checks.workflows.slice(0, 8).map((w) => (
                  <tr key={w.name}>
                    <th scope="row">{w.name}</th>
                    <td>{w.runs}</td>
                    <td>
                      <span class="wf-rate">
                        <span class="wf-track" aria-hidden="true">
                          <span
                            class={`wf-fill ${w.rate >= 0.9 ? 'tone-good' : w.rate >= 0.7 ? 'tone-ok' : 'tone-bad'}`}
                            style={{ width: `${(w.rate ?? 0) * 100}%` }}
                          />
                        </span>
                        {percent(w.rate)}
                      </span>
                    </td>
                    <td>{duration(w.duration)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p class="muted">No finished workflow runs in this period.</p>
          )}
        </Card>

        <Card title="Routines" className="span-5">
          {data.routines.list.length ? (
            <BarList
              label="Routine runs"
              rows={data.routines.list.map((r) => ({
                key: r.slug,
                label: r.slug,
                value: r.runs,
                note: r.failed ? `${r.failed} failed` : null,
              }))}
            />
          ) : (
            <p class="muted">No routine ran in this period.</p>
          )}
        </Card>
      </div>
    </div>
  );
}

// ---- the stream ----------------------------------------------------------------------------------

/** How many changes the stream shows at first, and how many more each press adds. */
const STREAM_FIRST = 25;
const STREAM_MORE = 40;

function Stream() {
  const state = activity.value;
  const [limit, setLimit] = useState(STREAM_FIRST);
  const more = () => {
    setLimit(limit + STREAM_MORE);
    if (state.next && state.events.length < limit + STREAM_MORE) loadActivity({ more: true });
  };
  // The switcher's repository: a change to one of its tasks, or a GitHub event in it. Install-wide changes (a horizon closed) always show.
  const repoOf = (e) => e.task?.repo ?? e.changes.find((c) => c.repo)?.repo ?? null;
  const shown = repoScope.value ? state.events.filter((e) => !repoOf(e) || inScope(repoOf(e))) : state.events;
  const days = [];
  for (const e of shown.slice(0, limit)) {
    const label = dayLabel(e.at);
    if (days.at(-1)?.label !== label) days.push({ label, events: [] });
    days.at(-1).events.push(e);
  }
  return (
    <section class="stream" aria-labelledby="stream-title">
      <header class="stream-head">
        <h2 id="stream-title">
          <Activity size={18} aria-hidden="true" /> Latest changes
        </h2>
        <p class="muted small">
          From the board and agents (<Globe size={13} aria-hidden="true" />
          ), Taskwarrior (<Terminal size={13} aria-hidden="true" />
          ), and GitHub (<GitPullRequest size={13} aria-hidden="true" />
          ).
        </p>
      </header>
      {state.error && <p class="field-error">{state.error}</p>}
      {!state.loaded && !state.error && (
        <p class="muted" aria-busy="true">
          Loading activity…
        </p>
      )}
      {state.loaded && !shown.length && (
        <p class="muted">
          {repoScope.value && state.events.length
            ? `No changes in ${repoName(repoScope.value)} lately. Load more, or switch to every repository.`
            : 'Changes show here as soon as anyone makes one.'}
        </p>
      )}
      {days.map((d) => (
        <section key={d.label} class="activity-day" aria-label={d.label}>
          <h3 class="activity-day-head">{d.label}</h3>
          <ol class="events">
            {d.events.map((e) => (
              <li key={e.id ?? `${e.seq}-${e.task?.uuid}`} class={`event event-${e.source}`}>
                <span class="event-time">{time(e.at)}</span>
                {(() => {
                  const source = SOURCES[e.source] ?? SOURCES.api;
                  const Icon = source.icon;
                  return (
                    <span class="event-source" title={source.text}>
                      <Icon size={15} aria-hidden="true" />
                      <span class="visually-hidden">{source.text}</span>
                    </span>
                  );
                })()}
                <div class="event-body">
                  {e.task ? (
                    <a class="event-task" href={hashFor({ task: e.task.wid ?? e.task.uuid.slice(0, 8) })}>
                      <span class="wid">{e.task.wid ?? e.task.uuid.slice(0, 8)}</span>
                      <RepoChip slug={e.task.repo} />
                      <span class={`event-title${e.task.status === 'gone' ? ' muted' : ''}`}>
                        <Title text={e.task.description} />
                      </span>
                    </a>
                  ) : null}
                  <ul class="event-changes">
                    {e.changes.map((c, i) => {
                      const Icon = ICONS[c.kind] ?? Pencil;
                      return (
                        <li key={i} class={`change change-${c.kind}`}>
                          <Icon size={15} aria-hidden="true" />
                          <span>
                            {c.url ? (
                              <a href={c.url} target="_blank" rel="noopener noreferrer">
                                {describe(c)}
                              </a>
                            ) : (
                              describe(c)
                            )}
                            {c.kind === 'note' && (
                              <>
                                :{' '}
                                <q class="note-quote">
                                  <Inline text={c.text} />
                                </q>
                              </>
                            )}
                            {c.kind?.startsWith('pr_') && c.title && (
                              <>
                                {' '}
                                · <Title text={c.title} />
                              </>
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
      {(state.next || shown.length > limit) && (
        <p class="board-more">
          <button type="button" class="btn btn-outline btn-sm" disabled={state.loading} onClick={more}>
            {state.loading ? 'Loading…' : 'Show more changes'}
          </button>
        </p>
      )}
    </section>
  );
}

export function ActivityView() {
  const s = stats.value;
  useEffect(() => {
    if (!activity.value.loaded) loadActivity();
    loadStats();
    navOrder.value = [];
  }, []);
  // The switcher picks whose numbers these are.
  const scope = repoScope.value;
  const counted = useRef(scope);
  useEffect(() => {
    if (counted.current === scope) return;
    counted.current = scope;
    loadStats();
  }, [scope]);
  const choose = (days) => {
    if (days === statsDays.value) return;
    statsDays.value = days;
    loadStats();
  };

  return (
    <div class="activity-view">
      <div class="activity-head">
        <div class="view-intro">
          <h1>Activity</h1>
          <p class="muted">
            How fast the work moves: tasks, pull requests, deploys, agents, and routines, then every change as it
            happens.
          </p>
        </div>
        <div class="activity-period">
          <Segmented label="Period" options={PERIODS} value={statsDays.value} onChange={choose} />
          {s.data && (
            <span class="meta" aria-live="polite">
              {s.loading
                ? 'Updating…'
                : `${day(`${s.data.period.from}T12:00:00`)} to today${
                    s.data.period.covered < s.data.period.days
                      ? ` · ${plural(s.data.period.covered, 'day')} so far`
                      : ''
                  }`}
            </span>
          )}
        </div>
      </div>
      <div class="activity-layout">
        <div class="activity-main">
          {s.error && <p class="field-error">Couldn’t load the numbers: {s.error}</p>}
          {!s.data && !s.error && (
            <p class="muted" aria-busy="true">
              Counting…
            </p>
          )}
          {s.data && multiRepo.value && (
            <p class="meta">
              {scope ? `These numbers count ${repoName(scope)}.` : 'These numbers count every repository.'}
            </p>
          )}
          {s.data && <Dashboard data={s.data} />}
        </div>
        <Stream />
      </div>
    </div>
  );
}
