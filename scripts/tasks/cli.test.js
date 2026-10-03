import { describe, expect, it } from 'vitest';
import { CLI_PACKAGE } from './init.js';
import { githubRequest, ideaTask, NO_ARGUMENTS, SUBCOMMANDS, staleCliWarning, unknownSubcommand } from './cli.js';

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
