import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileDeployPaths } from '../../src/deploy-paths.js';
import { stagedIn } from '../../src/packages.js';
import { RELEASE_ENTRIES } from './init.js';
import {
  CI_PATH,
  CONFIG_PATH,
  DEPLOY_PATHS,
  HEADER,
  HELPERS,
  WORKFLOWS,
  checkConfig,
  fill,
  helpersFor,
  initPlan,
  lintWorkflow,
  parseYaml,
  renderPipeline,
  run,
  runScripts,
  starterPlan,
} from './pipeline.js';

const TEMPLATES = new URL('../../template/pipeline/', import.meta.url);
const readTemplate = (name) => readFileSync(new URL(name, TEMPLATES), 'utf8');
const widgets = { name: 'widgets', version: '1.0.0' };
const render = (raw, packageJson = () => widgets) => renderPipeline(checkConfig(raw, { packageJson }), readTemplate);
const fileOf = (files, path) => files.find((f) => f.path === path)?.text;

const SAMPLE = {
  workers: { staging: 'widgets-staging', production: 'widgets' },
  checks: ['CI', 'Lint'],
  install: 'npm ci',
  build: 'npm run build',
  beforeDeploy: ['npx wrangler d1 migrations apply DB --remote --env $BREAKAWAY_ENV'],
  deployPaths: { widgets: '^(src|public|migrations)/|^wrangler\\.jsonc$' },
  healthCheck: { staging: 'https://widgets-staging.example.workers.dev/', production: 'https://widgets.example.com/' },
};
const PACKAGE_ONLY = { checks: ['CI'], package: { name: 'widgets' } };

/** Every check the tests can run on a rendered workflow: the linter, and bash's own syntax check of each script. */
function problemsOf(text) {
  const problems = lintWorkflow(text);
  for (const { where, script } of problems.length ? [] : runScripts(text)) {
    const bash = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
    if (bash.status !== 0) problems.push(`${where}: ${bash.stderr.trim()}`);
  }
  return problems;
}

// BRK-90: a repository's deploy and release workflows come from one config, rendered from template/pipeline/.
describe('pipeline init renders (BRK-90)', () => {
  it('a Worker’s Deploy, Promote, Roll back, and deploy paths, each sound', () => {
    const files = render(SAMPLE);
    expect(files.map((f) => f.path)).toEqual([WORKFLOWS.deploy, WORKFLOWS.promote, WORKFLOWS.rollback, DEPLOY_PATHS]);
    for (const file of files.filter((f) => f.path.endsWith('.yml'))) {
      expect(file.text.startsWith(`# ${HEADER}\n`)).toBe(true);
      expect(problemsOf(file.text), file.path).toEqual([]);
    }
    expect(compileDeployPaths(JSON.parse(fileOf(files, DEPLOY_PATHS)))).toHaveLength(1);
  });

  it('Deploy after every check, staging only, with the repository’s own commands', () => {
    const deploy = fileOf(render(SAMPLE), WORKFLOWS.deploy);
    const doc = parseYaml(deploy);
    expect(doc.on.workflow_run).toEqual({ workflows: ['CI', 'Lint'], types: ['completed'], branches: ['main'] });
    expect(doc.env).toMatchObject({ STAGING: 'widgets-staging', CHECKS: '["CI","Lint"]' });
    expect(doc.env).not.toHaveProperty('PRODUCTION');
    expect(doc.jobs.staging.environment).toBe('staging');
    const script = doc.jobs.staging.steps.map((s) => s.run ?? '').join('\n');
    expect(script).toMatch(/^npm ci$/mu);
    expect(script).toMatch(/^npm run build$/mu);
    expect(script).toMatch(/^npx wrangler d1 migrations apply DB --remote --env \$BREAKAWAY_ENV$/mu);
    expect(script).toMatch(/--note pre-release --version "\$VERSION" --artifact "\$DIGEST"/u);
    expect(doc.jobs.staging.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'))?.with.name).toBe(
      'release-${{ github.event.workflow_run.head_sha || github.sha }}',
    );
  });

  it('Promote and Roll back take exactly what the board’s buttons send', () => {
    const files = render(SAMPLE);
    const promote = parseYaml(fileOf(files, WORKFLOWS.promote));
    const rollback = parseYaml(fileOf(files, WORKFLOWS.rollback));
    // src/store-github.js githubRelease: { sha, destructive_ok } and { worker, reason, version? }.
    expect(Object.keys(promote.on.workflow_dispatch.inputs)).toEqual(['sha', 'destructive_ok']);
    expect(promote.on.workflow_dispatch.inputs.sha.required).toBe(true);
    expect(Object.keys(rollback.on.workflow_dispatch.inputs)).toEqual(['worker', 'version', 'reason']);
    expect(rollback.on.workflow_dispatch.inputs.version.required).toBe(false);
    for (const doc of [promote, rollback]) {
      expect(doc.concurrency.group).toBe('deploy-production');
      expect(Object.values(doc.jobs)[0].environment).toBe('production');
      expect(Object.values(doc.jobs)[0].if).toBe("github.ref == 'refs/heads/main'");
    }
    expect(promote.env).toMatchObject({ PRODUCTION: 'widgets', HEALTH_URL: 'https://widgets.example.com/' });
    const steps = promote.jobs.production.steps.map((s) => s.name).filter(Boolean);
    expect(steps.indexOf('Check the candidate')).toBeLessThan(steps.indexOf('Deploy to production'));
    expect(steps.at(-1)).toBe('Tag and release');
  });

  it('a repository with no beforeDeploy and no build: nothing left of either', () => {
    const files = render({ ...SAMPLE, beforeDeploy: undefined, build: '', healthCheck: undefined });
    for (const file of files.filter((f) => f.path.endsWith('.yml')))
      expect(problemsOf(file.text), file.path).toEqual([]);
    const deploy = fileOf(files, WORKFLOWS.deploy);
    expect(deploy).not.toMatch(/migrations apply|npm run build/u);
    expect(parseYaml(deploy).env.HEALTH_URL).toBe('');
    expect(fileOf(files, WORKFLOWS.deploy)).toMatch(/\n {10}step migrating\n {10}step deploying\n/u);
  });

  it('wrangler environments, when the config names them', () => {
    const files = render({ ...SAMPLE, wranglerEnv: { staging: 'staging', production: 'production' } });
    expect(fileOf(files, WORKFLOWS.deploy)).toMatch(/--name "\$WORKER" --env staging; \}/u);
    expect(fileOf(files, WORKFLOWS.promote)).toMatch(/--name "\$WORKER" --env production; \}/u);
    expect(
      render(SAMPLE)
        .map((f) => f.text)
        .join(''),
    ).not.toMatch(/--env (staging|production);/u);
  });

  it('a package only: just release.yml, its tags v…', () => {
    const files = render(PACKAGE_ONLY);
    expect(files.map((f) => f.path)).toEqual([WORKFLOWS.release]);
    const release = files[0].text;
    expect(problemsOf(release)).toEqual([]);
    const doc = parseYaml(release);
    expect(doc.env).toMatchObject({ PACKAGE: 'widgets', DIRECTORY: '.', ACCESS: 'public', PREFIX: 'v' });
    expect(doc.on.workflow_run.workflows).toEqual(['CI']);
    expect(Object.keys(doc.on.workflow_dispatch.inputs)).toEqual(['prerelease', 'next']);
    expect(doc.on.workflow_dispatch.inputs.next).toMatchObject({
      default: 'patch',
      options: ['patch', 'minor', 'major'],
    });
    expect(Object.keys(doc.jobs)).toEqual(['prerelease', 'stable', 'next-version']);
    for (const job of [doc.jobs.prerelease, doc.jobs.stable]) {
      expect(job.environment).toBe('npm');
      expect(job.permissions['id-token']).toBe('write');
    }
    // WEB-39: the pull request that sets the next minor or major runs with no environment, no secrets, and no OIDC.
    const next = doc.jobs['next-version'];
    expect(next).toMatchObject({ needs: 'stable', if: "inputs.next == 'minor' || inputs.next == 'major'" });
    expect(next.environment).toBeUndefined();
    expect(next.permissions).toEqual({ contents: 'write', 'pull-requests': 'write' });
    expect(next.env.STABLE).toBe('${{ needs.stable.outputs.version }}');
    expect(doc.jobs.stable.outputs.version).toBe('${{ steps.version.outputs.version }}');
    expect(JSON.stringify(next)).not.toMatch(/secrets\./u);
  });

  it('a Worker and a package together: both flows, the package’s tags <package>@…', () => {
    const files = render(
      { ...SAMPLE, package: { name: '@acme/widgets', directory: './packages/widgets/', access: 'restricted' } },
      (dir) => (dir === 'packages/widgets' ? { name: '@acme/widgets', version: '0.3.0' } : null),
    );
    expect(files.map((f) => f.path)).toEqual([
      WORKFLOWS.deploy,
      WORKFLOWS.promote,
      WORKFLOWS.rollback,
      DEPLOY_PATHS,
      WORKFLOWS.release,
    ]);
    for (const file of files.filter((f) => f.path.endsWith('.yml')))
      expect(problemsOf(file.text), file.path).toEqual([]);
    expect(parseYaml(fileOf(files, WORKFLOWS.release)).env).toMatchObject({
      PACKAGE: '@acme/widgets',
      DIRECTORY: 'packages/widgets',
      ACCESS: 'restricted',
      PREFIX: '@acme/widgets@',
    });
  });

  it('release.yml stages on next and latest, never publishes, and prints the notice the Packages feed reads', () => {
    const release = fileOf(render(PACKAGE_ONLY), WORKFLOWS.release);
    expect(release).not.toMatch(/^\s+(if )?npm publish\b/mu);
    expect(release.match(/npm stage publish \$provenance --access "\$ACCESS" --tag "\$DIST_TAG"/gu)).toHaveLength(2);
    const doc = parseYaml(release);
    const stage = (job) => doc.jobs[job].steps.find((s) => s.name === 'Stage it on npm');
    expect(stage('prerelease').env.DIST_TAG).toBe('next');
    expect(stage('stable').env.DIST_TAG).toBe('latest');
    // Only the two staging steps see NPM_TOKEN.
    expect(release.match(/secrets\.NPM_TOKEN/gu)).toHaveLength(2);
    for (const job of ['prerelease', 'stable']) {
      const line = stage(job)
        .run.split('\n')
        .find((l) => l.includes('title=Staged on npm'));
      const shown = line
        .replace(/^.*::notice title=Staged on npm::/u, '')
        .replace(/"$/u, '')
        .replace('$PACKAGE', '@acme/widgets')
        .replace('$VERSION', '1.2.0-main.3')
        .replace('$DIST_TAG', stage(job).env.DIST_TAG);
      expect(stagedIn(shown)).toEqual([
        { name: '@acme/widgets', version: '1.2.0-main.3', tag: stage(job).env.DIST_TAG },
      ]);
      // Word for word what breakaway's own Release workflow prints.
      expect(shown).toBe(
        `@acme/widgets@1.2.0-main.3 goes live on ${stage(job).env.DIST_TAG} once the owner approves it with 2FA: npm stage approve <id>, or Staged Packages on npmjs.com.`,
      );
    }
  });

  it('only from helpers repos init copies', () => {
    const copied = new Set(RELEASE_ENTRIES);
    for (const path of Object.values(HELPERS).flat()) expect(copied.has(path), path).toBe(true);
    for (const file of render({ ...SAMPLE, package: { name: 'widgets' } }).filter((f) => f.path.endsWith('.yml')))
      for (const [, path] of file.text.matchAll(/node (?:"\$helpers\/|scripts\/)([\w-]+\.mjs)/gu))
        expect(
          helpersFor(checkConfig({ ...SAMPLE, package: { name: 'widgets' } }, { packageJson: () => widgets })),
        ).toContain(`scripts/${path}`);
  });
});

describe('pipeline check refuses a bad config (BRK-90)', () => {
  const check =
    (raw, packageJson = () => widgets) =>
    () =>
      checkConfig(raw, { packageJson });

  it('one that names neither workers nor a package', () => {
    expect(check({ checks: ['CI'] })).toThrow(/needs workers .*, package .*, or both/u);
  });

  it('a package whose name isn’t its package.json’s, or that npm won’t take', () => {
    expect(check({ checks: ['CI'], package: { name: 'gadgets' } })).toThrow(
      /package\.name is gadgets, but package\.json names widgets/u,
    );
    expect(check({ checks: ['CI'], package: { name: 'widgets', directory: 'pkg' } }, () => null)).toThrow(
      /pkg\/package\.json isn't there/u,
    );
    expect(check({ checks: ['CI'], package: { name: 'widgets' } }, () => ({ ...widgets, private: true }))).toThrow(
      /private/u,
    );
    expect(
      check({ checks: ['CI'], package: { name: 'widgets' } }, () => ({ ...widgets, version: '1.0.0-beta.1' })),
    ).toThrow(/counts from a version like 1\.0\.0/u);
    expect(check({ checks: ['CI'], package: { name: 'widgets', directory: '../elsewhere' } })).toThrow(
      /package\.directory/u,
    );
    expect(check({ checks: ['CI'], package: { name: 'widgets', access: 'secret' } })).toThrow(/public or restricted/u);
  });

  it('workers without deploy paths, or with one that isn’t a regular expression', () => {
    expect(check({ ...SAMPLE, deployPaths: undefined })).toThrow(/deployPaths says which files need a deploy/u);
    expect(check({ ...SAMPLE, deployPaths: { widgets: '(' } })).toThrow(
      /deployPaths\.widgets isn't a regular expression/u,
    );
    expect(check({ ...SAMPLE, workers: { staging: 'same', production: 'same' } })).toThrow(/two different Workers/u);
  });

  it('commands Actions would expand, keys it doesn’t know, and no checks', () => {
    expect(check({ ...SAMPLE, build: 'echo ${{ secrets.X }}' })).toThrow(/build can't hold/u);
    expect(check({ ...SAMPLE, beforeDeploy: ['a\nb'] })).toThrow(/one line/u);
    expect(check({ ...SAMPLE, deploy: 'x' })).toThrow(/has no "deploy"/u);
    expect(check({ ...SAMPLE, checks: [] })).toThrow(/checks names the workflows/u);
    expect(check({ ...SAMPLE, branch: 'main"' })).toThrow(/branch is the default branch/u);
    expect(check({ ...PACKAGE_ONLY, beforeDeploy: ['x'] })).toThrow(/beforeDeploy runs before a Worker deploys/u);
  });

  it('takes a health check for staging alone as a string', () => {
    expect(checkConfig({ ...SAMPLE, healthCheck: 'https://s.example.dev/' }).healthCheck).toEqual({
      staging: 'https://s.example.dev/',
      production: null,
    });
    expect(check({ ...SAMPLE, healthCheck: 'not a url' })).toThrow(/healthCheck is an address/u);
  });
});

describe('the workflow checks (BRK-90)', () => {
  const ok = fileOf(render(SAMPLE), WORKFLOWS.rollback);

  it('find what GitHub would refuse or run unsafely', () => {
    expect(lintWorkflow(ok)).toEqual([]);
    expect(lintWorkflow(ok.replace(/actions\/checkout@[0-9a-f]{40}/u, 'actions/checkout@v7'))).toEqual([
      expect.stringMatching(/isn't pinned to a commit/u),
    ]);
    expect(lintWorkflow(ok.replace('${{ inputs.reason }}', '${{ inputs.why }}'))).toEqual([
      expect.stringMatching(/no input why/u),
    ]);
    expect(lintWorkflow(ok.replace('${{ secrets.CLOUDFLARE_API_TOKEN }}', '${{ secrets.ADMIN_TOKEN }}'))).toEqual([
      expect.stringMatching(/no secret ADMIN_TOKEN/u),
    ]);
    expect(lintWorkflow(ok.replace('    environment: production\n', ''))).toEqual([
      expect.stringMatching(/reads a secret outside an environment/u),
    ]);
    expect(lintWorkflow(ok.replace('    timeout-minutes: 15\n', ''))).toEqual([
      expect.stringMatching(/no timeout-minutes/u),
    ]);
    expect(lintWorkflow(ok.replace('cd "$RUNNER_TEMP"', 'cd "${{ runner.temp }}"'))).toEqual([
      expect.stringMatching(/pass it through env/u),
    ]);
    expect(lintWorkflow(ok.replace('name: Roll back\n', 'name: Roll back: production\n'))).toEqual([
      expect.stringMatching(/line \d+: a plain value can't hold/u),
    ]);
    expect(lintWorkflow(ok.replace('PRODUCTION: "widgets"', 'PRODUCTION: {{production}}'))).toContain(
      "the template's {{production}} is left over",
    );
  });

  it('know which steps ran before', () => {
    const deploy = fileOf(render(SAMPLE), WORKFLOWS.deploy);
    expect(lintWorkflow(deploy.replace('steps.plan.outputs.from', 'steps.later.outputs.from'))).toEqual([
      expect.stringMatching(/no step later before this one/u),
    ]);
  });

  it('read the YAML the templates use as GitHub does', () => {
    expect(
      parseYaml(
        'on:\n  push:\n    branches: ["main", dev]\nkeys:\n- a: 1\n  b: "x"\n- plain\nblock: |\n  one\n    two\npermissions: {}\n',
      ),
    ).toEqual({
      on: { push: { branches: ['main', 'dev'] } },
      keys: [{ a: 1, b: 'x' }, 'plain'],
      block: 'one\n  two\n',
      permissions: {},
    });
    expect(() => parseYaml('a: 1\na: 2\n')).toThrow(/"a" twice/u);
    expect(() => parseYaml('a:\n\tb: 1\n')).toThrow(/tab/u);
  });

  it('fill keeps {{#if}} blocks only when the value is set', () => {
    expect(fill('a\n{{#if x}}\n  b {{y}}\n{{/if}}\n  {{@list}}\nc', { x: true, y: 1, list: ['d', 'e'] })).toBe(
      'a\n  b 1\n  d\n  e\nc',
    );
    expect(fill('{{#if x}}\nb\n{{/if}}\nc', { x: '' })).toBe('c');
    expect(() => fill('{{missing}}', {})).toThrow(/has no value/u);
  });
});

describe('pipeline init and check in a checkout (BRK-90)', () => {
  let dir;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const setUp = (config) => {
    dir = mkdtempSync(join(tmpdir(), 'pipeline-'));
    mkdirSync(join(dir, '.github'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(widgets));
    if (config) writeFileSync(join(dir, CONFIG_PATH), JSON.stringify(config));
    const out = [];
    const io = { cwd: dir, log: (l) => out.push(l), error: (l) => out.push(`! ${l}`) };
    return { out, call: (args, opts = {}) => run(args, opts, io) };
  };

  it('prints an example when there is no config', () => {
    const { out, call } = setUp(null);
    expect(call(['init'])).toBe(1);
    expect(out.join('\n')).toMatch(/breakaway-pipeline\.json isn't here[\s\S]*"workers"/u);
  });

  it('writes the files, then finds them current, and says which helpers are missing', () => {
    const { out, call } = setUp({ ...SAMPLE, package: { name: 'widgets' } });
    expect(call(['init'])).toBe(0);
    expect(out.filter((l) => l.startsWith('Wrote '))).toHaveLength(5);
    expect(out.at(-1)).toMatch(/repos init <slug> --update copies them/u);
    expect(call(['check'])).toBe(1);
    for (const path of helpersFor(checkConfig(SAMPLE))) {
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      writeFileSync(join(dir, path), '');
    }
    for (const path of helpersFor(checkConfig({ ...PACKAGE_ONLY }, { packageJson: () => widgets })))
      writeFileSync(join(dir, path), '');
    out.length = 0;
    expect(call(['check'])).toBe(0);
    expect(out[0]).toMatch(/is sound/u);
  });

  it('leaves a changed file unless --update, and never a workflow of the repository’s own', () => {
    const { out, call } = setUp(SAMPLE);
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    writeFileSync(join(dir, WORKFLOWS.rollback), 'name: Our own rollback\n');
    expect(call(['init'])).toBe(1);
    expect(out.join('\n')).toMatch(/Left \.github\/workflows\/rollback\.yml: it differs/u);
    out.length = 0;
    expect(call(['init'], { update: true })).toBe(1);
    expect(out.join('\n')).toMatch(/rollback\.yml: it's the repository's own/u);
    expect(readFileSync(join(dir, WORKFLOWS.rollback), 'utf8')).toBe('name: Our own rollback\n');
    // A rendered file the config has moved past is replaced by --update.
    writeFileSync(join(dir, CONFIG_PATH), JSON.stringify({ ...SAMPLE, checks: ['Tests'] }));
    out.length = 0;
    expect(call(['check'])).toBe(1);
    expect(out.join('\n')).toMatch(/deploy\.yml isn't what .* renders/u);
    call(['init'], { update: true });
    expect(parseYaml(readFileSync(join(dir, WORKFLOWS.deploy), 'utf8')).on.workflow_run.workflows).toEqual(['Tests']);
  });

  it('writes nothing on a dry run', () => {
    const { out, call } = setUp(SAMPLE);
    expect(call(['init'], { 'dry-run': true })).toBe(0);
    expect(out[0]).toBe(`Would write ${WORKFLOWS.deploy}`);
    expect(initPlan([{ path: 'a', text: 'x' }], () => null).write).toHaveLength(1);
    expect(() => readFileSync(join(dir, WORKFLOWS.deploy))).toThrow();
  });
});

// BRK-91: repos init --pipeline and --package give a repository the flows, as new files in the pull request it opens.
describe('repos init --pipeline (BRK-91)', () => {
  const workers = { staging: 'widgets-staging', production: 'widgets' };
  /** The repository as `files` (path → text), and what --pipeline and --package add to it. */
  const plan = (files, options = {}) => {
    const readTarget = (path) => files[path] ?? null;
    const workflows = Object.entries(files)
      .filter(([path]) => path.startsWith('.github/workflows/'))
      .map(([path, text]) => ({ path, text }));
    const out = starterPlan({ readTarget, workflows, readTemplate, ...options });
    // Nothing the repository has is written over.
    for (const file of out.files) expect(readTarget(file.path), file.path).toBeNull();
    return {
      ...out,
      paths: out.files.map((f) => f.path),
      text: (path) =>
        fileOf(
          out.files.map((f) => ({ path: f.path, text: f.content })),
          path,
        ),
    };
  };
  // What repos init writes into a repository with no package.json.
  const fresh = { 'package.json': `${JSON.stringify({ name: 'widgets', private: true, type: 'module' }, null, 2)}\n` };
  const published = (extra = {}) => ({
    'package.json': JSON.stringify({
      name: 'widgets',
      version: '0.1.0',
      scripts: { build: 'vite build', test: 'vitest run' },
      ...extra,
    }),
    'package-lock.json': '{}',
  });

  it('gives a fresh repository the deploy flow and a minimal CI, each sound, and no release flow', () => {
    const out = plan(fresh, { workers });
    expect(out.paths).toEqual([
      CONFIG_PATH,
      WORKFLOWS.deploy,
      WORKFLOWS.promote,
      WORKFLOWS.rollback,
      DEPLOY_PATHS,
      CI_PATH,
    ]);
    const config = JSON.parse(out.text(CONFIG_PATH));
    expect(config).toEqual({
      workers,
      checks: ['CI'],
      install: 'npm install',
      deployPaths: { widgets: expect.any(String) },
    });
    // The rendered files are what pipeline init renders from that config, so pipeline check finds them current.
    for (const file of render(config)) expect(out.text(file.path)).toBe(file.text);
    for (const path of out.paths.filter((p) => p.endsWith('.yml')))
      expect(problemsOf(out.text(path)), path).toEqual([]);
    const ci = parseYaml(out.text(CI_PATH));
    expect(ci.name).toBe('CI');
    expect(ci.on.push.branches).toEqual(['main']);
    expect(runScripts(out.text(CI_PATH))[0].script).toMatch(/^npm install$/mu);
    expect(runScripts(out.text(CI_PATH))[0].script).not.toMatch(/npm run/u);
    // The starter deploy paths deploy the code, not the docs or the board's own files.
    const paths = new RegExp(config.deployPaths.widgets, 'u');
    for (const file of ['src/index.js', 'wrangler.jsonc', 'package.json']) expect(paths.test(file), file).toBe(true);
    for (const file of ['README.md', 'docs/a.md', 'tools/tasks/prompts/core.md', '.github/workflows/ci.yml'])
      expect(paths.test(file), file).toBe(false);
    expect(out.todo.join('\n')).toMatch(/create the Workers widgets-staging and widgets/u);
    expect(out.todo.join('\n')).toMatch(/Turn on deploys/u);
    expect(out.todo.join('\n')).not.toMatch(/npm environment|environment npm/u);
  });

  it('adds the release flow with --package, from the name and access in package.json', () => {
    const out = plan(published(), { workers, withPackage: true });
    expect(out.paths).toEqual([
      CONFIG_PATH,
      WORKFLOWS.deploy,
      WORKFLOWS.promote,
      WORKFLOWS.rollback,
      DEPLOY_PATHS,
      WORKFLOWS.release,
      CI_PATH,
    ]);
    const config = JSON.parse(out.text(CONFIG_PATH));
    expect(config).toMatchObject({
      install: 'npm ci',
      build: 'npm run build',
      package: { name: 'widgets', directory: '.', access: 'public' },
    });
    for (const path of out.paths.filter((p) => p.endsWith('.yml')))
      expect(problemsOf(out.text(path)), path).toEqual([]);
    expect(runScripts(out.text(CI_PATH))[0].script).toMatch(/npm ci\nnpm run build\nnpm run test/u);
    expect(out.todo.join('\n')).toMatch(/environment npm/u);

    // A scoped package is restricted unless publishConfig says otherwise; the name is package.json's.
    const scoped = (extra) =>
      JSON.parse(plan(published({ name: '@acme/widgets', ...extra }), { withPackage: true }).text(CONFIG_PATH)).package;
    expect(scoped({})).toEqual({ name: '@acme/widgets', directory: '.', access: 'restricted' });
    expect(scoped({ publishConfig: { access: 'public' } }).access).toBe('public');
  });

  it('gives --package alone the release flow and CI, and no Worker workflows', () => {
    const out = plan(published(), { withPackage: true });
    expect(out.paths).toEqual([CONFIG_PATH, WORKFLOWS.release, CI_PATH]);
    expect(JSON.parse(out.text(CONFIG_PATH)).workers).toBeUndefined();
  });

  it('gives no release flow without --package, or to a private package.json either way', () => {
    expect(plan(published(), { workers }).paths).not.toContain(WORKFLOWS.release);
    const out = plan(fresh, { workers, withPackage: true });
    expect(out.paths).not.toContain(WORKFLOWS.release);
    expect(JSON.parse(out.text(CONFIG_PATH)).package).toBeUndefined();
    expect(out.notes.join('\n')).toMatch(/"private": true/u);
    // Only a package to release, and it's private: nothing at all.
    const none = plan(fresh, { withPackage: true });
    expect(none.files).toEqual([]);
    expect(none.notes.join('\n')).toMatch(/no release flow/u);
    // A version the release flow can't count from is said, not guessed.
    expect(plan(published({ version: 'next' }), { withPackage: true }).notes.join('\n')).toMatch(/version is next/u);
  });

  it('keeps an existing repository’s workflows, and gates on the ones that run on a push', () => {
    const repoFiles = {
      ...published(),
      '.github/workflows/ci.yml': 'name: Tests\non:\n  push:\n    branches: [main]\n  pull_request:\njobs: {}\n',
      '.github/workflows/lint.yml': 'name: Lint\non: [push, pull_request]\njobs: {}\n',
      '.github/workflows/stale.yml': 'name: Stale\non:\n  schedule:\n    - cron: "0 0 * * *"\njobs: {}\n',
    };
    const out = plan(repoFiles, { workers, withPackage: true });
    expect(out.paths).not.toContain(CI_PATH);
    expect(out.paths).toEqual([
      CONFIG_PATH,
      WORKFLOWS.deploy,
      WORKFLOWS.promote,
      WORKFLOWS.rollback,
      DEPLOY_PATHS,
      WORKFLOWS.release,
    ]);
    expect(JSON.parse(out.text(CONFIG_PATH)).checks).toEqual(['Tests', 'Lint']);
    expect(out.todo.join('\n')).toMatch(/checks \(Tests, Lint\) names only/u);

    // No workflow that runs on a push: nothing would gate a deploy, so nothing is added.
    const ungated = plan({ '.github/workflows/stale.yml': repoFiles['.github/workflows/stale.yml'] }, { workers });
    expect(ungated.files).toEqual([]);
    expect(ungated.notes.join('\n')).toMatch(/runs on a push/u);
  });

  it('adds nothing to a repository that has the config or a file it would render', () => {
    const configured = plan({ ...fresh, [CONFIG_PATH]: '{}' }, { workers });
    expect(configured.files).toEqual([]);
    expect(configured.notes.join('\n')).toMatch(/already there.*pipeline init/u);
    const own = plan({ ...fresh, [WORKFLOWS.deploy]: 'name: Ship\non: push\njobs: {}\n' }, { workers });
    expect(own.files).toEqual([]);
    expect(own.notes.join('\n')).toMatch(/deploy\.yml is already there/u);
  });

  it('installs with the repository’s own package manager, on its default branch', () => {
    const out = plan(
      { ...published(), 'package-lock.json': undefined, 'pnpm-lock.yaml': '' },
      { workers, branch: 'trunk' },
    );
    const config = JSON.parse(out.text(CONFIG_PATH));
    expect(config).toMatchObject({
      branch: 'trunk',
      install: 'corepack pnpm install --frozen-lockfile',
      build: 'corepack pnpm run build',
    });
    expect(parseYaml(out.text(CI_PATH)).on.push.branches).toEqual(['trunk']);
    // npm's placeholder test script fails, so CI doesn't run it.
    const placeholder = plan(
      { 'package.json': JSON.stringify({ name: 'w', scripts: { test: 'echo "Error: no test specified" && exit 1' } }) },
      { workers },
    );
    expect(runScripts(placeholder.text(CI_PATH))[0].script).not.toMatch(/test/u);
  });
});
