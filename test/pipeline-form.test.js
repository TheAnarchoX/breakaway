import { describe, expect, it } from 'vitest';
import { checkPipeline } from '../src/repos.js';
import { deployField, missingOf, pipelineForm, pipelineOf } from '../web/src/lib/pipeline-form.js';

// A repository's Deploys form (WEB-33): Workers, an npm package, or both, as repos modify --pipeline takes them.
const form = (fields) => ({ ...pipelineForm(null), ...fields });

describe('pipelineForm', () => {
  it('reads a saved pipeline, package and release workflow included', () => {
    expect(
      pipelineForm({
        workers: { staging: 's', production: 'p' },
        package: '@acme/widgets',
        workflows: { release: 'r.yml' },
      }),
    ).toMatchObject({ staging: 's', production: 'p', package: '@acme/widgets', release: 'r.yml', deploy: '' });
  });

  it('is blank with no pipeline', () => {
    expect(Object.values(pipelineForm(null)).every((v) => v === '')).toBe(true);
  });
});

describe('pipelineOf', () => {
  it('sends a package alone, with no Workers, and the server takes it', () => {
    const pipeline = pipelineOf(form({ package: ' @acme/widgets ' }), null);
    expect(pipeline).toEqual({ package: '@acme/widgets' });
    expect(checkPipeline(pipeline)).toEqual({ package: '@acme/widgets' });
  });

  it('sends Workers and a package together', () => {
    const pipeline = pipelineOf(form({ staging: 'w-staging', production: 'w', package: 'widgets' }), null);
    expect(checkPipeline(pipeline)).toEqual({ workers: { staging: 'w-staging', production: 'w' }, package: 'widgets' });
  });

  it('drops the package when it is cleared, and keeps what the form does not show', () => {
    const saved = { workers: { staging: 's', production: 'p' }, package: 'widgets', workflows: { release: 'r.yml' } };
    expect(pipelineOf(form({ staging: 's', production: 'p', release: 'r.yml' }), saved)).toEqual({
      workers: { staging: 's', production: 'p' },
      workflows: { release: 'r.yml' },
    });
  });

  it('leaves blank workflow files out so the defaults apply', () => {
    const saved = { workers: { staging: 's', production: 'p' }, workflows: { deploy: 'old.yml' } };
    expect(pipelineOf(form({ staging: 's', production: 'p' }), saved)).toEqual({
      workers: { staging: 's', production: 'p' },
    });
  });

  it('sends one Worker so the server names the other', () => {
    const pipeline = pipelineOf(form({ staging: 's' }), null);
    expect(() => checkPipeline(pipeline)).toThrow(/pipeline\.workers\.production/u);
  });
});

describe('missingOf', () => {
  it('is complete with both Workers, or a package alone', () => {
    expect(missingOf(form({ staging: 's', production: 'p' }))).toBeNull();
    expect(missingOf(form({ package: 'widgets' }))).toBeNull();
  });

  it('asks for the other Worker when only one is named, package or not', () => {
    expect(Object.keys(missingOf(form({ staging: 's' })))).toEqual(['production']);
    expect(Object.keys(missingOf(form({ production: 'p', package: 'widgets' })))).toEqual(['staging']);
  });

  it('asks for Workers or a package when there is neither', () => {
    expect(missingOf(form({}))?.staging).toMatch(/npm package/u);
  });
});

describe('deployField', () => {
  it('puts each refusal under its field', () => {
    expect(deployField('pipeline.workers.production is a Worker name: …')).toBe('production');
    expect(deployField('pipeline.workflows.release is a workflow file name: …')).toBe('release');
    expect(deployField('pipeline.package is the npm package’s name, …')).toBe('package');
    expect(deployField('pipeline.deployPaths is the path of a JSON file …')).toBe('deployPaths');
    expect(deployField('pipeline needs workers (…), package (…), or both')).toBe('staging');
    // The web app's api() capitalizes an error's first letter.
    expect(deployField('Pipeline.package is the npm package’s name, …')).toBe('package');
    expect(deployField('Pipeline.workers.production is a Worker name: …')).toBe('production');
  });
});
