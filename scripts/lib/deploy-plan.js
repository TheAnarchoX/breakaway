/**
 * What a repository's Deploy, Promote, Roll back, and Release workflows decide before they act
 * (docs/specs/IDEA-27-move-ci-cd-to-the-deploy-flow.md, section 2): whether every check passed on the commit,
 * whether staging needs it, and which Worker version is which. Pure over GitHub's and wrangler's answers, so the
 * tests run without either. Copied into a repository by `repos init`, with scripts/deploy-plan.mjs.
 */
import { candidate, productionSha, versionOf } from './promote.js';

/**
 * Whether every check workflow passed on `sha`. `runs` are GitHub's workflow runs for the commit
 * (`{ id, name, head_sha, status, conclusion }`); each check counts by its latest run.
 * @param {Array<{ id: number, name: string, head_sha: string, status: string, conclusion: string | null }>} runs
 * @param {string[]} checks the check workflows' names
 * @param {string} sha
 * @returns {{ ready: boolean, reason: string }}
 */
export function checksPassed(runs, checks, sha) {
  const latest = new Map();
  for (const run of runs ?? []) {
    if (run.head_sha !== sha || !checks.includes(run.name)) continue;
    if (!latest.has(run.name) || latest.get(run.name).id < run.id) latest.set(run.name, run);
  }
  const short = sha.slice(0, 7);
  const missing = checks.filter((name) => !latest.has(name));
  if (missing.length) return { ready: false, reason: `${missing.join(', ')} hasn't run on ${short} yet.` };
  const failed = checks.filter(
    (name) => latest.get(name).status === 'completed' && latest.get(name).conclusion !== 'success',
  );
  if (failed.length) return { ready: false, reason: `${failed.join(', ')} didn't pass on ${short}.` };
  const running = checks.filter((name) => latest.get(name).status !== 'completed');
  if (running.length)
    return { ready: false, reason: `${running.join(', ')} is still running on ${short}; its own run deploys it.` };
  return { ready: true, reason: `${checks.join(', ')} passed on ${short}.` };
}

/**
 * Whether staging should deploy `sha`. `tip` is the branch's latest commit, `staging` the staging Worker's
 * Deployments (newest first, as deploymentsOf reads them), `files` the paths changed since staging's last successful
 * deploy (null when they can't be known), and `patterns` the deploy paths' regular expressions.
 * @returns {{ deploy: boolean, from: string, reason: string }}
 */
export function planDeploy({ sha, tip, checks, staging, files, patterns }) {
  const short = sha.slice(0, 7);
  const no = (reason, from = '') => ({ deploy: false, from, reason });
  if (!checks.ready) return no(checks.reason);
  if (tip && tip !== sha)
    return no(`${short} isn't the branch's latest commit any more: ${tip.slice(0, 7)} deploys next, with it.`);
  const last = candidate(staging ?? []);
  const from = last?.sha ?? '';
  if (from === sha) return no(`Staging already runs ${short}.`, from);
  if (!from) return { deploy: true, from, reason: `Staging has no deploy yet, so ${short} goes first.` };
  if (files && patterns?.length && !files.some((file) => patterns.some((pattern) => pattern.test(file))))
    return no(`Nothing since ${from.slice(0, 7)} touches the deploy paths, so staging stays as it is.`, from);
  return { deploy: true, from, reason: `${short} goes to staging, after ${from.slice(0, 7)}.` };
}

/** The deploy paths file (`{ worker: "regex" }`) as regular expressions; a pattern that doesn't compile is an error. */
export function deployPatterns(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json))
    throw new Error('The deploy paths file is an object of Worker names and regular expressions.');
  return Object.entries(json).map(([worker, pattern]) => {
    try {
      return new RegExp(String(pattern), 'u');
    } catch {
      throw new Error(`The deploy path for ${worker} isn't a regular expression: ${pattern}`);
    }
  });
}

/** The version a Worker runs, from `wrangler deployments list --json`: what a rollback goes back to. */
export function currentVersionId(deployments) {
  const list = Array.isArray(deployments) ? deployments : [];
  const newest = [...list].sort((a, b) => String(b.created_on ?? '').localeCompare(String(a.created_on ?? '')))[0];
  const best = [...(newest?.versions ?? [])].sort((a, b) => (b.percentage ?? 0) - (a.percentage ?? 0))[0];
  return best?.version_id ?? null;
}

/** The version wrangler just uploaded or deployed, from its output file (WRANGLER_OUTPUT_FILE_PATH, one JSON a line). */
export function uploadedVersionId(ndjson) {
  const entries = String(ndjson ?? '')
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  return entries.filter((e) => ['version-upload', 'deploy'].includes(e.type) && e.version_id).pop()?.version_id ?? null;
}

/** Whether wrangler's output from a failed `deployments list` says the Worker doesn't exist yet (Cloudflare error 10007). */
export const workerMissing = (output) =>
  /\[code: 10007\]|worker does not exist on your account/iu.test(String(output ?? ''));

/** The commit an environment runs now: its latest successful deploy or rollback. */
export const liveSha = (deployments) => productionSha(deployments ?? []);

/** The commit a Worker version was deployed from, by the Deployments that recorded it. */
export const shaOfVersion = (deployments, version) =>
  (deployments ?? []).find((d) => d.state === 'success' && versionOf(d.description) === version)?.sha ?? null;
