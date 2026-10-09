import { describe, expect, it } from 'vitest';
import { CLI_PACKAGE } from './init.js';
import {
  captainLines,
  captainRequest,
  chaseLines,
  chaseRequest,
  chaseSummary,
  featureBody,
  featureLines,
  featureListLines,
  progressLine,
  githubRequest,
  ideaTask,
  NO_ARGUMENTS,
  forceFields,
  generalAgentRequest,
  generalAgentSummary,
  packageReleaseRequest,
  pullAgentRequest,
  pullAgentSummary,
  reviewRequest,
  specLines,
  specListLines,
  specRequest,
  specsRequest,
  SUBCOMMANDS,
  staleCliWarning,
  releaseBehind,
  removedRepoByHand,
  routineMakerRequest,
  routineWrite,
  unknownSubcommand,
} from './cli.js';
import { TEXT_KINDS } from './peloton.js';

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

  it('knows every peloton command: each kind of post, plan, and listen (IDEA-36)', () => {
    for (const sub of [...TEXT_KINDS, 'reply', 'in', 'outcome', 'plan', 'listen'])
      expect(unknownSubcommand('peloton', sub)).toBeNull();
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

  it('in the board’s own checkout, says nothing unless the board’s release is ahead of it, then says to pull (BRK-148)', () => {
    expect(staleCliWarning({ own: 72, board: '72', boardCheckout: true, release: '1.4.0-main.9' })).toBeNull();
    expect(staleCliWarning({ own: 72, board: '72', boardCheckout: true, release: null, behind: true })).toBeNull();
    expect(
      staleCliWarning({ own: 72, board: '72', boardCheckout: true, release: '1.4.0-main.9', behind: true }),
    ).toMatch(/behind the board's release \(v1\.4\.0-main\.9\).*pull the default branch/u);
  });

  it('knows a checkout is behind a release only when it has the release’s tag and the tag isn’t in its history', () => {
    const git = (exits) => (args) => exits[args[0]];
    expect(releaseBehind('1.4.0-main.9', git({ 'rev-parse': 0, 'merge-base': 0 }))).toBe(false);
    expect(releaseBehind('1.4.0-main.9', git({ 'rev-parse': 0, 'merge-base': 1 }))).toBe(true);
    // No tag here (a shallow clone, or not fetched yet): it can't tell, so it says nothing.
    expect(releaseBehind('1.4.0-main.9', git({ 'rev-parse': 1, 'merge-base': 1 }))).toBe(false);
    // git itself failing isn't "behind" either.
    expect(releaseBehind('1.4.0', git({ 'rev-parse': 0, 'merge-base': 128 }))).toBe(false);
    expect(releaseBehind('not a version', git({ 'rev-parse': 0, 'merge-base': 1 }))).toBe(false);
    expect(releaseBehind(null, git({ 'rev-parse': 0, 'merge-base': 1 }))).toBe(false);
    // A shallow clone's cut history can hide an ancestor, so it says nothing there either.
    expect(releaseBehind('1.4.0-main.9', git({ 'rev-parse': 0, 'merge-base': 1 }), { shallow: true })).toBe(false);
    const seen = [];
    releaseBehind('1.4.0', (args) => {
      seen.push(args);
      return 0;
    });
    expect(seen).toEqual([
      ['rev-parse', '-q', '--verify', 'refs/tags/v1.4.0^{commit}'],
      ['merge-base', '--is-ancestor', 'refs/tags/v1.4.0', 'HEAD'],
    ]);
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

describe('Review with an agent (BRK-111)', () => {
  it('always says who asks for a review, so the board can refuse an agent’s name', () => {
    expect(pullAgentRequest('review', '8', { repo: 'widgets', by: 'claude-brk-1' })).toEqual({
      request: ['POST', 'github/pulls/8/review', { repo: 'widgets', by: 'claude-brk-1' }],
    });
    expect(pullAgentRequest('fix', '8', { repo: 'widgets', by: 'claude-brk-1' })).toEqual({
      request: ['POST', 'github/pulls/8/fix', { repo: 'widgets' }],
    });
  });

  it('says it started a review rather than a test on a pull request that isn’t Dependabot’s', () => {
    const task = { wid: 'BRK-5' };
    expect(
      pullAgentSummary('review', 8, {
        task,
        run: { agent: 'claude-brk-5-review', kind: 'pr-review', url: 'https://x/y' },
      }),
    ).toBe('Started claude-brk-5-review, reviewing #8 on BRK-5: https://x/y');
  });

  it('posts the verdict and note on the task, with the pull request when named', () => {
    expect(reviewRequest('BRK-5', 'ready', '  Matches the done when. ', { by: 'claude-brk-5-review' })).toEqual({
      request: [
        'POST',
        'tasks/BRK-5/review',
        { verdict: 'ready', note: 'Matches the done when.', by: 'claude-brk-5-review' },
      ],
    });
    expect(reviewRequest('BRK-5', 'changes', 'Missing tests.', { by: 'a', pr: '#12' })).toEqual({
      request: ['POST', 'tasks/BRK-5/review', { verdict: 'changes', note: 'Missing tests.', by: 'a', pr: 12 }],
    });
  });

  it('refuses a missing task, a verdict it doesn’t know, an empty note, and a bad --pr', () => {
    expect(reviewRequest(undefined, 'ready', 'x')).toHaveProperty('error');
    expect(reviewRequest('BRK-5', undefined, 'x')).toEqual({
      error: 'say the verdict: --verdict ready|follow-up|changes',
    });
    expect(reviewRequest('BRK-5', 'lgtm', 'x')).toEqual({
      error: 'say the verdict: --verdict ready|follow-up|changes',
    });
    expect(reviewRequest('BRK-5', 'ready', ' ')).toHaveProperty('error');
    expect(reviewRequest('BRK-5', 'ready', 'x', { pr: 'abc' })).toEqual({ error: '--pr is a pull request number' });
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

  it('agents new --decision sends the decision and the text as the owner’s note, with no repository of its own', () => {
    expect(generalAgentRequest('  Leave the web alone ', { decision: 'BRK-104', repo: null, by: 'owner' })).toEqual({
      request: ['POST', 'agents/general', { decision: 'BRK-104', note: 'Leave the web alone', by: 'owner' }],
    });
    expect(generalAgentRequest('', { decision: 'BRK-104', repo: 'widgets', force: true })).toEqual({
      request: ['POST', 'agents/general', { decision: 'BRK-104', repo: 'widgets', force: true }],
    });
  });

  it('says when an agent from the decision is already open, instead of starting another', () => {
    expect(generalAgentSummary({ task: { short: 'a1b2c3d4' }, run: null, already: 'claude-a1b2c3d4 is on it' })).toBe(
      'a1b2c3d4 already refines from these answers: claude-a1b2c3d4 is on it.',
    );
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

const progress = (over = {}) => ({
  total: 0,
  done: 0,
  running: 0,
  ready: 0,
  waiting: 0,
  needsYou: 0,
  inReview: 0,
  shipped: 0,
  ...over,
});

describe('features (BRK-85)', () => {
  it('sends only the fields given, with none or a v-prefixed release read as the board reads them', () => {
    expect(featureBody({})).toEqual({});
    expect(featureBody({ title: 'Self update', release: 'v1.3.0' })).toEqual({
      title: 'Self update',
      release: '1.3.0',
    });
    expect(featureBody({ release: 'none' })).toEqual({ release: '' });
    expect(featureBody({ brief: 'Why', state: 'shipped' })).toEqual({ brief: 'Why', state: 'shipped' });
  });

  it('knows its subcommands', () => {
    for (const sub of ['list', 'add', 'show', 'modify', 'pull']) expect(unknownSubcommand('features', sub)).toBeNull();
    expect(unknownSubcommand('features', 'delete')).toMatch(
      /^features has no "delete"; it has list, add, show, modify, pull/u,
    );
  });

  it('says progress in words, and nothing when there are no tasks', () => {
    expect(progressLine(progress())).toBe('no tasks yet');
    expect(progressLine(progress({ total: 3, done: 3 }))).toBe('3 of 3 done');
    expect(progressLine(progress({ total: 10, done: 4, running: 2, ready: 1, needsYou: 1, inReview: 2 }))).toBe(
      '4 of 10 done: 2 in review, 2 running, 1 ready, 1 waiting for you',
    );
  });

  it('lists features by release, then unplanned, suggestions, and other tasks', () => {
    const lines = featureListLines({
      features: [
        {
          slug: 'self-update',
          title: 'Self update',
          release: '1.3.0',
          progress: progress({ total: 2, done: 1, ready: 1 }),
          chase: { state: 'on', parallel: 3 },
          conflicts: [],
        },
        {
          slug: 'artifacts',
          title: 'Artifacts',
          release: null,
          plannedEnd: '2026-10-19',
          progress: progress(),
          conflicts: [{ wid: 'BRK-9' }],
        },
      ],
      suggestions: [{ slug: 'legacy-free', tasks: 3, open: 2, release: '1.2.0' }],
      releaseTasks: [{ release: '1.2.0', tasks: [{ wid: 'BRK-1' }, { wid: 'WEB-2' }] }],
    });
    expect(lines).toEqual([
      '1.3.0',
      '  self-update  Self update · 1 of 2 done: 1 ready · chasing, 3 at once in an area',
      '',
      'Unplanned',
      '  artifacts    Artifacts · no tasks yet · planned by 2026-10-19 · 1 task in two features',
      '',
      'Tags that could be features (npx breakaway features add <slug>):',
      '  legacy-free (2 open tasks, 1.2.0)',
      '',
      'Other tasks in 1.2.0: BRK-1, WEB-2',
    ]);
  });

  it('says how to make the first feature on an empty board', () => {
    expect(featureListLines({ features: [] })[0]).toMatch(/^No features yet\. Make one: npx breakaway features add/u);
  });

  it('shows a feature with its tasks in order, and without tasks says how to add them', () => {
    const base = {
      slug: 'self-update',
      title: 'Self update',
      brief: 'Update from the board.',
      release: '1.3.0',
      state: 'open',
      shipped: false,
      progress: progress({ total: 2, done: 1, needsYou: 1 }),
      needsYou: [{ wid: 'BRK-50', why: 'it waits on your decision' }],
      conflicts: [],
    };
    const text = featureLines({
      ...base,
      tasks: [
        { wid: 'BRK-49', state: 'done', description: 'The record', why: null },
        { wid: 'BRK-50', state: 'needs-you', description: 'Pick a channel', why: 'it waits on your decision' },
      ],
    }).join('\n');
    expect(text).toContain('  Release     1.3.0');
    expect(text).toContain('  Planned     no dates yet');
    expect(text).toContain('  Needs you   BRK-50 it waits on your decision');
    expect(text).toContain('    BRK-50    needs-you Pick a channel (it waits on your decision)');
    expect(text).toContain('  Update from the board.');
    const planned = (plan) => featureLines({ ...base, ...plan, tasks: [] }).find((l) => l.includes('Planned'));
    expect(planned({ plannedStart: '2026-10-12', plannedEnd: '2026-10-19' })).toBe(
      '  Planned     2026-10-12 to 2026-10-19',
    );
    expect(planned({ plannedStart: null, plannedEnd: '2026-10-19' })).toBe('  Planned     by 2026-10-19');
    expect(planned({ plannedStart: '2026-10-12', plannedEnd: null })).toBe('  Planned     from 2026-10-12');
    expect(featureLines({ ...base, release: null, tasks: [] }).join('\n')).toMatch(
      /Release {5}unplanned[\s\S]*No tasks yet: tag them with self-update/u,
    );
  });
});

describe('chase (BRK-85)', () => {
  it('starts, stops, sets parallel, and dry-runs, always saying who asks', () => {
    expect(chaseRequest('Self-Update', undefined, { by: 'claude-x' })).toEqual({
      request: ['POST', 'features/self-update/chase', { on: true, by: 'claude-x' }],
    });
    expect(chaseRequest('self-update', 'stop')).toEqual({
      request: ['POST', 'features/self-update/chase', { on: false }],
    });
    expect(chaseRequest('self-update', undefined, { parallel: '2', dryRun: true })).toEqual({
      request: ['POST', 'features/self-update/chase', { on: true, parallel: 2, dryRun: true }],
    });
  });

  it('refuses what can’t be right before asking the board', () => {
    expect(chaseRequest(undefined, undefined).error).toMatch(/^say which feature/u);
    expect(chaseRequest('x', 'pause').error).toMatch(/chase has no "pause"/u);
    for (const n of ['0', '-1', '1.5', 'three'])
      expect(chaseRequest('x', undefined, { parallel: n }).error).toMatch(/^--parallel is how many/u);
    expect(chaseRequest('x', 'stop', { parallel: 2 }).error).toMatch(/^--parallel is for a chase that runs/u);
  });

  it('sets the review cap, from 1 to 50, on a chase that runs (BRK-276)', () => {
    expect(chaseRequest('x', undefined, { reviewCap: '2' })).toEqual({
      request: ['POST', 'features/x/chase', { on: true, reviewCap: 2 }],
    });
    for (const n of ['0', '51', '1.5', 'five'])
      expect(chaseRequest('x', undefined, { reviewCap: n }).error).toMatch(/^--review-cap is how many/u);
    expect(chaseRequest('x', 'stop', { reviewCap: 2 }).error).toMatch(/^--review-cap is for a chase that runs/u);
  });

  it('prints the review cap, and says when the chase is at it (BRK-276)', () => {
    expect(chaseLines({ state: 'off', parallel: 3, reviewCap: 5 }, 'x')).toContain(
      '  Review cap  up to 5 pull requests waiting for you',
    );
    expect(
      chaseLines(
        { state: 'on', parallel: 3, reviewCap: 2, review: { waiting: 2, cap: 2, full: true, pulls: [41, 42] } },
        'x',
      ),
    ).toContain('  Review cap  2 of 2 pull requests wait for you: it starts nothing new but fixes');
  });

  it('asks for a road captain, or none, and its watch (BRK-275)', () => {
    expect(chaseRequest('x', undefined, { captain: true, watch: '6' })).toEqual({
      request: ['POST', 'features/x/chase', { on: true, captain: true, captainHours: 6 }],
    });
    expect(chaseRequest('x', undefined, { captain: false }).request[2]).toEqual({ on: true, captain: false });
    for (const n of ['0', '73', '1.5', 'long'])
      expect(chaseRequest('x', undefined, { watch: n }).error).toMatch(/^--watch is a road captain’s watch/u);
    expect(chaseRequest('x', 'stop', { captain: true }).error).toMatch(/for a chase that runs/u);
  });

  const chase = {
    state: 'on',
    on: true,
    startedAt: '2026-10-04T10:00:00.000Z',
    parallel: 3,
    summary: '1 running, 2 ready, 1 waiting for you',
    needsYou: [{ wid: 'BRK-50', why: 'its pull request #12 is open: merging is yours', kind: 'merge' }],
    stuck: [{ wid: 'WEB-3', why: 'it was refused 2 times', last: 'The build\nneeds a key' }],
    queue: [
      { wid: 'BRK-51', ready: true, reason: 'starting now' },
      {
        wid: 'CLI-4',
        ready: false,
        reason: '3 agents are already working in cli, the most this chase allows',
        blocks: ['BRK-52'],
      },
    ],
  };

  it('prints the chase: its line, what needs you, what’s stuck, and who starts next with why the rest waits', () => {
    expect(chaseLines(chase)).toEqual([
      '  Chase       On since 2026-10-04 10:00 UTC, 3 agents at once in an area',
      '              1 running, 2 ready, 1 waiting for you',
      '  Needs you   BRK-50 its pull request #12 is open: merging is yours',
      '  Stuck       WEB-3 it was refused 2 times; last: The build needs a key',
      '  Next',
      '    BRK-51    ready to start',
      '    CLI-4     3 agents are already working in cli, the most this chase allows (in the chase because it blocks BRK-52)',
    ]);
    expect(chaseLines(undefined)).toEqual([]);
  });

  it('says what it started, would start, or stopped', () => {
    expect(chaseSummary('self-update', { dryRun: false, chase, started: ['BRK-51'] })).toMatch(
      /^Chasing self-update: started BRK-51\.\n\n {2}Chase {7}On since/u,
    );
    expect(chaseSummary('self-update', { dryRun: false, chase, started: [] })).toMatch(
      /^Chasing self-update: the board starts BRK-51 on its next check\./u,
    );
    expect(chaseSummary('self-update', { dryRun: false, chase: { ...chase, queue: [] } })).toMatch(
      /^Chasing self-update: nothing can start right now/u,
    );
    expect(chaseSummary('self-update', { dryRun: true, chase, wouldStart: [] }, { parallel: 1 })).toMatch(
      /^A chase of self-update with 1 agent at once in an area would start nothing now\./u,
    );
    expect(chaseSummary('self-update', { dryRun: true, chase, wouldStart: ['BRK-51'] })).toMatch(
      /^A chase of self-update would start BRK-51 now\. Nothing was started\./u,
    );
    expect(
      chaseSummary('self-update', { dryRun: false, chase: { ...chase, state: 'stopped' } }, { stop: true }),
    ).toMatch(/^Stopped the chase of self-update\. Running agents finish/u);
  });
});

describe('github release, a package’s stable for the owner (BRK-103)', () => {
  it('posts the pre-release and who asks, for the checkout’s repository', () => {
    expect(packageReleaseRequest('1.4.0-main.5', { repo: 'widgets' })).toEqual({
      request: ['POST', 'github/release', { version: '1.4.0-main.5', repo: 'widgets' }],
    });
    expect(packageReleaseRequest(' @acme/widgets@2.0.0-main.1 ', { by: 'claude-x-1' })).toEqual({
      request: ['POST', 'github/release', { version: '@acme/widgets@2.0.0-main.1', by: 'claude-x-1' }],
    });
  });

  it('refuses anything but a pre-release', () => {
    for (const bad of [undefined, '1.4.0', 'latest', '1.4.0-beta.1'])
      expect(packageReleaseRequest(bad).error).toMatch(/say which pre-release/u);
  });

  it('sends --next, and refuses anything but patch, minor, or major (WEB-39)', () => {
    expect(packageReleaseRequest('1.4.0-main.5', { repo: 'widgets', next: 'minor' })).toEqual({
      request: ['POST', 'github/release', { version: '1.4.0-main.5', next: 'minor', repo: 'widgets' }],
    });
    expect(packageReleaseRequest('1.4.0-main.5', { next: 'huge' }).error).toMatch(/--next is patch, minor, or major/u);
  });
});

describe('specs (BRK-121)', () => {
  it('reads the checkout’s repository unless --repo names another, and a spec by its path', () => {
    expect(specsRequest('widgets')).toEqual(['GET', 'specs?repo=widgets', undefined]);
    expect(specsRequest(null)).toEqual(['GET', 'specs', undefined]);
    expect(specRequest('docs/specs/ACME-3-a b.md', 'widgets')).toEqual({
      request: ['GET', 'specs/docs/specs/ACME-3-a%20b.md?repo=widgets', undefined],
    });
    expect(specRequest('./docs//specs/ACME-3.md', null)).toEqual({
      request: ['GET', 'specs/docs/specs/ACME-3.md', undefined],
    });
  });

  it('refuses a missing path, and one that climbs out', () => {
    expect(specRequest(undefined, 'widgets')).toHaveProperty('error');
    expect(specRequest('  ', 'widgets')).toHaveProperty('error');
    expect(specRequest('docs/specs/../secret.md', 'widgets')).toHaveProperty('error');
  });

  it('knows its subcommands', () => {
    expect(unknownSubcommand('specs', 'list')).toBeNull();
    expect(unknownSubcommand('specs', 'show')).toBeNull();
    expect(unknownSubcommand('specs', 'edit')).toMatch(/^specs has no "edit"; it has list, show/u);
  });

  const task = (wid, status, description = 'Do it') => ({ uuid: `${wid}-uuid`, wid, status, description });

  it('lists the specs newest first, each with its status and how many of its tasks are open', () => {
    const lines = specListLines({
      slug: 'widgets',
      dir: 'docs/specs',
      missing: false,
      readme: { path: 'docs/specs/README.md' },
      specs: [
        {
          path: 'docs/specs/ACME-7-sort.md',
          wid: 'ACME-7',
          title: 'ACME-7 · Sort the inbox',
          status: 'draft',
          tasks: [task('ACME-8', 'pending'), task('ACME-9', 'completed'), task('ACME-10', 'pending')],
        },
        { path: 'docs/specs/notes.md', wid: null, title: 'Notes', status: null, tasks: [] },
        {
          path: 'docs/specs/ACME-2-big.md',
          wid: 'ACME-2',
          title: 'ACME-2-big',
          status: null,
          tasks: [],
          tooLarge: true,
        },
      ],
    });
    expect(lines[0]).toBe('widgets: 3 specs in docs/specs (its introduction is docs/specs/README.md)');
    expect(lines).toContain('  ACME-7    draft      ACME-7 · Sort the inbox  (3 tasks, 2 open)');
    expect(lines).toContain('            -          Notes  (no tasks)');
    expect(lines.find((l) => l.includes('ACME-2-big'))).toMatch(/over 1 MB: read it on GitHub/u);
    expect(lines.at(-1)).toBe('Read one: npx breakaway specs show <path>, like docs/specs/ACME-7-sort.md');
  });

  it('says where specs go when there are none, or no directory', () => {
    expect(specListLines({ slug: 'widgets', dir: 'docs/specs', missing: true, specs: [] }).join('\n')).toMatch(
      /^No specs in docs\/specs yet: widgets has no docs\/specs on its default branch\.\n.*repos modify widgets --specs <dir>/su,
    );
    expect(specListLines({ slug: 'widgets', dir: 'specs', missing: false, specs: [] })[0]).toMatch(
      /^No specs in specs yet\./u,
    );
  });

  it('shows a spec: its header, last change, Markdown, and the tasks that link it', () => {
    const out = specLines({
      slug: 'widgets',
      path: 'docs/specs/ACME-7-sort.md',
      title: 'ACME-7 · Sort the inbox',
      status: 'draft',
      url: 'https://github.com/acme/widgets/blob/main/docs/specs/ACME-7-sort.md',
      commit: { sha: 'abcdef1234567', date: '2026-01-02T03:04:05Z', message: 'ACME-7: Sort it' },
      text: '# ACME-7 · Sort the inbox\n\nStatus: draft\n',
      tasks: [task('ACME-8', 'pending', 'Sort by age'), task('ACME-9', 'completed', 'Sort by name')],
    }).join('\n');
    expect(out).toContain('ACME-7 · Sort the inbox (docs/specs/ACME-7-sort.md)');
    expect(out).toContain('  Status      draft');
    expect(out).toContain('  Changed     2026-01-02 03:04 in abcdef1: ACME-7: Sort it');
    expect(out).toContain('  GitHub      https://github.com/acme/widgets/blob/main/docs/specs/ACME-7-sort.md');
    expect(out).toContain('# ACME-7 · Sort the inbox\n\nStatus: draft');
    expect(out).toContain(
      '  Tasks (2, 1 open)\n    ACME-8    pending   Sort by age\n    ACME-9    completed Sort by name',
    );
    expect(out).toMatch(
      /Refine it: npx breakaway agents new --spec docs\/specs\/ACME-7-sort\.md "<what should change>"$/u,
    );
  });

  it('links a spec over 1 MB instead of printing it, and says when no task links it', () => {
    const out = specLines({
      path: 'docs/specs/ACME-2-big.md',
      title: 'ACME-2-big',
      status: null,
      url: 'https://github.com/acme/widgets/blob/main/docs/specs/ACME-2-big.md',
      commit: null,
      text: null,
      tooLarge: true,
      tasks: [],
    }).join('\n');
    expect(out).toContain('Over 1 MB, too large to show here: read it on GitHub.');
    expect(out).toContain('No task links it yet');
    expect(out).not.toContain('Changed');
  });
});

describe('agents new --spec (BRK-121)', () => {
  it('sends the spec and the text as the owner’s note, for the checkout’s repository', () => {
    expect(
      generalAgentRequest('  Drop the web form ', { spec: 'docs/specs/ACME-7-sort.md', repo: 'widgets', by: 'owner' }),
    ).toEqual({
      request: [
        'POST',
        'agents/general',
        { spec: 'docs/specs/ACME-7-sort.md', note: 'Drop the web form', repo: 'widgets', by: 'owner' },
      ],
    });
    expect(generalAgentRequest('x', { spec: 'docs/specs/a.md', force: true })).toEqual({
      request: ['POST', 'agents/general', { spec: 'docs/specs/a.md', note: 'x', force: true }],
    });
  });

  it('needs what should change, and only one of --spec, --decision, and --next', () => {
    expect(generalAgentRequest('  ', { spec: 'docs/specs/a.md' })).toEqual({
      error: 'say what should change in the spec: npx breakaway agents new --spec <path> "<what should change>"',
    });
    expect(generalAgentRequest('x', { spec: 'docs/specs/a.md', decision: 'BRK-1' })).toHaveProperty('error');
    expect(generalAgentRequest('x', { spec: 'docs/specs/a.md', next: 'minor' })).toHaveProperty('error');
    expect(generalAgentRequest('x', { decision: 'BRK-1', next: 'minor' })).toHaveProperty('error');
  });

  it('says when an agent is already on the spec, instead of starting another', () => {
    expect(
      generalAgentSummary(
        { task: { short: 'a1b2c3d4' }, run: null, already: 'claude-a1b2c3d4 is on it' },
        { spec: true },
      ),
    ).toBe('a1b2c3d4 already refines this spec: claude-a1b2c3d4 is on it.');
  });
});

describe('repos remove', () => {
  it('ends with deleting the routine on claude.ai and, after a rehearsal, the repository on GitHub', () => {
    const steps = removedRepoByHand('acme/widgets');
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatch(
      /^Delete its routine on claude\.ai, with its API trigger: open claude\.ai\/code\/routines/u,
    );
    expect(steps[0]).toContain('acme/widgets');
    expect(steps[1]).toContain('gh repo delete acme/widgets');
    expect(steps[1]).toMatch(/rehearsal/u);
  });
});

describe('routines new, and who writes a routine (CLI-19)', () => {
  it('posts the owner’s words to the routine maker’s route, in the checkout’s repository unless --repo says another', () => {
    expect(routineMakerRequest('  Every Monday, update the changelog ', { repo: 'widgets' })).toEqual({
      request: ['POST', 'routines/agent', { prompt: 'Every Monday, update the changelog', repo: 'widgets' }],
    });
    expect(routineMakerRequest('Watch the builds', { force: true, by: 'owner' })).toEqual({
      request: ['POST', 'routines/agent', { prompt: 'Watch the builds', force: true, by: 'owner' }],
    });
  });

  it('says who asks, so the board refuses an agent’s name', () => {
    expect(routineMakerRequest('Watch the builds', { by: 'claude-a' }).request?.[2]).toHaveProperty('by', 'claude-a');
  });

  it('refuses an empty prompt', () => {
    expect(routineMakerRequest('  ')).toHaveProperty('error');
    expect(routineMakerRequest(undefined)).toHaveProperty('error');
  });

  it('signs every routines write with the agent’s name, and sends none without one', () => {
    expect(routineWrite({ slug: 'changelog', name: 'Changelog' }, 'claude-1a2b3c4d')).toEqual({
      slug: 'changelog',
      name: 'Changelog',
      by: 'claude-1a2b3c4d',
    });
    expect(routineWrite({}, 'claude-1a2b3c4d')).toEqual({ by: 'claude-1a2b3c4d' });
    expect(routineWrite({ paused: true }, undefined)).toEqual({ paused: true });
  });

  it('knows new and cap as routines subcommands', () => {
    expect(unknownSubcommand('routines', 'new')).toBeNull();
    expect(unknownSubcommand('routines', 'cap')).toBeNull();
  });
});

describe('captain (BRK-275)', () => {
  it('reads the captain, and writes its log as the agent that runs it', () => {
    expect(captainRequest('Crew', undefined)).toEqual({ request: ['GET', 'features/crew'] });
    expect(captainRequest('crew', 'log', { text: 'Where it stands', by: 'claude-captain-crew-1' })).toEqual({
      request: [
        'POST',
        'features/crew/captain',
        { log: 'Where it stands', handover: false, by: 'claude-captain-crew-1' },
      ],
    });
    expect(
      captainRequest('crew', 'log', { text: 'Done', handover: true, by: 'claude-captain-crew-1' }).request[2],
    ).toMatchObject({
      handover: true,
    });
  });

  it('refuses what can’t be right before asking the board', () => {
    expect(captainRequest(undefined, undefined).error).toMatch(/^say which feature/u);
    expect(captainRequest('crew', 'steer').error).toMatch(/captain has no "steer"/u);
    expect(captainRequest('crew', undefined, { handover: true }).error).toMatch(/go with log/u);
    expect(captainRequest('crew', 'log', { by: 'claude-a' }).error).toMatch(/--file <path>/u);
    expect(captainRequest('crew', 'log', { text: '  ', by: 'claude-a' }).error).toMatch(/the log is empty/u);
    expect(captainRequest('crew', 'log', { text: 'Log' }).error).toMatch(/say who you are/u);
  });

  it('prints who holds it, when its watch ends, and the log', () => {
    const captain = {
      on: true,
      hours: 12,
      agent: 'claude-captain-crew-2',
      since: '2026-10-09T08:00:00.000Z',
      watchEndsAt: '2026-10-09T20:00:00.000Z',
      askedAt: null,
      log: [
        {
          at: '2026-10-09T07:59:00.000Z',
          agent: 'claude-captain-crew-1',
          text: 'OPS-1 next.\nThen OPS-2.',
          handover: true,
        },
      ],
    };
    expect(captainLines(captain)).toEqual([
      '  Captain     claude-captain-crew-2, since 2026-10-09 08:00 UTC; its watch ends 2026-10-09 20:00 UTC',
      '  Log         2026-10-09 07:59 claude-captain-crew-1 (handed over): OPS-1 next. Then OPS-2.',
    ]);
    expect(captainLines({ on: true, hours: 12, agent: null, log: [] })).toEqual([
      '  Captain     on: the board starts one on its next check (12-hour watches)',
    ]);
    expect(captainLines({ on: false, log: [] })).toEqual(['  Captain     off']);
    expect(chaseLines({ ...captain, state: 'on', parallel: 3, startedAt: captain.since, captain }, 'crew')).toContain(
      '  Captain     claude-captain-crew-2, since 2026-10-09 08:00 UTC; its watch ends 2026-10-09 20:00 UTC',
    );
  });
});
