/**
 * A stable digest of a build output, for a repository that builds one environment-neutral output once and
 * promotes those bytes. The manifest is one line per regular file under the folder, sorted by path:
 * "<sha256 of the bytes> <size> <path>" with "/" separators. The digest is the SHA-256 of that manifest, so
 * it depends only on the paths and bytes: not on the order files were written, their times, or their modes.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** `[{ path, size, sha256 }]` for every file under `dir`, sorted by path. Links are refused: they don't travel. */
export function filesUnder(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const path = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`${path} is a link, and a link can't be part of a release artifact.`);
    if (stat.isDirectory()) out.push(...filesUnder(full, path));
    else if (stat.isFile()) {
      const bytes = readFileSync(full);
      out.push({ path, size: bytes.length, sha256: sha256(bytes) });
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The manifest text for a list from filesUnder. */
export const manifestOf = (files) => files.map((f) => `${f.sha256} ${f.size} ${f.path}\n`).join('');

/** `{ digest, manifest, files }` for the folder `dir`. */
export function digestDir(dir) {
  const files = filesUnder(dir);
  if (!files.length) throw new Error(`${dir} has no files, so there is nothing to make a release artifact of.`);
  const manifest = manifestOf(files);
  return { digest: sha256(manifest), manifest, files };
}
