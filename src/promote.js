// Whether a commit may be promoted to production (CLD-103, docs/specs/IDEA-10-promote-releases.md).
// Pure functions over GitHub Deployments, so tests run without GitHub. The Promote workflow runs
// these first (scripts/lib/promote.js re-exports them, and repos init copies both); the board only asks,
// and a forged request can at worst fail here.

// A Deployment is { sha, task, state, description }: `state` is its latest status (none = queued),
// `description` that status's description ("pre-release · version <id> · artifact <digest>").
// Lists are newest first. Only `deploy` counts: branch deploys (`try`) and rollbacks never do.
const PENDING = new Set(['', 'queued', 'pending', 'in_progress', 'waiting']);

export const versionOf = (description) =>
  /version ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/u.exec(description ?? '')?.[1];
export const artifactOf = (description) => /artifact ([0-9a-f]{64})/u.exec(description ?? '')?.[1];

// The latest successful staging deploy, which is the only thing that can be promoted.
export function candidate(staging) {
  return staging.find((d) => d.task === 'deploy' && d.state === 'success') ?? null;
}

// What production runs now: its latest successful deploy or rollback.
export function productionSha(production) {
  return production.find((d) => (d.task === 'deploy' || d.task === 'rollback') && d.state === 'success')?.sha ?? null;
}

// Returns { ok: true, candidate } or { ok: false, reason } in the words the run shows.
export function checkCandidate({ sha, staging, production, paused = false, onMain = true, artifactDigest = null }) {
  const no = (reason) => ({ ok: false, reason });
  if (paused) return no('Deploys are paused (DEPLOYS_PAUSED is true). Promote again when the pause is over.');
  if (!/^[0-9a-f]{40}$/u.test(sha ?? '')) return no('Give the full commit SHA of the staging build to promote.');
  if (staging.some((d) => d.task === 'deploy' && PENDING.has(d.state ?? '')))
    return no('Staging is still deploying. Try again when it is done.');
  const latest = candidate(staging);
  if (!latest) return no('There is no staging build to promote yet. Merge to main and let staging deploy first.');
  if (latest.sha !== sha) {
    return no(
      staging.some((d) => d.task === 'deploy' && d.state === 'success' && d.sha === sha)
        ? `Superseded by ${latest.sha.slice(0, 7)}: promote that one instead. Only the latest staging build can be promoted, so every migration goes in order.`
        : `${sha.slice(0, 7)} was never deployed to staging. Only the latest successful staging build can be promoted.`,
    );
  }
  if (!onMain) return no(`${sha.slice(0, 7)} isn't on main.`);
  if (productionSha(production) === sha) return no(`Production already runs ${sha.slice(0, 7)}.`);
  const digest = artifactOf(latest.description);
  if (!digest)
    return no(
      'The staging deploy recorded no release artifact, so there is nothing stored to promote. Merge to main to make a new candidate.',
    );
  if (artifactDigest !== null && artifactDigest !== digest)
    return no("The stored release artifact doesn't match the one staging ran. Nothing was changed.");
  return { ok: true, candidate: { sha, version: versionOf(latest.description), digest } };
}
