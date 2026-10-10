/**
 * Move to breakaway's deploy flow (WEB-12, docs/specs/IDEA-27-move-ci-cd-to-the-deploy-flow.md, sections 3 and 6): the
 * owner's press on the GitHub page adds one task to a repository without a pipeline and starts its agent, which follows
 * the `pipeline` skill and opens one pull request. This is what the press and the card need that doesn't touch the
 * store: what the default branch suggests the repository ships, the task's words, and which stage the card shows. Pure,
 * so it's tested without GitHub.
 */
import { PIPELINE_SKILL } from './prompt.js';

/** A wrangler config at the repository's root: what the deploy flow's workflows run. */
const WRANGLER = /^wrangler\.(toml|json|jsonc)$/u;

/**
 * @typedef {{ worker: boolean, package: { name: string | null, private: boolean } | null }} Shape
 */

/**
 * What the default branch suggests the repository ships, from its root's file names and its `package.json` (the text,
 * or null when there's none): a Worker (a wrangler config at the root) and a package (the name `package.json` gives,
 * and whether it says `"private": true`). The card words its title from it; the agent decides from the whole tree.
 * @param {{ root?: string[], packageJson?: string | null }} read
 * @returns {Shape}
 */
export function repoShape({ root = [], packageJson = null }) {
  const worker = root.some((name) => WRANGLER.test(name));
  if (packageJson === null || packageJson === undefined) return { worker, package: null };
  let parsed = null;
  try {
    parsed = JSON.parse(packageJson);
  } catch {
    // A package.json that doesn't parse names no package: the agent reads it and says so.
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { worker, package: null };
  const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim().slice(0, 214) : null;
  // A package.json with no name and no version is a project's, not a package to publish.
  if (!name && typeof parsed.version !== 'string') return { worker, package: null };
  return { worker, package: { name, private: parsed.private === true } };
}

/** Whether the move releases a package: one `package.json` names, which isn't private. */
export const releases = (shape) => Boolean(shape?.package?.name && !shape.package.private);

/**
 * The move's task for repository `repo` (`{ name, github }`): its title, brief, and done when. A repository that only
 * publishes a package moves to the release flow; anything else to the deploy flow, which the agent may find also
 * releases a package. The brief points at the skill, which holds the rules.
 * @param {{ name: string, github: string }} repo
 * @param {Shape | null} shape
 */
export function moveTask(repo, shape) {
  const flow = releases(shape) && !shape?.worker ? 'release flow' : 'deploy flow';
  return {
    description: `Move ${repo.name} to breakaway’s ${flow}`.slice(0, 200),
    brief: [
      `The owner pressed Move to breakaway’s ${flow} on the board’s GitHub page for ${repo.github}. Move its CI/CD to breakaway’s deploy flow (a Worker’s deploys), its release flow (an npm package’s releases), or both, in one pull request.`,
      `Follow the pipeline skill, ${PIPELINE_SKILL}: read the workflows, the wrangler config, the migrations, and package.json; decide what moves; write .github/breakaway-pipeline.json; run npx breakaway pipeline init; and account for every step of the old setup in the pull request, so nothing is lost and nothing runs twice.`,
      `If the skill isn’t in this checkout, comment that the board’s files need npx breakaway repos init --update, release the task, and stop. If the repository deploys somewhere the flow doesn’t (Pages, Vercel, a server), comment why, release the task, and open no pull request: the board shows that comment on the GitHub page.`,
    ].join('\n\n'),
    done_when:
      'One pull request holds .github/breakaway-pipeline.json, the files pipeline init renders from it, and a table saying where each old workflow, job, and step went (the config, a rendered workflow, kept as it is, or dropped and why). No check workflow is edited or removed, and nothing deploys or publishes twice after the merge. The owner’s checklist is a person’s task (who: person, assignee: owner) that depends on this one, and the pull request’s After merging repeats it.',
  };
}

/**
 * Which stage the card shows for a repository without a pipeline, from its move task (null: none, or deleted) and the
 * pull requests that close it, newest first:
 * - `start`: no move, or the last one finished without a merge, so the button is offered;
 * - `running`: an agent holds the task and no pull request is open;
 * - `pr`: its pull request is open;
 * - `merged`: its pull request merged, and the board hasn't read the files on the default branch yet;
 * - `stopped`: the task is open with nobody on it and no pull request open, so Try again is offered.
 * Once the files are on the default branch the card is Turn on deploys (WEB-13), whatever the stage.
 * @param {{ status?: string, claim?: string | null } | null} task
 * @param {{ state: string }[]} pulls
 */
export function moveStage(task, pulls = []) {
  if (!task || task.status === 'deleted') return 'start';
  const open = pulls.find((p) => p.state === 'open');
  const merged = pulls.find((p) => p.state === 'merged');
  if (task.status !== 'pending') return merged ? 'merged' : 'start';
  if (open) return 'pr';
  if (task.claim) return 'running';
  return 'stopped';
}
