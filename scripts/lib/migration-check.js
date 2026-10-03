/**
 * Checks a repository's SQL migrations before a deploy runs them: names that sort in order with no gap or
 * repeat (0000_first.sql, 0001_next.sql), no empty file, and an owner-approval line on any migration that
 * destroys data. Pure over `[{ name, sql }]`, so it's tested without a disk. The same rule the board reads
 * when it warns before Promote (src/release.js): a destructive migration carries
 * "-- owner-approved: <who and why>".
 */

const NAME = /^(\d{4,})_[\w.-]+\.sql$/u;
const APPROVAL = /^[ \t]*--[ \t]*owner-approved:[ \t]*\S/mu;
const DESTRUCTIVE = [
  /\bDROP\s+(TABLE|COLUMN|INDEX|VIEW|TRIGGER)\b/iu,
  /\bTRUNCATE\b/iu,
  /\bALTER\s+TABLE\s+\S+\s+DROP\b/iu,
  /\bDELETE\s+FROM\s+\S+\s*(;|$)/imu,
];

/** SQL without comments and string literals, so a keyword inside either doesn't count. */
const code = (sql) =>
  String(sql)
    .replace(/--[^\n]*/gu, '')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/'(?:[^']|'')*'/gu, "''");

/**
 * Returns `{ ok, errors, destructive }`: `errors` in the words a run shows, `destructive` the names lacking
 * approval. With `added` (the names of migrations new since the last deploy), only those need approval: the
 * rest have already run.
 */
/**
 * @param {any} files
 * @param {{ added?: string[] }} [options]
 */
export function checkMigrations(files, { added } = {}) {
  const errors = [];
  const destructive = [];
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : 1));
  let expected = 0;
  const seen = new Set();
  for (const { name, sql } of sorted) {
    const m = NAME.exec(name);
    if (!m) {
      errors.push(`${name} isn't named like 0001_what_it_does.sql.`);
      continue;
    }
    const n = Number(m[1]);
    if (seen.has(n)) errors.push(`${name} repeats number ${m[1]}: two migrations can't share one.`);
    else if (n !== expected)
      errors.push(
        `${name} should be number ${String(expected).padStart(m[1].length, '0')}: a migration is missing or out of order.`,
      );
    seen.add(n);
    expected = n + 1;
    if (!code(sql).trim()) errors.push(`${name} is empty.`);
    else if ((!added || added.includes(name)) && DESTRUCTIVE.some((re) => re.test(code(sql))) && !APPROVAL.test(sql)) {
      destructive.push(name);
      errors.push(`${name} destroys data. Add a line "-- owner-approved: <who and why>" once the owner has agreed.`);
    }
  }
  return { ok: !errors.length, errors, destructive };
}
