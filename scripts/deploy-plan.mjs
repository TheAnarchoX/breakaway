#!/usr/bin/env node
/**
 * The steps a repository's Deploy, Promote, Roll back, and Release workflows run before they act
 * (scripts/lib/deploy-plan.js). Each prints key=value lines for $GITHUB_OUTPUT and its reason on stderr.
 *   node scripts/deploy-plan.mjs checks --sha <commit> --checks '["CI"]'
 *       ready=true when every check workflow passed on the commit
 *   node scripts/deploy-plan.mjs plan --staging <worker> --sha <commit> --checks '["CI"]' [--branch main] [--paths <file>]
 *       deploy=true when staging should deploy the commit, and from=<the commit staging ran before>
 *   node scripts/deploy-plan.mjs live --environment <worker>              sha=<the commit it runs>
 *   node scripts/deploy-plan.mjs sha-of --environment <worker> --version <id>   sha=<the commit that version came from>
 *   node scripts/deploy-plan.mjs current < deployments.json               version=<what wrangler deployments list runs>
 *   node scripts/deploy-plan.mjs uploaded < wrangler-output.ndjson        version=<what wrangler just uploaded>
 *   node scripts/deploy-plan.mjs missing < wrangler-error.txt             exits 1 unless the Worker doesn't exist yet
 * Reads GITHUB_TOKEN and GITHUB_REPOSITORY (or --repo owner/name). Copied into a repository by `repos init`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  checksPassed,
  currentVersionId,
  deployPatterns,
  liveSha,
  planDeploy,
  shaOfVersion,
  uploadedVersionId,
  workerMissing,
} from './lib/deploy-plan.js';
import { USER_AGENT, deploymentsOf } from './lib/deployments.js';

const { positionals, values: o } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string' },
    sha: { type: 'string' },
    checks: { type: 'string' },
    staging: { type: 'string' },
    branch: { type: 'string', default: 'main' },
    paths: { type: 'string' },
    environment: { type: 'string' },
    version: { type: 'string' },
  },
});
const token = process.env.GITHUB_TOKEN;
const repo = o.repo ?? process.env.GITHUB_REPOSITORY;
const stdin = () => readFileSync(0, 'utf8');

/** @returns {Promise<any>} */
async function get(path) {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': USER_AGENT,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function checks() {
  if (!/^[0-9a-f]{40}$/u.test(o.sha ?? '')) throw new Error('Give the full commit: --sha <commit>.');
  let names;
  try {
    names = JSON.parse(o.checks ?? '');
  } catch {
    names = null;
  }
  if (!Array.isArray(names) || !names.length) throw new Error('Name the check workflows as JSON: --checks \'["CI"]\'.');
  const { workflow_runs: runs } = await get(`/actions/runs?head_sha=${o.sha}&per_page=100`);
  return checksPassed(runs, names, o.sha);
}

/** The files changed between two commits, or null when git can't say (the older one isn't in this checkout). */
function changedFiles(from, to) {
  try {
    return execFileSync('git', ['diff', '--name-only', from, to], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

try {
  const [command] = positionals;
  if (command === 'checks') {
    const result = await checks();
    console.error(result.reason);
    console.log(`ready=${result.ready}`);
  } else if (command === 'plan') {
    if (!o.staging) throw new Error('Name the staging Worker: --staging <worker>.');
    const ready = await checks();
    const [tip, staging] = ready.ready
      ? await Promise.all([
          get(`/commits/${encodeURIComponent(o.branch)}`),
          deploymentsOf({ token, repo, environment: o.staging }),
        ])
      : [null, []];
    const from = staging.find((d) => d.task === 'deploy' && d.state === 'success')?.sha;
    const patterns = o.paths ? deployPatterns(JSON.parse(readFileSync(o.paths, 'utf8'))) : [];
    const plan = planDeploy({
      sha: o.sha,
      tip: tip?.sha ?? null,
      checks: ready,
      staging,
      files: from ? changedFiles(from, o.sha) : null,
      patterns,
    });
    console.error(plan.reason);
    console.log(`deploy=${plan.deploy}\nfrom=${plan.from}`);
  } else if (command === 'live' || command === 'sha-of') {
    if (!o.environment) throw new Error('Name the Worker: --environment <worker>.');
    const list = await deploymentsOf({ token, repo, environment: o.environment });
    console.log(`sha=${(command === 'live' ? liveSha(list) : shaOfVersion(list, o.version)) ?? ''}`);
  } else if (command === 'current') {
    console.log(`version=${currentVersionId(JSON.parse(stdin() || '[]')) ?? ''}`);
  } else if (command === 'uploaded') {
    const version = uploadedVersionId(stdin());
    if (!version) throw new Error("wrangler's output names no version it uploaded.");
    console.log(`version=${version}`);
  } else if (command === 'missing') {
    if (!workerMissing(stdin()))
      throw new Error(
        "Couldn't list the Worker's deployments, so there would be nothing to roll back to. Check that CLOUDFLARE_ACCOUNT_ID is your account's ID and that CLOUDFLARE_API_TOKEN can read and edit the Worker.",
      );
    console.log('missing=true');
  } else {
    throw new Error(
      'Usage: deploy-plan.mjs checks | plan | live | sha-of | current | uploaded | missing (see the file)',
    );
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
