/**
 * The task structure on the command line (IDEA-5): the description, done when, related tasks, and
 * comments. Pure functions, so they're tested without a board (structure.test.js).
 */

/** What the flags say about the description and done when: { brief, done_when } (only what was given). */
export function textFields(opts, readFile) {
  const out = {};
  if ('brief' in opts && 'brief-file' in opts) throw new Error('use --brief or --brief-file, not both');
  if ('brief' in opts) out.brief = String(opts.brief);
  if ('brief-file' in opts) out.brief = readFile(String(opts['brief-file']));
  if ('done-when' in opts) out.done_when = String(opts['done-when']);
  return out;
}

/** What --decision says: { decision } from a JSON file of questions (the board checks them), or {} without the flag. */
export function decisionField(opts, readFile) {
  if (!('decision' in opts)) return {};
  const path = String(opts.decision);
  let questions;
  try {
    questions = JSON.parse(readFile(path));
  } catch (error) {
    throw new Error(`--decision ${path} must be a JSON file with a list of questions (${error.message})`);
  }
  if (!Array.isArray(questions)) throw new Error(`--decision ${path} must hold a list of questions`);
  return { decision: questions };
}

/** An example decision file, one question of each type. Edit it, then: add … --decision <file> or modify <ID> --decision <file>. */
export const DECISION_TEMPLATE = [
  { id: 'go', type: 'yesno', prompt: 'Should we do this?', help: 'Say what changes if the answer is yes.' },
  {
    id: 'which',
    type: 'choice',
    prompt: 'Which way?',
    options: [
      { id: 'a', label: 'Option A', note: 'What picking it means' },
      { id: 'b', label: 'Option B' },
    ],
    other: true,
  },
  {
    id: 'extras',
    type: 'multi',
    prompt: 'Which of these too?',
    options: [
      { id: 'x', label: 'X' },
      { id: 'y', label: 'Y' },
    ],
    min: 0,
    max: 2,
  },
  {
    id: 'first',
    type: 'rank',
    prompt: 'Which first?',
    options: [
      { id: 'x', label: 'X' },
      { id: 'y', label: 'Y' },
    ],
  },
  {
    id: 'weight',
    type: 'scale',
    prompt: 'How much does it matter?',
    min: 1,
    max: 5,
    minLabel: 'barely',
    maxLabel: 'a lot',
  },
  { id: 'by', type: 'date', prompt: 'By when?', required: false },
  { id: 'notes', type: 'open', prompt: 'Anything else?', required: false },
];

/** An example proposal for `ping --template`: one of each change. Edit it, then: ping <ID> --kind blocked "<message>" --proposal <file.json>. */
export const PING_TEMPLATE = {
  changes: [
    {
      type: 'add',
      ref: 'n1',
      title: 'Create the Sentry project',
      project: 'ops',
      horizon: 'now',
      tags: ['owner'],
      brief: 'What has to happen and why.',
      done_when: 'What has to be true to call it done.',
      depends: [],
      priority: 'M',
    },
    { type: 'depend', task: 'CLD-111', add: ['n1'], remove: [] },
    {
      type: 'modify',
      task: 'CLD-112',
      horizon: 'next',
      addTags: ['owner'],
      removeTags: ['agent'],
      done_when: 'The new done when.',
    },
    { type: 'done', task: 'CLD-113', note: 'Does not reproduce any more; it behaves as expected.' },
    { type: 'release', task: 'CLD-111' },
  ],
};

/** What --proposal says: { proposal } from a JSON file (the board checks it), or {} without the flag. */
export function proposalField(opts, readFile) {
  if (!('proposal' in opts)) return {};
  const path = String(opts.proposal);
  try {
    return { proposal: JSON.parse(readFile(path)) };
  } catch (error) {
    throw new Error(`--proposal ${path} must be a JSON file with a list of changes (${error.message})`);
  }
}

/** The pings of `show`: open ones first, with what each proposes. */
export function pingLines(t) {
  const pings = t.pings ?? [];
  if (!pings.length) return [];
  const out = ['', '  Pings'];
  for (const p of pings) {
    const state = p.resolved ? `resolved: ${p.resolved.how}` : 'open';
    out.push(`  ${String(p.at).slice(0, 10)}  ${p.kind} by ${p.by} (${state})`, ...indent(p.message, 4));
    if (p.proposal?.length) {
      out.push(`      Proposes ${p.proposal.length} change${p.proposal.length === 1 ? '' : 's'}:`);
      for (const c of p.proposal) out.push(`        - ${proposalLine(c)}`);
    }
    for (const w of p.warnings ?? []) out.push(`      Note: ${w}`);
  }
  return out;
}

function proposalLine(c) {
  if (c.type === 'add')
    return `add ${c.ref}: ${c.title} (${c.project}, ${c.horizon}${c.depends?.length ? `, waits for ${c.depends.join(', ')}` : ''})`;
  if (c.type === 'depend')
    return `${c.task}${c.add?.length ? ` waits for ${c.add.join(', ')}` : ''}${c.remove?.length ? `${c.add?.length ? ';' : ''} stops waiting for ${c.remove.join(', ')}` : ''}`;
  if (c.type === 'modify')
    return `change ${c.task}: ${['horizon', 'addTags', 'removeTags', 'brief', 'done_when'].filter((k) => k in c).join(', ')}`;
  if (c.type === 'done') return `finish ${c.task}${c.note ? ` (${c.note})` : ''}`;
  return `release ${c.task}`;
}

/** How `show` prints a comment's author: `null` is a note from before comments had authors. */
export const authorOf = (c) => c.by ?? 'earlier note';

/** The lines of `show` under the fields: description, done when, related, then the comments. */
export function structureLines(t) {
  const out = [];
  if (t.brief) {
    out.push('', `  Description${t.briefBy ? ` (edited by ${t.briefBy})` : ''}`, ...indent(t.brief));
  }
  if (t.doneWhen) out.push('', '  Done when', ...indent(t.doneWhen));
  out.push(...decisionLines(t));
  out.push(...pingLines(t));
  const related = t.relatedTasks ?? [];
  if (related.length) {
    out.push('', '  Related');
    for (const r of related) out.push(`  ${r.wid ?? r.uuid.slice(0, 8)} ${r.description} [${r.status}]`);
  }
  const comments = t.comments ?? t.annotations?.map((a) => ({ by: null, at: a.entry, text: a.text })) ?? [];
  if (comments.length) {
    out.push('', '  Comments');
    for (const c of comments) out.push(`  ${String(c.at).slice(0, 10)}  ${authorOf(c)}:`, ...indent(c.text, 4));
  }
  return out;
}

function indent(text, by = 2) {
  const pad = ' '.repeat(by + 2);
  return String(text)
    .split('\n')
    .map((l) => (l ? `${pad}${l}` : ''));
}

const optionLabel = (q, id, answer) =>
  id === 'other' ? `something else: ${answer.other}` : (q.options?.find((o) => o.id === id)?.label ?? id);

function answerText(q, answer) {
  const { value } = answer;
  if (Array.isArray(value)) return value.map((id) => optionLabel(q, id, answer)).join(', ');
  if (q.type === 'choice') return optionLabel(q, value, answer);
  return String(value);
}

/** The questions of a decision, and the owner's answers when there are some. Nothing here answers one. */
export function decisionLines(t) {
  if (!Array.isArray(t.decision) || !t.decision.length) return [];
  const answers = t.decisionAnswers?.answers ?? {};
  const out = [
    '',
    `  Decision${t.decisionAnswers ? ` (answered ${String(t.decisionAnswers.at).slice(0, 10)} by ${t.decisionAnswers.by ?? 'owner'})` : ' (not answered yet)'}`,
  ];
  t.decision.forEach((q, i) => {
    out.push(
      `  ${i + 1}. [${q.id}] ${q.prompt}  (${q.type}${q.required === false ? ', optional' : ''}${q.min !== undefined ? `, ${q.min} to ${q.max ?? '…'}` : ''})`,
    );
    if (q.help) out.push(...indent(q.help, 4));
    for (const o of q.options ?? []) out.push(`      - ${o.id}: ${o.label}${o.note ? ` (${o.note})` : ''}`);
    if (q.other) out.push('      - something else (free text)');
    const a = answers[q.id];
    if (a) out.push(`     Answer: ${answerText(q, a)}${a.comment ? ` (${a.comment})` : ''}`);
  });
  return out;
}
