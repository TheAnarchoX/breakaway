import { describe, expect, it } from 'vitest';
import { entryFor, redact } from './session-log.js';

describe('redact', () => {
  it("removes tokens, keys, and an install's secrets (breakaway's prefix or its own) before anything leaves the session", () => {
    const text = [
      'ACME_TASKS_TOKEN=abcDEF123456789xyz', // gitleaks:allow (made up, for the redaction)
      'Authorization: Bearer sk-ant-oat01-AbCdEf_1234567890abcdef',
      'token ghs_1234567890abcdefghijABCDEFGHIJ12',
      'export ACME_TASKS_SECRET="s3cr3t-value"',
      'BREAKAWAY_API_TOKEN=plainword',
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----',
      'key=MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7', // gitleaks:allow (made up, for the redaction)
    ].join('\n');
    const out = redact(text);
    for (const secret of [
      'abcDEF123456789xyz',
      'sk-ant-oat01',
      'ghs_1234567890',
      's3cr3t-value',
      'plainword',
      'MIIEvQIBADANBgkq',
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('ACME_TASKS_TOKEN=[redacted]');
  });

  it('keeps what makes the log readable: commit SHAs, UUIDs, paths, and ordinary text', () => {
    const text =
      'git show 5a41a4f9d37790f094bde837d07d13575acf7f00 in tools/tasks/src/store.js for 8fc05b97-87ba-4ad1-93e3-c230d803fdbb';
    expect(redact(text)).toBe(text);
  });
});

describe('entryFor', () => {
  it('summarises a Bash call and the start of its output', () => {
    const e = entryFor({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test', description: 'Run the tests' },
      tool_response: { stdout: 'Tests  97 passed (97)\n', stderr: '', interrupted: false },
    });
    expect(e).toMatchObject({ kind: 'tool', tool: 'Bash', title: 'Run the tests', detail: 'pnpm test' });
    expect(e.output).toContain('97 passed');
  });

  it('names the file for edits and reads, and the pattern for searches', () => {
    expect(
      entryFor(
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Edit',
          tool_input: { file_path: '/repo/src/app/App.jsx', old_string: 'a', new_string: 'b' },
          tool_response: {},
        },
        '/repo',
      ),
    ).toMatchObject({ kind: 'tool', tool: 'Edit', detail: 'src/app/App.jsx' });
    expect(
      entryFor(
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Grep',
          tool_input: { pattern: 'canonicalUri', path: '/repo/src' },
          tool_response: 'x',
        },
        '/repo',
      ),
    ).toMatchObject({ detail: 'canonicalUri in src' });
  });

  it('keeps what the agent said when it stops, trimmed', () => {
    const e = entryFor({ hook_event_name: 'Stop', last_assistant_message: `Opened the PR.${' more'.repeat(2000)}` });
    expect(e.kind).toBe('message');
    expect(e.text.length).toBeLessThanOrEqual(4001);
    expect(e.text.startsWith('Opened the PR.')).toBe(true);
  });

  it('marks a failed tool call', () => {
    expect(
      entryFor({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'false' },
        tool_response: { stdout: '', stderr: 'boom', exit_code: 1 },
      }).failed,
    ).toBe(true);
  });

  it("notes the start of a session and a prompt, and ignores what it doesn't know", () => {
    expect(entryFor({ hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5' })).toMatchObject({
      kind: 'start',
      text: 'Session started (claude-opus-5-5)',
    });
    expect(entryFor({ hook_event_name: 'UserPromptSubmit', user_prompt: 'Work on OPS-5' })).toMatchObject({
      kind: 'prompt',
      text: 'Work on OPS-5',
    });
    expect(entryFor({ hook_event_name: 'Notification' })).toBeNull();
  });
});
