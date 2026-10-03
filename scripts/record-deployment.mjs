#!/usr/bin/env node
/**
 * Record a deploy step as a GitHub Deployment status, the way the board reads them (scripts/lib/deployments.js).
 *   node scripts/record-deployment.mjs --environment <worker> --sha <commit> --state <state>
 *     [--task deploy|rollback|try] [--version <id>] [--migrations <names>] [--artifact <digest>] [--note <text>]
 *     [--description <text>] [--log-url <url>] [--environment-url <url>] [--deployment <id>] [--production]
 *     [--repo owner/name]
 * Reads GITHUB_TOKEN and, without --repo, GITHUB_REPOSITORY. Prints the Deployment's id: pass it back as
 * --deployment to add the next status to the same one. Copied into a repository by `repos init`.
 */
import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { describeDeploy, recordDeployment } from './lib/deployments.js';

const { values: o } = parseArgs({
  options: {
    repo: { type: 'string' },
    environment: { type: 'string' },
    sha: { type: 'string' },
    task: { type: 'string', default: 'deploy' },
    state: { type: 'string' },
    version: { type: 'string' },
    migrations: { type: 'string' },
    artifact: { type: 'string' },
    note: { type: 'string' },
    description: { type: 'string' },
    'log-url': { type: 'string' },
    'environment-url': { type: 'string' },
    deployment: { type: 'string' },
    production: { type: 'boolean', default: false },
  },
});

try {
  const { id } = await recordDeployment({
    token: process.env.GITHUB_TOKEN,
    repo: o.repo ?? process.env.GITHUB_REPOSITORY,
    environment: o.environment,
    sha: o.sha,
    task: o.task,
    state: o.state,
    description: o.description ?? describeDeploy(o),
    logUrl: o['log-url'],
    environmentUrl: o['environment-url'],
    deploymentId: o.deployment,
    production: o.production,
  });
  console.log(id);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `deployment=${id}\n`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
