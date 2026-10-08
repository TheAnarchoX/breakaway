// BRK-306: the CLA check. A contributor's signature counts only once three things are on the pull request: a signed
// copy of CLA.md they uploaded in a comment, a comment of theirs with the sign phrase, and, after both, the owner's
// countersign comment. Only then is it recorded on the cla-signatures branch. .github/workflows/cla.yml runs `run`
// from the default branch with actions/github-script; it never checks out or runs the pull request's code, and reads
// comments only as text.

export const SIGN_PHRASE = 'I have read the breakaway CLA and I sign it.';
export const COUNTERSIGN_PHRASE = 'I countersign the breakaway CLA.';
export const BRANCH = 'cla-signatures';
export const FILE = 'signatures/signed.json';
export const MARKER = '<!-- breakaway-cla -->';
export const WORKFLOW = 'cla.yml';

// Exempt by login: their commits in an outside pull request need no signature. The owner is added at run time.
export const EXEMPT = ['dependabot[bot]', 'github-actions[bot]', 'breakaway-integration[bot]'];

/**
 * @typedef {{ id: number, html_url: string, body: string, created_at: string, updated_at: string,
 *   user: { login: string, id: number, type?: string } | null }} Comment
 * @typedef {{ login: string, id: number }} Person
 * @typedef {{ login: string, id: number, pullRequest: number, signedCopy: string, signedCopyComment: string,
 *   signComment: string, countersignComment: string, countersignedBy: string, signedAt: string,
 *   countersignedAt: string, recordedAt?: string }} Signature
 * @typedef {'copy' | 'sign' | 'countersign'} Step
 * @typedef {{ login: string, id: number, state: 'signed' | 'complete' | 'missing', missing: Step[],
 *   record?: Signature }} Result
 */

// A file or image uploaded to a comment on GitHub (it's only read as a link: the check never opens it).
const ATTACHMENT = /https:\/\/github\.com\/user-attachments\/(?:files|assets)\/[\w./%-]+/i;

/** @param {string} text */
const plain = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!]+$/, '')
    .trim();

/**
 * Whether a comment says the phrase, on a line of its own or in a sentence, ignoring case, spacing, and the full stop.
 * @param {string} body
 * @param {string} phrase
 */
export function says(body, phrase) {
  return plain(body).includes(plain(phrase));
}

/**
 * The first uploaded file a comment links to, or null.
 * @param {string} body
 */
export function attachment(body) {
  const found = String(body ?? '').match(ATTACHMENT);
  return found ? found[0].replace(/[).,]+$/, '') : null;
}

/**
 * Who has to sign: the pull request's author and everyone GitHub links a commit's author or committer to, less the
 * exempt logins. A commit whose email isn't linked to a GitHub account can't be signed for; it's named in `unlinked`.
 * @param {{ author: Person | null, committer: Person | null, commit: { author: { name: string, email?: string } } }[]} commits
 * @param {Person} opener
 * @param {string[]} exempt
 */
export function contributorsOf(commits, opener, exempt) {
  const skip = new Set(exempt.map((login) => login.toLowerCase()));
  /** @type {Map<number, Person>} */
  const people = new Map();
  /** @type {Set<string>} */
  const unlinked = new Set();
  const add = (/** @type {Person} */ person) => {
    if (!skip.has(person.login.toLowerCase()) && !people.has(person.id))
      people.set(person.id, { login: person.login, id: person.id });
  };
  if (opener) add(opener);
  for (const commit of commits) {
    if (commit.author) add(commit.author);
    else unlinked.add(commit.commit.author.name);
    // web-flow commits a merge or an edit made on github.com for the person who made it.
    if (commit.committer && commit.committer.login !== 'web-flow') add(commit.committer);
  }
  return { people: [...people.values()], unlinked: [...unlinked] };
}

/**
 * Where each contributor is: already signed (on the branch), complete on this pull request (ready to record), or
 * missing steps. The owner's countersign counts for a contributor only when it comes after their signed copy and their
 * sign comment, each as last edited, so the owner saw what they countersigned.
 * @param {{ people: Person[], comments: Comment[], owner: string, signed: Signature[], pullRequest: number }} input
 * @returns {Result[]}
 */
export function evaluate({ people, comments, owner, signed, pullRequest }) {
  const signedIds = new Set(signed.filter((s) => s.countersignComment).map((s) => s.id));
  const byTime = [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const countersigns = byTime.filter(
    (c) => c.user && c.user.login.toLowerCase() === owner.toLowerCase() && says(c.body, COUNTERSIGN_PHRASE),
  );
  return people.map((person) => {
    if (signedIds.has(person.id)) return { login: person.login, id: person.id, state: 'signed', missing: [] };
    const theirs = byTime.filter((c) => c.user && c.user.id === person.id);
    const copies = theirs.filter((c) => attachment(c.body));
    const signs = theirs.filter((c) => says(c.body, SIGN_PHRASE));
    /** @type {Step[]} */
    const missing = [];
    if (!copies.length) missing.push('copy');
    if (!signs.length) missing.push('sign');
    if (missing.length)
      return { login: person.login, id: person.id, state: 'missing', missing: [...missing, 'countersign'] };
    for (const countersign of countersigns) {
      const copy = copies.find((c) => c.updated_at <= countersign.created_at);
      const sign = signs.find((c) => c.updated_at <= countersign.created_at);
      if (!copy || !sign) continue;
      return {
        login: person.login,
        id: person.id,
        state: 'complete',
        missing: [],
        record: {
          login: person.login,
          id: person.id,
          pullRequest,
          signedCopy: attachment(copy.body),
          signedCopyComment: copy.html_url,
          signComment: sign.html_url,
          countersignComment: countersign.html_url,
          countersignedBy: countersign.user.login,
          signedAt: sign.created_at,
          countersignedAt: countersign.created_at,
        },
      };
    }
    return { login: person.login, id: person.id, state: 'missing', missing: ['countersign'] };
  });
}

const STEP_WORDS = {
  copy: 'upload a signed copy',
  sign: 'comment the sign phrase',
  countersign: "the owner's countersign",
};

/**
 * The check's one line (a commit status or a failed job allows about 140 characters).
 * @param {Result[]} results
 * @param {string[]} unlinked
 */
export function summary(results, unlinked) {
  const waiting = results.filter((r) => r.state === 'missing');
  if (!waiting.length && !unlinked.length) return 'Everyone who wrote a commit here has signed the CLA.';
  const parts = waiting.map((r) => `@${r.login}: ${r.missing.map((step) => STEP_WORDS[step]).join(', ')}`);
  if (unlinked.length) parts.push(`${unlinked.length} commit author(s) not linked to a GitHub account`);
  const line = `CLA missing: ${parts.join('; ')}`;
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

/**
 * The comment the check keeps up to date on the pull request.
 * @param {Result[]} results
 * @param {string[]} unlinked
 * @param {string} claUrl
 */
export function report(results, unlinked, claUrl) {
  const lines = [MARKER];
  if (results.every((r) => r.state !== 'missing') && !unlinked.length) {
    lines.push('Everyone who wrote a commit here has signed the CLA.');
    return lines.join('\n');
  }
  lines.push(
    `Thanks for the pull request. Before the owner can look at it, each person who wrote a commit in it signs breakaway's [contributor licence agreement](${claUrl}), once, in three steps on this pull request:`,
    '',
    `1. **Upload a signed copy.** Fill in the signature section at the end of [CLA.md](${claUrl}), sign it, and attach the copy (a PDF or a photo) to a comment here. The copy is as public as this pull request.`,
    `2. **Sign it in a comment**, in the same comment or another one, with exactly: \`${SIGN_PHRASE}\``,
    `3. **The owner countersigns** after checking your copy, with: \`${COUNTERSIGN_PHRASE}\``,
    '',
    'Where everyone is:',
    '',
  );
  for (const r of results) {
    if (r.state === 'missing')
      lines.push(`- @${r.login}: waiting for ${r.missing.map((s) => STEP_WORDS[s]).join(', ')}`);
    else lines.push(`- @${r.login}: signed`);
  }
  for (const name of unlinked)
    lines.push(
      `- A commit by ${name} isn't linked to a GitHub account, so it can't be signed for. Add its email to the account that wrote it, then comment \`recheck\`.`,
    );
  lines.push('', 'Comment `recheck` to check again.');
  return lines.join('\n');
}

/**
 * The run: read the pull request, its commits and comments, and the signatures; record new signatures; keep the
 * report comment up to date; and fail the pull request's check while anyone is missing a step. On a comment, it re-runs
 * the pull request's last CLA run so its check shows the new state.
 * @param {{ github: any, context: any, core: any }} actions
 */
export async function run({ github, context, core }) {
  const { owner, repo } = context.repo;
  const ownerLogin = context.payload.repository.owner.login;
  const pr =
    context.eventName === 'pull_request_target'
      ? context.payload.pull_request
      : (await github.rest.pulls.get({ owner, repo, pull_number: context.payload.issue.number })).data;
  const exempt = [ownerLogin, ...EXEMPT];
  if (exempt.some((login) => login.toLowerCase() === pr.user.login.toLowerCase())) return;

  const commits = await github.paginate(github.rest.pulls.listCommits, {
    owner,
    repo,
    pull_number: pr.number,
    per_page: 100,
  });
  const { people, unlinked } = contributorsOf(commits, pr.user, exempt);
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pr.number,
    per_page: 100,
  });

  let results = [];
  for (let attempt = 0; ; attempt++) {
    const { signatures, sha } = await readSignatures(github, owner, repo);
    results = evaluate({ people, comments, owner: ownerLogin, signed: signatures, pullRequest: pr.number });
    const fresh = results.filter((r) => r.state === 'complete').map((r) => r.record);
    if (!fresh.length) break;
    const recordedAt = new Date().toISOString();
    const next = [...signatures, ...fresh.map((r) => ({ ...r, recordedAt }))];
    try {
      await ensureBranch(github, owner, repo, pr.base.repo.default_branch);
      await github.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        branch: BRANCH,
        path: FILE,
        sha,
        message: `CLA: ${fresh.map((r) => r.login).join(', ')} signed on #${pr.number}`,
        content: Buffer.from(`${JSON.stringify({ signatures: next }, null, 2)}\n`).toString('base64'),
      });
      break;
    } catch (error) {
      // Another pull request recorded a signature first: read the file again and retry.
      if (attempt < 2 && (error.status === 409 || error.status === 422)) continue;
      throw error;
    }
  }

  const claUrl = `${context.serverUrl}/${owner}/${repo}/blob/${pr.base.repo.default_branch}/CLA.md`;
  const body = report(results, unlinked, claUrl);
  const mine = comments.find((c) => c.user?.type === 'Bot' && c.body?.startsWith(MARKER));
  if (!mine) await github.rest.issues.createComment({ owner, repo, issue_number: pr.number, body });
  else if (mine.body !== body) await github.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body });

  const ok = results.every((r) => r.state !== 'missing') && !unlinked.length;
  const line = summary(results, unlinked);
  core.info(line);
  if (context.eventName === 'pull_request_target') {
    if (!ok) core.setFailed(line);
    return;
  }
  // A comment's run isn't on the pull request: re-run the pull request's last CLA run when its result is out of date.
  const runs = await github.rest.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: WORKFLOW,
    event: 'pull_request_target',
    head_sha: pr.head.sha,
    per_page: 1,
  });
  const last = runs.data.workflow_runs[0];
  if (last && last.status === 'completed' && (last.conclusion === 'success') !== ok)
    await github.rest.actions.reRunWorkflow({ owner, repo, run_id: last.id });
}

/**
 * @param {any} github
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<{ signatures: Signature[], sha?: string }>}
 */
async function readSignatures(github, owner, repo) {
  try {
    const { data } = await github.rest.repos.getContent({ owner, repo, path: FILE, ref: BRANCH });
    const parsed = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    return { signatures: Array.isArray(parsed.signatures) ? parsed.signatures : [], sha: data.sha };
  } catch (error) {
    if (error.status === 404) return { signatures: [] };
    throw error;
  }
}

/**
 * Starts the cla-signatures branch from the default branch the first time a signature is recorded.
 * @param {any} github
 * @param {string} owner
 * @param {string} repo
 * @param {string} base
 */
async function ensureBranch(github, owner, repo, base) {
  try {
    await github.rest.git.getRef({ owner, repo, ref: `heads/${BRANCH}` });
  } catch (error) {
    if (error.status !== 404) throw error;
    const { data } = await github.rest.git.getRef({ owner, repo, ref: `heads/${base}` });
    await github.rest.git.createRef({ owner, repo, ref: `refs/heads/${BRANCH}`, sha: data.object.sha });
  }
}
