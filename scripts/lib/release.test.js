import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { describeDeploy, deploymentsOf, isOnBranch, recordDeployment } from './deployments.js';
import { checkMigrations } from './migration-check.js';
import { checkCandidate } from './promote.js';
import { digestDir } from './release-artifact.js';
import { parseAreas, parseTitle, prNumberOf, releaseNotes } from './release-notes.js';
import { RELEASE_ENTRIES, importClosure } from '../tasks/init.js';

const SHA = 'a'.repeat(40);
const VERSION = '12345678-1234-1234-1234-123456789abc';
const DIGEST = 'b'.repeat(64);

function pretendGitHub(routes) {
  const calls = [];
  const fetch = vi.fn(async (url, init = {}) => {
    const path = new URL(url).pathname + new URL(url).search;
    const method = init.method ?? 'GET';
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    const answer = routes[`${method} ${path}`];
    if (answer === undefined) return new Response('no such route', { status: 404 });
    return new Response(JSON.stringify(answer), { status: 200 });
  });
  return { fetch, calls };
}

describe('deployments', () => {
  it('describes a deploy the way the board reads it', () => {
    expect(describeDeploy({ note: 'pre-release', version: VERSION, artifact: DIGEST })).toBe(
      `pre-release · version ${VERSION} · artifact ${DIGEST}`,
    );
    expect(describeDeploy({ version: VERSION, migrations: ['0001_a.sql', '0002_b.sql'] })).toBe(
      `version ${VERSION} · migrations 0001_a.sql, 0002_b.sql`,
    );
  });

  it('makes a Deployment and its status, then adds statuses to the same one', async () => {
    const gh = pretendGitHub({
      'POST /repos/acme/widgets/deployments': { id: 7 },
      'POST /repos/acme/widgets/deployments/7/statuses': {},
    });
    const args = { fetch: gh.fetch, token: 't', repo: 'acme/widgets', environment: 'widgets-staging', sha: SHA };
    expect(await recordDeployment({ ...args, state: 'in_progress', description: 'Deploying' })).toEqual({
      id: 7,
      state: 'in_progress',
    });
    await recordDeployment({ ...args, deploymentId: 7, state: 'success', description: `version ${VERSION}` });
    expect(gh.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /repos/acme/widgets/deployments',
      'POST /repos/acme/widgets/deployments/7/statuses',
      'POST /repos/acme/widgets/deployments/7/statuses',
    ]);
    expect(gh.calls[0].body).toMatchObject({
      ref: SHA,
      environment: 'widgets-staging',
      task: 'deploy',
      required_contexts: [],
    });
    expect(gh.calls[0].headers['user-agent']).toBe('breakaway-release-helpers');
    expect(gh.calls[0].headers['user-agent']).not.toMatch(/samewave/iu);
  });

  it('says what is wrong with the inputs', async () => {
    const base = { fetch: vi.fn(), token: 't', repo: 'acme/widgets', environment: 'e', sha: SHA, state: 'success' };
    await expect(recordDeployment({ ...base, token: '' })).rejects.toThrow(/GITHUB_TOKEN/u);
    await expect(recordDeployment({ ...base, repo: 'widgets' })).rejects.toThrow(/owner\/name/u);
    await expect(recordDeployment({ ...base, task: 'ship' })).rejects.toThrow(/deploy, rollback, try/u);
    await expect(recordDeployment({ ...base, state: 'done' })).rejects.toThrow(/state is one of/u);
    await expect(recordDeployment({ ...base, sha: 'abc' })).rejects.toThrow(/full commit SHA/u);
    expect(base.fetch).not.toHaveBeenCalled();
  });

  it('reads an environment’s Deployments for promote', async () => {
    const routes = {
      'GET /repos/acme/widgets/deployments?environment=widgets-staging&per_page=30': [
        { id: 2, sha: SHA, task: 'deploy' },
      ],
      'GET /repos/acme/widgets/deployments/2/statuses?per_page=1': [
        { state: 'success', description: `version ${VERSION} · artifact ${DIGEST}` },
      ],
    };
    const real = pretendGitHub(routes);
    const staging = await deploymentsOf({
      fetch: real.fetch,
      token: 't',
      repo: 'acme/widgets',
      environment: 'widgets-staging',
    });
    expect(staging).toEqual([
      { sha: SHA, task: 'deploy', state: 'success', description: `version ${VERSION} · artifact ${DIGEST}` },
    ]);
    expect(checkCandidate({ sha: SHA, staging, production: [] })).toEqual({
      ok: true,
      candidate: { sha: SHA, version: VERSION, digest: DIGEST },
    });
  });

  it('knows whether a commit is on the branch', async () => {
    const path = () => `GET /repos/acme/widgets/compare/${SHA}...main`;
    const on = pretendGitHub({ [path()]: { status: 'ahead' } });
    const off = pretendGitHub({ [path()]: { status: 'diverged' } });
    const args = { token: 't', repo: 'acme/widgets', branch: 'main', sha: SHA };
    expect(await isOnBranch({ ...args, fetch: on.fetch })).toBe(true);
    expect(await isOnBranch({ ...args, fetch: off.fetch })).toBe(false);
  });
});

describe('release notes', () => {
  const areas = parseAreas('BRK:Board, WEB:Web');

  it('reads a pull request number and a work ID', () => {
    expect(prNumberOf('BRK-1: Sort it (#31)\n\nbody')).toBe(31);
    expect(prNumberOf('Merge pull request #7 from a/b')).toBe(7);
    expect(prNumberOf('Fix a thing')).toBeNull();
    expect(parseTitle('BRK-12: Sort the inbox')).toEqual({ id: 'BRK-12', prefix: 'BRK', text: 'Sort the inbox' });
    expect(parseTitle('Sort the inbox').id).toBeNull();
  });

  it('groups by the repository’s areas and puts the rest under Other', () => {
    const text = releaseNotes({
      title: 'widgets',
      version: 'v3',
      areas,
      prs: [
        { number: 9, title: 'WEB-2: Dark mode' },
        { number: 4, title: 'BRK-1: Sort it' },
        { number: 5, title: 'ZZZ-3: Elsewhere' },
        { number: 6, title: 'No work ID' },
      ],
      migrations: ['0001_a.sql'],
    });
    expect(text).toBe(
      [
        '## widgets v3',
        '',
        '### Board',
        '',
        '- Sort it (BRK-1, #4)',
        '',
        '### Web',
        '',
        '- Dark mode (WEB-2, #9)',
        '',
        '### Other',
        '',
        '- Elsewhere (ZZZ-3, #5)',
        '- No work ID (#6)',
        '',
        '### Migrations',
        '',
        '- 0001_a.sql',
        '',
      ].join('\n'),
    );
    expect(releaseNotes({ title: 'widgets', prs: [] })).toContain('No merged pull requests');
  });

  it('names no area of another repository', () => {
    expect(releaseNotes({ title: 'x', prs: [{ number: 1, title: 'BRK-1: a' }] })).toContain('### Other');
  });
});

describe('migration check', () => {
  const m = (name, sql = 'CREATE TABLE a (id INTEGER);') => ({ name, sql });

  it('passes migrations in order', () => {
    expect(checkMigrations([m('0001_b.sql'), m('0000_a.sql')])).toEqual({ ok: true, errors: [], destructive: [] });
  });

  it('names a gap, a repeat, a bad name, and an empty file', () => {
    const { errors } = checkMigrations([
      m('0000_a.sql'),
      m('0002_c.sql'),
      m('0002_d.sql'),
      m('notes.sql'),
      m('0003_e.sql', '-- nothing'),
    ]);
    expect(errors.join('\n')).toMatch(/0002_c\.sql should be number 0001/u);
    expect(errors.join('\n')).toMatch(/0002_d\.sql repeats number 0002/u);
    expect(errors.join('\n')).toMatch(/notes\.sql isn't named/u);
    expect(errors.join('\n')).toMatch(/0003_e\.sql is empty/u);
  });

  it('asks for an owner approval line on a destructive migration, only for the new ones', () => {
    const drop = m('0001_drop.sql', 'ALTER TABLE a DROP COLUMN b;');
    const result = checkMigrations([m('0000_a.sql'), drop]);
    expect(result.destructive).toEqual(['0001_drop.sql']);
    expect(
      checkMigrations([m('0000_a.sql'), { ...drop, sql: `-- owner-approved: the owner, unused\n${drop.sql}` }]).ok,
    ).toBe(true);
    expect(checkMigrations([m('0000_a.sql'), drop], { added: [] }).ok).toBe(true);
    expect(checkMigrations([m('0000_a.sql', "INSERT INTO a VALUES ('DROP TABLE');")]).ok).toBe(true);
  });
});

describe('release artifact digest', () => {
  const tree = (files) => {
    const dir = mkdtempSync(join(tmpdir(), 'artifact-'));
    for (const [path, text] of files) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return dir;
  };

  it('gives the same digest for the same tree, however it was written', () => {
    const a = tree([
      ['index.js', 'one'],
      ['assets/app.css', 'two'],
    ]);
    const b = tree([
      ['assets/app.css', 'two'],
      ['index.js', 'one'],
    ]);
    try {
      expect(digestDir(a).digest).toBe(digestDir(b).digest);
      expect(digestDir(a).digest).toMatch(/^[0-9a-f]{64}$/u);
      expect(digestDir(a).manifest.split('\n')[0]).toMatch(/ 3 assets\/app\.css$/u);
    } finally {
      rmSync(a, { recursive: true });
      rmSync(b, { recursive: true });
    }
  });

  it('changes when a byte or a path does, and refuses an empty folder', () => {
    const a = tree([['index.js', 'one']]);
    const b = tree([['index.js', 'One']]);
    const c = tree([['main.js', 'one']]);
    const empty = mkdtempSync(join(tmpdir(), 'artifact-'));
    try {
      const digests = new Set([a, b, c].map((d) => digestDir(d).digest));
      expect(digests.size).toBe(3);
      expect(() => digestDir(empty)).toThrow(/no files/u);
    } finally {
      for (const d of [a, b, c, empty]) rmSync(d, { recursive: true });
    }
  });
});

describe('repos init copies the release helpers (BRK-45)', () => {
  const RAW = import.meta.glob(['../*.mjs', './*.js', '../../src/promote.js'], {
    query: '?raw',
    import: 'default',
    eager: true,
  });
  const FILES = new Map(
    Object.entries(RAW).map(([key, text]) => [
      key
        .replace(/^\.\.\/\.\.\//u, '')
        .replace(/^\.\.\//u, 'scripts/')
        .replace(/^\.\//u, 'scripts/lib/'),
      text,
    ]),
  );
  const read = (path) => {
    if (!FILES.has(path)) throw new Error(`no ${path} in the fixture`);
    return FILES.get(path);
  };

  it('lists every helper with what it imports, and no tests', () => {
    const files = importClosure(RELEASE_ENTRIES, read);
    expect(files).toEqual(
      [
        'scripts/check-migrations.mjs',
        'scripts/lib/deployments.js',
        'scripts/lib/migration-check.js',
        'scripts/lib/promote.js',
        'scripts/lib/release-artifact.js',
        'scripts/lib/release-notes.js',
        'scripts/promote-check.mjs',
        'scripts/record-deployment.mjs',
        'scripts/release-artifact.mjs',
        'scripts/release-notes.mjs',
        'src/promote.js',
      ].sort(),
    );
  });

  it('keeps samewave’s names out of them', () => {
    for (const path of importClosure(RELEASE_ENTRIES, read)) expect(read(path), path).not.toMatch(/samewave/iu);
  });
});
