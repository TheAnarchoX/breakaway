import { useEffect, useState } from 'preact/hooks';
import { ArrowLeft, Boxes, FileCode, History, RefreshCw, Server, Target } from 'lucide-preact';
import { ago } from '../lib/model.js';
import { api, enc } from '../lib/api.js';
import { environmentId, hashFor, navOrder, repoName } from '../lib/store.js';
import { DeploysSection } from '../components/EnvironmentDeploys.jsx';
import {
  EnvironmentFlags,
  FreezeButton,
  HEALTH,
  Health,
  KIND_LABEL,
  environmentHealth,
} from './InfrastructureView.jsx';
import { IncidentsSection } from '../components/Incidents.jsx';
import { UnownedSection } from '../components/Unowned.jsx';

/**
 * An environment's page (WEB-61; docs/specs/IDEA-19-architect.md, "Views"), at #/infrastructure/<id>: its resources
 * grouped by kind, each with what it uses and what uses it, its owner, and its health (BRK-177's inventory); its
 * desired state and drift (BRK-180, BRK-184); and its audit trail, newest first (BRK-175). Cost is WEB-65's. A
 * pipeline's staging and production (BRK-195) show what's live, their recent deploys, and on production Promote and
 * Roll back, the release flow's own buttons (WEB-88).
 */

/** Audit entries a page shows at a time; Show older pages back with `before`. */
const AUDIT_PAGE = 20;

/** What each kind of audit entry says happened, in the brand's Infrastructure words. */
const AUDIT_LABEL = {
  plan: 'Plan',
  approve: 'Approved',
  reject: 'Rejected',
  apply: 'Applied',
  rollback: 'Rolled back',
  envelope: 'Inside an envelope',
  'lock-release': 'Lock released',
  'break-glass': 'Break-glass',
  freeze: 'Frozen',
  environment: 'Target changed',
  cleanup: 'Clean up',
};

/** Who acted, as the trail records it: the owner is never named. */
const ACTOR = {
  owner: 'you',
  executor: 'the executor',
  envelope: 'an envelope',
  board: 'the board',
};

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

/**
 * The resources, grouped by kind with the target's kind first, and for each what it uses and what uses it, built from
 * the inventory's relations.
 * @param {any[]} resources
 * @param {{ from: string, to: string, kind: string }[]} relations
 * @param {string | null} target the environment's target: its ID or name
 */
export function resourceGroups(resources, relations, target = null) {
  const byId = new Map(resources.map((r) => [r.id, r]));
  const name = (/** @type {string} */ id) => byId.get(id)?.name ?? id;
  const groups = new Map();
  for (const r of [...resources].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))) {
    const uses = relations
      .filter((rel) => rel.from === r.id)
      .map((rel) => ({ id: rel.to, name: name(rel.to), kind: rel.kind }));
    const usedBy = relations
      .filter((rel) => rel.to === r.id)
      .map((rel) => ({ id: rel.from, name: name(rel.from), kind: rel.kind }));
    groups.set(r.kind, [...(groups.get(r.kind) ?? []), { ...r, uses, usedBy }]);
  }
  const first = resources.find((r) => target && (r.id === target || r.name === target))?.kind;
  return [...groups]
    .sort(([a], [b]) => Number(b === first) - Number(a === first))
    .map(([kind, items]) => ({ kind, items }));
}

/** Moves focus to a resource on the page, so its relations read like links. */
function goTo(/** @type {string} */ id) {
  const el = document.getElementById(`infra-res-${id}`);
  if (!el) return;
  const reduce =
    document.documentElement.dataset.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  el.focus({ preventScroll: true });
}

/** @param {{ label: string, links: { id: string, name: string, kind: string }[] }} props */
function Relations({ label, links }) {
  if (!links.length) return null;
  return (
    <div class="infra-rel">
      <dt>{label}</dt>
      <dd>
        <ul class="infra-rel-list">
          {links.map((l) => (
            <li key={`${l.id} ${l.kind}`}>
              <button type="button" class="infra-rel-link" onClick={() => goTo(l.id)}>
                {l.name}
              </button>
              <span class="meta"> {l.kind}</span>
            </li>
          ))}
        </ul>
      </dd>
    </div>
  );
}

/** A resource's settings, as names and short values: the inventory keeps settings, never secrets' values. */
function Settings({ attrs }) {
  const entries = Object.entries(attrs ?? {});
  if (!entries.length) return null;
  return (
    <details class="infra-settings">
      <summary>
        Settings <span class="count">{entries.length}</span>
      </summary>
      <dl>
        {entries.map(([k, v]) => (
          <div key={k}>
            <dt>
              <code>{k}</code>
            </dt>
            <dd>
              <code>{typeof v === 'string' ? v : JSON.stringify(v)}</code>
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** @param {{ r: any, env: any }} props */
function Resource({ r, env }) {
  const isTarget = env.target && (r.id === env.target || r.name === env.target);
  const state = HEALTH[r.health?.state] ? r.health.state : 'unknown';
  const { label, Icon } = HEALTH[state];
  const task = r.owner?.task;
  return (
    <li class="infra-res" id={`infra-res-${r.id}`} tabIndex={-1}>
      <div class="infra-res-head">
        <h4 class="infra-res-name">{r.name}</h4>
        {isTarget && (
          <span class="infra-res-target">
            <Target size={13} aria-hidden="true" />
            Target
          </span>
        )}
        <span class={`infra-health infra-health-${state}`}>
          <Icon size={14} aria-hidden="true" />
          {label}
        </span>
      </div>
      {r.health?.text && <p class="infra-res-text">{r.health.text}</p>}
      <p class="meta infra-res-id">
        <code>{r.id}</code>
        {' · '}
        {repoName(r.owner.repo)}
        {task && (
          <>
            {' · for '}
            <a href={hashFor({ task: task.wid ?? task.uuid })}>{task.wid ?? task.description}</a>
          </>
        )}
        {r.health?.at ? ' · checked ' : ' · seen '}
        <When iso={r.health?.at ?? r.seen} />
      </p>
      {(r.uses.length > 0 || r.usedBy.length > 0) && (
        <dl class="infra-rels">
          <Relations label="Uses" links={r.uses} />
          <Relations label="Used by" links={r.usedBy} />
        </dl>
      )}
      <Settings attrs={r.attrs} />
    </li>
  );
}

/** @param {{ env: any, desired: any, error: string | null }} props */
function Drift({ env, desired, error }) {
  const file = `.github/breakaway-infra/${env.name}.json`;
  const compared = typeof env.driftCount === 'number';
  return (
    <section class="infra-section" aria-labelledby="infra-drift">
      <h2 id="infra-drift">
        <FileCode size={18} aria-hidden="true" />
        Desired state and drift
      </h2>
      {error ? (
        <p class="field-error" role="alert">
          {error}
        </p>
      ) : !desired ? (
        <p class="muted">
          {env.observeOnly
            ? 'It’s observe only: the board watches it and never changes it, so it takes no desired state.'
            : 'No desired state yet. Add '}
          {!env.observeOnly && (
            <>
              <code>{file}</code> to the repository’s default branch by pull request, and the board compares it with
              what runs.
            </>
          )}
        </p>
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

/**
 * What the deploy flow recorded (BRK-195), from its summary's first words: it deploys, never applies, so its entries
 * read in the release flow's words.
 */
const DEPLOY_LABEL = { Deploy: 'Deployed', Promote: 'Promoted', 'Roll back': 'Rolled back' };

/**
 * An entry's label and outcome in words.
 * @param {any} e
 */
function auditWords(e) {
  if (e.kind === 'freeze') return { label: e.outcome === 'off' ? 'Unfrozen' : AUDIT_LABEL.freeze, outcome: '' };
  const flow = /^(Deploy|Promote|Roll back) of /u.exec(e.summary ?? '')?.[1];
  if (!flow || (e.kind !== 'apply' && e.kind !== 'rollback'))
    return { label: AUDIT_LABEL[e.kind] ?? e.kind, outcome: e.outcome };
  if (e.outcome === 'failed') return { label: `${flow} failed`, outcome: '' };
  // A deploy whose health check failed, and the version before came back by itself.
  if (e.outcome === 'rolled back') return { label: 'Rolled back', outcome: `${flow.toLowerCase()} failed its check` };
  return { label: DEPLOY_LABEL[flow], outcome: '' };
}

/** @param {{ e: any }} props */
function AuditEntry({ e }) {
  const iso = new Date(e.at).toISOString();
  const { label, outcome } = auditWords(e);
  const who = e.by === 'agent' ? (e.agent ?? 'an agent') : (ACTOR[e.by] ?? e.by);
  return (
    <li class={`infra-audit-entry infra-audit-${e.kind}`}>
      <div class="infra-audit-head">
        <span class="infra-audit-kind">{label}</span>
        {outcome && <span class="meta">{outcome}</span>}
        <span class="meta infra-audit-when">
          <When iso={iso} />
        </span>
      </div>
      {e.summary && <p class="infra-audit-summary">{e.summary}</p>}
      <p class="meta">
        By {who}
        {e.plan && (
          <>
            {' · '}
            <code>{e.plan}</code>
          </>
        )}
        {e.envelope && (
          <>
            {' · envelope '}
            <code>{e.envelope}</code>
          </>
        )}
      </p>
    </li>
  );
}

export function EnvironmentView() {
  const id = environmentId.value;
  const [state, setState] = useState(
    /** @type {{ env: any, resources: any[], relations: any[], desired: any, desiredError: string | null, audit: any[], more: boolean, error: string | null, notFound: boolean, loading: boolean }} */ ({
      env: null,
      resources: [],
      relations: [],
      desired: null,
      desiredError: null,
      audit: [],
      more: false,
      error: null,
      notFound: false,
      loading: true,
    }),
  );
  const [older, setOlder] = useState(false);
  const load = async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const { environment } = await api(`infra/environments/${enc(id)}`);
      const [inventory, audit, desired] = await Promise.all([
        api(`infra/inventory?environment=${enc(id)}`),
        api(`infra/audit?environmentId=${enc(id)}&limit=${AUDIT_PAGE}`),
        api(`infra/desired/${enc(id)}`).then(
          (d) => ({ desired: d.desired, error: null }),
          (err) => (err.status === 404 ? { desired: null, error: null } : { desired: null, error: err.message }),
        ),
      ]);
      setState({
        env: environment,
        resources: inventory.resources,
        relations: inventory.relations,
        desired: desired.desired,
        desiredError: desired.error,
        audit: audit.entries,
        more: audit.more,
        error: null,
        notFound: false,
        loading: false,
      });
    } catch (error) {
      setState((s) => ({ ...s, error: error.message, notFound: error.status === 404, loading: false }));
    }
  };
  const loadOlder = async () => {
    const last = state.audit.at(-1);
    if (!last) return;
    setOlder(true);
    try {
      const { entries, more } = await api(
        `infra/audit?environmentId=${enc(id)}&limit=${AUDIT_PAGE}&before=${enc(last.id)}`,
      );
      setState((s) => ({ ...s, audit: [...s.audit, ...entries], more }));
    } catch (error) {
      setState((s) => ({ ...s, error: error.message }));
    } finally {
      setOlder(false);
    }
  };
  useEffect(() => {
    navOrder.value = [];
    load();
  }, [id]);

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
          <p class="field-error" role="alert">
            {state.error}
          </p>
        ) : (
          <p class="muted" aria-busy="true">
            Loading the environment…
          </p>
        )}
      </div>
    );

  const groups = resourceGroups(state.resources, state.relations, env.target);
  const health = environmentHealth(state.resources);
  return (
    <div class="infra-view infra-page">
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
                <a href={hashFor({ task: env.task.wid ?? env.task.uuid })}>{env.task.wid ?? env.task.description}</a>
              </>
            )}
          </p>
        </div>
        <div class="conn-buttons">
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
          <FreezeButton env={env} onChange={(updated) => setState((s) => ({ ...s, env: updated }))} />
        </div>
      </div>
      {state.error && (
        <p class="field-error" role="alert">
          {state.error}
        </p>
      )}
      <div class="infra-page-status">
        <Health health={env.target ? health : null} />
        <EnvironmentFlags env={env} />
      </div>

      <DeploysSection env={env} />

      <IncidentsSection env={env} />

      <section class="infra-section" aria-labelledby="infra-resources">
        <h2 id="infra-resources">
          <Boxes size={18} aria-hidden="true" />
          Resources {state.resources.length > 0 && <span class="count">{state.resources.length}</span>}
        </h2>
        {groups.length ? (
          groups.map((g) => (
            <section key={g.kind} class="infra-kind-group" aria-labelledby={`infra-kind-${g.kind}`}>
              <h3 id={`infra-kind-${g.kind}`}>
                {g.kind} <span class="count">{g.items.length}</span>
              </h3>
              <ul class="infra-res-list">
                {g.items.map((r) => (
                  <Resource key={r.id} r={r} env={env} />
                ))}
              </ul>
            </section>
          ))
        ) : (
          <p class="muted">
            {env.target ? (
              <>
                Nothing seen yet. The board lists what runs here once its provider is connected on{' '}
                <a href={hashFor({ view: 'connections', environment: null, task: null })}>Connections</a> and it has
                looked: give it a minute, then reload.
              </>
            ) : (
              'No target yet, so the board sees nothing here. Give the environment a target, like a Worker’s name, and the board lists it and everything it uses.'
            )}
          </p>
        )}
      </section>

      <UnownedSection env={env} />

      <Drift env={env} desired={state.desired} error={state.desiredError} />

      <section class="infra-section" aria-labelledby="infra-audit">
        <h2 id="infra-audit">
          <History size={18} aria-hidden="true" />
          Recent changes
        </h2>
        {state.audit.length ? (
          <>
            <ol class="infra-audit">
              {state.audit.map((e) => (
                <AuditEntry key={e.id} e={e} />
              ))}
            </ol>
            {state.more && (
              <button
                type="button"
                class="btn btn-quiet btn-sm infra-audit-more"
                onClick={loadOlder}
                disabled={older}
                aria-busy={older}
              >
                {older ? 'Loading…' : 'Show older'}
              </button>
            )}
          </>
        ) : (
          <p class="muted">
            Nothing yet. Every plan, approval, apply, freeze, and change inside an envelope shows here, and stays for at
            least a year.
          </p>
        )}
      </section>
    </div>
  );
}
