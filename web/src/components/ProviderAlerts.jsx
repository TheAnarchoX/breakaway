import { Fragment } from 'preact';
import { useState } from 'preact/hooks';
import { CircleCheck, CircleDashed, CircleOff, RefreshCw } from 'lucide-preact';
import { api, enc } from '../lib/api.js';
import { hashFor } from '../lib/store.js';

/**
 * Which of a provider's alerts reach the board (WEB-91), under its row on Connections: read live from
 * GET /api/infra/alerts (BRK-191) with the board's read-only token when you open it, so loading Connections asks the
 * provider nothing. Read only: setting up an alert is in the provider's dashboard, and the board says how.
 *
 * `connected` says whether the board holds a token for it.
 * @param {{ id: string, name: string, connected: boolean }} props
 */
export function ProviderAlerts({ id, name, connected }) {
  const [state, setState] = useState(
    /** @type {{ busy?: boolean, data?: any, error?: string, missing?: string[] }} */ ({}),
  );

  const load = async () => {
    setState({ busy: true });
    try {
      setState({ data: await api(`infra/alerts?provider=${enc(id)}`) });
    } catch (err) {
      setState({ error: err.message, missing: Array.isArray(err.data?.missing) ? err.data.missing : [] });
    }
  };

  const toggle = (e) => {
    if (connected && e.currentTarget.open && !state.data && !state.busy && !state.error) load();
  };

  return (
    <details class="conn-items conn-alerts" onToggle={toggle}>
      <summary>Which alerts reach the board</summary>
      <div class="conn-alerts-body" aria-live="polite">
        {!connected ? (
          <p class="muted">Paste {name}’s read-only token first: the board reads its alerts with it.</p>
        ) : state.busy ? (
          <p class="muted">Reading {name}’s alerts…</p>
        ) : state.error ? (
          <AlertsError name={name} error={state.error} missing={state.missing} onRetry={load} />
        ) : state.data ? (
          <AlertsSetup name={name} setup={state.data} onRefresh={load} />
        ) : null}
      </div>
    </details>
  );
}

/** The read failed: a permission the token lacks, or the provider didn't answer. */
function AlertsError({ name, error, missing, onRetry }) {
  return (
    <div class="conn-fix">
      {missing?.length ? (
        <p>
          <strong>To fix it:</strong> the token can’t read {name}’s alerts. Make a token with {missing.join(' and ')}{' '}
          too, on {name}, then replace the token above.
        </p>
      ) : (
        <p>{error}</p>
      )}
      <button type="button" class="btn btn-outline btn-sm" onClick={onRetry}>
        <RefreshCw size={15} aria-hidden="true" />
        Try again
      </button>
    </div>
  );
}

/** What fires a routine here, and how to send an alert when nothing does. */
function HowTo({ name }) {
  return (
    <p>
      <strong>To send one:</strong> on <a href={hashFor({ view: 'routines', routine: null })}>Routines</a>, add a
      trigger to the routine that should look into it. Then in {name}’s dashboard, under Notifications, add a webhook
      with the routine’s fire URL and the trigger’s secret, and a policy for the alert that sends to that webhook.
    </p>
  );
}

/** A routine on the board a policy fires, as a link to it. */
function RoutineLink({ slug }) {
  return (
    <a href={hashFor({ view: 'routines', routine: slug })}>
      <code>{slug}</code>
    </a>
  );
}

/**
 * The alert types: those with a policy first, each with its policies and the routines they fire; the rest folded.
 * @param {{ name: string, setup: { alerts: any[], policies: any[], webhooks: { toBoard: number, other: number } }, onRefresh: () => any }} props
 */
function AlertsSetup({ name, setup, onRefresh }) {
  const used = setup.alerts.filter((a) => a.policies > 0);
  const unused = setup.alerts.filter((a) => a.policies === 0);
  const reaching = used.filter((a) => a.reachesBoard).length;
  const { toBoard } = setup.webhooks;
  return (
    <>
      <p class="conn-alerts-sum">
        {reaching
          ? `${reaching} of ${setup.alerts.length} alert types reach the board.`
          : `None of ${name}’s alerts reach the board yet.`}{' '}
        {toBoard > 0 && (
          <span class="muted">{toBoard === 1 ? '1 webhook points' : `${toBoard} webhooks point`} at the board.</span>
        )}
      </p>
      {!setup.policies.length && <p class="muted">{name} has no notification policies yet.</p>}
      {!reaching && (
        <div class="conn-fix">
          <HowTo name={name} />
        </div>
      )}
      {used.length > 0 && (
        <ul>
          {used.map((a) => (
            <AlertRow key={a.type} alert={a} policies={setup.policies.filter((p) => p.alertType === a.type)} />
          ))}
        </ul>
      )}
      {unused.length > 0 && (
        <details class="conn-alerts-more">
          <summary>{unused.length === 1 ? '1 alert type' : `${unused.length} alert types`} with no policy</summary>
          <ul>
            {unused.map((a) => (
              <li key={a.type}>
                <CircleOff size={15} aria-hidden="true" />
                <span>
                  {a.name}
                  <span class="muted">, {a.product}: doesn’t reach the board</span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {reaching > 0 && (
        <details class="conn-alerts-more">
          <summary>How to send another</summary>
          <HowTo name={name} />
        </details>
      )}
      <p>
        <button type="button" class="btn btn-quiet btn-sm" onClick={onRefresh}>
          <RefreshCw size={15} aria-hidden="true" />
          Read again<span class="visually-hidden"> {name}’s alerts</span>
        </button>
      </p>
    </>
  );
}

/** One alert type with a policy: whether it reaches the board, and each policy with the routines it fires. */
function AlertRow({ alert, policies }) {
  const Icon = alert.reachesBoard ? CircleCheck : CircleDashed;
  return (
    <li class={alert.reachesBoard ? '' : 'is-off'}>
      <Icon size={15} aria-hidden="true" />
      <span>
        <strong>{alert.name}</strong>
        <span class="muted">, {alert.product}: </span>
        {alert.reachesBoard ? 'reaches the board' : 'doesn’t reach the board'}
        <ul class="conn-alerts-policies">
          {policies.map((p) => (
            <li key={p.name}>
              {p.name || 'An unnamed policy'}
              {!p.enabled ? (
                <span class="muted"> is off</span>
              ) : p.routines.length ? (
                <>
                  <span class="muted"> fires </span>
                  {p.routines.map((slug, i) => (
                    <Fragment key={slug}>
                      {i > 0 && ', '}
                      <RoutineLink slug={slug} />
                    </Fragment>
                  ))}
                </>
              ) : (
                <span class="muted"> sends nowhere on the board</span>
              )}
              {!p.enabled && p.routines.length > 0 && (
                <span class="muted"> (it would fire {p.routines.join(', ')})</span>
              )}
            </li>
          ))}
        </ul>
      </span>
    </li>
  );
}
