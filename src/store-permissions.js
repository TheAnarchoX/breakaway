/**
 * TaskStore's side of who may do what (BRK-301, docs/specs/BRK-299-people-and-roles.md, points 3 and 4): the actor
 * behind a call, with their grants as the store has them, and the one check, `src/permissions.js`'s `can`.
 *
 * The Worker resolves who's behind a request from its credential and hands it to the store as `actor`
 * (`{ person, press }`) in what it sends. The store never takes grants from the request: it reads them here. A call
 * with no actor is the board's own (the cron, a webhook, a run's steps) or the MCP server's, which is the owner's
 * token, as before: every write there names an agent, so the agent ceiling applies to it.
 */
import { ACTIONS, AUDIT_WAITS, NAME_WAITS, OWNER, OWN_CLAUDE, agentOf, refusal } from './permissions.js';
import { AgentError } from './store-agents.js';
import { repoSlugOf } from './repos.js';
import { resolveRef } from './model.js';
import { can, roleIn } from './permissions.js';

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const permissionsMethods = {
  /**
   * Who's behind a store call: the Worker's actor (from the credential), or the owner for the board's own calls. A
   * person who has been removed has no grants. `by`, when it names an agent, is the agent acting for them, capped by
   * the person its run is for.
   * @param {any} input what the call was given: `{ actor?, by? }`
   * @returns {import('./permissions.js').Actor}
   */
  actorIn(input) {
    const given = input && typeof input === 'object' ? input.actor : null;
    const person = given && typeof given.person === 'string' && given.person ? given.person : OWNER;
    const grants = person === OWNER ? [] : this.personRow(person) ? this.personGrants(person) : [];
    const agent = agentOf(input?.by, person);
    const forHandle = agent ? this.runForPerson(agent) : null;
    return {
      person,
      grants,
      ...(typeof given?.press === 'boolean' ? { press: given.press } : {}),
      agent,
      for:
        forHandle && forHandle !== OWNER
          ? { person: forHandle, grants: this.personRow(forHandle) ? this.personGrants(forHandle) : [] }
          : null,
    };
  },

  /** Whether `name` is a person's handle, now or once (a removed person's handle stays theirs). */
  isPersonHandle(name) {
    return this.sql.exec('SELECT 1 FROM people WHERE handle = ?', String(name)).toArray().length > 0;
  },

  /** The person the newest run of agent `name` is for, or null when the board didn't start it. */
  runForPerson(name) {
    return (
      this.sql
        .exec('SELECT for_person FROM agent_runs WHERE agent = ? ORDER BY id DESC LIMIT 1', String(name))
        .toArray()[0]?.for_person ?? null
    );
  },

  /**
   * Refuses unless `input`'s actor may do `action` in `repository` (null: install-wide). The store asks who, never
   * how: whether the request was a press is the Worker's gate. `message` keeps the words an agent has always been
   * refused with on the owner's token, so nothing changes for an install with nobody invited.
   * @param {any} input
   * @param {string} action
   * @param {string | null} [repository]
   * @param {string} [message]
   */
  allow(input, action, repository = null, message) {
    const actor = this.actorIn(input);
    const no = refusal({ ...actor, press: undefined }, action, repository);
    if (no) throw new AgentError(message && no.code === 'agent' ? message : no.message, 403);
    return actor;
  },

  /**
   * `allow` for a check that needs a lookup to know the repository: an agent is refused first, and the owner passes,
   * both before anything is looked up, so their answers come in the order they always have; a person's repository is
   * `repoOf()`'s.
   * @param {any} input
   * @param {string} action
   * @param {() => string | null} repoOf
   * @param {string} [words]
   */
  allowOn(input, action, repoOf, words) {
    const actor = this.actorIn(input);
    if (actor.agent) this.allow(input, action, null, words);
    if (actor.person === OWNER) return;
    this.allow(input, action, repoOf(), words);
  },

  /** A task's repository by its reference (a 404 or 400 as resolving it would). */
  repoOfRef(ref) {
    return repoSlugOf(this.tasks.get(this.resolve(ref)), this.defaultRepoSlug());
  },

  /** Whether the actor behind `input` is the owner (or the board itself), and not a person. */
  ownerActs(input) {
    return this.actorIn(input).person === OWNER;
  },

  /**
   * The repositories an action on `target` touches, as slugs, for the Worker's gate on a person's request. Null in
   * the list is an install-wide action. Unknown targets answer 404 by throwing, as their own routes would.
   * @param {Record<string, any>} target
   * @returns {(string | null)[]}
   */
  targetRepos(target) {
    const fallback = this.defaultRepoSlug();
    const slug = (value) =>
      value === undefined || value === null || value === '' ? fallback : String(value).trim().toLowerCase();
    const ofTask = (ref) => {
      const uuid = resolveRef(String(ref ?? ''), this.tasks);
      if (!uuid) throw new AgentError(`no task "${String(ref ?? '').slice(0, 40)}"`, 404);
      return repoSlugOf(this.tasks.get(uuid), fallback);
    };
    if (target.install) return [null];
    if ('task' in target) return [ofTask(target.task)];
    if (Array.isArray(target.tasks)) return [...new Set(target.tasks.map(ofTask))];
    if ('plan' in target) return [this.planRow(target.plan).repo];
    if ('change' in target) return [this.changeRow(target.change).repo];
    if ('policyChange' in target) return [this.policyChangeRow(target.policyChange).repo];
    if ('environment' in target) {
      const repo = target.repo ? slug(target.repo) : null;
      const row = this.environmentRow(target.environment, repo);
      if (!row) throw new AgentError(`no environment ${String(target.environment).slice(0, 40)}`, 404);
      return [row.repo];
    }
    if ('ping' in target) {
      const row = this.sql.exec('SELECT task FROM pings WHERE id = ?', Number(target.ping) || 0).toArray()[0];
      if (!row) throw new AgentError('no such ping', 404);
      return [ofTask(row.task)];
    }
    if ('attachment' in target) {
      const row = this.sql
        .exec('SELECT task FROM attachments WHERE id = ?', Number(target.attachment) || 0)
        .toArray()[0];
      if (!row) throw new AgentError('no such image', 404);
      return [ofTask(row.task)];
    }
    if ('feature' in target) {
      const row = this.featureRow(target.feature);
      const repos = new Set();
      for (const map of this.tasks.values()) if (map[`tag_${row.slug}`]) repos.add(repoSlugOf(map, fallback));
      return repos.size ? [...repos] : [null];
    }
    if ('routine' in target) return [slug(this.routineRow(target.routine).repo)];
    if ('release' in target) {
      // The repositories whose tasks the pull would move: a release spans every repository that aims at it.
      const into = target.into === 'next' ? 'next' : 'now';
      const pull = this.releasePulls(undefined, into).find((p) => p.release === String(target.release ?? '').trim());
      const moved = new Set((pull?.moves ?? []).map(({ task }) => repoSlugOf(this.tasks.get(task.uuid), fallback)));
      return moved.size ? [...moved] : [fallback];
    }
    if ('planning' in target) {
      const row = this.sql
        .exec('SELECT kind, target FROM planning_edits WHERE id = ?', Number(target.planning) || 0)
        .toArray()[0];
      if (!row) throw new AgentError(`there’s no change ${String(target.planning).slice(0, 20)} to undo`, 404);
      if (row.kind === 'task') return this.targetRepos({ task: row.target });
      if (row.kind === 'feature') return this.targetRepos({ feature: row.target });
      return [null];
    }
    if ('peloton' in target) {
      const p = this.pelotonOf(target.peloton);
      if (p.kind === 'repo') return [p.name];
      return this.targetRepos({ feature: p.feature.slug });
    }
    if (Array.isArray(target.repos)) return target.repos.length ? [...new Set(target.repos.map(slug))] : [fallback];
    return [slug(target.repo)];
  },

  /**
   * The Worker's gate for a person's request (BRK-301): may `actor` do `action` on `target`? `target.by` is the agent
   * the request names, if any. A start runs on the starter's own Claude, which comes with BRK-302, so a person's start
   * is refused until then, whatever their role; so is a press that writes the infrastructure audit, until BRK-303.
   * @param {{ person: string, press?: boolean }} actor
   * @param {string} action
   * @param {Record<string, any>} [target]
   */
  permitApi(actor, action, target = {}) {
    return this.run(() => {
      // An agent's name is never another person's handle: nobody writes as someone else on the board.
      for (const name of [target?.by, target?.agent])
        if (
          typeof name === 'string' &&
          name.trim() &&
          name.trim() !== actor?.person &&
          this.isPersonHandle(name.trim())
        )
          throw new AgentError(`${name.trim()} is a person on this board, not an agent: write as yourself`, 403);
      const repos = this.targetRepos(target ?? {});
      for (const repo of repos) this.allow({ actor, by: target?.by }, action, repo);
      const person = actor?.person && actor.person !== OWNER;
      if (ACTIONS[action]?.starts && person) throw new AgentError(OWN_CLAUDE, 403);
      // Until BRK-303 gives the audit trail a person, a person's press that writes it waits (the captain's call).
      if (ACTIONS[action]?.audited && person) throw new AgentError(AUDIT_WAITS, 403);
      if (ACTIONS[action]?.named && person) throw new AgentError(NAME_WAITS, 403);
      return { status: 200, body: { ok: true, repos } };
    });
  },

  /**
   * What `actor` can't read (BRK-323, the spec's point 3, "What a person sees"): the repositories they have no grant
   * in, by slug and GitHub name, and those repositories' tasks, by UUID and work ID. Removed repositories, and tasks
   * whose repository isn't registered, are only the `*` grant's. Empty for the owner.
   * @param {{ person: string }} actor
   * @returns {{ repos: string[], tasks: string[], readable: (slug: string | null) => boolean }}
   */
  hiddenFrom(actor) {
    const { person, grants } = this.actorIn({ actor });
    const all = person === OWNER || roleIn(grants, null) !== null;
    const readable = (/** @type {string | null} */ slug) =>
      all || (slug !== null && can({ person, grants }, 'read', slug));
    if (all) return { repos: [], tasks: [], readable };
    const fallback = this.defaultRepoSlug();
    const repos = new Set();
    for (const r of [...this.repos(), ...this.removedRepos()])
      if (!readable(r.slug) || r.removed) {
        repos.add(r.slug);
        if (r.github) repos.add(r.github);
      }
    const tasks = [];
    for (const [uuid, map] of this.tasks) {
      const slug = repoSlugOf(map, fallback);
      if (readable(slug) && this.repoBySlug(slug)) continue;
      repos.add(slug);
      tasks.push(uuid);
      if (map.wid) tasks.push(map.wid);
    }
    return { repos: [...repos], tasks, readable };
  },

  /**
   * Which task views `reader` (a person) sees, as a filter for a read that counts them (a feature's progress, a
   * chase's queue), or null for the owner and the board, who see them all.
   * @param {{ person: string } | null} reader
   * @returns {((view: { repo: string }) => boolean) | null}
   */
  seenBy(reader) {
    if (!reader || reader.person === OWNER) return null;
    const { readable } = this.hiddenFrom(reader);
    return (view) => readable(view.repo) && Boolean(this.repoBySlug(view.repo));
  },

  /**
   * The Worker's gate for a person's read (BRK-323): may `actor` read what `read` (src/reads.js) is about? Answers
   * what they can't see, for the scrub, or refuses: a 404, as if it weren't there, for a task, a plan, an environment,
   * or a repository they have no grant in (never naming its repository), and a 403 for the install's own reads, which
   * are the owner's and the `*` grant's. `read` null is a write's answer: only what they can't see.
   * @param {{ person: string }} actor
   * @param {import('./reads.js').Read | null} read
   */
  readGateApi(actor, read) {
    return this.run(() => {
      const { repos, tasks, readable } = this.hiddenFrom(actor);
      const answer = { status: 200, body: { hidden: { repos, tasks } } };
      if (!read || 'list' in read || 'single' in read) return answer;
      const everywhere = () => {
        const no = refusal(this.actorIn({ actor }), 'read', null);
        if (no) throw new AgentError(`${no.message}: ask about one repository, with ?repo=<its slug>`, 403);
      };
      if ('install' in read) {
        everywhere();
        return answer;
      }
      if ('absent' in read) {
        const slug = read.repo ? String(read.repo).trim().toLowerCase() : null;
        if (slug) {
          if (!readable(slug)) throw new AgentError(`no repository "${slug.slice(0, 40)}"`, 404);
        } else if (read.absent === 'default') {
          if (!readable(this.defaultRepoSlug())) everywhere();
        } else if (read.absent === 'install') everywhere();
        return answer;
      }
      const target = read.target;
      const touched = this.targetRepos(target);
      // A feature or a chase's peloton spans repositories: a person reads the parts in theirs.
      const spans = ('feature' in target && !target.whole) || ('peloton' in target && touched.length !== 1);
      const ok = spans ? touched.some(readable) : touched.every(readable);
      if (!ok) throw new AgentError(notThere(target), 404);
      return answer;
    });
  },
};

/** The words a read gets when what it asks about doesn't exist: the same for one in a repository the person can't read. */
function notThere(target) {
  const text = (value, max = 40) => String(value ?? '').slice(0, max);
  if ('task' in target) return `no task "${text(target.task)}"`;
  if ('attachment' in target) return 'no such image';
  if ('plan' in target) return `no plan ${text(target.plan)}`;
  if ('change' in target) return `no change ${text(target.change, 20)}`;
  if ('environment' in target)
    return `no environment ${text(target.environment).trim().toLowerCase()}${target.repo ? ` in ${target.repo}` : ''}`;
  if ('feature' in target) return `there’s no feature "${text(target.feature)}"`;
  if ('peloton' in target)
    return `there’s no peloton "${text(target.peloton)}": it’s a repository’s slug, or chase:<feature>`;
  return `no repository "${text(target.repo)}"`;
}
