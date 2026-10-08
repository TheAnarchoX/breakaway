import { useEffect, useState } from 'preact/hooks';
import {
  Bot,
  CircleCheck,
  CircleDashed,
  CircleX,
  Eye,
  FileDiff,
  Moon,
  Plug,
  Plus,
  RefreshCw,
  Server,
  Snowflake,
  TriangleAlert,
} from 'lucide-preact';
import { ago, shortVersion } from '../lib/model.js';
import { rollUpHealth } from '../../../src/infra-health.js';
import { api, enc } from '../lib/api.js';
import {
  confirmDialog,
  connections,
  hashFor,
  inScope,
  loadConnections,
  multiRepo,
  navOrder,
  repoName,
  repoScope,
  repos,
  toast,
} from '../lib/store.js';
import { Dialog } from '../components/ui.jsx';
import { BudgetLine, CostOverview } from '../components/InfraCosts.jsx';
import { InventoryRefresh } from '../components/InventoryRefresh.jsx';
import { StaleLine } from '../components/InventoryStale.jsx';
import { AccountAlerts } from '../components/AccountAlerts.jsx';
import { EnvironmentAgentDialog } from '../components/EnvironmentAgent.jsx';

/**
 * The Infrastructure view (WEB-60; docs/specs/IDEA-19-architect.md, "Views"): each repository's environments with
 * their health and freeze. Health is the worst of the environment's resources in the inventory (BRK-177). Each card's
 * estimated cost against its budget, and the overview by repository and task, are WEB-65's (src/components/InfraCosts.jsx).
 */

const KINDS = [
  ['production', 'Production'],
  ['staging', 'Staging'],
  ['short-lived', 'Short-lived'],
];
export const KIND_LABEL = Object.fromEntries(KINDS);

/** Worst first. Idle (deployed, no traffic) ranks with healthy, never as unknown (BRK-266). */
export const HEALTH = {
  down: { label: 'Down', Icon: CircleX },
  degraded: { label: 'Degraded', Icon: TriangleAlert },
  unknown: { label: 'Unknown', Icon: CircleDashed },
  healthy: { label: 'Healthy', Icon: CircleCheck },
  idle: { label: 'Idle', Icon: Moon },
};

/**
 * An environment's health from its resources (BRK-266): down and degraded win; otherwise healthy (or idle, when
 * every readable one is quiet) with how many couldn't be read; unknown only when none could. `count` is how many
 * resources share the state, `notRead` how many couldn't be read, and `at` the newest check.
 * @param {any[]} resources
 */
export function environmentHealth(resources) {
  const rolled = rollUpHealth(resources.map((r) => r.health));
  if (!rolled) return null;
  const at = resources
    .map((r) => r.health?.at)
    .filter(Boolean)
    .sort()
    .at(-1);
  return { ...rolled, at: at ?? null };
}

/**
 * How many resources an environment's health covers, in words: "all 4 resources", "2 of 5 resources", and how many
 * couldn't be read.
 * @param {{ state: string, count: number, total: number, notRead?: number }} health
 */
export function healthOfWords(health) {
  const n = (/** @type {number} */ k) => `${k} ${k === 1 ? 'resource' : 'resources'}`;
  const of =
    health.count === health.total
      ? health.total === 1
        ? '1 resource'
        : `all ${health.total} resources`
      : `${health.count} of ${n(health.total)}`;
  return health.notRead && health.state !== 'unknown' ? `${of}, ${health.notRead} not read` : of;
}

/** The providers on Connections (BRK-194): a row each, connected or not. */
const providerRows = () => (connections.value.data?.connections ?? []).filter((c) => c.group === 'providers');

/** @param {{ health: ReturnType<typeof environmentHealth> }} props */
export function Health({ health }) {
  if (!health)
    return (
      <span class="infra-health infra-health-none">
        <CircleDashed size={14} aria-hidden="true" />
        Not seen yet
      </span>
    );
  const { label, Icon } = HEALTH[health.state] ?? HEALTH.unknown;
  const of = healthOfWords(health);
  return (
    <span class="infra-health-line">
      <span class={`infra-health infra-health-${health.state}`}>
        <Icon size={14} aria-hidden="true" />
        {label}
      </span>
      <span class="meta">
        {of}
        {health.at && (
          <>
            {' · checked '}
            <time dateTime={health.at} title={new Date(health.at).toLocaleString()}>
              {ago(health.at)}
            </time>
          </>
        )}
      </span>
    </span>
  );
}

/**
 * What freezing or unfreezing an environment stops or lets run again, in the words BRK-235 settled: a pipeline's
 * production is the deploy pause too (BRK-236), and merges keep deploying a pipeline's staging.
 * @param {any} env
 * @param {boolean} freezing
 */
export function freezeWords(env, freezing) {
  if (env.pipeline === 'production')
    return freezing
      ? `Freezing ${env.name} pauses deploys and plans; Roll back still works.`
      : 'Promote and the plans you approve can run there again.';
  if (env.pipeline === 'staging')
    return freezing
      ? `Freezing ${env.name} stops plans; merges still deploy here.`
      : 'The plans you approve, and changes inside its envelopes, can apply there again.';
  return freezing
    ? 'Plans, and changes inside its envelopes, wait until you unfreeze it.'
    : 'The plans you approve, and changes inside its envelopes, can apply there again.';
}

/**
 * Freeze or Unfreeze one environment, after the owner confirms: the signed-in browser's alone (BRK-174). On a
 * pipeline's production it sets the deploy pause on GitHub too (BRK-236), and says so when that didn't sync.
 * @param {{ env: any, onChange: (env: any) => void }} props
 */
export function FreezeButton({ env, onChange }) {
  const [busy, setBusy] = useState(false);
  const toggleFreeze = async () => {
    const freezing = !env.frozen;
    const ok = await confirmDialog({
      title: freezing ? `Freeze ${env.name}?` : `Unfreeze ${env.name}?`,
      body: freezeWords(env, freezing),
      confirmLabel: freezing ? 'Freeze' : 'Unfreeze',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const { environment, pause, note } = await api(`infra/environments/${enc(env.id)}`, {
        method: 'PATCH',
        body: { frozen: freezing, by: 'owner' },
      });
      onChange(environment);
      const done = freezing ? `${env.name} is frozen.` : `${env.name} is unfrozen.`;
      if (pause && pause.synced === false)
        toast(
          `${done} The deploy pause on GitHub didn’t change${pause.error ? `: ${pause.error}` : ''}. Open Connections to fix it.`,
          'error',
        );
      else toast(note ? `${done} ${note}` : done, 'success');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      class="btn btn-outline btn-sm"
      onClick={toggleFreeze}
      disabled={busy}
      aria-busy={busy}
      aria-label={`${env.frozen ? 'Unfreeze' : 'Freeze'} ${env.name}`}
    >
      <Snowflake size={16} aria-hidden="true" />
      {env.frozen ? 'Unfreeze' : 'Freeze'}
    </button>
  );
}

/** @param {{ env: any }} props */
export function EnvironmentFlags({ env }) {
  // The deploy pause on GitHub that freeze couldn't set or read (BRK-236): Connections says how to fix it.
  const unsynced = env.deploysPaused?.synced === false;
  if (!env.frozen && !env.observeOnly && !unsynced) return null;
  return (
    <ul class="infra-flags">
      {env.frozen && (
        <li class="infra-flag infra-flag-frozen">
          <Snowflake size={14} aria-hidden="true" />
          Frozen
          {env.frozenAt && (
            <>
              {' '}
              <time dateTime={env.frozenAt} title={new Date(env.frozenAt).toLocaleString()}>
                {ago(env.frozenAt)}
              </time>
            </>
          )}
        </li>
      )}
      {unsynced && (
        <li class="infra-flag infra-flag-frozen">
          <TriangleAlert size={14} aria-hidden="true" />
          <span>
            The deploy pause isn’t synced with GitHub.{' '}
            <a href={hashFor({ view: 'connections', environment: null, task: null })}>Open Connections</a>
          </span>
        </li>
      )}
      {env.observeOnly && (
        <li class="infra-flag" title={env.runsTheBoard ? 'It runs this board: the board never changes it.' : ''}>
          <Eye size={14} aria-hidden="true" />
          {env.runsTheBoard ? 'Observe only: runs this board' : 'Observe only'}
        </li>
      )}
    </ul>
  );
}

/**
 * What the deploy flow runs on a pipeline's environment (BRK-195): its live version and commit, and when it went live.
 * @param {{ env: any }} props
 */
function LiveLine({ env }) {
  if (!env.pipeline) return null;
  const live = env.deploys?.live;
  if (!live) return <p class="meta infra-live">Nothing deployed yet</p>;
  return (
    <p class="meta infra-live">
      Live: <code>{shortVersion(live)}</code>
      {live.version && (
        <>
          {' at '}
          <span class="gh-sha">{live.sha.slice(0, 7)}</span>
        </>
      )}
      ,{' '}
      <time dateTime={live.at} title={new Date(live.at).toLocaleString()}>
        {ago(live.at)}
      </time>
    </p>
  );
}

/** @param {{ env: any, resources: any[], cost: any, stale?: any, onChange: (env: any) => void }} props */
function EnvironmentCard({ env, resources, cost, stale = null, onChange }) {
  const health = environmentHealth(resources);
  return (
    <li class={`infra-env ${env.frozen ? 'is-frozen' : ''}`}>
      <div class="infra-env-head">
        <h3 class="infra-env-name">
          <a href={hashFor({ view: 'infrastructure', environment: String(env.id), task: null })}>{env.name}</a>
        </h3>
        <span class="infra-kind">{KIND_LABEL[env.kind] ?? env.kind}</span>
      </div>
      <p class="meta infra-env-where">
        {env.provider ?? 'No provider'}
        {env.target ? (
          <>
            {' · '}
            <code>{env.target}</code>
          </>
        ) : (
          ' · no target yet'
        )}
        {env.task && (
          <>
            {' · for '}
            <a href={hashFor({ task: env.task.wid ?? env.task.uuid })}>{env.task.wid ?? env.task.description}</a>
          </>
        )}
      </p>
      <Health health={env.target ? health : null} />
      <StaleLine stale={env.target ? stale : null} />
      {cost && cost.cost.resources > 0 && <BudgetLine entry={cost} compact />}
      <LiveLine env={env} />
      <EnvironmentFlags env={env} />
      {env.waitingPlan && (
        <a
          class="infra-env-plan"
          href={hashFor({ view: 'infrastructure', environment: String(env.id), plan: env.waitingPlan, task: null })}
        >
          <FileDiff size={14} aria-hidden="true" />
          {env.waitingPlan} waits for you
        </a>
      )}
      <div class="infra-env-foot">
        <FreezeButton env={env} onChange={onChange} />
      </div>
    </li>
  );
}

/** The owner's form to add an environment (BRK-174's POST; an agent's `by` is refused). */
function AddEnvironmentForm({ onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const providers = providerRows();
  const startRepo = repoScope.value ?? repos.value.default;
  const save = async (/** @type {Event} */ e) => {
    e.preventDefault();
    const form = new FormData(/** @type {HTMLFormElement} */ (e.currentTarget));
    const field = (/** @type {string} */ name) => String(form.get(name) ?? '').trim();
    setBusy(true);
    setError(null);
    try {
      const { environment } = await api('infra/environments', {
        method: 'POST',
        body: {
          repo: field('repo') || startRepo,
          name: field('name'),
          kind: field('kind'),
          provider: field('provider'),
          target: field('target') || null,
          by: 'owner',
        },
      });
      toast(`Added ${environment.name}.`, 'success');
      onDone(environment);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="infra-form" onSubmit={save}>
      {multiRepo.value && (
        <label class="field">
          <span class="field-label">Repository</span>
          <select class="select" name="repo">
            {repos.value.list.map((r) => (
              <option key={r.slug} value={r.slug} selected={r.slug === startRepo}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div class="field-row">
        <label class="field">
          <span class="field-label">Name</span>
          <input
            class="input"
            name="name"
            required
            maxLength={40}
            pattern="[a-z0-9][a-z0-9\-]{0,39}"
            placeholder="staging"
            autocomplete="off"
          />
        </label>
        <label class="field">
          <span class="field-label">Kind</span>
          <select class="select" name="kind">
            {KINDS.map(([v, l]) => (
              <option key={v} value={v} selected={v === 'staging'}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      <span class="field-hint infra-form-hint">
        Lowercase letters, digits, and hyphens. Its desired state goes in{' '}
        <code>.github/breakaway-infra/&lt;name&gt;.json</code>.
      </span>
      <div class="field-row">
        <label class="field" htmlFor="infra-provider">
          <span class="field-label">Provider</span>
          {providers.length ? (
            <select class="select" id="infra-provider" name="provider">
              {providers.map((p) => (
                <option key={p.id} value={p.provider?.id ?? p.id.replace(/^provider\./u, '')}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              class="input"
              id="infra-provider"
              name="provider"
              required
              placeholder="cloudflare"
              autocomplete="off"
            />
          )}
        </label>
        <label class="field">
          <span class="field-label">Target (optional)</span>
          <input class="input" name="target" maxLength={100} placeholder="widgets-staging" autocomplete="off" />
        </label>
      </div>
      <span class="field-hint infra-form-hint">
        The target is what it runs on at the provider, like a Worker’s name. The board sees the target and everything it
        uses, and nothing else.
      </span>
      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
      <div class="row-gap infra-form-actions">
        <button type="submit" class="btn btn-primary" disabled={busy} aria-busy={busy}>
          {busy ? 'Adding…' : 'Add environment'}
        </button>
      </div>
    </form>
  );
}

/** Says what to connect, and where, while no provider is connected. */
function ConnectProvider() {
  return (
    <section class="infra-notice" aria-labelledby="infra-connect">
      <Plug size={20} aria-hidden="true" />
      <div>
        <h2 id="infra-connect">Connect a provider</h2>
        <p class="muted">
          The board sees what runs on a provider, like Cloudflare, once you give it a read-only token there. It never
          holds a token that can change anything.
        </p>
        <a class="btn btn-outline btn-sm" href={hashFor({ view: 'connections', task: null })}>
          Open Connections
        </a>
      </div>
    </section>
  );
}

export function InfrastructureView() {
  const [state, setState] = useState(
    /** @type {{ environments: any[] | null, resources: any[], stale: any[], costs: any, error: string | null, loading: boolean }} */ ({
      environments: null,
      resources: [],
      stale: [],
      costs: null,
      error: null,
      loading: true,
    }),
  );
  const [adding, setAdding] = useState(false);
  const [wizard, setWizard] = useState(false);
  const load = async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const [{ environments }, { resources, stale }, costs] = await Promise.all([
        api('infra/environments'),
        api('infra/inventory'),
        // Cost is an extra: the environments show without it.
        api('infra/costs').catch(() => null),
        loadConnections(),
      ]);
      setState({ environments, resources, stale: stale ?? [], costs, error: null, loading: false });
    } catch (error) {
      setState((s) => ({ ...s, error: error.message, loading: false }));
    }
  };
  useEffect(() => {
    navOrder.value = [];
    load();
  }, []);
  const replace = (/** @type {any} */ env) =>
    setState((s) => ({
      ...s,
      environments: (s.environments ?? []).some((e) => e.id === env.id)
        ? (s.environments ?? []).map((e) => (e.id === env.id ? env : e))
        : [...(s.environments ?? []), env],
    }));
  const all = state.environments ?? [];
  const order = KINDS.map(([k]) => k);
  const shown = all
    .filter((e) => inScope(e.repo))
    .sort(
      (a, b) =>
        a.repo.localeCompare(b.repo) || order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name),
    );
  const byRepo = new Map();
  for (const env of shown) byRepo.set(env.repo, [...(byRepo.get(env.repo) ?? []), env]);
  const connectedProviders = providerRows().filter((p) => p.provider?.connected && p.state !== 'off');
  const resourcesOf = (/** @type {any} */ env) => state.resources.filter((r) => r.owner?.environmentId === env.id);
  const costOf = (/** @type {any} */ env) =>
    state.costs?.environments.find((/** @type {any} */ c) => c.environmentId === env.id) ?? null;
  const scope = repoScope.value;
  return (
    <div class="infra-view">
      <div class="conn-top">
        <div class="view-intro">
          <h1>Infrastructure</h1>
          <p class="muted">
            Where each repository runs, and how it’s doing. The board watches; nothing changes without you.
          </p>
        </div>
        <div class="conn-buttons">
          <InventoryRefresh onDone={load} />
          <button
            type="button"
            class="btn btn-quiet btn-sm"
            onClick={load}
            disabled={state.loading}
            aria-busy={state.loading}
          >
            <RefreshCw size={16} aria-hidden="true" class={state.loading ? 'spin' : ''} />
            Reload
          </button>
          <button type="button" class="btn btn-primary btn-sm" aria-haspopup="dialog" onClick={() => setAdding(true)}>
            <Plus size={16} aria-hidden="true" />
            Add an environment
          </button>
        </div>
      </div>
      {state.error && (
        <p class="field-error" role="alert">
          Couldn’t load the environments. {state.error} Reload tries again.
        </p>
      )}
      {state.environments === null && !state.error && (
        <p class="muted" aria-busy="true">
          Loading environments…
        </p>
      )}
      {state.environments !== null && connections.value.loaded && !connectedProviders.length && <ConnectProvider />}
      {state.environments !== null && <AccountAlerts reload={state.environments} />}
      {state.environments !== null &&
        (shown.length ? (
          [...byRepo].map(([repo, envs]) => (
            <section key={repo} class="infra-repo" aria-labelledby={`infra-repo-${repo}`}>
              {(multiRepo.value || byRepo.size > 1) && (
                <h2 id={`infra-repo-${repo}`}>
                  {repoName(repo)} <span class="count">{envs.length}</span>
                </h2>
              )}
              <ul class="infra-envs" aria-label={`${repoName(repo)}’s environments`}>
                {envs.map((env) => (
                  <EnvironmentCard
                    key={env.id}
                    env={env}
                    resources={resourcesOf(env)}
                    cost={costOf(env)}
                    stale={state.stale.find((s) => s.environmentId === env.id) ?? null}
                    onChange={replace}
                  />
                ))}
              </ul>
            </section>
          ))
        ) : (
          <div class="empty">
            <Server size={28} aria-hidden="true" />
            <h2>No environments yet.</h2>
            <p class="muted">
              {scope && all.length
                ? `${repoName(scope)} has none. Switch to every repository to see the others, or add one here.`
                : 'An environment is a named place a repository runs: production, staging, or a short-lived one for a task. Add one, and the board shows its health once its provider is connected.'}
            </p>
            <div class="empty-actions">
              <button type="button" class="btn btn-primary" aria-haspopup="dialog" onClick={() => setAdding(true)}>
                <Plus size={16} aria-hidden="true" />
                Add an environment
              </button>
            </div>
          </div>
        ))}
      {shown.length > 0 && <CostOverview costs={state.costs} />}
      <Dialog open={adding} onClose={() => setAdding(false)} labelledBy="infra-add-title">
        <div class="sheet">
          <h2 id="infra-add-title">Add an environment</h2>
          <div class="env-agent-start">
            <button
              type="button"
              class="btn btn-outline btn-sm"
              aria-haspopup="dialog"
              onClick={() => {
                setAdding(false);
                setWizard(true);
              }}
            >
              <Bot size={16} aria-hidden="true" />
              Have an agent do it
            </button>
            <span class="meta">Describe what it needs, or let an agent work it out from the repository.</span>
          </div>
          {adding && (
            <AddEnvironmentForm
              onDone={(env) => {
                replace(env);
                setAdding(false);
              }}
            />
          )}
        </div>
      </Dialog>
      <EnvironmentAgentDialog open={wizard} onClose={() => setWizard(false)} onAdded={replace} />
    </div>
  );
}
