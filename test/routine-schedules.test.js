import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './helpers.js';

const body = async (res) => ({ status: res.status, ...(await res.json()) });
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
const fires = [];
const at = (iso) => Date.parse(iso);
const tickAt = (iso) =>
  runInDurableObject(env.STORE.get(env.STORE.idFromName('samewave')), (store) => store.scheduleTick(at(iso)));
const listed = async (slug) => (await body(await api('routines'))).routines.find((r) => r.slug === slug);

describe('routine schedules', () => {
  let spy;
  beforeEach(() => {
    spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url !== FIRE) return new Response('{}', { status: 404 });
      fires.push(JSON.parse(init.body).text);
      const id = `session_${fires.length}`;
      return Response.json({ claude_code_session_id: id, claude_code_session_url: `https://claude.ai/code/${id}` });
    });
  });
  afterEach(() => spy.mockRestore());

  it('refuses a schedule that isn’t cron text', async () => {
    const res = await body(
      await api('routines', {
        method: 'POST',
        body: { slug: 'bad', name: 'Bad', prompt: 'x', schedule: 'every monday' },
      }),
    );
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/five fields/);
  });

  it('shows the schedule and its next run, and lifts the gap and caps only as the other triggers do', async () => {
    await api('routines/settings', { method: 'PATCH', body: { dailyCap: 100 } });
    const made = await body(
      await api('routines', {
        method: 'POST',
        body: { slug: 'weekly', name: 'Weekly', prompt: 'Do it.', schedule: '0 9 * * *', gapMinutes: 0, dailyCap: 50 },
      }),
    );
    expect(made.status).toBe(201);
    expect(made.routine.schedule).toBe('0 9 * * *');
    expect(made.routine.nextRun).toMatch(/T09:00:00\.000Z$/);
    await api('routines/settings', { method: 'PATCH', body: { paused: true } });
    expect((await listed('weekly')).nextRun).toBeNull();
    await api('routines/settings', { method: 'PATCH', body: { paused: false } });
  });

  it('starts once per slot, and not again for the same slot', async () => {
    const day = (await body(await api('routines'))).routines[0];
    expect(day.openRun).toBeNull();
    const slot = new Date(Date.now() + 86_400_000 * 2);
    slot.setUTCHours(9, 0, 0, 0);
    const iso = slot.toISOString();
    expect(await tickAt(new Date(slot.getTime() - 5 * 60_000).toISOString())).toEqual([]); // before the slot
    expect(await tickAt(new Date(slot.getTime() + 2 * 60_000).toISOString())).toEqual(['weekly']);
    expect(fires).toHaveLength(1);
    expect(fires[0]).toMatch(/Mode: routine[\s\S]*Routine: weekly|Routine: weekly[\s\S]*Mode: routine/);
    expect(fires[0]).toContain('by a routine’s schedule');
    expect((await listed('weekly')).lastRun).toMatchObject({ trigger: 'schedule' });
    expect(await tickAt(new Date(slot.getTime() + 4 * 60_000).toISOString())).toEqual([]); // the same slot again
    expect(fires).toHaveLength(1);
    expect(iso).toBeTruthy();
  });

  it('skips a slot it can’t start and never makes it up', async () => {
    const open = (await listed('weekly')).openRun; // the run from the last slot is still open
    expect(open).not.toBeNull();
    const next = new Date(Date.now() + 86_400_000 * 3);
    next.setUTCHours(9, 0, 0, 0);
    expect(await tickAt(next.toISOString())).toEqual([]);
    await api(`tasks/${open.wid}/done`, { method: 'POST', body: {} });
    expect(await tickAt(new Date(next.getTime() + 5 * 60_000).toISOString())).toEqual([]); // same slot, already looked at
    expect(await tickAt(new Date(next.getTime() + 3 * 3_600_000).toISOString())).toEqual([]); // hours late: no catching up
    expect(fires).toHaveLength(1);
  });

  it('starts from now when a schedule is set, and not while the routine is off', async () => {
    await api('routines/weekly', { method: 'PATCH', body: { schedule: '*/5 * * * *' } });
    const past = new Date(Date.now() - 60 * 60_000).toISOString();
    expect(await tickAt(past)).toEqual([]); // a slot before the edit isn't made up
    await api('routines/weekly', { method: 'PATCH', body: { enabled: false } });
    expect(await tickAt(new Date(Date.now() + 3600_000).toISOString())).toEqual([]);
    expect(fires).toHaveLength(1);
  });
});
