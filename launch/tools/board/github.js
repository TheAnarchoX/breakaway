/**
 * The launch board's GitHub: acme/widgets as the board sees it, in memory, behind the Worker's fetch, like the
 * end-to-end test's (test/architect-e2e.test.js). The default branch's commits and files, pull requests and their
 * files, and the OIDC keys the apply runner's token is checked with. Anything else on the network is refused, so the
 * launch board never reaches a real service.
 */
export const REPO = 'acme/widgets';
const GH = `/repos/${REPO}`;
const OIDC_KEYS_URL = 'https://token.actions.githubusercontent.com/.well-known/jwks';

export const gh = {
  /** @type {Array<{ sha: string, commit: { message: string, author: { date: string } } }>} */ commits: [],
  /** @type {Record<string, string>} the default branch's files, by path */ main: {},
  /** @type {Record<string, Record<string, string>>} a pull request's files at its head, by head sha then path */ heads:
    {},
  /** @type {any[]} */ pulls: [],
  /** @type {Record<string, any[]>} */ pullFiles: {},
  /** @type {Record<string, string>} */ variables: {},
  /** @type {any[]} the OIDC keys, from architect.mjs's throwaway signer */ keys: [],
};

const b64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const reply = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const real = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = init.method ?? (typeof input === 'string' ? 'GET' : input.method) ?? 'GET';
  if (url.href === OIDC_KEYS_URL) return reply({ keys: gh.keys });
  // The local board's own origin is fine; nothing else leaves the machine.
  if (['127.0.0.1', 'localhost'].includes(url.hostname)) return real(input, init);
  if (url.host !== 'api.github.com') return reply({ message: `the launch board doesn’t reach ${url.host}` }, 503);
  const path = decodeURIComponent(url.pathname);
  if (path === `${GH}/installation`) return reply({ id: 77 });
  if (path.startsWith('/app/installations/'))
    return reply({ token: 'ghs_launch', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  if (path === '/app') return reply({ id: 1, slug: 'widgets-tasks', name: 'widgets tasks' });
  if (!path.startsWith(`${GH}/`) && path !== GH) return reply({ message: 'Not Found' }, 404);
  if (path === GH) return reply({ full_name: REPO, default_branch: 'main', private: false, archived: false });
  const rest = path.slice(GH.length);
  const sent = init.body ? JSON.parse(String(init.body)) : null;

  if (method !== 'GET') {
    if (rest === '/check-runs' && method === 'POST')
      return reply({ id: 901, html_url: `https://github.com/${REPO}/runs/901` });
    if (rest === '/actions/variables' && method === 'POST') {
      gh.variables[sent.name] = sent.value;
      return reply({}, 201);
    }
    return new Response(null, { status: 204 });
  }
  if (rest === '/pulls')
    return reply(gh.pulls.filter((p) => url.searchParams.get('state') === 'all' || p.state === 'open'));
  let m = /^\/pulls\/(\d+)$/u.exec(rest);
  if (m) {
    const found = gh.pulls.find((p) => String(p.number) === m[1]);
    return found
      ? reply({ ...found, mergeable: true, mergeable_state: 'clean' })
      : reply({ message: 'Not Found' }, 404);
  }
  m = /^\/pulls\/(\d+)\/files$/u.exec(rest);
  if (m) return reply(gh.pullFiles[m[1]] ?? []);
  if (/^\/pulls\/\d+\/(reviews|comments)$/u.test(rest)) return reply([]);
  if (/^\/commits\/[^/]+\/check-runs$/u.test(rest)) return reply({ check_runs: [] });
  if (/^\/commits\/[^/]+\/status$/u.test(rest)) return reply({ state: 'success', statuses: [] });
  if (rest === '/commits') return reply(gh.commits);
  if (rest === '/actions/runs') return reply({ workflow_runs: [] });
  if (rest === '/actions/workflows/breakaway-infra.yml')
    return reply({ id: 9, path: '.github/workflows/breakaway-infra.yml' });
  m = /^\/actions\/variables\/(.+)$/u.exec(rest);
  if (m)
    return m[1] in gh.variables
      ? reply({ name: m[1], value: gh.variables[m[1]] })
      : reply({ message: 'Not Found' }, 404);
  // Each GitHub environment lets only main deploy, as the apply workflow needs (BRK-250).
  if (/^\/environments\/[^/]+\/deployment-branch-policies$/u.test(rest))
    return reply({ branch_policies: [{ name: 'main', type: 'branch' }] });
  m = /^\/environments\/([^/]+)$/u.exec(rest);
  if (m)
    return reply({ name: m[1], deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
  if (rest === '/environments') return reply({ environments: [] });
  if (['/deployments', '/dependabot/alerts', '/releases', '/tags', '/issues', '/labels'].includes(rest))
    return reply([]);
  if (/^\/compare\//u.test(rest)) return reply({ commits: [], files: [] });
  m = /^\/contents\/(.+)$/u.exec(rest);
  if (m) {
    const ref = url.searchParams.get('ref') ?? 'main';
    const files = gh.heads[ref] ?? gh.main;
    const name = m[1];
    if (name in files) return reply({ type: 'file', size: files[name].length, content: b64(files[name]) });
    const inside = Object.keys(files).filter(
      (p) => p.startsWith(`${name}/`) && !p.slice(name.length + 1).includes('/'),
    );
    if (inside.length)
      return reply(
        inside.map((p) => ({ type: 'file', name: p.slice(name.length + 1), path: p, size: files[p].length })),
      );
    return reply({ message: 'Not Found' }, 404);
  }
  return reply({ message: 'Not Found' }, 404);
};

/** A pull request as GitHub lists it. */
export function pull(number, title, sha, { state = 'open', merged = false, hoursAgo = 2 } = {}) {
  return {
    number,
    title,
    body: '',
    draft: false,
    state,
    html_url: `https://github.com/${REPO}/pull/${number}`,
    node_id: `PR_${number}`,
    head: { ref: `claude/widgets-${number}`, sha },
    base: { ref: 'main' },
    user: { login: 'claude[bot]' },
    created_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
    updated_at: new Date().toISOString(),
    merge_commit_sha: merged ? `merge-${number}` : null,
    merged_at: merged ? new Date().toISOString() : null,
    closed_at: state === 'closed' ? new Date().toISOString() : null,
  };
}

/** A new commit on the default branch with `files` changed. */
export function commit(files, sha, message = 'Merge') {
  Object.assign(gh.main, files);
  gh.commits = [{ sha, commit: { message, author: { date: new Date().toISOString() } } }, ...gh.commits];
  return sha;
}
