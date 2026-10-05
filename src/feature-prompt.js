/**
 * Refine a feature with an agent (BRK-150) and shape a new feature as an idea (WEB-42): the words the board writes.
 * Apart from store-features.js, since only the Worker writes them.
 */

/** The longest a task's description may be. */
const MAX_BRIEF = 10000;
/** The title a refine task starts with: the board finds the open one by it, with the feature's tag. */
export const REFINE_FEATURE_TITLE = 'Refine the feature: ';

/** The feature's line: its title, tag, and release. */
const named = (feature) =>
  `${feature.title} (+${feature.slug})${feature.release ? `, aimed at release ${feature.release}` : ', with no release yet'}`;

/**
 * The general agent's prompt that refines the tasks of `feature` as the owner asks (BRK-150). `tasks` are its tasks
 * (their `ref` is the work ID or short ID), and `request` is the owner's, in their words; without one (a dry run) the
 * prompt leaves it out. Returns the task's title and description.
 * @param {{ slug: string, title: string, brief?: string | null, release?: string | null }} feature
 * @param {{ ref: string, description: string, status: string, repo?: string, claimed?: boolean }[]} tasks
 * @param {string} repo the repository the agent runs in
 * @param {string | null} [request]
 */
export function featurePrompt(feature, tasks, repo, request = null) {
  const title = `${REFINE_FEATURE_TITLE}${feature.title}`.slice(0, 200);
  const asked = String(request ?? '').trim();
  const state = (t) =>
    t.status === 'completed' ? 'done' : t.status === 'pending' ? (t.claimed ? 'open, claimed' : 'open') : t.status;
  const intro = [
    `The owner wants the tasks of the feature ${named(feature)} refined. Refine them as they ask.`,
    ...(asked ? ['', 'The owner’s request', asked.slice(0, 4000)] : []),
    ...(feature.brief ? ['', 'The feature’s brief', feature.brief] : []),
  ].join('\n');
  const after = [
    '',
    'What to do',
    `- Read each open task (npx breakaway show <ID>) and the code it touches, then bring the open, unclaimed tasks in ${repo} in line with the request and the feature’s brief: description, done when, area, horizon, tags, and dependencies (the cross-task edits a general agent may make, each change noted).`,
    `- Add the tasks the feature still needs, filled in, each with --tag ${feature.slug} and depending on what it waits for. Never set --autostart, and never tag a task with a release: the feature’s release is the owner’s.`,
    '- A task in another repository: add what it needs there, or say in a comment what should change. Never touch a claimed or closed task, an idea’s description, or a horizon-* tag.',
    '- Ask a decision for anything only the owner can choose.',
    '- If the change needs a spec, open one pull request with it that closes your own task. Otherwise comment on your task what you changed, task by task, and release it.',
  ].join('\n');
  // Too long for a description: the list gives way, since the feature's page lists every task.
  const head = ['', 'Its tasks'];
  const more = `- … (more: npx breakaway features show ${feature.slug} lists them all)`;
  const room = MAX_BRIEF - intro.length - after.length - head.join('\n').length - 1;
  const lines = tasks.length
    ? tasks.map((t) => `- ${t.ref}: ${t.description} (${state(t)}${t.repo && t.repo !== repo ? `, in ${t.repo}` : ''})`)
    : ['- None yet: add the tasks the feature needs.'];
  const kept = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > room - more.length - 1) {
      kept.push(more);
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  return { title, brief: `${intro}\n${[...head, ...kept].join('\n')}\n${after}`.slice(0, MAX_BRIEF) };
}

/**
 * The idea a new feature is shaped from (WEB-42): the owner's brief in their own words, with what the feature is
 * under it, so every task its agent makes joins the feature. Returns the idea's title and description.
 * @param {{ slug: string, title: string, brief: string, release?: string | null }} feature
 */
export function featureIdea(feature) {
  return {
    title: feature.title.slice(0, 200),
    brief: [
      feature.brief,
      '',
      '## The feature',
      '',
      `The owner made this idea from the New feature form: it shapes the feature ${named(feature)}, which is on the board already.`,
      '',
      `- Every task you make joins it: give each one --tag ${feature.slug}, and don't add the feature again.`,
      '- Keep the tasks to the feature’s title and the brief above.',
      `- Never tag a task with a release: the feature’s release is the owner’s${feature.release ? `, and its tasks go out in ${feature.release}` : ''}.`,
    ].join('\n'),
  };
}
