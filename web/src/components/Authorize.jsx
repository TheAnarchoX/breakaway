import { useEffect, useState } from 'preact/hooks';
import { TriangleAlert } from 'lucide-preact';
import { api, enc } from '../lib/api.js';
import { Logo } from './Logo.jsx';

/** Hosts whose apps are well known: anything else gets a plain warning before the owner approves. */
const KNOWN_HOSTS = new Set(['claude.ai', 'claude.com']);

/** The agent name to start with: the app's own name, made into one (`Some App` is `some-app`), else `mcp-agent`. */
export function agentFor(/** @type {string} */ client) {
  const name = String(client ?? '')
    .toLowerCase()
    .replace(/[^\w.@:-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64);
  return name && !/^(owner|board|routine:.*)$/u.test(name) ? name : 'mcp-agent';
}

/**
 * The consent page of a sign-in from an MCP app (BRK-157, docs/specs/IDEA-24-mcp-server.md, section 8): the
 * owner names the connection and picks its repositories (or the whole board, BRK-352) and agent name, then approves or
 * denies it. Either way the browser goes back to the app.
 * @param {{ id: string }} props
 */
export function Authorize({ id }) {
  const [state, setState] = useState(
    /** @type {{ loading: boolean, data?: any, error?: string }} */ ({ loading: true }),
  );
  const [form, setForm] = useState({ name: '', agent: '' });
  // The repositories it works in, or the whole board: today's and those added later (BRK-352).
  const [picked, setPicked] = useState(/** @type {string[]} */ ([]));
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(/** @type {null | 'approve' | 'deny'} */ (null));
  const [problem, setProblem] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    api(`oauth/requests/${enc(id)}`)
      .then((data) => {
        setState({ loading: false, data });
        setForm((f) => ({
          ...f,
          name: data.request.client,
          agent: agentFor(data.request.client),
        }));
        const first = data.default ?? data.repos[0]?.slug;
        setPicked(first ? [first] : []);
      })
      .catch((error) => setState({ loading: false, error: error.message }));
  }, [id]);

  const answer = async (/** @type {'approve' | 'deny'} */ how) => {
    setBusy(how);
    setProblem(null);
    try {
      const { redirect } = await api(`oauth/requests/${enc(id)}/${how}`, {
        method: 'POST',
        body: how === 'approve' ? { ...form, ...(all ? { all: true } : { repos: picked }) } : {},
      });
      location.assign(redirect);
    } catch (error) {
      setProblem(error.message);
      setBusy(null);
    }
  };

  const { loading, data, error } = state;
  const request = data?.request;
  const toggle = (/** @type {string} */ slug, /** @type {boolean} */ on) =>
    setPicked((list) => (on ? [...new Set([...list, slug])] : list.filter((s) => s !== slug)));
  const field = (/** @type {'name' | 'agent'} */ key) => ({
    value: form[key],
    onInput: (/** @type {any} */ e) => setForm({ ...form, [key]: e.currentTarget.value }),
  });
  return (
    <main id="main" class="signin">
      <div class="signin-card authorize-card">
        <h1 class="signin-logo">
          <Logo kind="logo" />
          <span class="visually-hidden">breakaway</span>
        </h1>
        {loading && (
          <p class="muted" aria-busy="true">
            Loading the sign-in…
          </p>
        )}
        {error && (
          <>
            <p class="display signin-tagline">Sign-in not found.</p>
            <p class="field-error" role="alert">
              {error}
            </p>
            <a class="btn btn-outline btn-block" href="#/mcp">
              Go to the board
            </a>
          </>
        )}
        {request && (
          <form
            class="signin-form"
            onSubmit={(e) => {
              e.preventDefault();
              answer('approve');
            }}
          >
            <p class="display signin-tagline">Connect {request.client}.</p>
            <p class="muted">
              {request.client} wants to work on this board as an agent, through MCP. It can read the tasks of the
              repositories you pick, claim them, comment, and post on the peloton. It can’t merge, deploy, start agents,
              or answer decisions. You can revoke it on MCP at any time.
            </p>
            <p class="authorize-host">
              After you answer, the board sends you back to <strong>{request.redirectHost}</strong>.
            </p>
            {!KNOWN_HOSTS.has(request.redirectHost) && (
              <p class="authorize-warning" role="note">
                <TriangleAlert size={16} aria-hidden="true" />
                <span>Approve only if you started this sign-in yourself, just now, from an app you trust.</span>
              </p>
            )}
            {data.repos.length === 0 ? (
              <p class="field-error" role="alert">
                The board has no repository yet. Add one on Connections, then start the sign-in again.
              </p>
            ) : (
              <>
                <label class="field">
                  <span class="field-label">Name</span>
                  <input class="input" required maxLength={80} {...field('name')} />
                  <span class="field-hint">So you know it on MCP when you want to revoke it.</span>
                </label>
                <fieldset class="field" aria-describedby="authorize-repos-hint">
                  <legend class="field-label">Repositories</legend>
                  <div class="check-list">
                    <label class="check-row">
                      <input type="checkbox" checked={all} onChange={(e) => setAll(e.currentTarget.checked)} />
                      <span>The whole board</span>
                    </label>
                    {data.repos.map((/** @type {any} */ r) => (
                      <label key={r.slug} class="check-row">
                        <input
                          type="checkbox"
                          checked={all || picked.includes(r.slug)}
                          disabled={all}
                          onChange={(e) => toggle(r.slug, e.currentTarget.checked)}
                        />
                        <span>{r.name}</span>
                        <span class="meta">{r.github}</span>
                      </label>
                    ))}
                  </div>
                  <span class="field-hint" id="authorize-repos-hint">
                    {all
                      ? 'It works in every repository on the board, and in each one you add later.'
                      : picked.length > 1
                        ? 'It works only in these, and names one on each call.'
                        : picked.length === 1
                          ? 'The only repository it works in. Pick more, or the whole board, for an app you connect once.'
                          : 'Pick a repository, or the whole board.'}
                  </span>
                </fieldset>
                <label class="field">
                  <span class="field-label">Agent name</span>
                  <input
                    class="input"
                    required
                    maxLength={64}
                    pattern="[\w.@:\/\-]{1,64}"
                    spellcheck={false}
                    autocapitalize="off"
                    {...field('agent')}
                  />
                  <span class="field-hint">It claims tasks and comments under this name.</span>
                </label>
              </>
            )}
            {problem && (
              <p class="field-error" role="alert">
                {problem}
              </p>
            )}
            <div class="authorize-buttons">
              <button
                type="button"
                class="btn btn-outline"
                disabled={busy !== null}
                aria-busy={busy === 'deny'}
                onClick={() => answer('deny')}
              >
                Deny
              </button>
              <button
                type="submit"
                class="btn btn-primary"
                disabled={busy !== null || data.repos.length === 0 || (!all && picked.length === 0)}
                aria-busy={busy === 'approve'}
              >
                {busy === 'approve' ? 'Approving…' : 'Approve'}
              </button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
