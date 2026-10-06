/**
 * `npx breakaway infra check [<environment>]` (CLI-14, docs/specs/IDEA-19-architect.md, "Desired state" and "CLI"):
 * before a pull request, checks the checkout's `.github/breakaway-infra/` folder (each environment's desired state and
 * the policy) the way the board will once it's merged, and asks the board for the plan each valid file would make
 * against what runs now, the way `pipeline check` checks the deploy config.
 *
 * The files are checked here, with src/infra-check.js: a file that doesn't check names its line and field, and nothing
 * is sent. A valid one goes to POST /api/infra/check, the board's preview: kept nowhere, with no ID and no state, so it
 * can't be approved or applied, and an agent's token may ask for it. The requests go through `post`, which the CLI gives
 * (and the tests mock), and which answers `{ ok, status, data }` for any answer.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkInfraFolder, problemLine } from '../../src/infra-check.js';
import { DESIRED_DIR } from '../../src/infra-desired.js';
import { POLICY_FILE } from '../../src/infra-policy.js';
import { planText } from './infra-read.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The folder's files in a checkout, by name and text, or null when it has no folder.
 * @param {string} root the checkout's top
 * @returns {{ name: string, text: string }[] | null}
 */
export function readInfraFolder(root) {
  let names;
  try {
    names = readdirSync(join(root, DESIRED_DIR), { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return null;
  }
  return names.map((name) => ({ name, text: readFileSync(join(root, DESIRED_DIR, name), 'utf8') }));
}

/**
 * Runs `infra check`. `code` is what the CLI exits with: 1 when a file doesn't check or the board refuses a preview.
 * @param {string[]} args what follows `infra check`: an environment's name, or nothing for every one
 * @param {{ files: { name: string, text: string }[] | null, repo: string | null,
 *   post: (path: string, body: any) => Promise<{ ok: boolean, status: number, data: any }> }} ctx
 * @returns {Promise<{ code: number, data: any, text: string }>}
 */
export async function infraCheck(args, { files, repo, post }) {
  const only = args[0] ?? null;
  if (files === null)
    return {
      code: 1,
      data: { ok: false, error: `no ${DESIRED_DIR}/ in this checkout` },
      text: `No ${DESIRED_DIR}/ in this checkout. Add one file per environment, like ${DESIRED_DIR}/staging.json, and ${POLICY_FILE} beside them for the policy.`,
    };
  const checked = checkInfraFolder(files);
  const environments = checked.files.filter((f) => f.kind === 'desired').map((f) => f.environment);
  if (only && !environments.includes(only))
    return {
      code: 1,
      data: { ok: false, error: `no ${DESIRED_DIR}/${only}.json in this checkout`, files: checked.files },
      text: `No ${DESIRED_DIR}/${only}.json in this checkout${environments.length ? `: it has ${environments.join(', ')}` : ''}.`,
    };

  const out = [];
  for (const f of checked.files) {
    if (f.kind === 'skipped') continue;
    if (!f.ok) out.push(problemLine(f.path, /** @type {any} */ (f.error)));
    else if (f.kind === 'policy') out.push(`${f.path}: the policy checks`);
    else out.push(`${f.path}: checks, ${plural(f.resources ?? 0, 'resource')}`);
  }
  if (!environments.length) out.push(`No environment’s file yet: add one, like ${DESIRED_DIR}/staging.json.`);
  if (!checked.files.some((f) => f.kind === 'policy'))
    out.push(`No ${POLICY_FILE}: the default policy decides, and every plan waits for you.`);
  if (!checked.ok) {
    out.push('', 'Nothing was sent to the board: fix what’s above, then check again.');
    return { code: 1, data: { ok: false, files: checked.files, previews: [] }, text: out.join('\n') };
  }

  const policy = files.find((f) => f.name === POLICY_FILE)?.text ?? null;
  const previews = [];
  let code = 0;
  for (const environment of only ? [only] : environments) {
    const file = /** @type {{ text: string }} */ (files.find((f) => f.name === `${environment}.json`)).text;
    const res = await post('infra/check', { environment, ...(repo ? { repo } : {}), file, policy });
    out.push('');
    if (res.ok) {
      const { preview } = res.data;
      previews.push({ environment, preview });
      out.push(planText({ plan: preview }));
      continue;
    }
    if (res.status === 404 && /^no route for/u.test(String(res.data?.error ?? '')))
      return {
        code: 1,
        data: { ok: false, error: 'this board has no infra check yet', files: checked.files, previews },
        text: [
          ...out,
          'This board doesn’t have infra check yet: its owner updates it to a release that does, then try again.',
        ].join('\n'),
      };
    // An environment the board doesn't have yet is one to add, as the board shows a file with no environment.
    if (res.status === 404) {
      previews.push({ environment, preview: null, toAdd: true });
      out.push(
        `${environment}: no environment on the board yet, so there’s no plan to show. The owner adds it on the board’s Infrastructure view.`,
      );
      continue;
    }
    code = 1;
    const problem = res.data?.problem;
    const error = res.status === 0 ? `can’t reach the board (${res.data?.error ?? 'no answer'})` : res.data?.error;
    previews.push({
      environment,
      preview: null,
      error: error ?? `HTTP ${res.status}`,
      ...(problem ? { problem } : {}),
    });
    out.push(problem ? problemLine(problem.path, problem) : `${environment}: ${error ?? `HTTP ${res.status}`}`);
  }
  return { code, data: { ok: code === 0, files: checked.files, previews }, text: out.join('\n') };
}
