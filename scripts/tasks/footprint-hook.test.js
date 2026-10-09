import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  conflictText,
  dirtyDue,
  dirtyPaths,
  editedPath,
  editOutput,
  isEdit,
  keepNote,
  porcelainPaths,
  takeNote,
} from './footprint-hook.js';
import { EDIT_HOOK_TIMEOUT, EDIT_MATCHER, hookCommand, rewireHooks, sessionHooks } from './init.js';
import { riderFootprint } from './peloton.js';
import { checkoutRunsHooks } from './plugin-hooks.js';
import { messageOutput } from './session-messages.js';

const ROOT = '/work/widgets';
const edit = (file_path, tool_name = 'Edit') => ({
  hook_event_name: 'PreToolUse',
  tool_name,
  tool_input: { file_path },
});
const claim = { uuid: 'u-1', agent: 'claude-ops-7', wid: 'OPS-7' };

describe('the edit hook in the session hooks (IDEA-55 section 1a)', () => {
  it('runs synchronously on the edit tools, with a short timeout, beside the background hooks', () => {
    const hooks = sessionHooks();
    expect(hooks.PreToolUse).toEqual([
      {
        matcher: 'Edit|Write|MultiEdit|NotebookEdit',
        hooks: [{ type: 'command', command: 'npx --yes breakaway@2 hook edit', timeout: EDIT_HOOK_TIMEOUT }],
      },
    ]);
    expect(hooks.PreToolUse[0].hooks[0]).not.toHaveProperty('async');
    expect(EDIT_MATCHER.split('|')).toEqual(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
    expect(hooks.PostToolUse[0].hooks[0].async).toBe(true);
  });

  it('rewires an older channel’s edit hook, and the plugin’s steps aside only for a checkout that runs it', () => {
    expect(rewireHooks('"npx --yes breakaway@next hook edit"')).toBe(`"${hookCommand('edit')}"`);
    const plugin = { CLAUDE_PLUGIN_ROOT: '/home/me/.claude/plugins/breakaway' };
    const reading = (text) => (path) => (path === join(ROOT, '.claude', 'settings.json') ? text : null);
    const old = JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ command: hookCommand('session') }] }] } });
    expect(checkoutRunsHooks(ROOT, plugin, reading(old))).toBe(true);
    expect(checkoutRunsHooks(ROOT, plugin, reading(old), 'edit')).toBe(false);
    expect(checkoutRunsHooks(ROOT, plugin, reading(JSON.stringify({ hooks: sessionHooks() })), 'edit')).toBe(true);
  });
});

describe('what the edit hook claims', () => {
  it('the repository path an edit names, and nothing outside the checkout', () => {
    expect(isEdit(edit('/x'))).toBe(true);
    expect(isEdit({ tool_name: 'Bash' })).toBe(false);
    expect(editedPath(edit(`${ROOT}/src/app.js`), ROOT)).toBe('src/app.js');
    expect(editedPath(edit(`${ROOT}/./web/a.jsx`, 'Write'), `${ROOT}/`)).toBe('web/a.jsx');
    expect(editedPath({ tool_name: 'NotebookEdit', tool_input: { notebook_path: `${ROOT}/nb/a.ipynb` } }, ROOT)).toBe(
      'nb/a.ipynb',
    );
    expect(editedPath(edit('C:\\work\\widgets\\src\\a.js'), 'C:\\work\\widgets')).toBe('src/a.js');
    expect(editedPath(edit('/tmp/scratch.txt'), ROOT)).toBeNull();
    expect(editedPath(edit('/work/widgets-other/a.js'), ROOT)).toBeNull();
    expect(editedPath(edit(`${ROOT}/.git/config`), ROOT)).toBeNull();
    expect(editedPath(edit(`${ROOT}/a/../../b.js`), ROOT)).toBeNull();
    expect(editedPath({ tool_name: 'Edit', tool_input: {} }, ROOT)).toBeNull();
  });

  it('grants quietly, refuses with the board’s reason, and lets the edit through when the board doesn’t answer', () => {
    expect(editOutput({ status: 200, data: { granted: [] } }, 'src/a.js', claim)).toBeNull();
    const reason =
      '`src/a.js` is claimed by claude-web-40 on WEB-40 (`src/**`, active 2 minutes ago). Back off: change other files, ask @claude-web-40 on the peloton, or if your task can’t go on without it, comment why and release it.';
    expect(editOutput({ status: 409, data: { error: reason } }, 'src/a.js', claim)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    });
    expect(
      editOutput({ status: 409, data: null }, 'src/a.js', claim).hookSpecificOutput.permissionDecisionReason,
    ).toMatch(/src\/a\.js. is claimed by another task/u);
    for (const answer of [{ error: 'The operation was aborted due to timeout' }, { status: 502, data: null }]) {
      const out = editOutput(answer, 'src/a.js', claim);
      expect(out.hookSpecificOutput).not.toHaveProperty('permissionDecision');
      expect(out.hookSpecificOutput.additionalContext).toMatch(
        /^The board didn't grant a claim on `src\/a\.js` \(.+\), so this edit went ahead unclaimed\..*paths OPS-7 --claim src\/a\.js\.$/u,
      );
    }
  });
});

describe('dirty paths (IDEA-55 section 1b)', () => {
  it('reads git status’s paths, a rename’s both names among them', () => {
    expect(porcelainPaths(' M src/a.js\0?? docs/new.md\0R  src/b.js\0src/old-b.js\0 D gone.txt\0')).toEqual([
      'src/a.js',
      'docs/new.md',
      'src/b.js',
      'src/old-b.js',
      'gone.txt',
    ]);
    expect(porcelainPaths('')).toEqual([]);
  });

  it('adds what differs from the default branch’s merge base, paths only, sorted', () => {
    const calls = [];
    const git = (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'status') return ' M src/a.js\0';
      if (args[0] === 'symbolic-ref') return 'origin/main\n';
      if (args[0] === 'merge-base') return 'abc123\n';
      if (args[0] === 'diff') return 'src/a.js\0test/a.test.js\0';
      return null;
    };
    expect(dirtyPaths(git)).toEqual(['src/a.js', 'test/a.test.js']);
    expect(calls).toContain('diff --name-only -z abc123');
    // No origin/HEAD and no merge base: what git status lists. Not a checkout: nothing to say.
    expect(dirtyPaths((args) => (args[0] === 'status' ? '?? x.js\0' : null))).toEqual(['x.js']);
    expect(dirtyPaths(() => null)).toBeNull();
  });

  it('goes at most once a minute, on an edit tool’s call or a stop', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brk-320-'));
    const post = { hook_event_name: 'PostToolUse', tool_name: 'Edit' };
    expect(dirtyDue({ hook_event_name: 'PostToolUse', tool_name: 'Read' }, 'u', { dir, now: 0 })).toBe(false);
    expect(dirtyDue(post, 'u', { dir, now: 100_000 })).toBe(true);
    expect(dirtyDue(post, 'u', { dir, now: 130_000 })).toBe(false);
    expect(dirtyDue({ hook_event_name: 'Stop' }, 'u', { dir, now: 160_000 })).toBe(true);
    expect(dirtyDue(post, 'other', { dir, now: 160_000 })).toBe(true);
  });

  it('tells the agent about a conflict the first time the board flags it, even after a stop', () => {
    const conflicts = [
      { path: 'web/a.jsx', task: 'WEB-40', agent: 'claude-web-40', pattern: 'web/**', new: true },
      { path: 'web/b.jsx', task: 'WEB-40', agent: 'claude-web-40', pattern: 'web/**', new: false },
    ];
    const text = conflictText({ conflicts });
    expect(text).toBe(
      'You changed `web/a.jsx`, which claude-web-40 claims on WEB-40 (`web/**`). Agree on the peloton who goes first (@claude-web-40); by default the second one backs off and leaves the file to its holder.',
    );
    expect(conflictText(undefined)).toBe('');
    const dir = mkdtempSync(join(tmpdir(), 'brk-320-'));
    keepNote('u', text, dir);
    keepNote('u', 'second', dir);
    expect(takeNote('u', dir)).toBe(`${text}\nsecond`);
    expect(takeNote('u', dir)).toBe('');
    // It goes after the owner's messages and the peloton's posts.
    const out = messageOutput({ messages: [{ text: 'Hi', sent: null }] }, 'PostToolUse', text);
    expect(out.hookSpecificOutput.additionalContext).toBe(`Message from the owner (via the board): Hi\n\n${text}`);
    expect(messageOutput({}, 'PostToolUse', text).hookSpecificOutput.additionalContext).toBe(text);
    expect(messageOutput({}, 'Stop', text)).toBeNull();
  });
});

describe('riders’ footprints on the peloton (IDEA-55 section 4)', () => {
  it('names what a rider is changing and where the reader’s paths meet it', () => {
    expect(riderFootprint({})).toBe('');
    expect(riderFootprint({ changing: ['src/a.js', 'test/'] })).toBe(': changing src/a.js, test/');
    expect(riderFootprint({ changing: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], overlaps: ['src/**'] })).toBe(
      ': changing a, b, c, d, e, f and 2 more; overlaps yours: src/**',
    );
  });
});

describe('the edit hook, run as Claude Code runs it', () => {
  const HOOK = fileURLToPath(new URL('./edit-hook.mjs', import.meta.url));
  /** @type {import('node:http').Server} */
  let server;
  let port = 0;
  /** What the fake board answers, and what it was sent. */
  let answer = { status: 200, body: { granted: [{ pattern: 'src/a.js' }], held: [], refused: [] } };
  const seen = [];
  const root = mkdtempSync(join(tmpdir(), 'brk-320-root-'));
  writeFileSync(join(root, '.task-session'), JSON.stringify(claim));

  beforeAll(async () => {
    server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
      });
      req.on('end', () => {
        seen.push({ url: req.url, method: req.method, body: JSON.parse(data || 'null') });
        res.writeHead(answer.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(answer.body));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  });
  afterAll(() => new Promise((resolve) => server.close(() => resolve(undefined))));

  /** Runs the hook on `input` against the board at `url`: its exit code and what it printed. */
  const run = (input, url = `http://127.0.0.1:${port}`, argv = [HOOK]) =>
    new Promise((resolve) => {
      const env = {
        PATH: process.env.PATH,
        HOME: root,
        BREAKAWAY_HOME: root,
        CLAUDE_PROJECT_DIR: root,
        BREAKAWAY_URL: url,
      };
      const child = spawn(process.execPath, argv, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (c) => {
        out += c;
      });
      child.on('close', (code) => resolve({ code, out: out.trim() ? JSON.parse(out) : null }));
      child.stdin.end(JSON.stringify(input));
    });

  it('claims the edited file and lets the edit go ahead quietly', async () => {
    const res = await run(edit(join(root, 'src', 'a.js')));
    expect(res).toEqual({ code: 0, out: null });
    expect(seen.at(-1)).toEqual({
      url: '/api/tasks/u-1/paths',
      method: 'POST',
      body: { agent: 'claude-ops-7', claim: ['src/a.js'] },
    });
  });

  it('denies the edit with who holds the file', async () => {
    answer = { status: 409, body: { error: '`src/a.js` is claimed by claude-web-40 on WEB-40.', refused: [] } };
    const res = await run(edit(join(root, 'src', 'a.js'), 'Write'));
    expect(res.code).toBe(0);
    expect(res.out.hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: '`src/a.js` is claimed by claude-web-40 on WEB-40.',
    });
  });

  it('runs through the CLI as `hook edit`, the command the settings name', async () => {
    const CLI = fileURLToPath(new URL('../tasks.mjs', import.meta.url));
    answer = { status: 409, body: { error: 'Held by claude-web-40.', refused: [] } };
    const res = await run(edit(join(root, 'src', 'b.js')), `http://127.0.0.1:${port}`, [CLI, 'hook', 'edit']);
    expect(res.code).toBe(0);
    expect(res.out.hookSpecificOutput.permissionDecisionReason).toBe('Held by claude-web-40.');
    expect(seen.at(-1).body).toEqual({ agent: 'claude-ops-7', claim: ['src/b.js'] });
  });

  it('fails open when the board can’t be reached, and stays out of files outside the checkout', async () => {
    const before = seen.length;
    const down = await run(edit(join(root, 'src', 'a.js')), 'http://127.0.0.1:1');
    expect(down.code).toBe(0);
    expect(down.out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(down.out.hookSpecificOutput.additionalContext).toMatch(/went ahead unclaimed/u);
    expect(await run(edit('/somewhere/else.js'))).toEqual({ code: 0, out: null });
    expect(await run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })).toEqual({
      code: 0,
      out: null,
    });
    expect(seen.length).toBe(before);
  });
});
