/**
 * TaskStore's envelopes (docs/specs/IDEA-19-architect.md, "Envelopes"; BRK-186): bounds the owner approves once on one
 * environment, production included (BRK-171), kept on the board and never in the repository, so a pull request can't
 * widen them. Setting, changing, and revoking one are the owner's alone: the worker refuses the bearer token agents and
 * the CLI hold, and an agent's `by` is refused here as a second line.
 *
 * An act asks for one scale or restart. Only an agent running a runbook (BRK-196) asks, for the run it holds, or the
 * board itself. The board builds the plan from what the provider discovers, never from the request's body: a scale is
 * the resource's scaled setting moved to the value asked for, a restart is the resource as it is. Inside the envelope,
 * the plan is approved by the envelope and the executor (BRK-183) applies it with no press; the act is in the audit
 * trail and noted quietly in the inbox, on the runbook's task. Outside, or once the restart cap is used up, the plan
 * waits for the owner, with its push. A frozen or observe-only environment refuses every act.
 */
import { AgentError } from './store-agents.js';
import { InputError, resolveRef } from './model.js';
import { install } from './install.js';
import { runsTheBoard } from './infra-environments.js';
import { declares } from './infra-provider.js';
import { HOURS_MAX, checkAct, checkEnvelope, envelopeWords, judgeChange, windowWords } from './infra-envelopes.js';

/** @typedef {import('./infra-envelopes.js').Envelope} Envelope */

const HOUR_MS = 3_600_000;
/** The most acts an environment keeps: plenty for any restart window. */
export const ACTS_KEPT = 500;

/** Whether `by` is the owner's: none, or `owner`. Anything else is an agent's name, and is refused. */
const owners = (by) => by === undefined || by === null || by === '' || by === 'owner';

/** What the audit trail calls an environment's envelope. */
const envelopeRef = (env) => `envelope-${env.id}`;

/** A whole number's unit from the setting it is: `instances` stays, `max_instances` and `maxInstances` read "max instances". */
const unit = (setting) =>
  String(setting ?? '')
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/_/gu, ' ')
    .toLowerCase();

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraEnvelopesMethods = {
  initInfraEnvelopes() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS infra_envelopes (
        environment INTEGER PRIMARY KEY, repo TEXT NOT NULL, envelope TEXT NOT NULL,
        created INTEGER NOT NULL, edited INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS infra_envelope_acts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, environment INTEGER NOT NULL, at INTEGER NOT NULL,
        change TEXT NOT NULL, resource TEXT NOT NULL, inside INTEGER NOT NULL, plan TEXT, agent TEXT, why TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS infra_envelope_acts_by_environment ON infra_envelope_acts (environment, change, at);
    `);
  },

  /**
   * An environment's envelope, or null when it has none.
   * @returns {Envelope | null}
   */
  infraEnvelopeFor(environmentId) {
    const row = this.sql.exec('SELECT envelope FROM infra_envelopes WHERE environment = ?', environmentId).toArray()[0];
    return row ? JSON.parse(row.envelope) : null;
  },

  /** How many restarts applied inside an environment's envelope in its window, as of `now`. */
  envelopeRestartsUsed(environmentId, hours, now = Date.now()) {
    return Number(
      this.sql
        .exec(
          "SELECT COUNT(*) AS n FROM infra_envelope_acts WHERE environment = ? AND change = 'restart' AND inside = 1 AND at > ?",
          environmentId,
          now - hours * HOUR_MS,
        )
        .one().n,
    );
  },

  /**
   * What the owner can bound on an environment, for the board's form (WEB-64): its provider's kinds that scale, each
   * with the setting a scale changes, and why an envelope can't be set there now, or null when it can.
   * @returns {{ scalable: { kind: string, setting: string }[], blocked: string | null }}
   */
  envelopeScope(env) {
    try {
      const { provider } = this.envelopeEnvironment(env.id, env.repo);
      const scalable = Object.entries(provider.kinds)
        .filter(([, spec]) => spec.changes.includes('scale') && spec.scales)
        .map(([kind, spec]) => ({ kind, setting: /** @type {string} */ (spec.scales) }));
      return { scalable, blocked: null };
    } catch (error) {
      if (error instanceof AgentError) return { scalable: [], blocked: error.message };
      throw error;
    }
  },

  /** An environment's envelope as the API shows it, with the restarts its cap has used. */
  envelopeOut(env) {
    const row = this.sql.exec('SELECT * FROM infra_envelopes WHERE environment = ?', env.id).toArray()[0];
    const envelope = row ? JSON.parse(row.envelope) : null;
    const acts = this.sql
      .exec('SELECT * FROM infra_envelope_acts WHERE environment = ? ORDER BY id DESC LIMIT 20', env.id)
      .toArray()
      .map((a) => ({
        at: new Date(Number(a.at)).toISOString(),
        change: a.change,
        resource: a.resource,
        inside: Boolean(a.inside),
        plan: a.plan ?? null,
        agent: a.agent ?? null,
        why: a.why,
      }));
    return {
      repo: env.repo,
      environment: { id: Number(env.id), name: env.name, kind: env.kind },
      envelope,
      words: envelope ? envelopeWords(envelope) : null,
      restartsUsed: envelope ? this.envelopeRestartsUsed(env.id, envelope.restarts.hours) : 0,
      created: row ? new Date(Number(row.created)).toISOString() : null,
      edited: row ? new Date(Number(row.edited)).toISOString() : null,
      acts,
      ...this.envelopeScope(env),
    };
  },

  /** The environment an envelope is for: one Architect may change, on a connected provider. */
  envelopeEnvironment(ref, repo) {
    const env = this.environmentRow(ref, repo);
    if (env.observe_only || runsTheBoard(env, install(this.env).worker))
      throw new AgentError(`${env.name} is observe only: Architect watches it and never changes it`, 409);
    if (!env.provider) throw new AgentError(`${env.name} has no provider: pick one on the board first`, 409);
    const registry = this.infraRegistry();
    if (!registry.has(env.provider))
      throw new AgentError(`${env.provider} isn’t connected, so ${env.name} can’t have an envelope yet`, 409);
    return { env, provider: registry.get(env.provider) };
  },

  /**
   * Sets or changes an environment's envelope: the owner's approval, once, of the bounds. Audited as `envelope`.
   * @param {string | number} ref the environment's ID or name
   * @param {{ repo?: string | null, envelope: unknown, by?: string }} input
   */
  setInfraEnvelope(ref, { repo = null, envelope, by }) {
    if (!owners(by)) throw new AgentError('only the owner sets an envelope, from the board', 403);
    const { env, provider } = this.envelopeEnvironment(ref, repo);
    let kept;
    try {
      kept = checkEnvelope(envelope, provider.kinds);
    } catch (error) {
      if (error instanceof InputError) throw new AgentError(error.message, 400);
      throw error;
    }
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const had = this.sql.exec('SELECT 1 FROM infra_envelopes WHERE environment = ?', env.id).toArray().length > 0;
      this.sql.exec(
        `INSERT INTO infra_envelopes (environment, repo, envelope, created, edited) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (environment) DO UPDATE SET envelope = excluded.envelope, edited = excluded.edited`,
        env.id,
        env.repo,
        JSON.stringify(kept),
        now,
        now,
      );
      this.appendInfraAudit({
        kind: 'envelope',
        repo: env.repo,
        environment: env.name,
        environmentId: env.id,
        envelope: envelopeRef(env),
        by: 'owner',
        outcome: had ? 'changed' : 'set',
        summary: `${had ? 'changed' : 'set'} by the owner: ${envelopeWords(kept)}`,
      });
    });
    return this.envelopeOut(env);
  },

  /** Revokes an environment's envelope: from now on every scale and restart waits for the owner. */
  revokeInfraEnvelope(ref, { repo = null, by } = {}) {
    if (!owners(by)) throw new AgentError('only the owner revokes an envelope, from the board', 403);
    const env = this.environmentRow(ref, repo);
    this.ctx.storage.transactionSync(() => {
      const row = this.sql.exec('SELECT envelope FROM infra_envelopes WHERE environment = ?', env.id).toArray()[0];
      if (!row) throw new AgentError(`${env.name} has no envelope`, 404);
      this.sql.exec('DELETE FROM infra_envelopes WHERE environment = ?', env.id);
      this.appendInfraAudit({
        kind: 'envelope',
        repo: env.repo,
        environment: env.name,
        environmentId: env.id,
        envelope: envelopeRef(env),
        by: 'owner',
        outcome: 'revoked',
        summary: `revoked by the owner; every scale and restart waits for you again (was ${envelopeWords(JSON.parse(row.envelope))})`,
      });
    });
    return this.envelopeOut(env);
  },

  /**
   * The runbook run an agent acts for: a pending task it holds, made by a routine with a signal trigger (BRK-196), in
   * the environment's repository. Any other task, or none, is refused: acting is a runbook's, not any agent's.
   * @param {unknown} task the run's work ID or UUID
   * @param {string} agent
   * @param {string} repo the environment's repository
   */
  envelopeRunbookTask(task, agent, repo) {
    const uuid = task ? resolveRef(String(task), this.tasks) : null;
    const map = uuid ? this.tasks.get(uuid) : null;
    const id = map?.wid ?? String(task ?? '').slice(0, 40);
    if (!map)
      throw new AgentError('name the runbook run you hold as task: only a runbook’s agent acts in an envelope', 403);
    if (map.status !== 'pending' || map.claim !== agent)
      throw new AgentError(`${id} isn’t a run you hold: claim it first`, 403);
    const runbook = this.sql
      .exec(
        'SELECT r.slug FROM routine_runs r JOIN infra_runbooks b ON b.slug = r.slug WHERE r.task = ? AND b.enabled = 1 LIMIT 1',
        uuid,
      )
      .toArray()[0];
    if (!runbook) throw new AgentError(`${id} isn’t a runbook’s run: only a runbook’s agent acts in an envelope`, 403);
    if (this.repoOfTask(map)?.slug !== repo)
      throw new AgentError(`${id} is another repository’s, and the environment is ${repo}’s`, 403);
    return { uuid, wid: map.wid ?? null };
  },

  /**
   * One scale or restart, asked for by a runbook's agent or the board: inside the environment's envelope it's approved
   * by the envelope and the executor applies it; otherwise it's a plan that waits for the owner, with its push.
   * @param {string | number} ref the environment's ID or name
   * @param {{ repo?: string | null, resource: string, change: 'scale' | 'restart', value: number | null,
   *   by: 'board' | 'agent', agent?: string | null, task?: { uuid: string, wid: string | null } | null,
   *   rule?: string | null }} input `rule` names the scaling rule (BRK-241) the board acts for
   */
  async actInEnvelope(ref, { repo = null, resource, change, value, by, agent = null, task = null, rule = null }) {
    const { env, provider } = this.envelopeEnvironment(ref, repo);
    if (env.frozen)
      throw new AgentError(
        `${env.name} is frozen: nothing changes there, envelopes included, until the owner unfreezes it`,
        409,
      );
    const ctx = {
      environment: env.name,
      scope: { target: env.target },
      observeOnly: false,
      token: (await this.providerReadToken(env.provider)) ?? undefined,
    };
    let found;
    try {
      found = await provider.discover(ctx);
    } catch (error) {
      throw new AgentError(`${provider.name} couldn’t say what runs in ${env.name}: ${error?.message ?? error}`, 502);
    }
    const matches = (found?.resources ?? []).filter((r) => r.id === resource || r.name === resource);
    const exact = matches.find((r) => r.id === resource);
    if (!exact && matches.length > 1)
      throw new AgentError(`${matches.length} resources in ${env.name} are called ${resource}: name it by its ID`, 409);
    const r = exact ?? matches[0];
    if (!r) throw new AgentError(`${env.name} has no resource ${resource}`, 404);
    const refused =
      provider.refuses?.(r, change) ??
      (declares(provider, r.kind, change) ? null : `a ${r.kind} can’t ${change} on ${provider.name}`);
    if (refused) throw new AgentError(`${refused}, so nothing was planned`, 409);
    const attrs = structuredClone(r.attrs ?? {});
    const scales = provider.kinds[r.kind]?.scales;
    if (change === 'scale' && attrs[scales] === value)
      throw new AgentError(`${r.name} already runs ${value} ${unit(scales)}: there’s nothing to change`, 409);
    const diff = {
      provider: provider.id,
      environment: env.name,
      changes: [
        {
          op: change,
          resource: r.id,
          kind: r.kind,
          name: r.name,
          before: attrs,
          after: change === 'scale' ? { ...attrs, [scales]: value } : structuredClone(attrs),
          reversible: true,
        },
      ],
      reversible: true,
    };
    const asked = by === 'agent' ? { by: 'agent', agent } : { by: 'board', agent: null };
    const made = await this.makeInfraPlan(env.id, {
      repo: env.repo,
      source: 'envelope',
      sourceRef: task?.wid ?? (rule ? 'scaling.json' : null),
      ...asked,
      diff,
    });

    // From here the decision and its record are one step, so two acts at once can't both take the cap's last restart.
    const now = Date.now();
    const envelope = this.infraEnvelopeFor(env.id);
    const used = envelope ? this.envelopeRestartsUsed(env.id, envelope.restarts.hours, now) : 0;
    const verdict = judgeChange(envelope, made.diff.changes[0], {
      scales,
      costAfter: made.cost?.after ?? null,
      currency: made.cost?.currency ?? this.infraCurrency().currency,
      restartsUsed: used,
    });
    const what = change === 'scale' ? `scale ${r.name} to ${value} ${unit(scales)}` : `restart ${r.name}`;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        'INSERT INTO infra_envelope_acts (environment, at, change, resource, inside, plan, agent, why) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        env.id,
        now,
        change,
        r.id,
        verdict.inside ? 1 : 0,
        made.id,
        agent,
        verdict.why,
      );
      // A restart inside the envelope stays while any window could count it (HOURS_MAX), so many acts can't push the
      // ones that used the cap out and let more restarts through (BRK-229).
      this.sql.exec(
        `DELETE FROM infra_envelope_acts WHERE environment = ?
           AND id NOT IN (SELECT id FROM infra_envelope_acts WHERE environment = ? ORDER BY id DESC LIMIT ?)
           AND NOT (change = 'restart' AND inside = 1 AND at > ?)`,
        env.id,
        env.id,
        ACTS_KEPT,
        now - HOURS_MAX * HOUR_MS,
      );
      this.appendInfraAudit({
        kind: 'envelope',
        repo: env.repo,
        environment: env.name,
        environmentId: env.id,
        plan: made.id,
        envelope: envelopeRef(env),
        ...asked,
        outcome: verdict.inside ? 'inside' : verdict.capUsed ? 'cap used' : 'outside',
        summary: `${what}${task?.wid ? ` for ${task.wid}` : rule ? ` for the scaling rule “${rule}”` : ''}: ${verdict.inside ? 'inside its envelope' : 'waits for the owner'}, ${verdict.why}`,
      });
    });

    let plan = made;
    if (plan.state === 'draft') {
      if (verdict.inside) {
        this.moveInfraPlan(plan.id, 'waiting', { by: 'envelope', summary: `inside its envelope: ${verdict.why}` });
        plan = await this.approveInfraPlan(plan.id, {
          by: 'envelope',
          summary: `approved by its envelope, set by the owner: ${verdict.why}`,
        });
      } else {
        const production = env.kind === 'production' ? ' in production' : '';
        const reason = verdict.capUsed
          ? `A restart waits for you${production} · ${r.name} used its ${envelope?.restarts.cap} restart${envelope?.restarts.cap === 1 ? '' : 's'} ${envelope?.restarts.hours === 24 ? 'today' : `in ${windowWords(envelope?.restarts.hours)}`}.`
          : `Outside its envelope: ${verdict.why}.`;
        plan = await this.waitForOwner(plan.id, {
          by: 'board',
          summary: `outside its envelope: ${verdict.why}`,
          reason,
        });
      }
    }
    if (task)
      await this.boardPing(
        task.uuid,
        'envelope',
        verdict.inside
          ? `${what[0].toUpperCase()}${what.slice(1)} in ${env.name}, inside its envelope: ${plan.id} applies without a press.`
          : `${what[0].toUpperCase()}${what.slice(1)} in ${env.name} waits for the owner as ${plan.id}: ${verdict.why}.`,
        { quiet: true },
      );
    return { inside: verdict.inside, why: verdict.why, plan };
  },

  /** GET /api/infra/envelopes[?repo=]: every environment Architect may change, with its envelope or none. */
  envelopesApi({ repo } = {}) {
    return this.run(async () => {
      const slug = repo ? String(repo).trim().toLowerCase() : null;
      const rows = this.sql
        .exec(
          `SELECT * FROM infra_environments ${slug ? 'WHERE repo = ?' : ''} ORDER BY repo, name`,
          ...(slug ? [slug] : []),
        )
        .toArray()
        .filter((env) => !env.observe_only && !runsTheBoard(env, install(this.env).worker));
      return { status: 200, body: { envelopes: rows.map((env) => this.envelopeOut(env)) } };
    });
  },

  /** GET /api/infra/envelopes/<environment>: one environment's envelope, its restarts used, and its last acts. */
  envelopeApi(ref, { repo } = {}) {
    return this.run(async () => {
      const env = this.environmentRow(ref, repo ? String(repo).trim().toLowerCase() : null);
      return { status: 200, body: this.envelopeOut(env) };
    });
  },

  /** PUT /api/infra/envelopes/<environment>: the owner sets or changes it, from the signed-in board only. */
  envelopeSetApi(ref, body = {}) {
    return this.run(async () => ({
      status: 200,
      body: this.setInfraEnvelope(ref, {
        repo: body.repo ? String(body.repo).trim().toLowerCase() : null,
        envelope: body.envelope,
        by: body.by,
      }),
    }));
  },

  /** DELETE /api/infra/envelopes/<environment>: the owner revokes it, from the signed-in board only. */
  envelopeRevokeApi(ref, body = {}) {
    return this.run(async () => ({
      status: 200,
      body: this.revokeInfraEnvelope(ref, {
        repo: body.repo ? String(body.repo).trim().toLowerCase() : null,
        by: body.by,
      }),
    }));
  },

  /**
   * POST /api/infra/envelopes/<environment>/act: a runbook's agent asks for one scale or restart, for the run it holds
   * (`task`). The body is only { resource, change, value, task, by }; the board builds the plan.
   */
  envelopeActApi(ref, body = {}) {
    return this.run(async () => {
      if (owners(body.by))
        throw new AgentError(
          'an act is a runbook’s agent’s: name yourself as by. The owner approves plans instead',
          403,
        );
      const agent = String(body.by);
      let asked;
      try {
        asked = checkAct({ resource: body.resource, change: body.change, value: body.value });
      } catch (error) {
        if (error instanceof InputError) throw new AgentError(error.message, 400);
        throw error;
      }
      const env = this.environmentRow(ref, body.repo ? String(body.repo).trim().toLowerCase() : null);
      const task = this.envelopeRunbookTask(body.task, agent, env.repo);
      const act = await this.actInEnvelope(env.id, { repo: env.repo, ...asked, by: 'agent', agent, task });
      return { status: 200, body: { act } };
    });
  },
};
