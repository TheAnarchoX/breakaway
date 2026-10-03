import { describe, expect, it } from 'vitest';
import { allWorkers, compileDeployPaths, workersFor } from '../src/deploy-paths.js';
import { pullAccess } from '../src/github-access.js';
import { buildFlow, pipelineOf } from '../src/release.js';
import { defaultRepo } from '../src/repos.js';

// What each repository's pipeline, deploy paths, and access mean for the GitHub view (CLD-125).

describe('a repository’s pipeline', () => {
  it('is samewave’s as registered today, and null without Workers', () => {
    expect(pipelineOf(defaultRepo({}))).toEqual({
      staging: 'samewave-staging',
      production: 'samewave',
      promote: 'promote.yml',
      rollback: 'rollback.yml',
      deployPaths: '.github/deploy-paths.json',
      branch: 'main',
    });
    expect(pipelineOf({ pipeline: null })).toBeNull();
    expect(pipelineOf({ pipeline: { workers: { production: 'x' } } })).toBeNull();
    expect(pipelineOf({ pipeline: { workers: { staging: 'a b', production: 'x' } } })).toBeNull();
    expect(
      pipelineOf({
        defaultBranch: 'trunk',
        pipeline: { workers: { staging: 's', production: 'p' }, workflows: { rollback: 'back.yml' } },
      }),
    ).toMatchObject({ promote: 'promote.yml', rollback: 'back.yml', deployPaths: null, branch: 'trunk' });
  });

  it('builds the release flow from its own Workers', () => {
    const deploys = [
      {
        id: 2,
        env: 'b-staging',
        sha: 'b'.repeat(40),
        task: 'deploy',
        state: 'success',
        landed: true,
        version: null,
        updated: '2026-10-01T10:00:00Z',
      },
      {
        id: 1,
        env: 'samewave-staging',
        sha: 'a'.repeat(40),
        task: 'deploy',
        state: 'success',
        landed: true,
        version: null,
        updated: '2026-10-01T09:00:00Z',
      },
    ];
    const flow = buildFlow({ deploys, workers: { staging: 'b-staging', production: 'b' } });
    expect(flow.staging).toMatchObject({ env: 'b-staging', state: 'live', build: { sha: 'b'.repeat(40) } });
    expect(flow.production.state).toBe('none');
    expect(buildFlow({ deploys }).staging.build.sha).toBe('a'.repeat(40)); // samewave's by default
  });
});

describe('deploy paths from a repository’s own file', () => {
  it('compiles { worker: regex } and refuses anything else', () => {
    const patterns = compileDeployPaths({ api: '^src/', docs: '^site/' });
    expect(workersFor(['src/a.js', 'README.md'], patterns)).toEqual(['api']);
    expect(workersFor(['README.md'], patterns)).toEqual([]);
    expect(allWorkers(patterns)).toEqual(['api', 'docs']);
    expect(compileDeployPaths(null)).toBeNull();
    expect(compileDeployPaths(['^src/'])).toBeNull();
    expect(compileDeployPaths({ api: 3 })).toBeNull();
    expect(compileDeployPaths({ api: '(' })).toBeNull();
  });

  it('keeps samewave’s built-in rules', () => {
    expect(workersFor(['src/server/pages.js'])).toEqual(['samewave']);
    expect(workersFor(['docs/tasks.md'])).toEqual([]);
  });
});

describe('what the owner’s buttons can do', () => {
  const all = {
    metadata: 'read',
    pull_requests: 'write',
    contents: 'write',
    checks: 'read',
    statuses: 'read',
    actions: 'write',
    deployments: 'read',
    vulnerability_alerts: 'read',
  };

  it('allows everything until Connections has checked', () => {
    expect(pullAccess(null, { github: 'o/r' })).toEqual({
      checked: null,
      write: { ok: true, reason: null },
      autoMerge: { ok: true, reason: null },
      actions: { ok: true, reason: null },
    });
    expect(pullAccess({ installed: null, error: 'timeout' }, { github: 'o/r' }).write.ok).toBe(true);
  });

  it('says why, per button', () => {
    expect(
      pullAccess({ installed: true, permissions: all, autoMerge: true }, { github: 'o/r', pipeline: true, at: 0 }),
    ).toMatchObject({ write: { ok: true }, autoMerge: { ok: true }, actions: { ok: true } });
    const missing = pullAccess({ installed: false }, { github: 'o/r' });
    expect(missing.write.reason).toMatch(/isn’t installed on o\/r/u);
    expect(missing.autoMerge.ok).toBe(false);
    const readOnly = pullAccess(
      { installed: true, permissions: { ...all, contents: 'read' }, autoMerge: true },
      { github: 'o/r' },
    );
    expect(readOnly.write.reason).toMatch(/read and write on Contents/u);
    expect(readOnly.autoMerge).toEqual(readOnly.write);
    const noAuto = pullAccess({ installed: true, permissions: all, autoMerge: false }, { github: 'o/r' });
    expect(noAuto.write.ok).toBe(true);
    expect(noAuto.autoMerge.reason).toMatch(/Allow auto-merge/u);
    // Couldn't read the setting: not a reason to block.
    expect(
      pullAccess({ installed: true, permissions: all, autoMerge: false, autoMergeError: 'x' }, { github: 'o/r' })
        .autoMerge.ok,
    ).toBe(true);
    // Actions matter only where there's a pipeline.
    const noActions = { installed: true, permissions: { ...all, actions: 'read' }, autoMerge: true };
    expect(pullAccess(noActions, { github: 'o/r', pipeline: true }).actions.reason).toMatch(/start workflows/u);
    expect(pullAccess(noActions, { github: 'o/r', pipeline: false }).actions.ok).toBe(true);
    expect(pullAccess({ installed: true, suspended: true }, { github: 'o/r' }).write.reason).toMatch(/suspended/u);
  });
});
