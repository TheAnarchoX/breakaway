import { useEffect, useState } from 'preact/hooks';
import { Cable, Copy, ExternalLink, KeyRound, Puzzle, Unplug } from 'lucide-preact';
import { ago } from '../lib/model.js';
import { api, enc } from '../lib/api.js';
import { copy } from '../lib/clipboard.js';
import { confirmDialog, inScope, navOrder, repoScope, repos, toast } from '../lib/store.js';
import { RepoChip } from '../components/ui.jsx';

const ext = { target: '_blank', rel: 'noopener noreferrer' };
const DOCS = 'https://leavethepack.dev/docs/';
/** The environment variable the token comes from, as `npx breakaway mcp` prints it. */
const TOKEN_VAR = 'BREAKAWAY_TOKEN';
const AGENT = /^[\w.@:/-]{1,64}$/u;

/** This board's MCP server: the board's own origin, as the Worker serves both. */
export const mcpEndpoint = () => `${location.origin}/mcp`;

/**
 * A command or config to copy, with its Copy button.
 * @param {{ text: string, what: string, multiline?: boolean }} props
 */
function CopyBox({ text, what, multiline = false }) {
  return (
    <div class={`gh-command mcp-copy ${multiline ? 'is-multiline' : ''}`}>
      {multiline ? (
        <pre tabIndex={0}>
          <code>{text}</code>
        </pre>
      ) : (
        <code>{text}</code>
      )}
      <button
        type="button"
        class="btn btn-quiet btn-icon btn-sm"
        aria-label={`Copy the ${what.toLowerCase()}`}
        onClick={() => copy(text, what)}
      >
        <Copy size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

/** @param {{ iso?: string | null, prefix: string }} props */
function When({ iso, prefix }) {
  if (!iso) return null;
  return (
    <span>
      {prefix}{' '}
      <time dateTime={iso} title={new Date(iso).toLocaleString()}>
        {ago(iso)}
      </time>
    </span>
  );
}

/**
 * The apps you approved to work on the board through MCP (BRK-157): each connection's name, repository, and agent
 * name, and Revoke. The owner approves them on the consent page the app opens; listing and revoking are cookie-only.
 */
function ConnectedApps() {
  const [list, setList] = useState(/** @type {any[] | null} */ (null));
  const [revoking, setRevoking] = useState(/** @type {string | null} */ (null));
  const load = () =>
    api('oauth/connections')
      .then((data) => setList(data.connections))
      .catch(() => setList([]));
  useEffect(() => {
    load();
  }, []);
  const shownList = (list ?? []).filter((c) => inScope(c.repo));
  const revoke = async (/** @type {any} */ c) => {
    const ok = await confirmDialog({
      title: `Revoke ${c.name}?`,
      body: `It stops working on the board at once. To connect it again, add the board in ${c.client} and approve it here.`,
      confirmLabel: 'Revoke',
      tone: 'danger',
    });
    if (!ok) return;
    setRevoking(c.id);
    try {
      await api(`oauth/connections/${enc(c.id)}`, { method: 'DELETE' });
      toast(`Revoked ${c.name}.`, 'success');
      await load();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setRevoking(null);
    }
  };
  return (
    <section class="gh-section" aria-labelledby="mcp-apps">
      <h2 id="mcp-apps">
        <Unplug size={18} aria-hidden="true" />
        Connected apps
      </h2>
      <p class="muted small">
        Apps you approved to work on the board through MCP, each as one agent in one repository, with a token of its
        own. Revoke one, and it stops at once.
      </p>
      {list === null ? (
        <p class="muted small" aria-busy="true">
          Loading connected apps…
        </p>
      ) : shownList.length ? (
        <ul class="conn-repos">
          {shownList.map((c) => (
            <li key={c.id}>
              <span class="conn-signin">
                <span>
                  <strong>{c.name}</strong> <RepoChip slug={c.repo} />
                </span>
                <span class="meta">
                  {c.client} as <code>{c.agent}</code> · <When iso={c.created} prefix="approved" />
                  {' · '}
                  {c.used ? <When iso={c.used} prefix="last used" /> : 'not used yet'}
                </span>
              </span>
              <button
                type="button"
                class="btn btn-outline btn-sm"
                disabled={revoking === c.id}
                aria-busy={revoking === c.id}
                onClick={() => revoke(c)}
              >
                Revoke<span class="visually-hidden"> {c.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p class="mcp-empty">No apps connected yet. Add the board’s address in one, and approve it here.</p>
      )}
    </section>
  );
}

/** For clients that send headers: the board's token, an agent name, and a repository, as `npx breakaway mcp` prints. */
function TokenConfig({ endpoint }) {
  const list = repos.value.list;
  const [picked, setRepo] = useState(/** @type {string | null} */ (null));
  // The repositories load after the page can open, so the pick follows the switcher until you choose one.
  const repo = picked ?? repoScope.value ?? repos.value.default ?? list[0]?.slug ?? '';
  const [agent, setAgent] = useState('my-agent');
  const name = AGENT.test(agent) ? agent : 'my-agent';
  const json = JSON.stringify(
    {
      mcpServers: {
        breakaway: {
          type: 'http',
          url: endpoint,
          headers: {
            Authorization: `Bearer \${${TOKEN_VAR}}`,
            'X-Breakaway-Agent': name,
            ...(repo ? { 'X-Breakaway-Repo': repo } : {}),
          },
        },
      },
    },
    null,
    2,
  );
  return (
    <section class="gh-section" aria-labelledby="mcp-token">
      <h2 id="mcp-token">
        <KeyRound size={18} aria-hidden="true" />
        Connect with the board’s token
      </h2>
      <p class="muted small">
        For a coding agent in your terminal or editor that sends headers. Most read a config like this one; the token
        comes from <code>{TOKEN_VAR}</code> in the environment, so the file never holds it. In a checkout,{' '}
        <code>npx breakaway mcp</code> prints the same for its repository.
      </p>
      <div class="field-row mcp-fields">
        <label class="field">
          <span class="field-label">Agent name</span>
          <input
            class="input"
            value={agent}
            maxLength={64}
            spellcheck={false}
            autocapitalize="off"
            onInput={(e) => setAgent(e.currentTarget.value)}
            aria-describedby="mcp-agent-hint"
          />
          <span class="field-hint" id="mcp-agent-hint">
            It claims tasks and comments under this name.
          </span>
        </label>
        {list.length > 0 && (
          <label class="field">
            <span class="field-label">Repository</span>
            <select class="select" value={repo} onChange={(e) => setRepo(e.currentTarget.value)}>
              {list.map((r) => (
                <option key={r.slug} value={r.slug}>
                  {r.name}
                </option>
              ))}
            </select>
            <span class="field-hint">The only repository it works in.</span>
          </label>
        )}
      </div>
      <CopyBox text={json} what="Config" multiline />
      <p class="muted small">
        The token is the board’s full token. Put it only in a client you run, on a machine you trust.
      </p>
    </section>
  );
}

/**
 * MCP (WEB-74): every board is an MCP server, so any agent that speaks MCP works the board, not only Claude Code. This
 * page says how to connect one, holds the apps you approved, and sets up the Claude Code plugin.
 */
export function McpView() {
  useEffect(() => {
    navOrder.value = [];
  }, []);
  const endpoint = mcpEndpoint();
  return (
    <div class="connections-view mcp-view">
      <div class="view-intro">
        <h1>MCP</h1>
        <p class="muted">
          Work the board from any agent that speaks MCP: in your terminal, your editor, or a chat app. This board is an
          MCP server. A connected agent lists, claims, and comments on tasks, posts on the peloton, and pings you, with
          the same rules as the CLI. It can’t merge, deploy, start agents, or answer decisions.
        </p>
      </div>
      <section class="gh-section mcp-address" aria-labelledby="mcp-address">
        <h2 id="mcp-address">
          <Cable size={18} aria-hidden="true" />
          The board’s address
        </h2>
        <CopyBox text={endpoint} what="Address" />
        <ol class="mcp-steps">
          <li>In your app, add it as a remote MCP server over HTTP. Some apps call it a custom connector.</li>
          <li>
            The app opens this board. Name the connection, pick its repository and the agent name it claims as, and
            press Approve.
          </li>
          <li>It shows under Connected apps below. Ask it for the next task on the board.</li>
        </ol>
        <p class="muted small">
          An app that can’t open a sign-in takes the board’s token instead, as below.{' '}
          <a href={`${DOCS}mcp/`} {...ext}>
            Read about MCP clients
            <ExternalLink size={14} aria-hidden="true" />
            <span class="visually-hidden"> (opens in a new tab)</span>
          </a>
        </p>
      </section>
      <ConnectedApps />
      <TokenConfig endpoint={endpoint} />
      <section class="gh-section" aria-labelledby="mcp-plugin">
        <h2 id="mcp-plugin">
          <Puzzle size={18} aria-hidden="true" />
          The Claude Code plugin
        </h2>
        <p class="muted small">
          In Claude Code, one install brings this MCP server, the <code>tasks</code> skill, <code>/breakaway:next</code>{' '}
          and <code>/breakaway:hand-over</code>, and the hooks that show a session’s output live on its task. Type:
        </p>
        <CopyBox
          text={'/plugin marketplace add TheAnarchoX/breakaway\n/plugin install breakaway@breakaway'}
          what="Commands"
          multiline
        />
        <p class="muted small">
          When it asks, give it the board’s address, <code>{location.origin}</code>, the board’s token, and an agent
          name, or leave the name empty for <code>claude-&lt;branch&gt;</code>. Then type <code>/breakaway:next</code>{' '}
          in a checkout of a repository the board tracks.{' '}
          <a href={`${DOCS}plugin/`} {...ext}>
            Read about the plugin
            <ExternalLink size={14} aria-hidden="true" />
            <span class="visually-hidden"> (opens in a new tab)</span>
          </a>
        </p>
      </section>
    </div>
  );
}
