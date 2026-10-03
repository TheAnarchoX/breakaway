#!/usr/bin/env node
/**
 * The Promote workflow's first step: may this commit go to production? Exits 1 with the reason when it may not.
 *   node scripts/promote-check.mjs --staging <worker> --production <worker> --sha <commit>
 *     [--artifact-digest <digest>] [--branch main] [--paused] [--repo owner/name]
 * Reads GITHUB_TOKEN, and without --repo GITHUB_REPOSITORY; DEPLOYS_PAUSED=true is the same as --paused.
 * On success it prints the version and artifact digest, and writes them to GITHUB_OUTPUT when that is set.
 * Copied into a repository by `repos init`; the rules are the board's (src/promote.js).
 */
import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { deploymentsOf, isOnBranch } from './lib/deployments.js';
import { checkCandidate } from './lib/promote.js';

const { values: o } = parseArgs({
  options: {
    repo: { type: 'string' },
    staging: { type: 'string' },
    production: { type: 'string' },
    sha: { type: 'string' },
    'artifact-digest': { type: 'string' },
    branch: { type: 'string', default: 'main' },
    paused: { type: 'boolean', default: false },
  },
});

try {
  if (!o.staging || !o.production) throw new Error('Name both Workers: --staging <worker> --production <worker>.');
  const token = process.env.GITHUB_TOKEN;
  const repo = o.repo ?? process.env.GITHUB_REPOSITORY;
  const [staging, production] = await Promise.all([
    deploymentsOf({ token, repo, environment: o.staging }),
    deploymentsOf({ token, repo, environment: o.production }),
  ]);
  const valid = /^[0-9a-f]{40}$/u.test(o.sha ?? '');
  const result = checkCandidate({
    sha: o.sha,
    staging,
    production,
    paused: o.paused || process.env.DEPLOYS_PAUSED === 'true',
    onMain: valid ? await isOnBranch({ token, repo, branch: o.branch, sha: o.sha }) : true,
    artifactDigest: o['artifact-digest'] ?? null,
  });
  if (!result.ok) {
    console.error(result.reason);
    process.exit(1);
  }
  const { version, digest } = result.candidate;
  console.log(`Ready to promote ${o.sha.slice(0, 7)}: version ${version ?? 'unknown'}, artifact ${digest}.`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version ?? ''}\ndigest=${digest}\n`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
