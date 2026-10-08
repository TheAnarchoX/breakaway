import { describe, expect, it, vi } from 'vitest';
import {
  BRANCH,
  COUNTERSIGN_PHRASE,
  FILE,
  MARKER,
  SIGN_PHRASE,
  attachment,
  contributorsOf,
  evaluate,
  report,
  run,
  says,
  summary,
} from './cla.js';

const OWNER = 'acme-owner';
const ann = { login: 'acme-ann', id: 101 };
const bob = { login: 'acme-bob', id: 102 };
const COPY = 'https://github.com/user-attachments/files/123456/cla-signed.pdf';

let next = 1;
/** A made-up comment; `at` and `edited` are minutes past noon. */
const comment = (user, body, at, edited = at) => {
  const id = next++;
  const time = (m) => new Date(Date.UTC(2026, 9, 8, 12, m)).toISOString();
  return {
    id,
    html_url: `https://github.com/acme/widgets/pull/7#issuecomment-${id}`,
    body,
    created_at: time(at),
    updated_at: time(edited),
    user: { ...user, type: 'User' },
  };
};
const owner = { login: OWNER, id: 1 };

describe('phrases and attachments', () => {
  it('finds the phrase in a sentence, ignoring case, spacing, and the full stop', () => {
    expect(says(`Hi!\n\ni have read the breakaway  CLA and I sign it`, SIGN_PHRASE)).toBe(true);
    expect(says('I have read the breakaway CLA', SIGN_PHRASE)).toBe(false);
  });

  it('takes only a file or image uploaded to GitHub', () => {
    expect(attachment(`Signed: [cla-signed.pdf](${COPY})`)).toBe(COPY);
    expect(attachment('![copy](https://github.com/user-attachments/assets/1b2c-3d4e)')).toBe(
      'https://github.com/user-attachments/assets/1b2c-3d4e',
    );
    expect(attachment('https://example.com/user-attachments/files/1/cla.pdf')).toBe(null);
    expect(attachment('https://github.com/acme/widgets/blob/main/CLA.md')).toBe(null);
  });
});

describe('contributorsOf', () => {
  it('names the opener and linked authors and committers, less the exempt, and lists unlinked commits', () => {
    const commits = [
      { author: ann, committer: { login: 'web-flow', id: 9 }, commit: { author: { name: 'Ann' } } },
      { author: bob, committer: bob, commit: { author: { name: 'Bob' } } },
      { author: { login: 'dependabot[bot]', id: 5 }, committer: null, commit: { author: { name: 'dependabot' } } },
      { author: { login: OWNER, id: 1 }, committer: null, commit: { author: { name: 'Owner' } } },
      { author: null, committer: null, commit: { author: { name: 'Nobody Linked' } } },
    ];
    const { people, unlinked } = contributorsOf(commits, ann, [OWNER, 'dependabot[bot]']);
    expect(people).toEqual([ann, bob]);
    expect(unlinked).toEqual(['Nobody Linked']);
  });
});

describe('evaluate', () => {
  const base = { owner: OWNER, signed: [], pullRequest: 7 };

  it('waits for every step, and says which are missing', () => {
    const [r] = evaluate({ ...base, people: [ann], comments: [] });
    expect(r).toMatchObject({ state: 'missing', missing: ['copy', 'sign', 'countersign'] });
    const [s] = evaluate({ ...base, people: [ann], comments: [comment(ann, SIGN_PHRASE, 1)] });
    expect(s.missing).toEqual(['copy', 'countersign']);
    const [t] = evaluate({ ...base, people: [ann], comments: [comment(ann, `[copy](${COPY})`, 1)] });
    expect(t.missing).toEqual(['sign', 'countersign']);
  });

  it('records a signature once the copy, the sign phrase, and the owner countersign are there, in that order', () => {
    const copy = comment(ann, `Here's my copy: [cla-signed.pdf](${COPY})`, 1);
    const sign = comment(ann, SIGN_PHRASE, 2);
    const cs = comment(owner, COUNTERSIGN_PHRASE, 3);
    const [r] = evaluate({ ...base, people: [ann], comments: [cs, sign, copy] });
    expect(r.state).toBe('complete');
    expect(r.record).toEqual({
      login: 'acme-ann',
      id: 101,
      pullRequest: 7,
      signedCopy: COPY,
      signedCopyComment: copy.html_url,
      signComment: sign.html_url,
      countersignComment: cs.html_url,
      countersignedBy: OWNER,
      signedAt: sign.created_at,
      countersignedAt: cs.created_at,
    });
  });

  it('takes the copy and the phrase in one comment', () => {
    const both = comment(ann, `${SIGN_PHRASE}\n\n[cla-signed.pdf](${COPY})`, 1);
    const [r] = evaluate({ ...base, people: [ann], comments: [both, comment(owner, COUNTERSIGN_PHRASE, 2)] });
    expect(r.state).toBe('complete');
  });

  it("doesn't count a countersign from anyone but the owner, or one that came first", () => {
    const steps = [comment(ann, `[copy](${COPY})`, 2), comment(ann, SIGN_PHRASE, 3)];
    const early = comment(owner, COUNTERSIGN_PHRASE, 1);
    const stranger = comment({ login: 'acme-mallory', id: 666 }, `${COUNTERSIGN_PHRASE} (as ${OWNER})`, 4);
    const self = comment(ann, COUNTERSIGN_PHRASE, 5);
    const [r] = evaluate({ ...base, people: [ann], comments: [early, ...steps, stranger, self] });
    expect(r).toMatchObject({ state: 'missing', missing: ['countersign'] });
  });

  it('needs a new countersign when the copy was edited after it', () => {
    const copy = comment(ann, `[copy](${COPY})`, 1, 5);
    const comments = [copy, comment(ann, SIGN_PHRASE, 2), comment(owner, COUNTERSIGN_PHRASE, 3)];
    expect(evaluate({ ...base, people: [ann], comments })[0].state).toBe('missing');
    comments.push(comment(owner, COUNTERSIGN_PHRASE, 6));
    expect(evaluate({ ...base, people: [ann], comments })[0].state).toBe('complete');
  });

  it("doesn't take another person's copy or phrase", () => {
    const comments = [comment(bob, `[copy](${COPY})`, 1), comment(bob, SIGN_PHRASE, 2)];
    comments.push(comment(owner, COUNTERSIGN_PHRASE, 3));
    const [a, b] = evaluate({ ...base, people: [ann, bob], comments });
    expect(a).toMatchObject({ state: 'missing', missing: ['copy', 'sign', 'countersign'] });
    expect(b.state).toBe('complete');
  });

  it('counts a recorded signature only when it was countersigned', () => {
    const old = { login: 'acme-ann', id: 101, pullRequest: 3 };
    const recorded = { ...old, countersignComment: 'https://github.com/acme/widgets/pull/3#issuecomment-9' };
    // @ts-expect-error a signature from before the countersign has none of its fields
    expect(evaluate({ ...base, people: [ann], comments: [], signed: [old] })[0].state).toBe('missing');
    // @ts-expect-error the test only needs the fields the check reads
    expect(evaluate({ ...base, people: [ann], comments: [], signed: [recorded] })[0].state).toBe('signed');
  });
});

describe('summary and report', () => {
  it('says what each person is missing, in one line short enough for a check', () => {
    const results = evaluate({ owner: OWNER, signed: [], pullRequest: 7, people: [ann], comments: [] });
    const line = summary(results, []);
    expect(line).toBe("CLA missing: @acme-ann: upload a signed copy, comment the sign phrase, the owner's countersign");
    expect(line.length).toBeLessThanOrEqual(140);
    const many = Array.from({ length: 9 }, (_, i) => ({ login: `acme-person-${i}`, id: 200 + i }));
    expect(summary(evaluate({ owner: OWNER, signed: [], pullRequest: 7, people: many, comments: [] }), []).length).toBe(
      140,
    );
  });

  it('gives the three steps and where everyone is, and says when everyone has signed', () => {
    const results = evaluate({ owner: OWNER, signed: [], pullRequest: 7, people: [ann], comments: [] });
    const body = report(results, ['Nobody Linked'], 'https://github.com/acme/widgets/blob/main/CLA.md');
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toContain(SIGN_PHRASE);
    expect(body).toContain(COUNTERSIGN_PHRASE);
    expect(body).toContain('- @acme-ann: waiting for upload a signed copy');
    expect(body).toContain('A commit by Nobody Linked');
    expect(report([{ login: 'acme-ann', id: 101, state: 'signed', missing: [] }], [], '')).toBe(
      `${MARKER}\nEveryone who wrote a commit here has signed the CLA.`,
    );
  });
});

describe('run', () => {
  /** A fake GitHub client over made-up data; nothing reaches the network. */
  const fake = ({ comments, signatures = null, runs = [] }) => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 });
    const rest = {
      pulls: { listCommits: 'commits', get: vi.fn(async () => ({ data: pr })) },
      issues: { listComments: 'comments', createComment: vi.fn(), updateComment: vi.fn() },
      repos: {
        getContent: vi.fn(async () => {
          if (!signatures) throw notFound;
          const content = Buffer.from(JSON.stringify({ signatures })).toString('base64');
          return { data: { content, sha: 'file-sha' } };
        }),
        createOrUpdateFileContents: vi.fn(),
      },
      git: {
        getRef: vi.fn(async ({ ref }) => {
          if (ref === `heads/${BRANCH}` && !signatures) throw notFound;
          return { data: { object: { sha: 'main-sha' } } };
        }),
        createRef: vi.fn(),
      },
      actions: {
        listWorkflowRuns: vi.fn(async () => ({ data: { workflow_runs: runs } })),
        reRunWorkflow: vi.fn(),
      },
    };
    const paginate = vi.fn(async (what) =>
      what === 'commits' ? [{ author: ann, committer: ann, commit: { author: { name: 'Ann' } } }] : comments,
    );
    return { rest, paginate };
  };
  const pr = { number: 7, user: ann, head: { sha: 'head-sha' }, base: { repo: { default_branch: 'main' } } };
  const context = (eventName) => ({
    eventName,
    repo: { owner: 'acme', repo: 'widgets' },
    serverUrl: 'https://github.com',
    payload: { repository: { owner: { login: OWNER } }, pull_request: pr, issue: { number: 7 } },
  });
  const core = () => ({ info: vi.fn(), setFailed: vi.fn() });

  it('fails the pull request while a step is missing, and posts the steps', async () => {
    const github = fake({ comments: [comment(ann, SIGN_PHRASE, 1)] });
    const c = core();
    await run({ github, context: context('pull_request_target'), core: c });
    expect(c.setFailed).toHaveBeenCalledWith(expect.stringContaining('upload a signed copy'));
    expect(github.rest.issues.createComment.mock.calls[0][0].body).toContain(MARKER);
    expect(github.rest.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
  });

  it('records the signature on a new cla-signatures branch, and re-runs the failed check after a comment', async () => {
    const comments = [
      comment(ann, `${SIGN_PHRASE} [copy](${COPY})`, 1),
      comment(owner, COUNTERSIGN_PHRASE, 2),
      {
        ...comment({ login: 'github-actions[bot]', id: 41898282 }, `${MARKER}\nold`, 0),
        user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' },
      },
    ];
    const github = fake({ comments, runs: [{ id: 55, status: 'completed', conclusion: 'failure' }] });
    const c = core();
    await run({ github, context: context('issue_comment'), core: c });
    expect(github.rest.git.createRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: `refs/heads/${BRANCH}`, sha: 'main-sha' }),
    );
    const write = github.rest.repos.createOrUpdateFileContents.mock.calls[0][0];
    expect(write).toMatchObject({ branch: BRANCH, path: FILE, sha: undefined });
    const saved = JSON.parse(Buffer.from(write.content, 'base64').toString('utf8'));
    expect(saved.signatures).toHaveLength(1);
    expect(saved.signatures[0]).toMatchObject({ login: 'acme-ann', id: 101, pullRequest: 7, signedCopy: COPY });
    expect(github.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: `${MARKER}\nEveryone who wrote a commit here has signed the CLA.` }),
    );
    expect(github.rest.actions.reRunWorkflow).toHaveBeenCalledWith(expect.objectContaining({ run_id: 55 }));
    expect(c.setFailed).not.toHaveBeenCalled();
  });

  it('passes a contributor who signed before, and skips the owner and the bots', async () => {
    const recorded = { login: 'acme-ann', id: 101, countersignComment: 'https://github.com/acme/widgets/pull/3#c' };
    const github = fake({ comments: [], signatures: [recorded] });
    const c = core();
    await run({ github, context: context('pull_request_target'), core: c });
    expect(c.setFailed).not.toHaveBeenCalled();
    expect(github.rest.repos.createOrUpdateFileContents).not.toHaveBeenCalled();

    const own = fake({ comments: [] });
    const ctx = context('pull_request_target');
    ctx.payload.pull_request = { ...pr, user: { login: OWNER, id: 1 } };
    await run({ github: own, context: ctx, core: core() });
    expect(own.paginate).not.toHaveBeenCalled();
  });
});
