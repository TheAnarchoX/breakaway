/**
 * TaskStore's inventory (docs/specs/IDEA-19-architect.md, "Inventory"; BRK-177): what actually exists in each
 * environment, from its provider's `discover`, with relations, ownership (the environment's repository, the task that
 * owns a short-lived one, and the environment), last health from `observe`, and last cost from `cost`. A refresh
 * replaces one provider's slice in one transaction: a resource the provider no longer reports is dropped, and a failed
 * discovery changes nothing. Nothing outside an environment's scope is stored (infra-inventory.js). Anyone signed in
 * reads it; a refresh is the owner's or the board's (an agent's `by` is refused).
 */
import { AgentError } from './store-agents.js';
import { install } from './install.js';
import { redact } from './redact.js';
import { checkCosts, checkDiscovery, checkHealth } from './infra-provider.js';
import { MAX_RESOURCES, redactAttrs, resourceView, scopeDiscovery } from './infra-inventory.js';
import { runsTheBoard } from './infra-environments.js';

/** @typedef {import('./infra-provider.js').ProviderRegistry} ProviderRegistry */

/** A call that may fail without failing the refresh: health and cost keep their last values instead. */
async function tryCall(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const infraInventoryMethods = {
  initInfraInventory() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS infra_inventory (
        environment INTEGER NOT NULL, provider TEXT NOT NULL, rid TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
        attrs TEXT, health TEXT, health_at INTEGER, health_text TEXT, cost REAL, currency TEXT, seen INTEGER NOT NULL,
        PRIMARY KEY (environment, rid)
      );
      CREATE INDEX IF NOT EXISTS infra_inventory_provider ON infra_inventory (provider);
      CREATE TABLE IF NOT EXISTS infra_inventory_relations (
        environment INTEGER NOT NULL, provider TEXT NOT NULL, from_rid TEXT NOT NULL, to_rid TEXT NOT NULL,
        kind TEXT NOT NULL, PRIMARY KEY (environment, from_rid, to_rid, kind)
      );
      CREATE INDEX IF NOT EXISTS infra_inventory_relations_provider ON infra_inventory_relations (provider);
    `);
  },

  /**
   * Discovers what exists in every environment on `providerId` and replaces that provider's slice of the inventory
   * in one transaction. Every environment is discovered before anything is written, so a discovery that fails leaves
   * the inventory as it was. Health and cost are best effort: when `observe` or `cost` fails, a resource keeps its
   * last values.
   * @param {string} providerId
   * @param {{ registry?: ProviderRegistry }} [options] tests pass a registry with the fake provider
   */
  async refreshInventory(providerId, options = {}) {
    const registry = options.registry ?? this.infraRegistry();
    if (!registry.has(providerId))
      throw new AgentError(`no provider ${String(providerId).slice(0, 40)} is connected`, 404);
    const provider = registry.get(providerId);
    const token = (await this.providerReadToken(providerId)) ?? undefined;
    const worker = install(this.env).worker;
    const environments = this.sql
      .exec('SELECT * FROM infra_environments WHERE provider = ? ORDER BY id', providerId)
      .toArray();
    const slices = [];
    /** @type {Set<string>} */
    const missing = new Set();
    for (const environment of environments) {
      if (!environment.target) continue;
      const ctx = {
        environment: environment.name,
        scope: { target: environment.target },
        observeOnly: Boolean(environment.observe_only) || runsTheBoard(environment, worker),
        token,
      };
      let found;
      try {
        const discovered = checkDiscovery(provider, await provider.discover(ctx));
        for (const name of discovered.missing ?? []) missing.add(name);
        found = scopeDiscovery(discovered, environment.target);
      } catch (error) {
        const message = `${provider.name} couldn’t discover ${environment.repo}’s ${environment.name}: ${redact(error?.message ?? error)}`;
        await this.infraConnectionSeen(providerId, 'discovery', {
          ok: false,
          error: message,
          missing: typeof error?.permission === 'string' ? [error.permission] : [],
        });
        throw new AgentError(`${message}. Nothing changed; try again once the provider answers.`, 502);
      }
      if (found.resources.length > MAX_RESOURCES)
        throw new AgentError(
          `${environment.name} has ${found.resources.length} resources in scope, more than ${MAX_RESOURCES}: point its target at what the repository runs`,
          409,
        );
      const health = await tryCall(async () => checkHealth(provider, await provider.observe(ctx)));
      const costs = await tryCall(async () => checkCosts(provider, await provider.cost(ctx)));
      slices.push({ environment, found, health, costs });
    }
    const now = Date.now();
    let count = 0;
    this.ctx.storage.transactionSync(() => {
      const before = new Map(
        this.sql
          .exec('SELECT * FROM infra_inventory WHERE provider = ?', providerId)
          .toArray()
          .map((row) => [`${row.environment} ${row.rid}`, row]),
      );
      this.sql.exec('DELETE FROM infra_inventory WHERE provider = ?', providerId);
      this.sql.exec('DELETE FROM infra_inventory_relations WHERE provider = ?', providerId);
      for (const { environment, found, health, costs } of slices) {
        const healthOf = new Map((health ?? []).map((h) => [h.resource, h]));
        const costOf = new Map((costs ?? []).map((c) => [c.resource, c]));
        for (const r of found.resources) {
          const last = before.get(`${environment.id} ${r.id}`);
          const h = health ? healthOf.get(r.id) : null;
          const c = costs ? costOf.get(r.id) : null;
          this.sql.exec(
            'INSERT INTO infra_inventory (environment, provider, rid, kind, name, attrs, health, health_at, health_text, cost, currency, seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            environment.id,
            providerId,
            r.id,
            r.kind,
            redact(r.name),
            JSON.stringify(redactAttrs(r.attrs ?? {})),
            health ? (h?.state ?? null) : (last?.health ?? null),
            health ? (h ? Date.parse(h.at) : null) : (last?.health_at ?? null),
            health ? (h?.text ? redact(h.text).slice(0, 200) : null) : (last?.health_text ?? null),
            costs ? (c?.amount ?? null) : (last?.cost ?? null),
            costs ? (c?.currency ?? null) : (last?.currency ?? null),
            now,
          );
          count++;
        }
        for (const rel of found.relations)
          this.sql.exec(
            'INSERT OR IGNORE INTO infra_inventory_relations (environment, provider, from_rid, to_rid, kind) VALUES (?, ?, ?, ?, ?)',
            environment.id,
            providerId,
            rel.from,
            rel.to,
            rel.kind,
          );
      }
    });
    await this.infraConnectionSeen(providerId, 'discovery', { ok: true, missing: [...missing] });
    return { provider: providerId, environments: slices.length, resources: count, at: new Date(now).toISOString() };
  },

  /** The task that owns a short-lived environment, as the inventory shows it. */
  inventoryTask(uuid) {
    const map = uuid ? this.tasks.get(uuid) : null;
    return map ? { uuid, wid: map.wid ?? null, description: map.description ?? '' } : null;
  },

  /** Inventory rows joined to their environment, so a removed environment's rows never show. */
  inventoryRows(where = '', ...args) {
    return this.sql
      .exec(
        `SELECT i.*, e.repo AS env_repo, e.name AS env_name, e.task AS env_task FROM infra_inventory i JOIN infra_environments e ON e.id = i.environment ${where} ORDER BY e.repo, e.name, i.kind, i.name, i.rid`,
        ...args,
      )
      .toArray();
  },

  inventoryOut(row) {
    return resourceView(
      row,
      { id: row.environment, repo: row.env_repo, name: row.env_name },
      this.inventoryTask(row.env_task),
    );
  },

  /** GET /api/infra/inventory[?repo=&environment=&provider=&kind=]: resources and the relations between them. */
  inventoryApi({ repo, environment, provider, kind } = {}) {
    return this.run(async () => {
      const slug = repo ? String(repo).trim().toLowerCase() : null;
      const env = environment ? this.environmentRow(environment, slug) : null;
      const rows = this.inventoryRows(
        'WHERE (? IS NULL OR e.repo = ?) AND (? IS NULL OR i.environment = ?) AND (? IS NULL OR i.provider = ?) AND (? IS NULL OR i.kind = ?)',
        slug,
        slug,
        env?.id ?? null,
        env?.id ?? null,
        provider ?? null,
        provider ?? null,
        kind ?? null,
        kind ?? null,
      );
      const environments = [...new Set(rows.map((r) => r.environment))];
      const relations = environments.flatMap((id) =>
        this.sql
          .exec(
            'SELECT from_rid, to_rid, kind FROM infra_inventory_relations WHERE environment = ? ORDER BY from_rid, kind, to_rid',
            id,
          )
          .toArray()
          .map((rel) => ({ environmentId: id, from: rel.from_rid, to: rel.to_rid, kind: rel.kind })),
      );
      const shown = new Set(rows.map((r) => `${r.environment} ${r.rid}`));
      return {
        status: 200,
        body: {
          resources: rows.map((row) => this.inventoryOut(row)),
          relations: relations.filter(
            (rel) => shown.has(`${rel.environmentId} ${rel.from}`) && shown.has(`${rel.environmentId} ${rel.to}`),
          ),
        },
      };
    });
  },

  /**
   * GET /api/infra/inventory/<resource>[?environment=&repo=]: one resource with its neighbours: what it uses and what
   * uses it, each with the relation's kind.
   */
  inventoryResourceApi(rid, { repo, environment } = {}) {
    return this.run(async () => {
      const slug = repo ? String(repo).trim().toLowerCase() : null;
      const env = environment ? this.environmentRow(environment, slug) : null;
      const id = String(rid ?? '');
      const rows = this.inventoryRows(
        'WHERE i.rid = ? AND (? IS NULL OR e.repo = ?) AND (? IS NULL OR i.environment = ?)',
        id,
        slug,
        slug,
        env?.id ?? null,
        env?.id ?? null,
      );
      if (rows.length > 1)
        throw new AgentError(
          `${id.slice(0, 80)} is in ${rows.map((r) => `${r.env_repo}’s ${r.env_name}`).join(' and ')}: say which with ?environment=`,
          409,
        );
      const row = rows[0];
      if (!row)
        throw new AgentError(
          `no resource ${id.slice(0, 80)} in the inventory${env ? ` of ${env.name}` : ''}: refresh it, or check its environment’s target`,
          404,
        );
      const neighbours = (column, other) =>
        this.sql
          .exec(
            `SELECT ${other} AS rid, kind FROM infra_inventory_relations WHERE environment = ? AND ${column} = ? ORDER BY kind, ${other}`,
            row.environment,
            id,
          )
          .toArray()
          .flatMap((rel) => {
            const n = this.inventoryRows('WHERE i.environment = ? AND i.rid = ?', row.environment, rel.rid)[0];
            return n ? [{ kind: rel.kind, resource: this.inventoryOut(n) }] : [];
          });
      return {
        status: 200,
        body: {
          resource: this.inventoryOut(row),
          uses: neighbours('from_rid', 'to_rid'),
          usedBy: neighbours('to_rid', 'from_rid'),
        },
      };
    });
  },

  /** POST /api/infra/inventory/refresh { provider }: the owner's or the board's; an agent's `by` is refused. */
  inventoryRefreshApi(body = {}) {
    return this.run(async () => {
      if (body.by !== undefined && body.by !== null && body.by !== '' && body.by !== 'owner')
        throw new AgentError('only the owner or the board refreshes the inventory; agents read it', 403);
      const provider = String(body.provider ?? '').trim();
      if (!provider) throw new AgentError('say which provider to refresh, like {"provider": "cloudflare"}', 400);
      return { status: 200, body: { refreshed: await this.refreshInventory(provider) } };
    });
  },
};
