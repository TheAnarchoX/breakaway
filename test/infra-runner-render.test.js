import { describe, expect, it } from 'vitest';
import TEMPLATE_FILE from '../template/infra/apply.yml?raw';
import RUNNER_TEMPLATE from '../src/infra-runner-template.json';
import { RUNNER_WORKFLOW } from '../src/infra-runner.js';
import {
  RUNNER_NEEDS_INIT,
  RUNNER_NEEDS_WORKFLOWS,
  RUNNER_RENDER_HEADER,
  RUNNER_TEMPLATE as TEMPLATE_PATH,
  RunnerRenderError,
  environmentsIn,
  isRenderedRunner,
  renderRunner,
  runnerChange,
  runnerMissing,
  runnerNote,
  runnerStep,
} from '../src/infra-runner-render.js';
import { canWriteWorkflows, runnerSetupStep } from '../src/infra-tokens.js';
import { changeBody, runnerWords } from '../src/infra-changes.js';

// The apply workflow, rendered by the board as by npx breakaway infra init (BRK-307).
const render = (environments, more = {}) =>
  renderRunner({ environments, branch: 'main', version: '2.0.0', ...more }, RUNNER_TEMPLATE.text);

describe('the apply workflow’s render', () => {
  it('reads the template generated from template/infra/apply.yml, never a copy by hand', () => {
    expect(RUNNER_TEMPLATE.path).toBe(TEMPLATE_PATH);
    expect(RUNNER_TEMPLATE.text).toBe(TEMPLATE_FILE);
  });

  it('offers each environment, from the default branch only, pinned to the release', () => {
    const file = render(['acme-production', 'acme-staging']);
    expect(file.path).toBe(RUNNER_WORKFLOW);
    expect(file.text.startsWith(`# ${RUNNER_RENDER_HEADER}\n`)).toBe(true);
    expect(isRenderedRunner(file.text)).toBe(true);
    expect(file.text).toContain('          - "acme-production"\n          - "acme-staging"\n');
    expect(file.text).toContain("if: github.ref == 'refs/heads/main'");
    expect(file.text).toContain('breakaway@2.0.0');
    expect(runnerMissing(file.text, ['acme-staging', 'acme-preview'])).toEqual(['acme-preview']);
    // Short-lived environments take any name.
    const any = render(['acme-staging'], { shortLived: true });
    expect(runnerMissing(any.text, ['acme-pr-12'])).toEqual([]);
    expect(() => render(['acme-staging'], { version: 'latest' })).toThrow(RunnerRenderError);
    expect(() => render(['acme-staging'], { branch: 'a..b' })).toThrow(RunnerRenderError);
  });

  it('takes the environments from the folder’s file names, skipping the reserved ones', () => {
    expect(environmentsIn(['staging.json', 'policy.json', 'scaling.json', 'README.md', 'production.json'])).toEqual([
      'production',
      'staging',
    ]);
    expect(() => environmentsIn(['policy.json'])).toThrow(/has no environment's file/u);
    expect(() => environmentsIn(['Not Good.json'])).toThrow(RunnerRenderError);
  });

  it('writes a missing file, leaves the same one, and replaces only its own render with --update', () => {
    const file = render(['acme-staging']);
    expect(runnerStep(file, null)).toEqual({ write: true });
    expect(runnerStep(file, file.text)).toEqual({ write: false, same: true });
    expect(runnerStep(file, render(['acme-old']).text)).toMatchObject({ write: false, refused: /--update/u });
    expect(runnerStep(file, render(['acme-old']).text, { update: true })).toEqual({ write: true });
    expect(runnerStep(file, 'name: ours\n', { update: true })).toMatchObject({ refused: /repository's own/u });
  });
});

describe('what a change does with the apply workflow', () => {
  const change = (there, names = ['acme-staging.json', 'policy.json']) =>
    runnerChange({
      names,
      environment: 'acme-production',
      there,
      branch: 'main',
      version: '2.0.0',
      template: RUNNER_TEMPLATE.text,
    });

  it('adds it for the folder’s environments and the change’s own when there’s none', () => {
    const got = change(null);
    expect(got).toMatchObject({ action: 'add', environments: ['acme-production', 'acme-staging'], missing: [] });
    expect(got.file).toEqual(render(['acme-production', 'acme-staging']));
    // An environment already in the folder isn't offered twice.
    expect(change(null, ['acme-production.json']).environments).toEqual(['acme-production']);
    // short-lived.json makes it take any environment.
    expect(runnerMissing(change(null, ['short-lived.json']).file.text, ['acme-pr-3'])).toEqual([]);
  });

  it('leaves the same render, updates its own older one, and never touches the repository’s own', () => {
    expect(change(render(['acme-production', 'acme-staging']).text).action).toBe('current');
    expect(change(render(['acme-staging']).text).action).toBe('update');
    expect(change(render(['acme-production', 'acme-staging'], { version: '1.9.0' }).text).action).toBe('update');
    const own =
      'name: Apply\non:\n  workflow_dispatch:\n    inputs:\n      environment:\n        type: choice\n        options:\n          - acme-staging\n';
    expect(change(own)).toMatchObject({ action: 'own', missing: ['acme-production'] });
  });

  it('can’t render from a folder with a file that isn’t an environment’s name', () => {
    expect(() => change(null, ['Bad Name.json'])).toThrow(RunnerRenderError);
  });

  it('says it in the pull request: added, updated, or what’s needed before Approve', () => {
    expect(runnerWords({ state: 'added' })).toBe(
      'Adds the apply workflow, `.github/workflows/breakaway-infra.yml`, so an approved plan can run.',
    );
    expect(runnerWords({ state: 'updated' })).toMatch(/^Updates the apply workflow/u);
    expect(runnerWords({ state: 'current', note: null })).toBeNull();
    expect(runnerWords({ state: 'needs-workflows', note: RUNNER_NEEDS_WORKFLOWS })).toBe(
      `**Before Approve:** ${RUNNER_NEEDS_WORKFLOWS}`,
    );
    const body = changeBody({
      environment: 'acme-staging',
      lines: ['~ acme-api: usage_model standard → bundled'],
      preview: null,
      runner: { state: 'added' },
    });
    expect(body).toContain(
      '- ~ acme-api: usage_model standard → bundled\n\nAdds the apply workflow, `.github/workflows/breakaway-infra.yml`, so an approved plan can run.\n',
    );
  });
});

describe('the apply workflow before Approve', () => {
  it('needs Workflows write for the board to commit it', () => {
    expect(canWriteWorkflows({ workflows: 'write' })).toBe(true);
    expect(canWriteWorkflows({ workflows: 'read' })).toBe(false);
    expect(canWriteWorkflows({ contents: 'write' })).toBe(false);
    expect(canWriteWorkflows(null)).toBe(false);
    expect(RUNNER_NEEDS_WORKFLOWS).toBe(
      'Applying needs .github/workflows/breakaway-infra.yml: give the board’s GitHub App Workflows: write and propose again, or run npx breakaway infra init in the repository and merge it.',
    );
  });

  it('notes a pull request’s plan when the workflow at its head is missing or doesn’t offer the environment', () => {
    expect(runnerNote(null, [])).toBeNull();
    expect(runnerNote(null, ['acme-staging'])).toBe(RUNNER_NEEDS_INIT);
    expect(runnerNote(render(['acme-staging']).text, ['acme-staging'])).toBeNull();
    expect(runnerNote(render(['acme-staging']).text, ['acme-production'])).toMatch(
      /doesn’t offer acme-production yet: run npx breakaway infra init --update/u,
    );
  });

  it('is a step of the token checklist, done when it offers every environment that needs a write token', () => {
    const at = { branch: 'main', environments: ['acme-staging'] };
    expect(runnerSetupStep({ ...at, text: render(['acme-staging']).text })).toEqual({
      id: 'workflow',
      label: 'The apply workflow on main',
      ok: true,
      fix: null,
    });
    expect(runnerSetupStep({ ...at, text: null })).toMatchObject({
      ok: false,
      fix: RUNNER_NEEDS_WORKFLOWS.replace(/\.$/u, ''),
    });
    expect(runnerSetupStep({ ...at, text: render(['acme-other']).text })).toMatchObject({
      ok: false,
      fix: expect.stringMatching(/^\.github\/workflows\/breakaway-infra\.yml doesn’t offer acme-staging\. Applying/u),
    });
    expect(runnerSetupStep({ ...at, text: null, problem: 'GitHub refused' })).toMatchObject({
      ok: null,
      fix: 'GitHub refused',
    });
  });
});
