import { createHash } from 'node:crypto';
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BOARD_FILES from '../src/board-files.json' with { type: 'json' };
import { checkReport, judgeStub, reportProblems, sessionReport, shortHash, stubText } from '../src/session-report.js';
import { api } from './helpers.js';

const inStore = (fn) => runInDurableObject(env.STORE.get(env.STORE.idFromName('widgets')), fn);
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const BOARD = { slug: 'widgets', host: 'tasks.acme.example' };

describe('a session’s report, the pure parts', () => {
  it('is only made in a cloud session, and holds yes/no facts, never a value', () => {
    expect(sessionReport({ env: { BREAKAWAY_TOKEN: 'secret-token', BREAKAWAY_AGENT: 'claude-x' } })).toBeNull();
    const cloud = { CLAUDE_CODE_REMOTE: 'true' };
    expect(sessionReport({ env: { ...cloud, BREAKAWAY_AGENT: 'claude-x' }, stub: 'abcdef0123456789' })).toEqual({
      token: 'credential',
      agent: true,
      stub: 'abcdef0123456789',
    });
    const variable = sessionReport({ env: { ...cloud, BREAKAWAY_TOKEN: 'secret-token' } });
    expect(variable).toEqual({ token: 'variable', agent: false, stub: null });
    expect(JSON.stringify(variable)).not.toContain('secret-token');
    expect(sessionReport({ env: cloud, file: { BREAKAWAY_TOKEN: 'x', BREAKAWAY_AGENT: 'y' } })).toEqual({
      token: 'file',
      agent: true,
      stub: null,
    });
    expect(sessionReport({ env: cloud, named: true }).agent).toBe(true);
  });

  it('keeps only the known facts', () => {
    expect(checkReport({ token: 'credential', agent: true, stub: 'abcdef0123456789', extra: 'x' })).toEqual({
      token: 'credential',
      agent: true,
      stub: 'abcdef0123456789',
    });
    expect(checkReport({ token: 'credential', agent: true, stub: 'sk-ant-oat01-a-token' })).toEqual({
      token: 'credential',
      agent: true,
      stub: null,
    });
    for (const bad of [null, 'x', [], {}, { token: 'sk-ant', agent: true }, { token: 'variable', agent: 'yes' }])
      expect(checkReport(bad)).toBeNull();
  });

  it('judges the stub against the board’s, and says each problem with its fix', () => {
    expect(judgeStub('a', 'a')).toBe('same');
    expect(judgeStub('a', 'b')).toBe('different');
    expect(judgeStub(null, 'b')).toBe('missing');
    expect(judgeStub('a', null)).toBeNull();
    expect(reportProblems({ token: 'credential', agent: true, stub: 'same' }, BOARD)).toEqual([]);
    expect(reportProblems({ token: 'credential', agent: true, stub: null }, BOARD)).toEqual([]);
    const all = reportProblems({ token: 'variable', agent: false, stub: 'different' }, BOARD);
    expect(all.map((p) => p.what)).toEqual([
      expect.stringMatching(/no agent name/u),
      expect.stringMatching(/BREAKAWAY_TOKEN/u),
      expect.stringMatching(/stub differs/u),
    ]);
    expect(all[1].fix).toMatch(/API credential for tasks\.acme\.example/u);
    expect(all[2].fix).toMatch(/repos init widgets --update/u);
    expect(reportProblems({ token: 'file', agent: true, stub: 'missing' }, BOARD).map((p) => p.what)).toEqual([
      expect.stringMatching(/tasks\.env/u),
      expect.stringMatching(/no copy of the stub/u),
    ]);
  });

  it('hashes the stub the way Node does, line endings aside', async () => {
    const text = 'Read `<prompt path>` now.\r\n';
    expect(await shortHash(stubText(text))).toBe(
      createHash('sha256').update('Read `<prompt path>` now.').digest('hex').slice(0, 16),
    );
  });
});

const fires = [];
function mockClaude() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === FIRE) {
      const id = `session_${String(fires.push(url)).padStart(4, '0')}`;
      return Response.json({ claude_code_session_id: id, claude_code_session_url: `https://claude.ai/code/${id}` });
    }
    return new Response('{"message":"Not Found"}', { status: 404 }); // GitHub
  });
}

const routineRow = async () =>
  (await inStore((s) => s.claudeConnections())).find((c) => c.id === 'claude.routine' && c.repo === 'widgets');
const start = (ref) => api('agents/start', { method: 'POST', body: { ref } });
const claim = (ref, agent, session) => api(`tasks/${ref}/claim`, { method: 'POST', body: { agent, session } });
const boardStub = async () => shortHash(stubText(BOARD_FILES['prompts/stub.md']));
const good = async () => ({ token: 'credential', agent: true, stub: await boardStub() });

describe('a session’s first claim verifies its routine', () => {
  let spy;
  beforeEach(() => {
    spy = mockClaude();
  });
  afterEach(() => spy.mockRestore());

  it('reads Not verified yet while nothing has started through it, and says what verifies it', async () => {
    const row = await routineRow();
    expect(row).toMatchObject({ state: 'working', reading: 'unverified', fix: null });
    expect(row.detail).toMatch(/not verified yet: start an agent on a task to verify it/u);
  });

  it('still reads Not verified yet after a start nobody has claimed from', async () => {
    await api('tasks', {
      method: 'POST',
      body: [
        { description: 'Publish security.txt', project: 'ops', who: 'agent', horizon: 'now' },
        { description: 'Status page', project: 'ops', who: 'agent', horizon: 'now' },
        { description: 'Route table', project: 'ops', who: 'agent', horizon: 'now' },
      ],
    });
    expect((await start('OPS-1')).status).toBe(200);
    const row = await routineRow();
    expect(row).toMatchObject({ state: 'working', reading: 'unverified' });
    expect(row.detail).toMatch(/the last start worked; not verified yet/u);
  });

  it('ignores a report from a claim the board didn’t start, and one that isn’t a report', async () => {
    expect((await claim('OPS-2', 'claude-ops-2', await good())).status).toBe(200);
    expect((await claim('OPS-1', 'claude-ops-1', { token: 'sk-ant-oat01-x', agent: true })).status).toBe(200);
    expect((await routineRow()).reading).toBe('unverified');
    await api('tasks/OPS-2/release', { method: 'POST', body: { agent: 'claude-ops-2' } });
  });

  it('reads Verified by the task, at the time, once the started session claims with a clean report', async () => {
    expect((await claim('OPS-1', 'claude-ops-1', await good())).status).toBe(200);
    const row = await routineRow();
    expect(row).toMatchObject({ state: 'working', reading: 'verified', fix: null });
    expect(row.detail).toMatch(/^verified by OPS-1’s session/u);
    expect(row.verified).toMatchObject({ task: 'OPS-1' });
    expect(Date.now() - Date.parse(row.verified.at)).toBeLessThan(60_000);
    // Only yes/no facts are kept.
    const kept = await inStore((s) => s.meta('routine_verified:widgets'));
    expect(kept).not.toMatch(/sk-ant|trig_test/u);
  });

  it('counts only a session’s first claim', async () => {
    expect((await claim('OPS-1', 'claude-ops-1', { token: 'variable', agent: true, stub: null })).status).toBe(200);
    expect((await routineRow()).reading).toBe('verified');
  });

  it('needs attention, with the fix, when the report has a problem; even a claim refused for its name reports', async () => {
    expect((await start('OPS-3')).status).toBe(200);
    // No BREAKAWAY_AGENT: the session claims as user@host, which the board refuses, but its report still lands.
    const refused = await claim('OPS-3', 'root@vm', { token: 'variable', agent: false, stub: 'abcdef0123456789' });
    expect(refused.status).toBe(409);
    const row = await routineRow();
    expect(row.state).toBe('attention');
    expect(row.reading).toBeUndefined();
    expect(row.detail).toMatch(/OPS-3’s session reported a problem: it had no agent name/u);
    expect(row.detail).toMatch(/BREAKAWAY_TOKEN/u);
    expect(row.detail).toMatch(/stub differs/u);
    expect(row.fix).toMatch(/Copy stub/u);
    expect(row.fix).toMatch(/API credential for/u);
    expect(row.fix).toMatch(/repos init widgets --update/u);
  });

  it('reads Not verified yet again once the routine is connected anew', async () => {
    await inStore(async (s) => {
      const kept = JSON.parse(s.meta('routine_verified:widgets'));
      s.setMeta('routine_verified:widgets', JSON.stringify({ ...kept, url: '0000000000000000' }));
    });
    expect((await routineRow()).reading).toBe('unverified');
  });

  it('never fires a start just to verify', () => {
    expect(fires).toHaveLength(2);
  });
});
