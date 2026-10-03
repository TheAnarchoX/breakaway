/**
 * What an agent session shows on its task (docs/specs/CLD-35-cloud-agents.md): one short entry
 * per hook event, with secrets redacted before anything leaves the session. Pure, so it runs
 * in the hook (Node); the patterns are the board's (tools/tasks/src/redact.js), which runs them in the Worker too.
 */

import { redact } from '../../src/redact.js';

export { redact };

const LIMITS = { text: 4000, output: 600, detail: 300 };

const clip = (text, max) => {
  const s = redact(text).trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

const rel = (path, root) =>
  root && typeof path === 'string' && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;

function outputOf(response) {
  if (response === null || response === undefined) return '';
  if (typeof response === 'string') return response;
  if (typeof response.stdout === 'string' || typeof response.stderr === 'string')
    return [response.stdout, response.stderr].filter(Boolean).join('\n');
  if (typeof response.content === 'string') return response.content;
  if (Array.isArray(response.content)) return response.content.map((c) => c?.text ?? '').join('\n');
  if (typeof response.output === 'string') return response.output;
  return '';
}

function failed(response) {
  if (!response || typeof response !== 'object') return false;
  return Boolean(
    response.interrupted ||
      response.is_error ||
      response.error ||
      (typeof response.exit_code === 'number' && response.exit_code !== 0) ||
      (typeof response.exitCode === 'number' && response.exitCode !== 0),
  );
}

/** What the tool was run on, in a few words. */
function detailOf(tool, input = {}, root) {
  switch (tool) {
    case 'Bash':
      return input.command;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return rel(input.file_path ?? input.notebook_path, root);
    case 'Grep':
      return `${input.pattern}${input.path ? ` in ${rel(input.path, root)}` : ''}`;
    case 'Glob':
      return input.pattern;
    case 'WebFetch':
      return input.url;
    case 'WebSearch':
      return input.query;
    case 'Skill':
      return input.skill;
    case 'Agent':
    case 'Task':
      return input.description;
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string');
      return first ?? '';
    }
  }
}

/** A hook's input → the entry to show on the task, or null for events it doesn't show. */
export function entryFor(hook, root) {
  const at = Date.now();
  switch (hook?.hook_event_name) {
    case 'PostToolUse': {
      const tool = hook.tool_name ?? 'tool';
      const entry = {
        kind: 'tool',
        at,
        tool,
        detail: clip(detailOf(tool, hook.tool_input, root) ?? '', LIMITS.detail),
      };
      if (hook.tool_input?.description && tool === 'Bash') entry.title = clip(hook.tool_input.description, 200);
      const output = clip(outputOf(hook.tool_response), LIMITS.output);
      if (output && !['Read', 'Write', 'Edit', 'MultiEdit'].includes(tool)) entry.output = output;
      if (failed(hook.tool_response)) entry.failed = true;
      return entry;
    }
    case 'Stop':
    case 'SubagentStop':
      return hook.last_assistant_message
        ? { kind: 'message', at, text: clip(hook.last_assistant_message, LIMITS.text) }
        : null;
    case 'SessionStart':
      return {
        kind: 'start',
        at,
        text: `Session ${hook.source === 'startup' || !hook.source ? 'started' : hook.source === 'resume' ? 'resumed' : `restarted (${hook.source})`}${hook.model ? ` (${hook.model})` : ''}`,
      };
    case 'UserPromptSubmit':
      return hook.user_prompt ? { kind: 'prompt', at, text: clip(hook.user_prompt, 1500) } : null;
    default:
      return null;
  }
}
