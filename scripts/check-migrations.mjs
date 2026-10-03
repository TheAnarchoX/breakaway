#!/usr/bin/env node
/**
 * Check a repository's SQL migrations before a deploy runs them (scripts/lib/migration-check.js).
 *   node scripts/check-migrations.mjs --dir <path> [--base <ref>]
 * --dir is the folder of .sql files (migrations, or drizzle). With --base, only migrations added since that
 * commit need an owner-approval line when they destroy data. Exits 1 and says what to fix. Copied by `repos init`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { checkMigrations } from './lib/migration-check.js';

const { values: o } = parseArgs({ options: { dir: { type: 'string' }, base: { type: 'string' } } });

try {
  if (!o.dir) throw new Error('Give the folder of migrations: --dir <path>.');
  const files = readdirSync(o.dir)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => ({ name, sql: readFileSync(join(o.dir, name), 'utf8') }));
  let added;
  if (o.base) {
    const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=A', o.base, '--', o.dir], {
      encoding: 'utf8',
    });
    added = out
      .split('\n')
      .filter(Boolean)
      .map((p) => p.split('/').pop());
  }
  const { ok, errors } = checkMigrations(files, { added });
  if (!ok) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log(
    `${files.length} migration${files.length === 1 ? '' : 's'} in ${o.dir}: in order, none destructive without approval.`,
  );
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
