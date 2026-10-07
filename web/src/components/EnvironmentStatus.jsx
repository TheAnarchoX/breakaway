import { Activity, Bot, Eye, FileDiff, Rocket, ScanSearch, Snowflake, Wallet } from 'lucide-preact';
import { ago, shortVersion } from '../lib/model.js';
import { hashFor } from '../lib/store.js';
import { runWords } from '../lib/env-stream.js';
import { widClass } from './ui.jsx';
import { BUDGET, costText } from './InfraCosts.jsx';
import { HEALTH } from '../views/InfrastructureView.jsx';
import { sentence } from '../lib/api.js';

/**
 * The console's status band (WEB-94; docs/specs/WEB-94-environment-console.md): health, freeze, what's live, the plan
 * waiting, the budget used, and the agents at work there now, a tile each, in one row on a wide screen. With a
 * target, whether what it shows is up to date (BRK-257). Its own card at the top of the centre column, above the map
 * (WEB-100).
 */

/** @param {{ iso: string | null | undefined }} props */
function When({ iso }) {
  if (!iso) return null;
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {ago(iso)}
    </time>
  );
}

/**
 * A tile: its label, one value that matters, and one muted line of detail under it, the same three rows in every tile
 * so they line up across the band (WEB-103). `title` is the value's and the detail's full text, for when they're cut.
 * `state` colours the value (and `detailState` the detail) with a health or budget state's colour; the words carry it.
 * @param {{ label: string, Icon: any, tone?: string, value: any, valueTitle?: string, state?: string, muted?: boolean,
 *   detail?: any, detailTitle?: string, detailState?: string }} props
 */
export function Tile({
  label,
  Icon,
  tone = '',
  value,
  valueTitle,
  state = '',
  muted = false,
  detail,
  detailTitle,
  detailState = '',
}) {
  return (
    <div class={`band-tile ${tone ? `band-${tone}` : ''}`}>
      <dt>
        <Icon size={13} aria-hidden="true" />
        {label}
      </dt>
      <dd>
        <span class={`band-value ${state ? `band-state-${state}` : ''} ${muted ? 'muted' : ''}`} title={valueTitle}>
          {value}
        </span>
        {detail && (
          <span class={`band-detail ${detailState ? `band-state-${detailState}` : ''}`} title={detailTitle}>
            {detail}
          </span>
        )}
      </dd>
    </div>
  );
}

const plural = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ many) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * Health: the worst state, and how many resources share it unless all are healthy.
 * @param {{ health: any }} props
 */
function HealthTile({ health }) {
  if (!health) return <Tile label="Health" Icon={Activity} value="Unknown" state="unknown" detail="Not seen yet" />;
  const { label } = HEALTH[health.state];
  const value = health.state === 'healthy' || health.state === 'unknown' ? label : `${label} ${health.count}`;
  const of =
    health.state === 'healthy'
      ? `${health.total} of ${plural(health.total, 'resource', 'resources')}`
      : `${health.count} of ${plural(health.total, 'resource', 'resources')}`;
  return (
    <Tile
      label="Health"
      Icon={Activity}
      value={value}
      valueTitle={value}
      state={health.state}
      detail={
        <>
          {of}
          {health.at && (
            <>
              , checked <When iso={health.at} />
            </>
          )}
        </>
      }
      detailTitle={`${of}${health.at ? `, checked ${ago(health.at)}` : ''}`}
    />
  );
}

/**
 * Whether what the map shows is up to date (BRK-257): when the board last looked or, when it couldn't, since when it's
 * out of date, and why.
 * @param {{ stale: any, seen: string | null }} props `stale` from GET /api/infra/inventory's `stale`; `seen` the latest resource's
 */
function InventoryTile({ stale, seen }) {
  if (stale) {
    const since = stale.seen ? `as of ${ago(stale.seen)}` : 'never looked at yet';
    return (
      <Tile
        label="Inventory"
        Icon={ScanSearch}
        tone="stale"
        value="Out of date"
        state="degraded"
        detail={
          <>
            {stale.seen ? (
              <>
                as of <When iso={stale.seen} />
              </>
            ) : (
              since
            )}
            : {sentence(stale.error)}
          </>
        }
        detailTitle={`${since}: ${sentence(stale.error)}`}
      />
    );
  }
  if (!seen) return <Tile label="Inventory" Icon={ScanSearch} value="Not yet" muted detail="Not looked at yet" />;
  return (
    <Tile
      label="Inventory"
      Icon={ScanSearch}
      value="Up to date"
      detail={
        <>
          looked <When iso={seen} />
        </>
      }
      detailTitle={`looked ${ago(seen)}`}
    />
  );
}

/**
 * `inventory` is whether what the map shows is up to date: the environment's `stale` entry and when the board last saw it.
 * @param {{ env: any, health: any, cost: any, run: any, agents: { agent: string, task: any, why: string }[], inventory?: { stale: any, seen: string | null } }} props
 */
export function StatusBand({ env, health, cost, run, agents, inventory = { stale: null, seen: null } }) {
  const live = env.deploys?.live ?? null;
  const planLink = (/** @type {string} */ plan) =>
    hashFor({ view: 'infrastructure', environment: String(env.id), plan, task: null });
  const used = cost && cost.budget?.amount > 0 ? Math.round((cost.cost.amount / cost.budget.amount) * 100) : null;
  const budgetState = cost?.budget?.state in BUDGET ? cost.budget.state : 'unknown';
  const liveVersion = live ? shortVersion(live) : '';
  return (
    <section class="console-status" aria-label={`${env.name}’s status`}>
      <dl class="console-band">
        <HealthTile health={env.target ? health : null} />
        {env.target && <InventoryTile stale={inventory.stale} seen={inventory.seen} />}
        {env.frozen ? (
          <Tile
            label="Freeze"
            Icon={Snowflake}
            tone="frozen"
            value="Frozen"
            detail={
              env.frozenAt && (
                <>
                  since <When iso={env.frozenAt} />
                </>
              )
            }
          />
        ) : env.observeOnly ? (
          <Tile
            label="Freeze"
            Icon={Eye}
            value="Observe only"
            detail={env.runsTheBoard ? 'Runs this board' : 'Watched, never changed'}
          />
        ) : (
          <Tile label="Freeze" Icon={Snowflake} value="Not frozen" muted />
        )}
        {live ? (
          <Tile
            label="Live"
            Icon={Rocket}
            value={<code>{liveVersion}</code>}
            valueTitle={liveVersion}
            detail={
              <>
                {live.version && <span class="gh-sha">{live.sha.slice(0, 7)} · </span>}
                <When iso={live.at} />
              </>
            }
            detailTitle={`${live.version ? `${live.sha.slice(0, 7)} · ` : ''}${live.at ? ago(live.at) : ''}`}
          />
        ) : env.pipeline ? (
          <Tile label="Live" Icon={Rocket} value="None" muted detail="Nothing deployed yet" />
        ) : env.target ? (
          <Tile label="Live" Icon={Rocket} value={<code>{env.target}</code>} valueTitle={env.target} />
        ) : (
          <Tile label="Live" Icon={Rocket} value="None" muted detail="No target yet" />
        )}
        {run && run.phase !== 'done' ? (
          <Tile
            label="Plan"
            Icon={FileDiff}
            value={runWords(run)}
            valueTitle={runWords(run)}
            detail={<a href={planLink(run.plan)}>{run.plan}</a>}
          />
        ) : env.waitingPlan ? (
          <Tile
            label="Plan"
            Icon={FileDiff}
            tone="waiting"
            value={<a href={planLink(env.waitingPlan)}>1 waits</a>}
            detail={
              <>
                <a href={planLink(env.waitingPlan)}>{env.waitingPlan}</a> waits for you
              </>
            }
            detailTitle={`${env.waitingPlan} waits for you`}
          />
        ) : env.observeOnly ? (
          <Tile label="Plan" Icon={FileDiff} value="Never" muted detail="Observe only" />
        ) : (
          <Tile label="Plan" Icon={FileDiff} value="None waits" muted />
        )}
        {cost && cost.cost.resources > 0 ? (
          <Tile
            label="Budget"
            Icon={Wallet}
            tone={budgetState === 'over' ? 'over' : ''}
            value={used !== null ? `${used}%` : costText(cost.cost)}
            valueTitle={used !== null ? `${used}% of the budget` : `${costText(cost.cost)} a month`}
            detail={`${used !== null ? `${costText(cost.cost)} a month, ` : 'A month, '}${BUDGET[budgetState].label.toLowerCase()}`}
            detailTitle={`${used !== null ? `${used}% of the budget, ${costText(cost.cost)} a month` : `${costText(cost.cost)} a month`}, ${BUDGET[budgetState].label.toLowerCase()}`}
            detailState={budgetState}
          />
        ) : (
          <Tile label="Budget" Icon={Wallet} value="None" muted detail="No estimate yet" />
        )}
        <Tile
          label="Agents"
          Icon={Bot}
          value={agents.length ? `${agents.length}` : 'None'}
          muted={!agents.length}
          detail={
            agents.length ? (
              <span class="band-agents">
                {agents.map((a, i) => (
                  <span key={a.agent}>
                    {i > 0 && ', '}
                    {a.task ? (
                      <a class={widClass(a.task)} href={hashFor({ task: a.task.wid ?? a.task.uuid })}>
                        {a.task.wid ?? a.task.description}
                      </a>
                    ) : (
                      <a href={planLink(a.why)}>{a.why}</a>
                    )}{' '}
                    <span class="band-agent">{a.agent}</span>
                  </span>
                ))}
              </span>
            ) : (
              'At work here'
            )
          }
          detailTitle={agents
            .map((a) => `${a.task ? (a.task.wid ?? a.task.description) : a.why} ${a.agent}`)
            .join(', ')}
        />
      </dl>
    </section>
  );
}
