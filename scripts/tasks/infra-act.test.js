import { describe, expect, it } from 'vitest';
import { unknownSubcommand } from './cli.js';
import { InfraActError, actText, heldRun, infraAct, parseAct } from './infra-act.js';

const AGENT = 'claude-run-7';

const run = (fields = {}) => ({
  uuid: '11111111-2222-3333-4444-555555555555',
  wid: 'RUN-7',
  project: 'routines',
  claim: AGENT,
  repo: 'widgets',
  ...fields,
});

const plan = (fields = {}) => ({
  id: 'plan-9',
  state: 'approved',
  environment: { id: 1, name: 'production' },
  ...fields,
});

/** A board that answers GET tasks with `tasks` and the act with `act`, keeping what it was sent. */
function board({
  tasks = [run()],
  act = { ok: true, status: 200, data: { act: { inside: true, why: '6 is within 2 to 10', plan: plan() } } },
} = {}) {
  const sent = [];
  return {
    sent,
    get: async (path) => {
      sent.push(['GET', path]);
      return { ok: true, status: 200, data: { tasks } };
    },
    post: async (path, body) => {
      sent.push(['POST', path, body]);
      return act;
    },
  };
}

describe('infra act', () => {
  it('is a subcommand infra knows', () => {
    expect(unknownSubcommand('infra', 'act')).toBeNull();
  });

  it('reads a scale and a restart, and refuses anything else before a request', () => {
    expect(parseAct(['production', 'acme-api', 'scale', '6'])).toEqual({
      environment: 'production',
      resource: 'acme-api',
      change: 'scale',
      value: 6,
    });
    expect(parseAct(['production', 'acme-api', 'restart'])).toEqual({
      environment: 'production',
      resource: 'acme-api',
      change: 'restart',
      value: null,
    });
    expect(() => parseAct(['production', 'acme-api'])).toThrow(/name the environment, the resource, and the change/u);
    expect(() => parseAct(['production', 'acme-api', 'scale'])).toThrow(/whole number/u);
    expect(() => parseAct(['production', 'acme-api', 'scale', '2.5'])).toThrow(/whole number/u);
    expect(() => parseAct(['production', 'acme-api', 'restart', '2'])).toThrow(/takes no number/u);
    expect(() => parseAct(['production', 'acme-api', 'delete'])).toThrow(/scale or restart, not delete/u);
  });

  it('sends the held run, the agent, and the repository, and says the envelope covered it', async () => {
    const b = board();
    const result = await infraAct(['production', 'acme-api', 'scale', '6'], {
      ...b,
      repo: 'widgets',
      agent: AGENT,
    });
    expect(b.sent[1]).toEqual([
      'POST',
      'infra/envelopes/production/act',
      { resource: 'acme-api', change: 'scale', value: 6, task: 'RUN-7', by: AGENT, repo: 'widgets' },
    ]);
    expect(result.code).toBe(0);
    expect(result.text).toContain('Scale acme-api to 6 in production: inside its envelope (6 is within 2 to 10).');
    expect(result.text).toContain('plan-9 · Approved: it applies without a press.');
    expect(result.text).toContain('npx breakaway infra plan plan-9');
  });

  it('says when it waits for the owner, with the plan', async () => {
    const b = board({
      act: {
        ok: true,
        status: 200,
        data: { act: { inside: false, why: '3 restarts used today', plan: plan({ id: 'plan-10', state: 'waiting' }) } },
      },
    });
    const result = await infraAct(['production', 'acme-api', 'restart'], { ...b, repo: 'widgets', agent: AGENT });
    expect(b.sent[1][2]).toMatchObject({ change: 'restart', value: null });
    expect(result.text).toContain('Restart acme-api in production: waits for the owner (3 restarts used today).');
    expect(result.text).toContain('plan-10 · Waiting for you: the owner approves or rejects it on the board.');
  });

  it('takes --task without looking for the run', async () => {
    const b = board();
    await infraAct(['staging', 'acme-queue', 'restart'], {
      ...b,
      repo: 'widgets',
      agent: AGENT,
      opts: { task: 'RUN-3' },
    });
    expect(b.sent).toHaveLength(1);
    expect(b.sent[0][2].task).toBe('RUN-3');
  });

  it('refuses before the act when the agent holds no run, or several', async () => {
    const none = board({ tasks: [run({ claim: 'someone-else' }), run({ project: 'board', wid: 'BRK-1' })] });
    await expect(
      infraAct(['production', 'acme-api', 'restart'], { ...none, repo: 'widgets', agent: AGENT }),
    ).rejects.toThrow(/holds no routine run here: only a runbook’s agent acts/u);
    expect(none.sent.filter(([m]) => m === 'POST')).toHaveLength(0);

    const several = board({ tasks: [run(), run({ wid: 'RUN-8', uuid: 'x' })] });
    await expect(heldRun({ get: several.get, agent: AGENT, inRepo: () => true })).rejects.toThrow(
      /holds 2 runs \(RUN-7, RUN-8\): name one with --task/u,
    );

    const elsewhere = board();
    await expect(
      heldRun({ get: elsewhere.get, agent: AGENT, inRepo: (t) => t.repo === 'gadgets' }),
    ).rejects.toBeInstanceOf(InfraActError);
  });

  it('passes the board’s refusal through in its words, and exits 1', async () => {
    const b = board({
      act: {
        ok: false,
        status: 403,
        data: { error: 'RUN-7 isn’t a runbook’s run: only a runbook’s agent acts in an envelope' },
      },
    });
    const result = await infraAct(['production', 'acme-api', 'restart'], { ...b, repo: 'widgets', agent: AGENT });
    expect(result.code).toBe(1);
    expect(result.text).toBe(
      'The board refused it: RUN-7 isn’t a runbook’s run: only a runbook’s agent acts in an envelope',
    );
    expect(result.data).toEqual({
      status: 403,
      error: 'RUN-7 isn’t a runbook’s run: only a runbook’s agent acts in an envelope',
    });
  });

  it('says when the board has no envelopes yet', async () => {
    const b = board({
      act: { ok: false, status: 404, data: { error: 'no route for POST /api/infra/envelopes/production/act' } },
    });
    await expect(
      infraAct(['production', 'acme-api', 'restart'], { ...b, repo: 'widgets', agent: AGENT }),
    ).rejects.toThrow(/doesn’t have envelopes yet/u);
  });

  it('writes a plan without a state as it comes', () => {
    expect(
      actText(
        { act: { inside: true, why: 'within bounds', plan: { id: 'plan-1', state: 'applying' } } },
        { environment: 'staging', resource: 'acme-api', change: 'scale', value: 2 },
      ),
    ).toContain('plan-1 · Applying');
  });
});
