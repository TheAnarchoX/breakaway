// A repository's Deploys form (docs/specs/IDEA-29-settings.md, section 2; WEB-31, WEB-33): the pipeline
// `repos modify --pipeline` takes, as fields. It needs both Workers, an npm package, or both (BRK-103), as
// checkPipeline (src/repos.js) does. Pure, so it's tested in the Workers pool.

/** The workflow files the form names: blank means the default. Release is a package's (BRK-103). */
export const WORKFLOWS = [
  ['deploy', 'Deploy', 'deploy.yml'],
  ['promote', 'Promote', 'promote.yml'],
  ['rollback', 'Roll back', 'rollback.yml'],
  ['release', 'Release', 'release.yml'],
];

/** The form's fields, from a saved pipeline (or none). */
export const pipelineForm = (pipeline) => ({
  staging: pipeline?.workers?.staging ?? '',
  production: pipeline?.workers?.production ?? '',
  package: pipeline?.package ?? '',
  deploy: pipeline?.workflows?.deploy ?? '',
  promote: pipeline?.workflows?.promote ?? '',
  rollback: pipeline?.workflows?.rollback ?? '',
  release: pipeline?.workflows?.release ?? '',
  deployPaths: pipeline?.deployPaths ?? '',
});

/**
 * The pipeline from the form: Workers when either is named (the server refuses one alone), the package when it's
 * named, and blank workflow files and deploy paths left out, so the defaults apply. Anything else the saved
 * pipeline holds stays as it is.
 * @param {Record<string, string>} form
 * @param {Record<string, any> | null} saved
 */
export function pipelineOf(form, saved) {
  const { workers: _w, workflows: savedFlows, deployPaths: _d, package: _p, ...rest } = saved ?? {};
  const workflows = { ...savedFlows };
  for (const [k] of WORKFLOWS) {
    if (form[k].trim()) workflows[k] = form[k].trim();
    else delete workflows[k];
  }
  const staging = form.staging.trim();
  const production = form.production.trim();
  return {
    ...(staging || production ? { workers: { staging, production } } : {}),
    ...(form.package.trim() ? { package: form.package.trim() } : {}),
    ...(Object.keys(workflows).length ? { workflows } : {}),
    ...(form.deployPaths.trim() ? { deployPaths: form.deployPaths.trim() } : {}),
    ...rest,
  };
}

/**
 * What the form still needs before the server can check it, as `{ field: message }`, or null when it's complete:
 * both Workers, or neither with a package.
 * @param {Record<string, string>} form
 * @returns {Record<string, string> | null}
 */
export function missingOf(form) {
  const staging = Boolean(form.staging.trim());
  const production = Boolean(form.production.trim());
  if (staging && production) return null;
  if (staging || production)
    return {
      [staging ? 'production' : 'staging']:
        'Name both Workers: staging, where merging deploys, and production, where Promote sends it.',
    };
  if (form.package.trim()) return null;
  return {
    staging: 'Name both Workers to deploy, or an npm package to release, or both.',
  };
}

/** Which field a refusal is about, from the field it names (`pipeline.workers.staging is …`). */
export function deployField(message) {
  const text = String(message ?? '');
  const named = /pipeline\.(?:workers|workflows)\.(\w+)/iu.exec(text)?.[1];
  if (named && named in pipelineForm(null)) return named;
  if (/pipeline\.package/iu.test(text)) return 'package';
  if (/deployPaths/iu.test(text)) return 'deployPaths';
  if (/workflows/iu.test(text)) return 'deploy';
  return 'staging';
}
