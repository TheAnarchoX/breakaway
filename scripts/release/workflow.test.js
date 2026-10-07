import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// BRK-74: npm says why its trusted publishing didn't apply only in its verbose log, and the release's Actions logs are
// public. Both jobs that publish keep that log to the runner and show only npm's usual lines and its oidc lines.
const WORKFLOW = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
const publishes = WORKFLOW.split('\n').filter((line) => /^\s+if npm stage publish\b/u.test(line));

describe('the release’s npm publish (BRK-74)', () => {
  it('runs in both jobs, with its verbose log kept to a file', () => {
    expect(publishes).toHaveLength(2);
    for (const line of publishes) expect(line).toMatch(/--loglevel verbose > "\$RUNNER_TEMP\/npm\.log" 2>&1/u);
    expect(publishes.join('\n')).toMatch(/--tag next/u);
    expect(publishes.join('\n')).toMatch(/--tag latest/u);
  });

  it('on a failure, shows the oidc lines and the fields to check, and never the whole log', () => {
    expect(WORKFLOW.match(/grep -i 'oidc' "\$RUNNER_TEMP\/npm\.log" \| grep -v 'eyJ'/gu)).toHaveLength(2);
    expect(WORKFLOW.match(/::error title=npm refused to stage it::/gu)).toHaveLength(2);
    expect(WORKFLOW).not.toMatch(/cat "\$RUNNER_TEMP\/npm\.log"/u);
    expect(WORKFLOW).not.toMatch(/--loglevel (silly|sill)/u);
  });
});

// BRK-75: npm's trusted publishing can't read this repository's immutable OIDC subject yet (npm/cli#9969), so a token
// stands in. It lives in the npm environment, which only main can use, and reaches npm stage publish only: the version
// goes live when the owner approves it with 2FA, so the token can't publish anything by itself.
describe('the npm token (BRK-75)', () => {
  it('stages every version for the owner’s approval, and never publishes one directly', () => {
    expect(WORKFLOW).not.toMatch(/^\s+(if )?npm publish\b/mu);
    expect(WORKFLOW.match(/npm install -g npm@\^11\.15\.0/gu)).toHaveLength(2);
  });

  it('runs both publishing jobs in the npm environment', () => {
    expect(WORKFLOW.match(/^ {4}environment: npm$/gmu)).toHaveLength(2);
  });

  it('reaches only the two publish steps', () => {
    const uses = WORKFLOW.split('\n').filter((line) => /secrets\.NPM_TOKEN/u.test(line));
    expect(uses).toEqual([
      '          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}',
      '          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}',
    ]);
    const steps = WORKFLOW.split(/\n {6}- /u).filter((step) => step.includes('secrets.NPM_TOKEN'));
    expect(steps).toHaveLength(2);
    for (const step of steps) expect(step).toMatch(/^name: Stage the CLI on npm\n/u);
  });
});

// BRK-51: each manifest is signed with the key in the npm environment, and the signature is a release asset.
describe('the release signature (BRK-51)', () => {
  it('signs the manifest before each release is created, with the secret reaching only those steps', () => {
    const uses = WORKFLOW.split('\n').filter((line) => /secrets\.RELEASE_SIGNING_KEY/u.test(line));
    expect(uses).toHaveLength(2);
    const creates = WORKFLOW.match(/gh release create .*\n?/gu) ?? [];
    expect(creates).toHaveLength(2);
    for (const create of creates) expect(create).toMatch(/out\/manifest\.json\.sig/u);
    expect(WORKFLOW.match(/scripts\/release\/sign\.mjs out\/manifest\.json out\/manifest\.json\.sig/gu)).toHaveLength(
      2,
    );
    for (const job of WORKFLOW.split(/\n {2}(?=\w+:\n {4}name:)/u).filter((j) => j.includes('gh release create')))
      expect(job).toMatch(/^ {4}environment: npm$/mu);
  });
});

// BRK-52: the signed manifest carries the bundle's checksum, which an install checks (SHA256SUMS isn't signed).
describe('the manifest’s bundle checksum (BRK-52)', () => {
  it('is computed from the bundle when the pre-release’s manifest is made', () => {
    expect(WORKFLOW).toMatch(/plan\.mjs manifest main "\$VERSION" "\$SHA" --bundle out\/breakaway-bundle\.tar\.gz/u);
  });
});

// BRK-118: the owner picks what main works toward next when they promote a stable. Minor or major opens the pull request
// that sets package.json, from a job of its own that holds no secrets and can only write contents and pull requests.
describe('the next version after a stable (BRK-118)', () => {
  const job = WORKFLOW.split(/\n {2}(?=[\w-]+:\n {4}name:)/u).find((j) => j.startsWith('next-version:')) ?? '';

  it('is a dispatch input: patch, minor, or major, patch by default', () => {
    expect(WORKFLOW).toMatch(
      / {6}next:\n {8}description: .+\n {8}required: false\n {8}default: patch\n {8}type: choice\n {8}options: \[patch, minor, major\]\n/u,
    );
  });

  it('runs after the stable, only for minor or major', () => {
    expect(job).toMatch(/^ {4}needs: stable$/mu);
    expect(job).toMatch(/^ {4}if: inputs\.next == 'minor' \|\| inputs\.next == 'major'$/mu);
    expect(job).toMatch(/plan\.mjs next "\$STABLE" "\$NEXT"/u);
  });

  it('can write contents and pull requests and nothing else, with no environment or secrets', () => {
    expect(job).toMatch(/ {4}permissions:\n {6}contents: write\n {6}pull-requests: write\n {4}env:/u);
    expect(job).not.toMatch(/secrets\.|environment:|id-token/u);
    expect(job).toMatch(/persist-credentials: false/u);
  });

  it('opens one pull request that sets package.json, and says how to get CI on it', () => {
    expect(job).toMatch(/gh pr create .*--base main --head "\$branch"/u);
    expect(job).toMatch(/contents\/package\.json/u);
    expect(job).toMatch(/close and reopen this pull request/u);
  });
});

// BRK-273: a merge publishes nothing. The owner runs Release by hand on main: with prerelease empty it publishes a
// pre-release of main's latest commit, once CI passed on it; with a pre-release's tag it promotes that one to stable.
describe('releases only by hand (BRK-273)', () => {
  const jobs = WORKFLOW.split(/\n {2}(?=[\w-]+:\n {4}name:)/u);
  const job = (name) => jobs.find((j) => j.startsWith(`${name}:`)) ?? '';
  const triggers = WORKFLOW.slice(WORKFLOW.indexOf('\non:\n'), WORKFLOW.indexOf('\npermissions:'));

  it('is started by workflow_dispatch alone, with prerelease optional', () => {
    expect(triggers.match(/^ {2}[\w-]+:/gmu)).toEqual(['  workflow_dispatch:']);
    expect(WORKFLOW).not.toMatch(/workflow_run/u);
    expect(triggers).toMatch(/ {6}prerelease:\n {8}description: .+\n {8}required: false\n {8}default: ''\n/u);
  });

  it('publishes a pre-release only from main with prerelease empty, and a stable only with it set', () => {
    expect(job('prerelease')).toMatch(
      /^ {4}if: github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main' && inputs\.prerelease == ''$/mu,
    );
    expect(job('stable')).toMatch(
      /^ {4}if: github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main' && inputs\.prerelease != ''$/mu,
    );
  });

  it('checks CI passed on the commit, and that it has no release yet, before it builds', () => {
    const pre = job('prerelease');
    expect(pre).toMatch(/^ {6}SHA: \$\{\{ github\.sha \}\}$/mu);
    expect(pre).toMatch(/^ {6}actions: read$/mu);
    const check = pre.indexOf('name: Check the commit');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(pre.indexOf('name: Build once'));
    expect(pre).toMatch(/gh run list --repo "\$GITHUB_REPOSITORY" --workflow ci\.yml --commit "\$SHA" --event push/u);
    expect(pre).toMatch(/git tag --points-at "\$SHA" -l 'v\*'/u);
  });
});
