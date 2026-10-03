/**
 * Record and read GitHub Deployments the way the board reads them (src/github.js deployFrom): one Deployment
 * per attempt (environment = Worker, ref = commit, task = deploy, rollback, or try), a status per step, and a
 * description like "version <id> · migrations <names> · artifact <digest>". A repository's Deploy, Promote, and
 * Roll back workflows use scripts/record-deployment.mjs, so every repository records the same shape.
 * Repository-neutral: the repository, Worker names, and token come from the caller. `fetch` is passed in, so
 * the tests run without GitHub.
 */

export const USER_AGENT = 'breakaway-release-helpers';
export const TASKS = ['deploy', 'rollback', 'try'];
export const STATES = ['queued', 'in_progress', 'success', 'failure', 'error', 'inactive'];

const REPO = /^[\w.-]+\/[\w.-]+$/u;

/** "version <id> · migrations <names> · artifact <digest>", leaving out what the caller has no value for. */
/** @param {{ note?: string, version?: string, migrations?: string | string[], artifact?: string }} [deploy] */
export function describeDeploy({ note, version, migrations, artifact } = {}) {
  const names = Array.isArray(migrations) ? migrations.join(', ') : migrations;
  return [note, version && `version ${version}`, artifact && `artifact ${artifact}`, names && `migrations ${names}`]
    .filter(Boolean)
    .join(' · ')
    .slice(0, 140);
}

function headers(token) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
    'x-github-api-version': '2022-11-28',
  };
}

async function call(fetch, token, method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: headers(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${method} ${path}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/**
 * Add a status to a Deployment, making the Deployment first unless `deploymentId` names one. Returns
 * `{ id, state }`. A `try` (branch deploy) is never a production environment.
 */
export async function recordDeployment({
  fetch = globalThis.fetch,
  token,
  repo,
  environment,
  sha,
  task = 'deploy',
  state,
  description = '',
  logUrl,
  environmentUrl,
  deploymentId,
  production = false,
}) {
  if (!token) throw new Error('Give a GitHub token (GITHUB_TOKEN) that can write Deployments.');
  if (!REPO.test(repo ?? '')) throw new Error('Give the repository as owner/name.');
  if (!TASKS.includes(task)) throw new Error(`The task is one of ${TASKS.join(', ')}, not ${task}.`);
  if (!STATES.includes(state)) throw new Error(`The state is one of ${STATES.join(', ')}, not ${state}.`);
  let id = deploymentId;
  if (!id) {
    if (!environment) throw new Error('Name the environment (the Worker) the deploy is for.');
    if (!/^[0-9a-f]{40}$/u.test(sha ?? '')) throw new Error('Give the full commit SHA being deployed.');
    const made = await call(fetch, token, 'POST', `/repos/${repo}/deployments`, {
      ref: sha,
      environment,
      task,
      auto_merge: false,
      required_contexts: [],
      transient_environment: task === 'try',
      production_environment: production && task !== 'try',
      description: description.slice(0, 140),
    });
    id = made.id;
  }
  await call(fetch, token, 'POST', `/repos/${repo}/deployments/${id}/statuses`, {
    state,
    description: description.slice(0, 140),
    ...(logUrl && { log_url: logUrl }),
    ...(environmentUrl && { environment_url: environmentUrl }),
  });
  return { id, state };
}

/**
 * An environment's Deployments, newest first, as promote.js reads them: `{ sha, task, state, description }`
 * with `state` the latest status's ('' when none yet).
 */
export async function deploymentsOf({ fetch = globalThis.fetch, token, repo, environment, limit = 30 }) {
  const list = await call(
    fetch,
    token,
    'GET',
    `/repos/${repo}/deployments?environment=${encodeURIComponent(environment)}&per_page=${limit}`,
  );
  return Promise.all(
    list.map(async (d) => {
      const [status] =
        (await call(fetch, token, 'GET', `/repos/${repo}/deployments/${d.id}/statuses?per_page=1`)) ?? [];
      return {
        sha: d.sha,
        task: d.task ?? 'deploy',
        state: status?.state ?? '',
        description: status?.description ?? d.description ?? '',
      };
    }),
  );
}

/** Whether `sha` is on `branch` (the branch's history includes it), by GitHub's compare. */
export async function isOnBranch({ fetch = globalThis.fetch, token, repo, branch, sha }) {
  const cmp = await call(
    fetch,
    token,
    'GET',
    `/repos/${repo}/compare/${encodeURIComponent(sha)}...${encodeURIComponent(branch)}`,
  );
  return cmp.status === 'identical' || cmp.status === 'ahead';
}
