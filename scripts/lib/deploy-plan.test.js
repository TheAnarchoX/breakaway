import { describe, expect, it } from 'vitest';
import {
  checksPassed,
  currentVersionId,
  deployPatterns,
  liveSha,
  planDeploy,
  shaOfVersion,
  uploadedVersionId,
  workerMissing,
} from './deploy-plan.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const V1 = '11111111-1111-1111-1111-111111111111';
const V2 = '22222222-2222-2222-2222-222222222222';
const run = (id, name, status, conclusion, sha = B) => ({ id, name, head_sha: sha, status, conclusion });

// BRK-90: Deploy and Release start once per check workflow; only the run that finds them all passed goes on.
describe('the checks before a deploy or a release (BRK-90)', () => {
  it('waits for every check, by its latest run on the commit', () => {
    expect(checksPassed([run(1, 'CI', 'completed', 'success')], ['CI', 'Lint'], B)).toEqual({
      ready: false,
      reason: `Lint hasn't run on bbbbbbb yet.`,
    });
    expect(
      checksPassed([run(1, 'CI', 'completed', 'success'), run(2, 'Lint', 'in_progress', null)], ['CI', 'Lint'], B)
        .ready,
    ).toBe(false);
    expect(
      checksPassed([run(1, 'CI', 'completed', 'failure'), run(3, 'CI', 'completed', 'success')], ['CI'], B).ready,
    ).toBe(true);
    expect(
      checksPassed([run(3, 'CI', 'completed', 'failure'), run(1, 'CI', 'completed', 'success')], ['CI'], B).reason,
    ).toMatch(/didn't pass/u);
  });

  it('ignores runs on other commits and of other workflows', () => {
    expect(
      checksPassed([run(1, 'CI', 'completed', 'success', A), run(2, 'Docs', 'completed', 'success')], ['CI'], B).ready,
    ).toBe(false);
  });
});

describe('whether staging deploys a commit (BRK-90)', () => {
  const ready = { ready: true, reason: 'CI passed.' };
  const staging = [{ sha: A, task: 'deploy', state: 'success', description: `pre-release · version ${V1}` }];
  const patterns = deployPatterns({ widgets: '^src/' });

  it('deploys the branch’s latest commit when it touches the deploy paths', () => {
    expect(planDeploy({ sha: B, tip: B, checks: ready, staging, files: ['src/a.js'], patterns })).toMatchObject({
      deploy: true,
      from: A,
    });
  });

  it('stops when the checks didn’t pass, a newer commit is coming, or staging already runs it', () => {
    expect(
      planDeploy({ sha: B, tip: B, checks: { ready: false, reason: 'no' }, staging, files: [], patterns }).deploy,
    ).toBe(false);
    expect(planDeploy({ sha: B, tip: C, checks: ready, staging, files: ['src/a.js'], patterns }).reason).toMatch(
      /ccccccc deploys next/u,
    );
    expect(planDeploy({ sha: A, tip: A, checks: ready, staging, files: [], patterns }).reason).toMatch(/already runs/u);
  });

  it('skips a commit that touches no deploy path, and deploys when the files can’t be known', () => {
    expect(planDeploy({ sha: B, tip: B, checks: ready, staging, files: ['docs/a.md'], patterns }).deploy).toBe(false);
    expect(planDeploy({ sha: B, tip: B, checks: ready, staging, files: null, patterns }).deploy).toBe(true);
  });

  it('deploys the first time, with nothing to compare', () => {
    expect(planDeploy({ sha: B, tip: B, checks: ready, staging: [], files: null, patterns })).toMatchObject({
      deploy: true,
      from: '',
    });
  });

  it('refuses a deploy paths file that isn’t one', () => {
    expect(() => deployPatterns(['^src/'])).toThrow(/an object/u);
    expect(() => deployPatterns({ widgets: '(' })).toThrow(/widgets isn't a regular expression/u);
  });
});

describe('Worker versions (BRK-90)', () => {
  it('reads what runs now from wrangler deployments list', () => {
    const list = [
      { created_on: '2026-10-01T00:00:00Z', versions: [{ version_id: V1, percentage: 100 }] },
      {
        created_on: '2026-10-02T00:00:00Z',
        versions: [
          { version_id: V1, percentage: 10 },
          { version_id: V2, percentage: 90 },
        ],
      },
    ];
    expect(currentVersionId(list)).toBe(V2);
    expect(currentVersionId([])).toBeNull();
  });

  it('reads what wrangler just uploaded from its output file', () => {
    const out = [
      JSON.stringify({ type: 'wrangler-session' }),
      'not json',
      JSON.stringify({ type: 'version-upload', version_id: V2 }),
    ].join('\n');
    expect(uploadedVersionId(out)).toBe(V2);
    expect(uploadedVersionId(JSON.stringify({ type: 'deploy', version_id: V1 }))).toBe(V1);
    expect(uploadedVersionId('')).toBeNull();
  });

  it('tells a Worker that doesn’t exist yet from any other failure', () => {
    expect(workerMissing('✘ [ERROR] This Worker does not exist on your account. [code: 10007]')).toBe(true);
    expect(workerMissing('Authentication error [code: 10000]')).toBe(false);
  });

  it('finds the commit production runs, and the commit a version came from', () => {
    const production = [
      { sha: B, task: 'deploy', state: 'failure', description: `version ${V2}` },
      { sha: A, task: 'deploy', state: 'success', description: `version ${V1} · artifact ${'f'.repeat(64)}` },
    ];
    expect(liveSha(production)).toBe(A);
    expect(shaOfVersion(production, V1)).toBe(A);
    expect(shaOfVersion(production, V2)).toBeNull();
  });
});
