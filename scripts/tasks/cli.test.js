import { describe, expect, it } from 'vitest';
import { CLI_PACKAGE } from './init.js';
import {
  githubRequest,
  ideaTask,
  NO_ARGUMENTS,
  forceFields,
  generalAgentRequest,
  generalAgentSummary,
  pullAgentRequest,
  pullAgentSummary,
  SUBCOMMANDS,
  staleCliWarning,
  unknownSubcommand,
} from './cli.js';

describe('unknown subcommands (CLD-193)', () => {
  it('fails on one a command doesn’t have, naming the ones it has', () => {
    expect(unknownSubcommand('repos', 'remov')).toBe(
      'repos has no "remov"; it has add, init, modify, remove, setup. npx breakaway help says what each does.',
    );
    expect(unknownSubcommand('routines', 'delete')).toMatch(/^routines has no "delete"; it has add, modify, run/u);
    expect(unknownSubcommand('agents', 'stop')).toMatch(/agents has no "stop"/u);
    expect(unknownSubcommand('horizon', 'open')).toMatch(/horizon has no "open"; it has close/u);
  });

  it('lets every known one, and none, through', () => {
    for (const [command, subs] of Object.entries(SUBCOMMANDS)) {
      expect(unknownSubcommand(command, undefined)).toBeNull();
      for (const sub of subs) expect(unknownSubcommand(command, sub)).toBeNull();
    }
  });

  it('fails on a word after a command that takes none, and leaves the others alone', () => {
    expect(unknownSubcommand('health', 'now')).toMatch(/^health takes no "now"/u);
    for (const command of NO_ARGUMENTS) expect(unknownSubcommand(command, undefined)).toBeNull();
    expect(unknownSubcommand('show', 'CLD-1')).toBeNull();
    expect(unknownSubcommand('ping', 'CLD-1')).toBeNull();
    expect(unknownSubcommand('decision', 'CLD-1')).toBeNull();
  });
});

describe('a stale CLI (CLD-193, BRK-7)', () => {
  it('says nothing when it runs from npm', () => {
    expect(staleCliWarning({ own: 3, board: '9', boardCheckout: false, slug: 'x', packaged: true })).toBeNull();
  });

  it('in the board’s own checkout, says nothing unless it’s older than the board, then says to pull', () => {
    expect(staleCliWarning({ own: 3, board: '3', boardCheckout: true })).toBeNull();
    expect(staleCliWarning({ own: 3, board: null, boardCheckout: true })).toBeNull();
    expect(staleCliWarning({ own: 3, board: 'nope', boardCheckout: true })).toBeNull();
    expect(staleCliWarning({ own: 2, board: '5', boardCheckout: true, slug: 'widgets' })).toMatch(
      /older than the board's \(5\).*pull the default branch/u,
    );
  });

  it('in another repository, an old copy says how to switch on every run', () => {
    const current = staleCliWarning({ own: 3, board: '3', boardCheckout: false, slug: 'breakaway' });
    expect(current).toContain("this checkout carries a copy of the board's CLI (version 3).");
    expect(current).toContain(`npx ${CLI_PACKAGE} <command> instead of node scripts/tasks.mjs`);
    expect(current).toContain(`npx ${CLI_PACKAGE} repos init breakaway --update`);
    expect(staleCliWarning({ own: 3, board: null, boardCheckout: false, slug: 'breakaway' })).toBe(current);
    expect(staleCliWarning({ own: 3, board: '3', boardCheckout: false, slug: null })).toContain(
      'repos init <slug> --update',
    );
  });

  it('adds that the copy is older than the board’s when it is', () => {
    expect(staleCliWarning({ own: 2, board: '5', boardCheckout: false, slug: 'breakaway' })).toContain(
      "(version 2, older than the board's (5), so a command may be missing or behave differently)",
    );
  });
});

describe('an idea (BRK-71)', () => {
  it('lands in the repository of the checkout it was written in, like add', () => {
    expect(ideaTask('Kickoff: set up a new project from the board.', { horizon: 'next', repo: 'widgets' })).toEqual({
      description: 'Kickoff: set up a new project from the board.',
      project: 'ideas',
      horizon: 'now',
      tags: ['agent', 'idea', 'horizon-next'],
      autostart: undefined,
      brief: 'Kickoff: set up a new project from the board.',
      repo: 'widgets',
    });
  });

  it('leaves the repository to the board outside a known checkout, and keeps its title to one short line', () => {
    const task = ideaTask(`\n${'a'.repeat(130)}\nmore`, { auto: true });
    expect(task).not.toHaveProperty('repo');
    expect(task.autostart).toBe('yes');
    expect(task.tags).toContain('horizon-auto');
    expect(task.description).toBe(`${'a'.repeat(117)}…`);
  });
});

describe('the GitHub view (BRK-72)', () => {
  it('asks for the repository of the checkout it runs in', () => {
    expect(githubRequest('widgets')).toEqual(['GET', 'github?repo=widgets', undefined]);
    expect(githubRequest('widgets', { sync: true })).toEqual(['POST', 'github/sync', { repo: 'widgets' }]);
  });

  it('leaves the repository to the board outside a known checkout', () => {
    expect(githubRequest(null)).toEqual(['GET', 'github', undefined]);
    expect(githubRequest(null, { sync: true })).toEqual(['POST', 'github/sync', undefined]);
  });
});

describe('the pull request page’s agent buttons (BRK-81)', () => {
  it('posts to the same paths as Fix with an agent and Safe to merge?, for the checkout’s repository', () => {
    expect(pullAgentRequest('fix', '12', { repo: 'widgets' })).toEqual({
      request: ['POST', 'github/pulls/12/fix', { repo: 'widgets' }],
    });
    expect(pullAgentRequest('review', '#7', { repo: 'widgets', note: 'check the lockfile' })).toEqual({
      request: ['POST', 'github/pulls/7/review', { repo: 'widgets', note: 'check the lockfile' }],
    });
  });

  it('sends the problem and note only when given', () => {
    expect(pullAgentRequest('fix', 3, { problem: 'conflicts', note: '  ' })).toEqual({
      request: ['POST', 'github/pulls/3/fix', { problem: 'conflicts' }],
    });
  });

  it('refuses a missing number, a bad problem, and a problem on review', () => {
    expect(pullAgentRequest('fix', undefined)).toEqual({
      error: 'say which pull request: npx breakaway github fix <number>',
    });
    expect(pullAgentRequest('fix', 'abc')).toHaveProperty('error');
    expect(pullAgentRequest('fix', '1', { problem: 'slow' })).toEqual({
      error: '--problem is conflicts, failing, review',
    });
    expect(pullAgentRequest('review', '1', { problem: 'failing' })).toEqual({ error: '--problem is for github fix' });
  });

  it('knows the subcommands, and plain github still takes none else', () => {
    expect(unknownSubcommand('github', 'fix')).toBeNull();
    expect(unknownSubcommand('github', 'review')).toBeNull();
    expect(unknownSubcommand('github', 'merge')).toMatch(/github has no "merge"; it has fix, review/u);
  });

  it('says which task and agent took it, or who already has it', () => {
    const task = { wid: 'BRK-5' };
    expect(pullAgentSummary('fix', 12, { task, run: { agent: 'claude-brk-5-fix', url: 'https://x/y' } })).toBe(
      'Started claude-brk-5-fix, fixing #12 on BRK-5: https://x/y',
    );
    expect(pullAgentSummary('review', 7, { task, run: { url: 'https://x/y' } })).toBe(
      'Started an agent testing #7 on BRK-5: https://x/y',
    );
    expect(pullAgentSummary('fix', 12, { task, run: null, already: 'claude-a has it' })).toBe(
      'BRK-5 already has it: claude-a has it.',
    );
  });
});

describe('agents new and Force start (BRK-107)', () => {
  it('posts the prompt to the general route, for the checkout’s repository unless --repo says another', () => {
    expect(generalAgentRequest('  Tidy the docs\nThe intro is stale. ', { repo: 'widgets', by: 'owner' })).toEqual({
      request: [
        'POST',
        'agents/general',
        { prompt: 'Tidy the docs\nThe intro is stale.', repo: 'widgets', by: 'owner' },
      ],
    });
    expect(generalAgentRequest('Fix it', { force: true })).toEqual({
      request: ['POST', 'agents/general', { prompt: 'Fix it', force: true }],
    });
  });

  it('refuses an empty prompt', () => {
    expect(generalAgentRequest('  ')).toHaveProperty('error');
    expect(generalAgentRequest(undefined)).toHaveProperty('error');
  });

  it('says who is asking only when forcing, so the board can refuse an agent’s name', () => {
    expect(forceFields(false, 'claude-a')).toEqual({});
    expect(forceFields(true, 'claude-a')).toEqual({ force: true, by: 'claude-a' });
    expect(forceFields(true, undefined)).toEqual({ force: true });
    expect(pullAgentRequest('review', '7', { repo: 'widgets', force: true })).toEqual({
      request: ['POST', 'github/pulls/7/review', { repo: 'widgets', force: true }],
    });
    expect(pullAgentRequest('fix', '7', { force: false, by: 'owner' })).toEqual({
      request: ['POST', 'github/pulls/7/fix', {}],
    });
  });

  it('knows agents new', () => {
    expect(unknownSubcommand('agents', 'new')).toBeNull();
  });

  it('says whether it started, or why it waits and how to force it', () => {
    const task = { short: 'a1b2c3d4' };
    expect(generalAgentSummary({ task, run: { agent: 'claude-a1b2c3d4', url: 'https://x/y' } })).toBe(
      'Started claude-a1b2c3d4 on a1b2c3d4: https://x/y',
    );
    expect(
      generalAgentSummary({ task, run: null, waiting: 'waiting for a free slot: 3 of 3 running', forceable: true }),
    ).toMatch(
      /^Saved a1b2c3d4, waiting to start: waiting for a free slot: 3 of 3 running\. .*agents start a1b2c3d4 --force$/u,
    );
    expect(generalAgentSummary({ task, run: null, waiting: 'the routine isn’t connected' })).not.toMatch(/--force/u);
  });
});
