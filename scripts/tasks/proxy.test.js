import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearHookFailure, hookFailure, noteHookFailure, sessionRequest } from './proxy.js';

// BRK-86: Claude Code runs hooks with the cloud image's default Node (20 there), which can't send fetch through the
// session proxy, so a hook's post went nowhere. With a proxy, the hooks send through curl, which reads HTTPS_PROXY and
// the system's certificates on any Node; and a hook that can't post leaves a reason the CLI shows.
const PROXY = { HTTPS_PROXY: 'http://proxy.local:8080' };
const URL_ = 'https://board.example.org/api/tasks/abc/session';

/** A stand-in for curl: records its arguments and input, answers with `out`, or fails with `error`. */
function curl({ out = '{"added":1}\n201', error = null } = {}) {
  const calls = [];
  const run = async (command, args, input) => {
    calls.push({ command, args, input });
    if (error) throw Object.assign(new Error(error), { code: error });
    return out;
  };
  return { calls, run };
}
const noFetch = () => {
  throw new Error('fetch should not run');
};

describe('the hooks’ requests (BRK-86)', () => {
  it('go through curl when the session has a proxy, with the body on stdin', async () => {
    const { calls, run } = curl();
    const res = await sessionRequest(
      URL_,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"entries":[]}', timeoutMs: 4000 },
      { env: PROXY, run, fetch: noFetch },
    );
    expect(res.status).toBe(201);
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ added: 1 });
    expect(calls).toHaveLength(1);
    const [{ command, args, input }] = calls;
    expect(command).toBe('curl');
    expect(args).toEqual(
      expect.arrayContaining(['-X', 'POST', '-H', 'Content-Type: application/json', '--data-binary', '@-', URL_]),
    );
    expect(args).toContain('--max-time');
    expect(input).toBe('{"entries":[]}');
  });

  it('read a failed answer as not ok, and an empty body as null', async () => {
    const { run } = curl({ out: '\n403' });
    const res = await sessionRequest(URL_, {}, { env: PROXY, run, fetch: noFetch });
    expect(res).toMatchObject({ ok: false, status: 403 });
    expect(await res.json()).toBeNull();
  });

  it('fall back to fetch when there is no curl, and use fetch when there is no proxy', async () => {
    const seen = [];
    const fetch = async (url, init) => {
      seen.push([url, init.method]);
      return { ok: true, status: 201, json: async () => ({ added: 1 }) };
    };
    const missing = curl({ error: 'ENOENT' });
    expect((await sessionRequest(URL_, { method: 'POST' }, { env: PROXY, run: missing.run, fetch })).status).toBe(201);
    const unused = curl();
    expect((await sessionRequest(URL_, { method: 'GET' }, { env: {}, run: unused.run, fetch })).status).toBe(201);
    expect(unused.calls).toEqual([]);
    expect(seen).toEqual([
      [URL_, 'POST'],
      [URL_, 'GET'],
    ]);
  });

  it('pass on a curl that fails for another reason, so the hook can say why', async () => {
    const { run } = curl({ error: 'curl: (56) CONNECT tunnel failed, response 403' });
    await expect(sessionRequest(URL_, {}, { env: PROXY, run, fetch: noFetch })).rejects.toThrow(/CONNECT tunnel/u);
  });
});

describe('a hook that can’t post (BRK-86)', () => {
  it('leaves a reason outside the repository, which the next success clears', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brk86-'));
    expect(hookFailure('task-1', dir)).toBeNull();
    noteHookFailure('task-1', 'HTTP 403', dir, new Date('2026-10-04T02:00:00Z'));
    expect(hookFailure('task-1', dir)).toEqual({ at: '2026-10-04T02:00:00.000Z', reason: 'HTTP 403' });
    expect(hookFailure('task-2', dir)).toBeNull();
    clearHookFailure('task-1', dir);
    expect(hookFailure('task-1', dir)).toBeNull();
  });
});
