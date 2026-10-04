/**
 * Refine a spec with an agent (docs/specs/IDEA-31-specs-view.md, section 4): the prompt the board writes. Apart
 * from specs.js, which repos init copies into other repositories, since only the Worker writes it.
 */
import { featureTags } from './decision.js';

/** The longest the prompt may be: a task's description. */
const MAX_BRIEF = 10000;

/**
 * Refine a spec with an agent (docs/specs/IDEA-31-specs-view.md, section 4): the prompt the board writes for a
 * general agent that changes spec `spec` as the owner asks and brings the tasks that link it in line. `tasks` are
 * those tasks (their `ref` is the work ID or short ID), and `request` is the owner's, in their words; without one
 * (a dry run) the prompt leaves it out. Returns the task's title and description.
 * @param {{ path: string, title: string }} spec
 * @param {{ ref: string, description: string, status: string, claimed?: boolean, tags?: string[] }[]} tasks
 * @param {string | null} [request]
 */
export function specPrompt(spec, tasks, request = null) {
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const title = clip(`Refine the spec: ${spec.title}`, 200);
  const asked = String(request ?? '').trim();
  const state = (t) =>
    t.status === 'completed' ? 'done' : t.status === 'pending' ? (t.claimed ? 'open, claimed' : 'open') : t.status;
  const linked = tasks.map((t) => {
    const features = featureTags(t.tags);
    return `- ${t.ref}: ${t.description} (${state(t)}${features.length ? `; feature: ${features.join(', ')}` : ''})`;
  });
  const intro = [
    `The owner wants the spec ${spec.path} (${spec.title}) changed. Change it as they ask, and bring the tasks that link it in line.`,
    ...(asked ? ['', 'The owner’s request', asked.slice(0, 4000)] : []),
  ].join('\n');
  const after = [
    '',
    'What to do',
    `- Change ${spec.path} as the request asks, keeping the repository’s spec template and its prompt’s **Direction**.`,
    '- Bring the open tasks that link it in line with the change (the cross-task edits a general agent may make: description, done when, area, horizon, tags, and dependencies, each change noted).',
    `- Add the tasks the change needs, filled in, with --spec ${spec.path} and depending on what they wait for. Never set --autostart.`,
    '- Ask a decision for anything only the owner can choose.',
    '- Open one pull request with the spec change that closes your own task. Never touch a claimed or closed task, an idea’s description, or a horizon-* tag.',
  ].join('\n');
  // Too long for a description: the list gives way, since the board lists every task with its spec.
  const head = ['', 'Tasks that link it'];
  const more = '- … (more link it: npx breakaway list --json shows each task’s spec)';
  const room = MAX_BRIEF - intro.length - after.length - head.join('\n').length - 1;
  const lines = linked.length ? linked : ['- None yet: add the tasks the change needs.'];
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
