/**
 * TaskStore's kickoffs (docs/specs/IDEA-26-kickoff.md, sections 1 to 3): a new project on its way from a pitch to
 * a registered repository with its IDEA. The `kickoffs` table keeps the pitch, the name, the slug and areas it will
 * register with, its GitHub owner/name once known, its IDEA once made, and the step it's on; its images wait in
 * `attachments` under `kickoff:<id>` until the IDEA takes them. Its steps are the Add a repository wizard's own
 * (wizardFacts, wizardSteps), so the two never disagree. A kickoff belongs to no repository until it has one, so
 * nothing about it is written anywhere but its own. Writing is the owner's, from the signed-in browser (worker.js);
 * an agent's `by` is refused here too.
 */
import { appCredentials } from './github.js';
import { InputError } from './model.js';
import { AgentError } from './store-agents.js';
import { checkRepo, promptPathOf } from './repos.js';
import {
  KICKOFF_AREA,
  checkName,
  checkPitch,
  createUrl,
  firstFree,
  freeSlug,
  githubOf,
  kickoffIdea,
  prefixCandidates,
  suggestName,
} from './kickoff.js';
import { slugFrom, wizardSteps } from './wizard.js';

const ID = /^[0-9a-f-]{36}$/u;
/** What a kickoff's GitHub name is checked as before it has one: never a real repository, so never a clash. */
const UNKNOWN_OWNER = 'kickoff-not-created-yet';

const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);
const ok = (body, status = 200) => ({ status, body });
const imagesOf = (id) => `kickoff:${id}`;

/** @type {Record<string, (this: any, ...args: any[]) => any>} */
export const kickoffsMethods = {
  initKickoffs() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kickoffs (
        id TEXT PRIMARY KEY, pitch TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL, areas TEXT NOT NULL,
        github TEXT, idea TEXT, step TEXT NOT NULL, created INTEGER NOT NULL, edited INTEGER NOT NULL
      );
    `);
  },

  ownerOnlyKickoffs(by) {
    if (by !== undefined && by !== null && by !== '' && by !== 'owner')
      throw new AgentError('only the owner kicks off, changes, or stops a project', 403);
  },

  kickoffRows() {
    return this.sql
      .exec('SELECT * FROM kickoffs ORDER BY created, id')
      .toArray()
      .map((r) => ({ ...r, areas: JSON.parse(r.areas) }));
  },

  kickoffRow(id) {
    const key = String(id ?? '').toLowerCase();
    const row = ID.test(key) ? this.kickoffRows().find((r) => r.id === key) : null;
    if (!row) throw new AgentError(`no kickoff "${String(id ?? '').slice(0, 40)}"`, 404);
    return row;
  },

  /** The registered repository a kickoff became, or null before it's registered. */
  kickoffRepo(row) {
    if (!row.github) return null;
    return this.repos().find((r) => r.github.toLowerCase() === row.github.toLowerCase()) ?? null;
  },

  /** A kickoff as the API gives it: its fields, its images, its IDEA's work ID, and github.com's create form. */
  kickoffView(row) {
    const repo = this.kickoffRepo(row);
    const idea = row.idea ? this.tasks.get(row.idea) : null;
    return {
      id: row.id,
      pitch: row.pitch,
      name: row.name,
      slug: repo?.slug ?? row.slug,
      areas: repo?.areas ?? row.areas,
      github: row.github,
      registered: Boolean(repo),
      idea: row.idea ? { uuid: row.idea, wid: idea?.wid ?? null, status: idea?.status ?? null } : null,
      finished: idea?.status === 'completed',
      step: row.step,
      images: this.attachmentsOf(row.idea ?? imagesOf(row.id)),
      links: {
        create: createUrl({ name: row.name, github: row.github, pitch: row.pitch }),
        settings: repo ? `#/settings/${repo.slug}` : null,
      },
      created: iso(row.created),
      edited: iso(row.edited),
    };
  },

  /**
   * What a kickoff's slug, prefixes, and GitHub name may not be: what registering refuses (repositories on the
   * board, those taken off it, prefixes tasks already use), and what the other kickoffs in progress will register.
   */
  kickoffTaken(except = null) {
    const others = this.kickoffRows().filter((r) => r.id !== except && !this.kickoffRepo(r));
    const repos = [...this.repos(), ...this.removedRepos()];
    const used = this.usedPrefixes();
    return {
      others,
      slug: (slug) => repos.some((r) => r.slug === slug) || others.some((r) => r.slug === slug),
      prefix: (prefix) =>
        used.has(prefix) ||
        repos.some((r) => r.areas.some((a) => a.prefix === prefix)) ||
        others.some((r) => r.areas.some((a) => a.prefix === prefix)),
    };
  },

  /**
   * A kickoff's fields from what the owner sent, on top of `current` when changing one: the pitch, the name
   * (suggested from the pitch), the slug and the one area's prefix (suggested from the name, the next free ones),
   * and the GitHub owner/name. Checked the way registering checks them, and against the other kickoffs.
   */
  kickoffFields(body, current = null) {
    const has = (key) => body[key] !== undefined && body[key] !== null && body[key] !== '';
    const pitch = has('pitch') || !current ? checkPitch(body.pitch) : current.pitch;
    const suggested = suggestName(pitch);
    if (!has('name') && !current && !suggested)
      throw new InputError('give it a name: the pitch’s first line has no word to make one from');
    const name = has('name') ? checkName(body.name) : (current?.name ?? suggested);
    const renamed = !current || name !== current.name;
    const taken = this.kickoffTaken(current?.id);
    const slug = has('slug')
      ? String(body.slug).trim().toLowerCase()
      : renamed
        ? freeSlug(slugFrom(name), taken.slug)
        : current.slug;
    let areas;
    if (has('areas')) areas = body.areas;
    else if (renamed) {
      const prefix = firstFree(prefixCandidates(name), taken.prefix);
      if (!prefix) throw new InputError('every prefix from that name is taken; pick one under More options');
      areas = [{ project: KICKOFF_AREA, prefix, name: KICKOFF_AREA }];
    } else areas = current.areas;
    let github = current?.github ?? null;
    if ('github' in body) {
      github = has('github') ? githubOf(body.github) : null;
      if (has('github') && !github) throw new InputError('github is owner/name, like your-name/plant-diary');
    }
    // The checks registering makes, nothing saved: a clash says what clashes.
    const row = checkRepo(
      { slug, name, github: github ?? `${UNKNOWN_OWNER}/${name}`, areas },
      {
        others: this.repos(),
        usedPrefixes: this.usedPrefixes(),
        removed: this.removedRepos(),
        caps: this.repoCapCeilings(),
      },
    );
    const clash = taken.others.find(
      (r) =>
        r.slug === row.slug ||
        r.areas.some((a) => row.areas.some((b) => a.prefix === b.prefix)) ||
        (github && r.github?.toLowerCase() === github.toLowerCase()),
    );
    if (clash) {
      const what =
        clash.slug === row.slug
          ? `the slug ${row.slug}`
          : github && clash.github?.toLowerCase() === github.toLowerCase()
            ? github
            : `the prefix ${clash.areas.find((a) => row.areas.some((b) => a.prefix === b.prefix)).prefix}`;
      throw new InputError(`another kickoff, ${clash.name}, will register ${what}; pick another`);
    }
    return { pitch, name, slug: row.slug, areas: row.areas, github };
  },

  /**
   * GET /api/kickoffs (anyone signed in): the kickoffs in progress, oldest first, and whether the board's GitHub App
   * is connected (`app`), which every kickoff needs past saving its pitch. A finished one leaves the list.
   */
  kickoffsApi() {
    return this.run(async () =>
      ok({
        kickoffs: this.kickoffRows()
          .map((r) => this.kickoffView(r))
          .filter((k) => !k.finished),
        app: Boolean(await appCredentials(this.env)),
      }),
    );
  },

  /**
   * GET /api/kickoffs/<id> (anyone signed in): one kickoff to pick up where it was, with the wizard's steps for its
   * repository (`check` asks GitHub live, as the wizard does), the App's slug, the prompt's path, and whether its
   * routine is connected (`{ connected, source }`). A registered kickoff whose IDEA wasn't made yet gets it now.
   */
  kickoffApi(id, { check = false } = {}) {
    return this.run(async () => {
      let row = this.kickoffRow(id);
      if (!row.idea && this.kickoffRepo(row)) row = (await this.kickoffMakeIdea(row)) ?? row;
      const facts = row.github
        ? await this.wizardFacts({ github: row.github, check })
        : { app: Boolean(await appCredentials(this.env)), checkedAt: null };
      const { steps, now, done } = wizardSteps(facts);
      const step = now ?? 'done';
      if (step !== row.step) {
        this.sql.exec('UPDATE kickoffs SET step = ? WHERE id = ?', step, row.id);
        row = { ...row, step };
      }
      return ok({
        kickoff: this.kickoffView(row),
        checked: iso(facts.checkedAt),
        // The wizard's own facts for the page's links and its routine guide, never the routine's URL or token.
        app: facts.appInfo ?? null,
        promptPath: promptPathOf(facts.registered ?? null),
        routine: { connected: Boolean(facts.routine), source: facts.routineSource ?? null },
        steps,
        now,
        done,
      });
    });
  },

  /**
   * POST /api/kickoffs (the owner): saves a kickoff from its pitch, with the name, slug, and prefix suggested
   * unless given. `dryRun` answers what it would save, or the clash, and saves nothing, for the form as it's typed.
   */
  kickoffsCreateApi(body) {
    return this.run(() => {
      if (!body || typeof body !== 'object') throw new InputError('a kickoff is an object, with its pitch');
      this.ownerOnlyKickoffs(body.by);
      const fields = this.kickoffFields(body);
      const view = {
        ...fields,
        links: { create: createUrl({ name: fields.name, github: fields.github, pitch: fields.pitch }) },
      };
      if (body.dryRun) return ok({ kickoff: view, dryRun: true });
      const id = crypto.randomUUID();
      const now = Date.now();
      this.sql.exec(
        'INSERT INTO kickoffs (id, pitch, name, slug, areas, github, idea, step, created, edited) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)',
        id,
        fields.pitch,
        fields.name,
        fields.slug,
        JSON.stringify(fields.areas),
        fields.github,
        'create',
        now,
        now,
      );
      return ok({ kickoff: this.kickoffView(this.kickoffRow(id)) }, 201);
    });
  },

  /**
   * PATCH /api/kickoffs/<id> (the owner): changes its pitch, name, slug, areas, or GitHub owner/name until it's
   * registered. After that the repository's own settings page holds them, and the pitch is its IDEA's.
   */
  kickoffsModifyApi(id, body) {
    return this.run(() => {
      if (!body || typeof body !== 'object') throw new InputError('send the fields to change');
      this.ownerOnlyKickoffs(body.by);
      const current = this.kickoffRow(id);
      const repo = this.kickoffRepo(current);
      if (repo)
        throw new AgentError(
          `${current.name} is on the board as ${repo.slug}: change its areas on its settings page, and its idea on ${this.tasks.get(current.idea)?.wid ?? 'its IDEA'}`,
          409,
        );
      const fields = this.kickoffFields(body, current);
      if (body.dryRun) return ok({ kickoff: { ...this.kickoffView(current), ...fields }, dryRun: true });
      this.sql.exec(
        'UPDATE kickoffs SET pitch = ?, name = ?, slug = ?, areas = ?, github = ?, edited = ? WHERE id = ?',
        fields.pitch,
        fields.name,
        fields.slug,
        JSON.stringify(fields.areas),
        fields.github,
        Math.max(Date.now(), current.edited + 1),
        current.id,
      );
      return ok({ kickoff: this.kickoffView(this.kickoffRow(current.id)) });
    });
  },

  /**
   * DELETE /api/kickoffs/<id> (the owner): Stop this kickoff. The row and the images still waiting for its IDEA
   * go; a registered repository and its IDEA stay, and `registered` names it, for the wizard's Changed your mind?.
   */
  kickoffsDeleteApi(id, body) {
    return this.run(() => {
      this.ownerOnlyKickoffs(body?.by);
      const row = this.kickoffRow(id);
      const repo = this.kickoffRepo(row);
      this.ctx.storage.transactionSync(() => {
        this.sql.exec('DELETE FROM attachments WHERE task = ?', imagesOf(row.id));
        this.sql.exec('DELETE FROM kickoffs WHERE id = ?', row.id);
      });
      return ok({ stopped: row.id, registered: repo?.slug ?? null });
    });
  },

  /**
   * POST /api/kickoffs/<id>/register (the owner): Add it to the board, with the slug, name, and areas the kickoff
   * saved. Registering makes its IDEA (reposAddApi calls kickoffRegistered), however it's registered.
   */
  kickoffsRegisterApi(id, body) {
    return this.run(async () => {
      this.ownerOnlyKickoffs(body?.by);
      const row = this.kickoffRow(id);
      if (!row.github)
        throw new InputError('say where it is on GitHub first: its owner/name, once you’ve pressed Create there');
      if (this.kickoffRepo(row)) throw new AgentError(`${row.name} is already on the board`, 409);
      const result = await this.reposAddApi({
        slug: row.slug,
        github: row.github,
        name: row.name,
        areas: row.areas,
        by: 'owner',
      });
      if (result.status !== 201) return result;
      return ok({ repo: result.body.repo, kickoff: this.kickoffView(this.kickoffRow(row.id)) }, 201);
    });
  },

  /** POST /api/kickoffs/<id>/images (the owner): one of up to 4 images, with the checks an idea's images get. */
  kickoffImageAdd(id, bytes, { name, alt } = {}) {
    return this.run(() => {
      const row = this.kickoffRow(id);
      const owner = row.idea ?? imagesOf(row.id);
      return ok({ attachment: this.attachmentInsert(owner, bytes, { name, alt }, 'a kickoff') }, 201);
    });
  },

  /** DELETE /api/kickoffs/<id>/images/<n> (the owner): one of its images, while it's still the kickoff's. */
  kickoffImageDelete(id, image) {
    return this.run(() => {
      const row = this.kickoffRow(id);
      const gone = this.sql
        .exec('DELETE FROM attachments WHERE id = ? AND task = ? RETURNING id', Number(image), imagesOf(row.id))
        .toArray();
      if (!gone.length) throw new AgentError(`no image ${String(image).slice(0, 12)} on this kickoff`, 404);
      return ok({ deleted: gone[0].id });
    });
  },

  /**
   * A repository was registered (reposAddApi): the kickoff that named it takes its slug and areas, and its IDEA
   * is made there. Nothing happens for a repository no kickoff named.
   */
  async kickoffRegistered(repo) {
    const row = this.kickoffRows().find((r) => !r.idea && r.github?.toLowerCase() === repo.github.toLowerCase());
    if (!row) return null;
    this.sql.exec(
      'UPDATE kickoffs SET slug = ?, areas = ?, edited = ? WHERE id = ?',
      repo.slug,
      JSON.stringify(repo.areas),
      Date.now(),
      row.id,
    );
    return this.kickoffMakeIdea({ ...row, slug: repo.slug, areas: repo.areas });
  },

  /**
   * Makes a registered kickoff's IDEA in its own repository: the pitch as its description, never rewritten, and
   * its images moved onto it. Returns the row with its IDEA, or null when the board couldn't make it (the
   * kickoff's page tries again).
   */
  async kickoffMakeIdea(row) {
    const repo = this.kickoffRepo(row);
    if (!repo || row.idea) return row;
    const made = await this.create([kickoffIdea({ ...row, slug: repo.slug })]);
    const uuid = made.status === 201 ? made.body.tasks[0].uuid : null;
    if (!uuid) return null;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('UPDATE attachments SET task = ? WHERE task = ?', uuid, imagesOf(row.id));
      this.sql.exec('UPDATE kickoffs SET idea = ?, edited = ? WHERE id = ?', uuid, Date.now(), row.id);
    });
    return { ...row, slug: repo.slug, areas: repo.areas, idea: uuid };
  },
};
