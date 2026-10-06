/**
 * `npx breakaway infra adopt <environment>` (CLI-23, docs/specs/IDEA-19-architect.md, "Desired state"): writes the
 * board's draft of an environment's desired state into the checkout, so nobody hand-writes
 * `.github/breakaway-infra/<environment>.json`. The board drafts it from what runs there (BRK-240,
 * GET /api/infra/environments/<environment>/draft, read only, so an agent's token may ask); this writes it where it
 * goes, then checks it the way `infra check` does and says what to commit.
 *
 * Files only: it never makes a plan and never applies anything. It never overwrites a file without --force, and it
 * writes nothing for an observe-only environment, which takes no desired state. The path is worked out here from the
 * environment's name, never taken from the board's answer, so the file can't land anywhere else.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkDesiredFile, desiredPath, environmentOfFile } from '../../src/infra-desired.js';
import { infraCheck, readInfraFolder } from './infra-check.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Runs `infra adopt`. `code` is what the CLI exits with: 1 when nothing was written, or the written file doesn't check.
 * @param {string[]} args what follows `infra adopt`: the environment's name (or ID)
 * @param {{ root: string, repo: string | null, force?: boolean, dryRun?: boolean,
 *   get: (path: string) => Promise<{ ok: boolean, status: number, data: any }>,
 *   post: (path: string, body: any) => Promise<{ ok: boolean, status: number, data: any }> }} ctx
 * @returns {Promise<{ code: number, data: any, text: string }>}
 */
export async function infraAdopt(args, { root, repo, get, post, force = false, dryRun = false }) {
  const refused = (error, text = `${error}.`) => ({ code: 1, data: { ok: false, written: false, error }, text });
  const ref = args[0];
  if (!ref)
    return refused(
      'name the environment',
      'Name the environment: infra adopt <environment>. npx breakaway infra lists this repository’s.',
    );

  const res = await get(
    `infra/environments/${encodeURIComponent(ref)}/draft${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`,
  );
  if (!res.ok) {
    if (res.status === 404 && /^no route for/u.test(String(res.data?.error ?? '')))
      return refused(
        'this board has no draft yet',
        'This board can’t draft a desired state yet: its owner updates it to a release that can, then try again.',
      );
    const error = res.status === 0 ? `can’t reach the board (${res.data?.error ?? 'no answer'})` : res.data?.error;
    return refused(error ?? `HTTP ${res.status}`, `Nothing was written: ${error ?? `HTTP ${res.status}`}.`);
  }

  const draft = res.data?.draft;
  const named = environmentOfFile(`${draft?.environment ?? ''}.json`);
  if (!draft || typeof draft.json !== 'string' || !named || !('environment' in named))
    return refused('the board’s draft isn’t one this CLI can read: update npx breakaway, then try again');
  const environment = named.environment;
  const path = desiredPath(environment);
  const notes = Array.isArray(draft.notes) ? draft.notes.map(String) : [];
  const data = { environment, path, resources: draft.resources ?? 0, observeOnly: Boolean(draft.observeOnly), notes };
  const withNotes = (lines) => [...lines, ...(notes.length ? ['', ...notes.map((n) => `- ${n}`)] : [])];

  if (draft.observeOnly)
    return {
      code: 1,
      data: { ...data, ok: false, written: false, error: `${environment} is observe only` },
      text: withNotes([
        `Nothing was written: ${environment} is observe only, so it takes no desired state and the board never changes it.`,
      ]).join('\n'),
    };
  // The board checks its draft before it answers, so this only fails when the two disagree: write nothing bad.
  const checked = checkDesiredFile(draft.json, {});
  if ('error' in checked)
    return refused(
      `the draft doesn’t check at ${checked.error.field ?? 'the top'}: ${checked.error.message}`,
      `Nothing was written: the board’s draft for ${environment} doesn’t check here (${checked.error.field ?? 'the top'}: ${checked.error.message}). Update npx breakaway, then try again.`,
    );

  const file = join(root, path);
  const exists = existsSync(file);
  if (exists && !force)
    return {
      code: 1,
      data: { ...data, ok: false, written: false, error: `${path} is already there` },
      text: `Nothing was written: ${path} is already there. See the draft with --dry-run, or replace the file with --force.`,
    };

  if (dryRun)
    return {
      code: 0,
      data: { ...data, ok: true, written: false, json: draft.json },
      text: withNotes([
        `Would ${exists ? 'replace' : 'write'} ${path}, ${plural(data.resources, 'resource')}:`,
        '',
        draft.json.trimEnd(),
      ]).join('\n'),
    };

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, draft.json);
  const check = await infraCheck([environment], { files: readInfraFolder(root), repo, post });
  const next =
    check.code === 0
      ? [
          '',
          `Next: commit ${path} and open a pull request. Nothing changes until it merges: then the board plans from it, and the plan waits for you.`,
        ]
      : ['', `Fix what’s above, then npx breakaway infra check ${environment} before you commit ${path}.`];
  return {
    code: check.code,
    data: { ...data, ok: check.code === 0, written: true, replaced: exists, check: check.data },
    text: [
      ...withNotes([`${exists ? 'Replaced' : 'Wrote'} ${path}, ${plural(data.resources, 'resource')}.`]),
      '',
      check.text,
      ...next,
    ].join('\n'),
  };
}
