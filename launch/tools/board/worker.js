/**
 * The launch board: breakaway's own Worker, run locally for the launch media, with Architect's platform and GitHub
 * made up (provider.js, github.js). Everything a screenshot shows is the real board's code and views; only what it
 * reads from outside is invented. It's for `wrangler dev` on your machine and is never deployed.
 *
 * One route is added, POST /__launch/<action> with the board's token, for architect.mjs to move the made-up world
 * along (a commit on main, a resource going down, the cron's comparisons). It never exists in the real Worker.
 */
import worker, { TaskStore as Store } from '../../../src/worker.js';
import { install } from '../../../src/install.js';
import { ProviderRegistry } from '../../../src/infra-provider.js';
import { DRIFT_EVERY_MS } from '../../../src/infra-drift.js';
import { commit, gh, pull } from './github.js';
import { filmPlatformOf, launchProvider, minutesAgo, platformOf, platforms } from './provider.js';

export class TaskStore extends Store {
  constructor(ctx, env) {
    super(ctx, env);
    this.infraProviders = new ProviderRegistry();
    this.infraProviders.register(launchProvider);
  }

  /**
   * One step of the made-up world, from architect.mjs.
   * @param {string} action
   * @param {any} body
   */
  async launch(action, body) {
    switch (action) {
      case 'platform': {
        // An environment's platform, from scratch (the README's world, or the film's with `film`), or a change to one:
        // health, events, refusals, attributes.
        const { environment, fresh, film, health, events, failOn, attrs } = body;
        if (film) platforms[environment] = filmPlatformOf(environment, film);
        else if (fresh || !platforms[environment]) platforms[environment] = platformOf(environment, fresh ?? {});
        const p = platforms[environment];
        if (health) Object.assign(p.health, health);
        if (events)
          p.events.push(...events.map(({ minutesAgo: m = 0, ...e }) => ({ value: null, ...e, at: minutesAgo(m) })));
        if (failOn) p.failOn = new Set(failOn);
        for (const [id, change] of Object.entries(attrs ?? {}))
          Object.assign(p.resources.find((r) => r.id === id).attrs, change);
        return { resources: p.resources };
      }
      case 'github': {
        const { files, sha, message, pulls, pullFiles, heads, keys, checks, deployments } = body;
        if (files) commit(files, sha, message);
        if (pulls) gh.pulls = pulls.map((p) => pull(p.number, p.title, p.sha, p));
        if (pullFiles) Object.assign(gh.pullFiles, pullFiles);
        if (heads) Object.assign(gh.heads, heads);
        if (keys) gh.keys = keys;
        if (checks) Object.assign(gh.checks, checks);
        if (deployments) gh.deployments = deployments;
        return { ok: true };
      }
      case 'refresh':
        return { refreshed: await this.refreshInventory('cloudflare') };
      case 'drift':
        return { compared: (await this.driftTick(Date.now() + DRIFT_EVERY_MS)).length };
      case 'tick':
        await this.infraRunsTick();
        this.sql.exec('UPDATE infra_runs SET next_try = NULL');
        return { ok: true };
      case 'shortlived':
        // The cron's look at short-lived environments (BRK-200): tasks that ask get one, closed ones lose theirs.
        await this.shortLivedTick();
        return { ok: true };
      case 'signals':
        await this.recordSignals(
          body.signals.map(({ minutesAgo: m = 0, ...s }) => ({ value: null, ...s, at: minutesAgo(m) })),
        );
        return { ok: true };
      case 'apply': {
        // What the apply workflow does with the environment's write token, against the made-up platform.
        const { environment, target, diff } = body;
        return launchProvider.apply({ environment, scope: { target }, writeToken: 'launch-write-token' }, diff);
      }
      default:
        throw new Error(`no launch action ${action}`);
    }
  }
}

export default {
  ...worker,
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const action = /^\/__launch\/([a-z]+)$/u.exec(url.pathname)?.[1];
    if (!action) return worker.fetch(request, env, ctx);
    if (request.method !== 'POST' || request.headers.get('Authorization') !== `Bearer ${env.TASKS_API_TOKEN}`)
      return new Response('Forbidden', { status: 403 });
    const stub = env.STORE.get(env.STORE.idFromName(install(env).store));
    try {
      return Response.json(await stub.launch(action, await request.json()));
    } catch (error) {
      return Response.json({ error: String(error?.message ?? error) }, { status: 500 });
    }
  },
};
