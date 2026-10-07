import { Activity, Bot, Eye, FileDiff, Rocket, ScanSearch, Snowflake, Wallet } from 'lucide-preact';
import { ago, shortVersion } from '../lib/model.js';
import { hashFor } from '../lib/store.js';
import { runWords } from '../lib/env-stream.js';
import { widClass } from './ui.jsx';
import { BudgetBadge, costText } from './InfraCosts.jsx';
import { Health } from '../views/InfrastructureView.jsx';
import { InventoryFreshness } from './InventoryStale.jsx';

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
 * @param {{ label: string, Icon: any, tone?: string, children: any }} props
 */
function Tile({ label, Icon, tone = '', children }) {
  return (
    <div class={`band-tile ${tone ? `band-${tone}` : ''}`}>
      <dt>
        <Icon size={13} aria-hidden="true" />
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
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
  return (
    <section class="console-status" aria-label={`${env.name}’s status`}>
      <dl class="console-band">
        <Tile label="Health" Icon={Activity}>
          <Health health={env.target ? health : null} />
        </Tile>
        {env.target && (
          <Tile label="Inventory" Icon={ScanSearch} tone={inventory.stale ? 'stale' : ''}>
            <InventoryFreshness stale={inventory.stale} seen={inventory.seen} />
          </Tile>
        )}
        <Tile label="Freeze" Icon={env.observeOnly ? Eye : Snowflake} tone={env.frozen ? 'frozen' : ''}>
          {env.frozen ? (
            <span class="band-value">
              Frozen{' '}
              <span class="meta">
                <When iso={env.frozenAt} />
              </span>
            </span>
          ) : env.observeOnly ? (
            <span class="band-value">{env.runsTheBoard ? 'Observe only: runs this board' : 'Observe only'}</span>
          ) : (
            <span class="band-value muted">Not frozen</span>
          )}
        </Tile>
        <Tile label="Live" Icon={Rocket}>
          {live ? (
            <span class="band-value">
              <code>{shortVersion(live)}</code>
              {live.version && <span class="gh-sha"> {live.sha.slice(0, 7)}</span>}{' '}
              <span class="meta">
                <When iso={live.at} />
              </span>
            </span>
          ) : env.pipeline ? (
            <span class="band-value muted">Nothing deployed yet</span>
          ) : env.target ? (
            <span class="band-value">
              <code>{env.target}</code>
            </span>
          ) : (
            <span class="band-value muted">No target yet</span>
          )}
        </Tile>
        <Tile label="Plan" Icon={FileDiff} tone={env.waitingPlan ? 'waiting' : ''}>
          {run && run.phase !== 'done' ? (
            <span class="band-value">
              {runWords(run)} <a href={planLink(run.plan)}>{run.plan}</a>
            </span>
          ) : env.waitingPlan ? (
            <a class="band-value band-plan" href={planLink(env.waitingPlan)}>
              {env.waitingPlan} waits for you
            </a>
          ) : (
            <span class="band-value muted">{env.observeOnly ? 'Never: observe only' : 'None waits'}</span>
          )}
        </Tile>
        <Tile label="Budget" Icon={Wallet} tone={cost?.budget?.state === 'over' ? 'over' : ''}>
          {cost && cost.cost.resources > 0 ? (
            <span class="band-value">
              {used !== null ? `${used}%` : costText(cost.cost)}
              <span class="meta"> {used !== null ? `of the budget, ${costText(cost.cost)} a month` : 'a month'}</span>{' '}
              <BudgetBadge state={cost.budget.state} />
            </span>
          ) : (
            <span class="band-value muted">No estimate yet</span>
          )}
        </Tile>
        <Tile label="Agents" Icon={Bot}>
          {agents.length ? (
            <ul class="band-agents">
              {agents.map((a) => (
                <li key={a.agent}>
                  {a.task ? (
                    <a class={widClass(a.task)} href={hashFor({ task: a.task.wid ?? a.task.uuid })}>
                      {a.task.wid ?? a.task.description}
                    </a>
                  ) : (
                    <a href={planLink(a.why)}>{a.why}</a>
                  )}{' '}
                  <span class="band-agent">{a.agent}</span>
                </li>
              ))}
            </ul>
          ) : (
            <span class="band-value muted">None at work here</span>
          )}
        </Tile>
      </dl>
    </section>
  );
}
