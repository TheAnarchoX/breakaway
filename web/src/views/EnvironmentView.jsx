import { useEffect, useRef, useState } from 'preact/hooks';
import { ArrowLeft, FileCode, RefreshCw, Server } from 'lucide-preact';
import { ago } from '../lib/model.js';
import { api, enc } from '../lib/api.js';
import { environmentId, hashFor, navOrder, repoName, tasks } from '../lib/store.js';
import { STREAM_MAX, agentsAtWork, arrived, streamItems } from '../lib/env-stream.js';
import { DeploysSection, RecentDeploys } from '../components/EnvironmentDeploys.jsx';
import { EnvironmentPlans } from '../components/EnvironmentPlans.jsx';
import { FreezeButton, KIND_LABEL, environmentHealth } from './InfrastructureView.jsx';
import { IncidentsSection } from '../components/Incidents.jsx';
import { UnownedSection } from '../components/Unowned.jsx';
import { CostSection } from '../components/InfraCosts.jsx';
import { DescribeAsCode } from '../components/InfraDescribe.jsx';
import { StatusBand } from '../components/EnvironmentStatus.jsx';
import { Topology } from '../components/EnvironmentTopology.jsx';
import { StreamRail } from '../components/EnvironmentStream.jsx';
import { ActionsSection } from '../components/EnvironmentActions.jsx';
import { NoneYet } from '../components/ui.jsx';
import { InventoryRefresh } from '../components/InventoryRefresh.jsx';
import {
  AddResourceButton,
  ChangePanel,
  LastChange,
  NodeChange,
  cantChange,
  changeTile,
  useChange,
} from '../components/EnvironmentChange.jsx';

/**
 * An environment's page (WEB-61; docs/specs/IDEA-19-architect.md, "Views"), at #/infrastructure/<id>, as a console
 * (WEB-94; docs/specs/WEB-94-environment-console.md): a status band (health, freeze, what's live, the plan waiting, the
 * budget, the agents at work), its resources as a map or a list (BRK-177's inventory, with drift from BRK-184 and a
 * waiting plan's changes on the nodes), and a stream of what happens there (signals, runs, incidents, and the audit
 * trail, BRK-175), all kept live by polling the routes it reads, with a panel each for deploys (WEB-88), plans
 * (WEB-62), incidents (WEB-63), nobody owns, cost (WEB-65), and the desired state with Describe it as code (WEB-92).
 * On a wide screen it fills the window (WEB-97), balanced 2:8:2 (WEB-100): the status band on top of the map in the
 * middle, admin on the left (the owner's actions, plans, desired state, cost, and nobody owns), and ops on the right
 * (the stream, incidents, what's live, and recent deploys: WEB-108), each column scrolling on its own and every panel shown in
 * full. Narrower, it stacks: status, map, ops, admin. The owner changes the environment from the map (WEB-99): Change
 * and Remove on a node's detail, Add resource on the map (WEB-107), and the change with its plan beside the map.
 */

/** Audit entries a page shows at a time; Show older pages back with `before`. */
const AUDIT_PAGE = 20;
/** Signals the stream reads each time. */
const SIGNALS_READ = 30;
/** How often the console reads again while the page is open and shown, in milliseconds. */
export const POLL_MS = 15_000;

/** A desired-state file's state (BRK-180), in words. */
const DESIRED = {
  valid: 'Valid',
  invalid: 'Can’t be read',
  'to-add': 'No environment for it',
  refused: 'Not used: observe only',
};

/** @param {{ iso: string | null }} props */
function When({ iso }) {
  if (!iso) return null;
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {ago(iso)}
    </time>
  );
}

/** @param {{ env: any, desired: any, error: string | null }} props */
function Drift({ env, desired, error }) {
  const file = `.github/breakaway-infra/${env.name}.json`;
  const compared = typeof env.driftCount === 'number';
  return (
    <section class="infra-section" aria-labelledby="infra-drift">
      <h2 id="infra-drift">
        <FileCode size={16} aria-hidden="true" />
        Desired state and drift
      </h2>
      {error ? (
        <p class="field-error" role="alert">
          {error}
        </p>
      ) : !desired ? (
        <>
          {env.observeOnly ? (
            <p class="console-quiet">Observe only: the board never changes it, so it takes no desired state.</p>
          ) : (
            <NoneYet>
              Add <code>{file}</code> by pull request.
            </NoneYet>
          )}
          <DescribeAsCode env={env} />
        </>
      ) : (
        <dl class="infra-facts">
          <div>
            <dt>File</dt>
            <dd>
              <code>{desired.path}</code>
              {desired.sha && <span class="meta"> at {desired.sha.slice(0, 7)}</span>}
            </dd>
          </div>
          <div>
            <dt>State</dt>
            <dd>
              <span class={`infra-desired infra-desired-${desired.state}`}>
                {DESIRED[desired.state] ?? desired.state}
              </span>
              {desired.problem && <span class="meta"> · {desired.problem}</span>}
              {desired.error?.message && (
                <span class="meta">
                  {' · '}
                  {desired.error.line ? `line ${desired.error.line}: ` : ''}
                  {desired.error.message}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>Read</dt>
            <dd>
              <When iso={desired.readAt} />
              {desired.state === 'invalid' && desired.validAt && (
                <span class="meta">
                  {' · plans use the last valid copy, from '}
                  <When iso={desired.validAt} />
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>Drift</dt>
            <dd>
              {compared
                ? env.driftCount
                  ? `${env.driftCount} ${env.driftCount === 1 ? 'resource differs' : 'resources differ'} from the repository`
                  : 'None: what runs matches the repository'
                : 'Not compared yet'}
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}

/** A read the console can do without: a 404 or a failure leaves its part empty, never the page. */
const optional = (/** @type {Promise<any>} */ p, /** @type {any} */ fallback) => p.catch(() => fallback);

/** When the board last saw any of the environment's resources, or null before it has. */
const lastSeen = (/** @type {any[]} */ resources) =>
  resources.reduce((at, r) => (r.seen && (!at || r.seen > at) ? r.seen : at), /** @type {string | null} */ (null));

/** Whether this screen starts on the list: a phone does, with Map a press away. */
const narrow = () => typeof matchMedia === 'function' && matchMedia('(max-width: 720px)').matches;

/**
 * @typedef {{ env: any, resources: any[], relations: any[], stale: any, desired: any, desiredError: string | null, drift: any,
 *   audit: any[], more: boolean, signals: any[], runs: any[], incidents: any[], plans: any[], plan: any, cost: any,
 *   error: string | null, notFound: boolean, loading: boolean, updated: number | null, tick: number }} ConsoleState
 */

export function EnvironmentView() {
  const id = environmentId.value;
  const [state, setState] = useState(
    /** @type {ConsoleState} */ ({
      env: null,
      resources: [],
      relations: [],
      stale: null,
      desired: null,
      desiredError: null,
      drift: null,
      audit: [],
      more: false,
      signals: [],
      runs: [],
      incidents: [],
      plans: [],
      plan: null,
      cost: null,
      error: null,
      notFound: false,
      loading: true,
      updated: null,
      tick: 0,
    }),
  );
  const [older, setOlder] = useState(/** @type {any[]} */ ([]));
  const [olderMore, setOlderMore] = useState(/** @type {boolean | null} */ (null));
  const [olderBusy, setOlderBusy] = useState(false);
  const [mode, setMode] = useState(/** @type {'map' | 'list'} */ (narrow() ? 'list' : 'map'));
  const [fresh, setFresh] = useState(/** @type {Set<string>} */ (new Set()));
  const shownKeys = useRef(/** @type {Set<string> | null} */ (null));
  const busy = useRef(false);
  const ch = useChange(state.env, {
    desired: state.desired,
    tick: state.tick,
    plans: state.plans,
    seen: state.resources.length,
  });

  const load = async (/** @type {{ quiet?: boolean }} */ { quiet = false } = {}) => {
    if (busy.current) return;
    busy.current = true;
    if (!quiet) setState((s) => ({ ...s, loading: true }));
    try {
      const { environment } = await api(`infra/environments/${enc(id)}`);
      const [inventory, audit, desired, drift, signals, runs, incidents, plans, costs] = await Promise.all([
        api(`infra/inventory?environment=${enc(id)}`),
        api(`infra/audit?environmentId=${enc(id)}&limit=${AUDIT_PAGE}`),
        api(`infra/desired/${enc(id)}`).then(
          (d) => ({ desired: d.desired, error: null }),
          (err) => (err.status === 404 ? { desired: null, error: null } : { desired: null, error: err.message }),
        ),
        optional(
          api(`infra/drift/${enc(id)}`).then((d) => d.drift),
          null,
        ),
        optional(api(`infra/signals?environmentId=${enc(id)}&limit=${SIGNALS_READ}`), { signals: [] }),
        optional(api(`infra/runs?environment=${enc(id)}`), { runs: [] }),
        optional(api(`infra/incidents?environment=${enc(id)}&limit=10`), { incidents: [] }),
        optional(api(`infra/plans?environment=${enc(id)}&limit=10`), { plans: [] }),
        optional(api(`infra/costs?environment=${enc(id)}`), null),
      ]);
      // The plan whose changes the map shows: one applying now, else the one waiting for you.
      const live = runs.runs.find((/** @type {any} */ r) => r.phase !== 'done');
      const showing = live?.plan ?? environment.waitingPlan ?? null;
      const plan = showing
        ? await optional(
            api(`infra/plans/${enc(showing)}`).then((p) => p.plan),
            null,
          )
        : null;
      setState((s) => ({
        env: environment,
        resources: inventory.resources,
        relations: inventory.relations,
        stale: inventory.stale?.find((/** @type {any} */ x) => x.environmentId === environment.id) ?? null,
        desired: desired.desired,
        desiredError: desired.error,
        drift,
        audit: audit.entries,
        more: audit.more,
        signals: signals.signals,
        runs: runs.runs,
        incidents: incidents.incidents,
        plans: plans.plans,
        plan,
        cost: costs?.environments?.find((/** @type {any} */ e) => e.environmentId === environment.id) ?? null,
        error: null,
        notFound: false,
        loading: false,
        updated: Date.now(),
        tick: s.tick + 1,
      }));
    } catch (error) {
      setState((s) => ({ ...s, error: error.message, notFound: error.status === 404, loading: false }));
    } finally {
      busy.current = false;
    }
  };

  const loadOlder = async () => {
    const last = (older.length ? older : state.audit).at(-1);
    if (!last) return;
    setOlderBusy(true);
    try {
      const { entries, more } = await api(
        `infra/audit?environmentId=${enc(id)}&limit=${AUDIT_PAGE}&before=${enc(last.id)}`,
      );
      setOlder((o) => [...o, ...entries]);
      setOlderMore(more);
    } catch (error) {
      setState((s) => ({ ...s, error: error.message }));
    } finally {
      setOlderBusy(false);
    }
  };

  useEffect(() => {
    navOrder.value = [];
    shownKeys.current = null;
    setOlder([]);
    setOlderMore(null);
    load();
    // Live: read again every POLL_MS while the page is shown, and at once when it's shown again.
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load({ quiet: true });
    }, POLL_MS);
    const shown = () => {
      if (document.visibilityState === 'visible') load({ quiet: true });
    };
    document.addEventListener('visibilitychange', shown);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [id]);

  // Everything the stream shows, older audit pages included, so every entry stays reachable.
  const seen = new Set(state.audit.map((e) => e.id));
  const audit = [...state.audit, ...older.filter((e) => !seen.has(e.id))];
  const items = streamItems(
    { signals: state.signals, audit, runs: state.runs, incidents: state.incidents },
    STREAM_MAX + older.length,
  );
  useEffect(() => {
    if (!state.updated) return;
    setFresh(arrived(shownKeys.current, items));
    shownKeys.current = new Set(items.map((i) => i.key));
  }, [state.updated]);

  const back = (
    <a class="fr-back" href={hashFor({ view: 'infrastructure', environment: null, task: null })}>
      <ArrowLeft size={16} aria-hidden="true" />
      Infrastructure
    </a>
  );
  const { env } = state;
  if (!env)
    return (
      <div class="infra-view">
        {back}
        {state.notFound ? (
          <div class="empty">
            <Server size={28} aria-hidden="true" />
            <h2>No environment here.</h2>
            <p class="muted">It may have been removed. Go back to Infrastructure to see the ones there are.</p>
          </div>
        ) : state.error ? (
          <>
            <p class="field-error" role="alert">
              Couldn’t load the environment. {state.error}
            </p>
            <div class="conn-buttons">
              <button
                type="button"
                class="btn btn-quiet btn-sm"
                onClick={() => load()}
                disabled={state.loading}
                aria-busy={state.loading}
              >
                <RefreshCw size={16} aria-hidden="true" class={state.loading ? 'spin' : ''} />
                Try again
              </button>
            </div>
          </>
        ) : (
          <p class="muted" aria-busy="true">
            Loading the environment…
          </p>
        )}
      </div>
    );

  const health = environmentHealth(state.resources);
  const run = state.runs.find((r) => r.phase !== 'done') ?? null;
  const agents = agentsAtWork(tasks.value, { env, incidents: state.incidents, plans: state.plans });
  const names = new Map(state.resources.map((r) => [r.id, r.name]));
  const cant = cantChange(env);
  const showResource = (/** @type {string} */ rid) => {
    setMode('list');
    requestAnimationFrame(() => {
      const el = document.getElementById(`infra-res-${rid}`);
      el?.scrollIntoView({ block: 'center' });
      el?.focus({ preventScroll: true });
    });
  };
  return (
    <div class="infra-view infra-page console">
      <div class="console-frame">
        <div class="console-top">
          {back}
          <div class="conn-top">
            <div class="view-intro">
              <div class="infra-env-head">
                <h1>{env.name}</h1>
                <span class="infra-kind">{KIND_LABEL[env.kind] ?? env.kind}</span>
              </div>
              <p class="meta infra-env-where">
                {repoName(env.repo)}
                {' · '}
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
                    <a href={hashFor({ task: env.task.wid ?? env.task.uuid })}>
                      {env.task.wid ?? env.task.description}
                    </a>
                  </>
                )}
              </p>
            </div>
            <div class="conn-buttons">
              {env.provider && env.target && <InventoryRefresh provider={env.provider} onDone={() => load()} />}
              <button
                type="button"
                class="btn btn-quiet btn-sm"
                onClick={() => load()}
                disabled={state.loading}
                aria-busy={state.loading}
              >
                <RefreshCw size={16} aria-hidden="true" class={state.loading ? 'spin' : ''} />
                Reload
              </button>
              <FreezeButton env={env} onChange={(updated) => setState((s) => ({ ...s, env: updated }))} />
            </div>
          </div>
        </div>

        <div class="console-grid">
          <div
            class={`console-centre ${!cant && (ch.held || ch.edits.length || ch.editing || ch.adding || ch.fromDraft) ? 'has-change' : ''}`}
          >
            <StatusBand
              env={env}
              health={health}
              cost={state.cost}
              run={run}
              agents={agents}
              inventory={{ stale: state.stale, seen: lastSeen(state.resources) }}
              change={changeTile(ch)}
            />
            <Topology
              env={env}
              resources={state.resources}
              relations={state.relations}
              plan={state.plan}
              drift={state.drift}
              signals={state.signals}
              mode={mode}
              onMode={setMode}
              change={ch.overlay(state.resources)}
              nodeActions={cant ? undefined : (r) => <NodeChange r={r} ch={ch} />}
              headActions={cant ? null : <AddResourceButton ch={ch} />}
              note={env.observeOnly ? cant : null}
              lead={<LastChange ch={ch} />}
            />
            <ChangePanel ch={ch} cant={cant} />
          </div>

          <aside class="console-side console-ops" aria-label={`What happens in ${env.name}`}>
            <StreamRail
              items={items}
              fresh={fresh}
              env={env}
              nameOf={(rid) => names.get(rid) ?? rid}
              onResource={showResource}
              more={olderMore ?? state.more}
              older={olderBusy}
              onOlder={loadOlder}
              updated={state.updated}
              error={state.error}
            />
            <IncidentsSection env={env} tick={state.tick} />
            <DeploysSection env={env} />
            <RecentDeploys env={env} />
          </aside>

          <aside class="console-side console-admin" aria-label={`Manage ${env.name}`}>
            <ActionsSection env={env} drift={state.drift} tick={state.tick} onChange={() => load({ quiet: true })} />
            <EnvironmentPlans env={env} tick={state.tick} />
            <Drift env={env} desired={state.desired} error={state.desiredError} />
            <CostSection env={env} tick={state.tick} />
            <UnownedSection env={env} />
          </aside>
        </div>
      </div>
    </div>
  );
}
