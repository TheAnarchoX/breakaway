/**
 * The shape check (BRK-54, docs/specs/IDEA-20-self-updating-installs.md section 4). A release's signed manifest lists
 * the shape it expects the Worker to have: the bindings, Durable Object classes, migrations, and cron triggers that
 * `wrangler deploy` would set. The Worker's own API call to Cloudflare uploads code and bindings it already has but
 * can't change the rest, so an install whose shape differs is stopped, even if the release forgot to say `manual`.
 * Routes need a zone-scoped token the install doesn't hold, so they are in the manifest for people, not compared here.
 */

/** The binding types a shape lists; plain values and secrets differ per install and never count. */
export const SHAPE_BINDINGS = ['durable_object_namespace', 'version_metadata', 'assets', 'secrets_store_secret'];

const names = (list) => [...new Set(list)].sort();
const said = (list) => (list.length ? list.join(', ') : 'none');

/**
 * What Cloudflare reports for this Worker, in the manifest's terms.
 * @param {{ bindings?: any[], migrations?: any }} settings the Worker's settings
 * @param {{ schedules?: { cron: string }[] } | null} schedules the Worker's cron triggers
 */
export function shapeOfInstall(settings, schedules) {
  const bindings = (settings.bindings ?? []).filter((b) => SHAPE_BINDINGS.includes(b.type));
  const tag = settings.migrations?.new_tag ?? settings.migrations?.old_tag ?? null;
  return {
    bindings: names(bindings.map((b) => `${b.type}:${b.name}`)),
    durableObjects: names(bindings.filter((b) => b.class_name).map((b) => b.class_name)),
    migrationTag: typeof tag === 'string' ? tag : null,
    crons: names((schedules?.schedules ?? []).map((s) => s.cron)),
  };
}

/**
 * What stops this release from being installed by the board, in words; empty when the install matches.
 * @param {any} expected the manifest's `shape`
 * @param {ReturnType<typeof shapeOfInstall>} actual
 * @returns {string[]}
 */
export function shapeProblems(expected, actual) {
  if (!expected || typeof expected !== 'object')
    return ['it doesn’t list the shape it expects, so the board can’t tell whether it fits'];
  const problems = [];
  const list = (key) => (Array.isArray(expected[key]) ? expected[key].map(String) : []);
  const bindings = list('bindings').map((b) => (typeof b === 'string' ? b : ''));
  const missing = names(bindings).filter((b) => !actual.bindings.includes(b));
  if (missing.length) problems.push(`it needs bindings this Worker doesn’t have (${said(missing)})`);
  const classes = names(list('durableObjects')).filter((c) => !actual.durableObjects.includes(c));
  if (classes.length) problems.push(`it needs Durable Object classes this Worker doesn’t have (${said(classes)})`);
  const migrations = list('migrations');
  const last = migrations[migrations.length - 1];
  if (last && actual.migrationTag && actual.migrationTag !== last)
    problems.push(`it expects migration ${last}, and this Worker is at ${actual.migrationTag}`);
  const want = names(list('crons'));
  if (want.join('|') !== actual.crons.join('|'))
    problems.push(`its cron triggers are ${said(want)}, and this Worker’s are ${said(actual.crons)}`);
  return problems;
}
