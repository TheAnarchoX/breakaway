import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const REPO = '/repos/acme/samewave';
const state = { alerts: [], fires: [], next: 1 };

function alert(number, severity, pkg, fixedIn = '1.2.3') {
  return {
    number,
    html_url: `https://github.com/acme/samewave/security/dependabot/${number}`,
    created_at: '2026-09-29T00:00:00Z',
    dependency: { package: { name: pkg, ecosystem: 'npm' }, manifest_path: 'pnpm-lock.yaml' },
    security_advisory: { severity, summary: `A ${severity} problem in ${pkg}`, ghsa_id: `GHSA-${number}` },
    security_vulnerability: { first_patched_version: { identifier: fixedIn } },
  };
}

function mock() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.href === FIRE) {
      state.fires.push(JSON.parse(init.body).text);
      const id = `session_a${state.next++}`;
      return json({
        type: 'routine_fire',
        claude_code_session_id: id,
        claude_code_session_url: `https://claude.ai/code/${id}`,
      });
    }
    const path = url.pathname;
    if (path === `${REPO}/installation`) return json({ id: 7 });
    if (path.startsWith('/app/installations/'))
      return json({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (path === `${REPO}/pulls` || path === `${REPO}/commits`) return json([]);
    if (path === `${REPO}/actions/runs`) return json({ workflow_runs: [] });
    if (path === `${REPO}/dependabot/alerts`) return json(state.alerts);
    return json({ message: 'Not Found' }, 404);
  });
}

describe('security alerts to agents', () => {
  let spy;
  beforeEach(() => {
    spy = mock();
  });
  afterEach(() => spy.mockRestore());

  it('turns an alert into a task and starts an agent on it', async () => {
    state.alerts = [alert(1, 'high', 'sharp', '0.35.4')];
    await api('github/sync', { method: 'POST' }); // the first sync only records history
    const res = await body(await api('github/alerts/1/fix', { method: 'POST', body: {} }));
    expect(res.status).toBe(200);
    expect(res.task).toMatchObject({
      description: 'Fix the high security alert in sharp',
      project: 'debt',
      priority: 'H',
      horizon: 'now',
      tags: ['agent', 'security'],
      alert: 'https://github.com/acme/samewave/security/dependabot/1',
      claim: `claude-${res.task.wid.toLowerCase()}`,
    });
    expect(res.task.brief).toMatch(/Fixed in sharp 0\.35\.4\.[\s\S]*GHSA-1/);
    expect(res.task.doneWhen).toMatch(/^The alert is gone/);
    expect(res.task.briefBy).toBe('board');
    expect(res.run).toMatchObject({ trigger: 'alert', status: 'started' });
    expect(state.fires.at(-1)).toMatch(/for a GitHub security alert/);

    // Asking again doesn't make a second task or a second agent.
    const again = await body(await api('github/alerts/1/fix', { method: 'POST', body: {} }));
    expect(again).toMatchObject({ run: null, already: expect.stringMatching(/is on it/) });
    expect(again.task.uuid).toBe(res.task.uuid);
    const overview = await body(await api('github'));
    expect(overview.alerts[0].task).toMatchObject({ wid: res.task.wid, claim: res.task.claim });
    expect((await api('github/alerts/99/fix', { method: 'POST', body: {} })).status).toBe(404);
  });

  it('starts agents by itself for new alerts at or above the chosen severity', async () => {
    expect((await api('agents/settings', { method: 'PATCH', body: { alerts: 'loud' } })).status).toBe(400);
    await api('agents/settings', { method: 'PATCH', body: { alerts: 'high' } });
    state.alerts = [alert(1, 'high', 'sharp'), alert(2, 'critical', 'undici', '7.1.0'), alert(3, 'low', 'debug')];
    await api('github/sync', { method: 'POST' });
    const { tasks } = await body(await api('tasks'));
    const undici = tasks.find((t) => t.alert?.endsWith('/2'));
    expect(undici).toMatchObject({ autostart: true, priority: 'H' });
    expect(tasks.find((t) => t.alert?.endsWith('/3'))).toBeUndefined(); // low is below "high"
    // The auto-starter picks it up on the next tick, even though another agent works in Tech debt.
    const { queue } = await body(await api('agents'));
    expect(queue.find((q) => q.uuid === undici.uuid)).toMatchObject({ ready: true, reason: 'starting now' });
  });

  it('notes on the task when GitHub closes the alert', async () => {
    state.alerts = [alert(2, 'critical', 'undici', '7.1.0'), alert(3, 'low', 'debug')];
    await api('github/sync', { method: 'POST' });
    const { tasks } = await body(await api('tasks?status=all'));
    const sharp = tasks.find((t) => t.alert?.endsWith('/1'));
    expect(sharp.comments.at(-1)).toMatchObject({ by: 'board', text: 'The security alert is closed on GitHub.' });
  });
});
