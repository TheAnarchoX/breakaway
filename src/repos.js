/**
 * Repositories on the board (docs/specs/IDEA-14-multi-repo.md, sections 1 and 2): what a registered
 * repository is, and how a task's area turns into its work-ID prefix. Pure, so it's tested without
 * the Durable Object; the table and the API are in store-repos.js.
 *
 * Every task belongs to one repository through its `repo` property, and a task without one belongs to
 * the default repository (the install's first, from before repositories), so no existing task, history, or replica changes.
 * A fresh install has no such repository: its first registered repository is its default (CLD-131). Ideas (IDEA) and
 * Routines (RUN) are install-wide (the owner's answer in CLD-119); every other area belongs to exactly one
 * repository, and a prefix to exactly one area, so a work ID means one task across the install.
 */
import { AREA_NAMES, InputError, PROJECTS } from './model.js';

/** The slug a task without `repo` falls back to while the registry has no default: nothing is registered, so no task is. */
export const NO_REPO = 'default';
/** Areas shared by the whole install: the owner's inbox and saved prompts, not a repository's work. */
export const SHARED_AREAS = { ideas: 'IDEA', routines: 'RUN' };

const SLUG = /^[a-z][a-z0-9-]{0,31}$/u;
const GITHUB = /^[\w.-]{1,39}\/[\w.-]{1,100}$/u;
const AREA = /^[a-z][a-z0-9-]{0,31}$/u;
const PREFIX = /^[A-Z]{2,8}$/u;
/** The optional settings a later task fills in (pipeline, routine, pull request settings), as JSON. */
export const JSON_FIELDS = ['pipeline', 'routine', 'settings'];
const MAX_JSON = 4096;

/**
 * Whether an empty registry gets a first row by itself: only on an install that names its repository in
 * TASKS_GITHUB_REPO. A fresh install starts with no repository, and its owner registers the first (CLD-131).
 */
export const seedsDefault = (env) => Boolean(env?.TASKS_GITHUB_REPO);

/** A repository's slug from its GitHub name: `acme/widgets` → `widgets`. */
export const slugOfGithub = (github) => {
  const slug = String(github)
    .split('/')
    .pop()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/^[^a-z]+|-+$/gu, '');
  return SLUG.test(slug) ? slug : NO_REPO;
};

/** The registry's first row on such an install: `TASKS_GITHUB_REPO` with the model's areas, and no pipeline until its owner sets one. */
export function defaultRepo(env) {
  const github = String(env.TASKS_GITHUB_REPO);
  const slug = slugOfGithub(github);
  return {
    slug,
    github,
    name: slug,
    defaultBranch: 'main',
    areas: Object.entries(PROJECTS)
      .filter(([project]) => !(project in SHARED_AREAS))
      .map(([project, prefix]) => ({ project, prefix, name: AREA_NAMES[project] ?? project })),
    pipeline: null,
    routine: null,
    settings: null,
  };
}

/** The repository a task belongs to: its `repo`, or the default. */
export const repoSlugOf = (map, fallback = NO_REPO) => map?.repo || fallback;

/** The work-ID prefix for `project` in `repo` (a registry row), or null when the area isn't the repository's. */
export function prefixFor(repo, project) {
  if (!project) return null;
  if (project in SHARED_AREAS) return SHARED_AREAS[project];
  return repo?.areas.find((a) => a.project === project)?.prefix ?? null;
}

/** The areas a task in `repo` may have, for messages: its own, then the shared ones. */
export const areasOf = (repo) => [...(repo?.areas ?? []).map((a) => a.project), ...Object.keys(SHARED_AREAS)];

/** `product:PRD` or `product:PRD:Product`, or an object → an area. */
function parseArea(value) {
  let area = value;
  if (typeof value === 'string') {
    const [project, prefix, ...name] = value.split(':').map((s) => s.trim());
    area = { project, prefix, name: name.join(':') || undefined };
  }
  if (!area || typeof area !== 'object') throw new InputError('an area is "project:PREFIX", like product:PRD');
  const project = String(area.project ?? '').toLowerCase();
  const prefix = String(area.prefix ?? '').toUpperCase();
  if (!AREA.test(project))
    throw new InputError(
      `"${String(area.project ?? '').slice(0, 40)}" isn't an area name: lowercase letters, digits, and hyphens, starting with a letter`,
    );
  if (!PREFIX.test(prefix)) throw new InputError(`the prefix for ${project} is 2 to 8 capital letters, like PRD`);
  if (project in SHARED_AREAS || Object.values(SHARED_AREAS).includes(prefix)) {
    throw new InputError(
      `${project in SHARED_AREAS ? project : prefix} is shared by the whole install (ideas IDEA, routines RUN), so no repository can have it`,
    );
  }
  const name =
    area.name === undefined || area.name === null ? project : String(area.name).trim().slice(0, 40) || project;
  return { project, prefix, name };
}

function jsonField(value, what) {
  if (value === null || value === undefined || value === '') return null;
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new InputError(`${what} must be JSON`);
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new InputError(`${what} is an object`);
  if (JSON.stringify(parsed).length > MAX_JSON)
    throw new InputError(`${what} can be up to ${MAX_JSON} characters of JSON`);
  return parsed;
}

const WORKER_NAME = /^[\w.-]{1,100}$/u;
const DEPLOY_PATHS_PATH = /^(?!\/)(?!.*\.\.)[\w./-]{1,200}\.json$/u;

/**
 * A repository's deploy pipeline as the owner sets it: the shape `pipelineOf` (release.js) reads, refused with
 * the reason when it would read none. `workers.staging` and `workers.production` are required; `workflows`
 * (deploy, promote, rollback, workflow file names) and `deployPaths` (a JSON file in the repository) are optional.
 */
function checkPipeline(pipeline) {
  if (!pipeline) return null;
  const known = { workers: ['staging', 'production'], workflows: ['deploy', 'promote', 'rollback'] };
  for (const key of Object.keys(pipeline)) {
    if (!['workers', 'workflows', 'deployPaths'].includes(key))
      throw new InputError(`pipeline has no "${key.slice(0, 40)}"; it has workers, workflows, and deployPaths`);
  }
  const out = {};
  for (const [group, keys] of Object.entries(known)) {
    const value = pipeline[group];
    if (value === undefined || value === null) {
      if (group === 'workers')
        throw new InputError('pipeline.workers needs staging and production, the names of the two Workers');
      continue;
    }
    if (typeof value !== 'object' || Array.isArray(value)) throw new InputError(`pipeline.${group} is an object`);
    for (const key of Object.keys(value))
      if (!keys.includes(key))
        throw new InputError(`pipeline.${group} has no "${key.slice(0, 40)}"; it has ${keys.join(', ')}`);
    out[group] = {};
    for (const key of keys) {
      if (value[key] === undefined || value[key] === null) {
        if (group === 'workers')
          throw new InputError(`pipeline.workers.${key} is required: the name of the ${key} Worker`);
        continue;
      }
      if (typeof value[key] !== 'string' || !WORKER_NAME.test(value[key])) {
        throw new InputError(
          `pipeline.${group}.${key} is ${group === 'workers' ? 'a Worker name' : 'a workflow file name'}: letters, digits, dots, hyphens, and underscores, like ${group === 'workers' ? 'my-app-staging' : `${key}.yml`}`,
        );
      }
      out[group][key] = value[key];
    }
  }
  if (pipeline.deployPaths !== undefined && pipeline.deployPaths !== null && pipeline.deployPaths !== '') {
    const path = typeof pipeline.deployPaths === 'string' ? pipeline.deployPaths.trim().replace(/^\.\//u, '') : '';
    if (!DEPLOY_PATHS_PATH.test(path))
      throw new InputError(
        'pipeline.deployPaths is the path of a JSON file in the repository, like .github/deploy-paths.json',
      );
    out.deployPaths = path;
  }
  return out;
}

/** The most agents at once and starts an hour a repository may have under the board's own (store-agents.js). */
/** The most a repository's caps can be: the Pro plan's agents at once and Claude's starts an hour for one routine (CLD-198 passes the plan's). */
const CAPS = { max: 6, hourly: 30 };

/** Where a repository keeps its agent prompt when its routine settings don't say. */
export const DEFAULT_PROMPT_PATH = 'tools/tasks/routine-prompt.md';
const PROMPT_PATH = /^(?!\/)(?!.*\.\.)[\w./-]{1,200}\.md$/u;

/** The path, in the repository's own checkout, of the prompt its agents follow (IDEA-14 section 4, CLD-127). */
export const promptPathOf = (repo) => repo?.routine?.prompt || DEFAULT_PROMPT_PATH;

/**
 * The instructions to paste into a repository's claude.ai routine: the stub (tools/tasks/prompts/stub.md,
 * passed in as `template`) with that repository's prompt path filled in.
 */
export const stubFor = (template, repo) => String(template).replaceAll('<prompt path>', promptPathOf(repo));

/**
 * A repository's routine settings (IDEA-14 section 4): its optional caps under the board's shared limits,
 * `max` agents at once and `hourly` starts, and `prompt`, the path of its agent prompt in its checkout
 * (DEFAULT_PROMPT_PATH when left out). A cap or prompt left out, or null, means none.
 */
function checkRoutine(routine, caps = CAPS) {
  if (!routine) return null;
  const out = { ...routine };
  if (out.prompt === null || out.prompt === undefined || out.prompt === '') delete out.prompt;
  else {
    const path = String(out.prompt).trim().replace(/^\.\//u, '');
    if (!PROMPT_PATH.test(path))
      throw new InputError(
        'routine.prompt is the path of a Markdown file in the repository, like tools/tasks/routine-prompt.md',
      );
    out.prompt = path;
  }
  for (const [key, most] of Object.entries(caps)) {
    if (out[key] === null || out[key] === undefined || out[key] === '') {
      delete out[key];
      continue;
    }
    const n = Number(out[key]);
    if (!Number.isInteger(n) || n < 1 || n > most)
      throw new InputError(`routine.${key} is a number from 1 to ${most}, or null for no cap`);
    out[key] = n;
  }
  return Object.keys(out).length ? out : null;
}

/** A repository's own caps on agents (null where it has none); the board's shared limits always apply too. */
export function routineCaps(repo) {
  return { max: repo?.routine?.max ?? null, hourly: repo?.routine?.hourly ?? null };
}

export const list = (value) =>
  value === undefined || value === null || value === '' ? [] : Array.isArray(value) ? value : String(value).split(',');

/**
 * Checks a new repository, or changes to one (`current`), against the others in the registry
 * (`others`) and the work IDs already in use outside it (`usedPrefixes`: prefix → slug of a task
 * that has it). Returns the row. A prefix is refused if any other repository or task outside
 * this repository has it, so `Closes BRK-3.` can only ever mean one task.
 *
 * input: {slug, github, name, defaultBranch, areas | addAreas (list of "project:PREFIX" or objects),
 *   removeAreas (list of area names), pipeline, routine, settings}
 * `inUse(project)`: whether a task of this repository has the area, so removing it is refused.
 * `removed`: repositories taken off the board (CLD-191). Their slugs and prefixes stay theirs, since a
 * work ID means one task forever; their GitHub repository may be registered again under a new slug.
 */
export function checkRepo(
  input,
  {
    current = null,
    others = [],
    usedPrefixes = new Map(),
    inUse = /** @type {(project: string) => boolean} */ (() => false),
    removed = [],
    caps = CAPS,
  } = {},
) {
  if (!input || typeof input !== 'object') throw new InputError('a repository is an object');
  const row = current
    ? { ...current, areas: [...current.areas] }
    : {
        slug: null,
        github: null,
        name: null,
        defaultBranch: 'main',
        areas: [],
        pipeline: null,
        routine: null,
        settings: null,
      };
  if (!current) {
    const slug = String(input.slug ?? '').toLowerCase();
    if (!SLUG.test(slug))
      throw new InputError('the slug is lowercase letters, digits, and hyphens, starting with a letter (up to 32)');
    if (others.some((r) => r.slug === slug)) throw new InputError(`the repository "${slug}" is already registered`);
    if (removed.some((r) => r.slug === slug))
      throw new InputError(`"${slug}" was a repository taken off the board, and its slug stays its own; pick another`);
    row.slug = slug;
  } else if ('slug' in input && input.slug !== current.slug) {
    throw new InputError('a repository keeps its slug');
  }
  if (!current || 'github' in input) {
    const github = String(input.github ?? '')
      .trim()
      .replace(/^https:\/\/github\.com\//u, '')
      .replace(/\.git$/u, '');
    if (!GITHUB.test(github)) throw new InputError('github is owner/name, like your-name/web');
    const taken = others.find((r) => r.github.toLowerCase() === github.toLowerCase());
    if (taken) throw new InputError(`${github} is already registered as ${taken.slug}`);
    row.github = github;
  }
  if ('name' in input)
    row.name =
      String(input.name ?? '')
        .trim()
        .slice(0, 60) || null;
  if (!row.name) row.name = row.slug;
  if ('defaultBranch' in input) {
    const branch = String(input.defaultBranch ?? '').trim();
    if (!/^[\w./-]{1,100}$/u.test(branch)) throw new InputError('the default branch is a branch name, like main');
    row.defaultBranch = branch;
  }
  for (const key of JSON_FIELDS) if (key in input) row[key] = jsonField(input[key], key);
  if ('pipeline' in input) row.pipeline = checkPipeline(row.pipeline);
  if ('routine' in input) row.routine = checkRoutine(row.routine, caps);

  const adding = [...list(input.areas), ...list(input.addAreas)].map(parseArea);
  for (const project of list(input.removeAreas).map((p) => String(p).trim().toLowerCase())) {
    if (!row.areas.some((a) => a.project === project)) throw new InputError(`${row.slug} has no area ${project}`);
    if (inUse(project)) throw new InputError(`${project} has tasks in ${row.slug}, so it stays`);
    row.areas = row.areas.filter((a) => a.project !== project);
  }
  for (const area of adding) {
    const same = row.areas.find((a) => a.project === area.project);
    if (same) {
      if (same.prefix !== area.prefix)
        throw new InputError(
          `${area.project} in ${row.slug} already has the prefix ${same.prefix}, and a prefix never changes`,
        );
      same.name = area.name;
      continue;
    }
    if (row.areas.some((a) => a.prefix === area.prefix)) throw new InputError(`${area.prefix} is given twice`);
    const owner = others.find((r) => r.areas.some((a) => a.prefix === area.prefix));
    if (owner)
      throw new InputError(`${area.prefix} already belongs to ${owner.slug}; a prefix belongs to one repository`);
    const gone = removed.find((r) => r.areas.some((a) => a.prefix === area.prefix));
    if (gone)
      throw new InputError(
        `${area.prefix} was ${gone.slug}’s, a repository taken off the board; a prefix is never given again`,
      );
    const used = usedPrefixes.get(area.prefix);
    if (used && used !== row.slug)
      throw new InputError(`${area.prefix} is already in use by tasks in ${used}; pick another prefix`);
    row.areas.push(area);
  }
  if (!row.areas.length) throw new InputError('a repository needs at least one area: --area product:PRD');
  return row;
}
