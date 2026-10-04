import { CirclePause } from 'lucide-preact';
import { actions, confirmDialog } from '../lib/store.js';
import { Segmented } from './ui.jsx';

/*
 * The board's own settings, one component per group (docs/specs/IDEA-29-settings.md, section 3; WEB-29): the
 * Settings page renders them, and so do the Agents and Routines views. Each saves through the one route it always
 * used and reads the store's one signal, so a change in either place shows in both.
 */

const upTo = (n) => Array.from({ length: n }, (_, i) => String(i + 1));

/**
 * The owner's Claude plan (CLD-198). Claude doesn't tell the board which plan an account is on, so the owner
 * picks it here, and it sets the ceilings and defaults of the board's limits. Claude's own limits on starting
 * a routine are the same on every plan.
 * @param {Record<string, any>} props
 */
function PlanField({ d }) {
  const plans = d.plans ?? [];
  const pick = async (id) => {
    const plan = plans.find((p) => p.id === id);
    if (!plan || id === d.settings.plan) return;
    const ok = await confirmDialog({
      title: `Switch to ${plan.name}?`,
      body: `Agents at once goes to ${plan.agents.default} (up to ${plan.agents.most}), starts an hour to ${Math.min(plan.hourly.default, d.limits.hourly)}, and routine runs a day to ${plan.routinesDaily.default}. You can change each one after.`,
      confirmLabel: `Use ${plan.name}`,
    });
    if (ok) actions.claudePlan(id);
  };
  return (
    <div class="field plan-field">
      <span class="field-label">Your Claude plan</span>
      <Segmented
        label="Your Claude plan"
        options={plans.map((p) => ({
          id: p.id,
          label: p.name,
          hint: p.usage > 1 ? `${p.usage}× Pro’s usage` : 'Claude Pro',
        }))}
        value={d.settings.plan}
        onChange={pick}
      />
      <span class="field-hint">
        Claude doesn’t tell the board your plan, so pick it here. It sets how high the limits below can go. Claude
        allows {d.limits.routineHourly} starts an hour for each routine and {d.limits.accountHourly} for your account,
        on every plan.
      </span>
    </div>
  );
}

/**
 * The board's agents: your Claude plan, agents at once, starts an hour, start by itself, and security alerts,
 * saved through `agents/settings`. `d` is GET /api/agents's.
 * @param {Record<string, any>} props
 */
export function AgentSettings({ d }) {
  const s = d.settings;
  const limits = d.limits ?? { agents: 6, hourly: 30 };
  const setHourly = (e) => {
    const n = Number(e.currentTarget.value);
    if (Number.isInteger(n) && n >= 1 && n <= limits.hourly) actions.agentSettings({ hourly: n });
  };
  const setMax = (e) => {
    const n = Number(e.currentTarget.value);
    if (Number.isInteger(n) && n >= 1 && n <= limits.agents) actions.agentSettings({ max: n });
  };
  return (
    <>
      <PlanField d={d} />
      <div class="settings-grid">
        {limits.agents <= 6 ? (
          <div class="field">
            <span class="field-label">Agents at once</span>
            <Segmented
              label="Agents at once"
              options={upTo(limits.agents).map((n) => ({ id: n, label: n }))}
              value={String(s.max)}
              onChange={(v) => actions.agentSettings({ max: Number(v) })}
            />
            <span class="field-hint">A task in review doesn’t count: its slot frees up when the PR opens.</span>
          </div>
        ) : (
          <label class="field">
            <span class="field-label">Agents at once</span>
            <input
              class="input input-sm"
              type="number"
              min="1"
              max={limits.agents}
              step="1"
              defaultValue={s.max}
              key={`${s.plan}-${s.max}`}
              onChange={setMax}
            />
            <span class="field-hint">
              1 to {limits.agents} on your plan. A task in review doesn’t count: its slot frees up when the PR opens.
            </span>
          </label>
        )}
        <label class="field">
          <span class="field-label">Starts an hour</span>
          <input
            class="input input-sm"
            type="number"
            min="1"
            max={limits.hourly}
            step="1"
            defaultValue={s.hourly}
            key={`${s.plan}-${s.hourly}`}
            onChange={setHourly}
          />
          <span class="field-hint">
            Most agents the board starts in an hour, 1 to {limits.hourly} (
            {limits.hourly > limits.routineHourly
              ? `${limits.routineHourly} for each routine`
              : 'Claude’s limit for the routine'}
            ). Every start uses your Claude subscription.
          </span>
        </label>
        <div class="field">
          <span class="field-label">Start by itself</span>
          <Segmented
            label="Start by itself"
            options={[
              { id: 'on', label: 'On' },
              { id: 'off', label: 'Off' },
            ]}
            value={s.autostart ? 'on' : 'off'}
            onChange={(v) => actions.agentSettings({ autostart: v === 'on' })}
          />
          <span class="field-hint">
            Tasks marked Start when ready start their agent as soon as nothing blocks them.
          </span>
        </div>
        <label class="field">
          <span class="field-label">New security alerts</span>
          <select
            class="select select-sm"
            value={s.alerts}
            onChange={(e) => actions.agentSettings({ alerts: e.currentTarget.value })}
          >
            <option value="off">Leave them to me</option>
            <option value="critical">Critical ones get an agent</option>
            <option value="high">High and critical get an agent</option>
            <option value="medium">Medium and up get an agent</option>
            <option value="all">Every alert gets an agent</option>
          </select>
          <span class="field-hint">A new alert at that level becomes a task that starts its own agent.</span>
        </label>
      </div>
    </>
  );
}

/**
 * Whether routines may run at all, saved through `routines/settings`. `s` is GET /api/routines's settings.
 * @param {Record<string, any>} props
 */
export function RoutinesSwitch({ s }) {
  return (
    <Segmented
      label="Routines can run"
      options={[
        { id: 'on', label: 'On' },
        { id: 'off', label: 'Paused', icon: <CirclePause size={14} aria-hidden="true" /> },
      ]}
      value={s.paused ? 'off' : 'on'}
      onChange={(v) => actions.routineSettings({ paused: v === 'off' })}
    />
  );
}

/**
 * The cap on runs for all routines together, up to the Claude plan's ceiling (CLD-199; the plan's from CLD-198).
 * @param {Record<string, any>} props
 */
export function RoutinesDailyCap({ s }) {
  const most = s.limits?.dailyCap ?? 100;
  const setCap = (e) => {
    const n = Number(e.currentTarget.value);
    if (Number.isInteger(n) && n >= 1 && n <= most) actions.routineSettings({ dailyCap: n });
  };
  return (
    <label class="field">
      <span class="field-label">All routines a day</span>
      <input
        class="input input-sm rt-cap"
        type="number"
        min="1"
        max={most}
        step="1"
        defaultValue={s.dailyCap}
        key={s.dailyCap}
        onChange={setCap}
      />
      <span class="field-hint">
        Most runs all routines start together in 24 hours, 1 to {most} on your Claude plan. Each routine also has its
        own cap.
      </span>
    </label>
  );
}
