/**
 * npx breakaway mcp (docs/specs/IDEA-24-mcp-server.md, section 5; CLI-6): how a checkout connects an MCP client to the
 * board's /mcp, and whether it answers. Pure apart from the `fetch` it's handed, so it's tested without a board.
 */
import { githubFromRemote, pickRepo } from './repo.js';

/** The MCP revision `--check` speaks: the one with an `initialize` handshake, which /mcp accepts (src/mcp.js, LEGACY). */
export const CHECK_PROTOCOL = '2025-11-25';
/** The server's name in a client's config. */
export const SERVER = 'breakaway';

const AGENT = /^[\w.@:/-]{1,64}$/u;

/**
 * The agent name an MCP connection claims as: --as or BREAKAWAY_AGENT (`named`), else `claude-<branch>` for the
 * checkout's branch, else `fallback` (the CLI's own default). A branch's `/` and anything a name can't hold become `-`.
 * @param {{ named?: string | null, branch?: string | null, fallback: string }} options
 */
export function mcpAgent({ named, branch, fallback }) {
  if (named) return named;
  const b = String(branch ?? '').trim();
  if (!b || b === 'HEAD') return fallback;
  const name = (/^claude[-/]/u.test(b) ? b : `claude-${b}`).replace(/[^\w.@:-]+/gu, '-').slice(0, 64);
  return AGENT.test(name) ? name : fallback;
}

/**
 * The `claude mcp add` line and the `.mcp.json` entry for a checkout. The token is always the environment variable
 * `tokenVar`, never its value: the shell fills it in for the line, and Claude Code for `.mcp.json`. Without `repo` (a
 * checkout the board doesn't track) there's no X-Breakaway-Repo, and the repository's tools say what's missing.
 * @param {{ url: string, agent: string, repo?: string | null, tokenVar: string }} options
 * @returns {{ endpoint: string, command: string, json: { mcpServers: Record<string, any> } }}
 */
export function mcpConfig({ url, agent, repo = null, tokenVar }) {
  const endpoint = `${String(url).replace(/\/+$/u, '')}/mcp`;
  const headers = {
    Authorization: `Bearer \${${tokenVar}}`,
    'X-Breakaway-Agent': agent,
    ...(repo ? { 'X-Breakaway-Repo': repo } : {}),
  };
  const command = [
    `claude mcp add --transport http ${SERVER} ${endpoint}`,
    `  --header "Authorization: Bearer $${tokenVar}"`,
    `  --header "X-Breakaway-Agent: ${agent}"`,
    ...(repo ? [`  --header "X-Breakaway-Repo: ${repo}"`] : []),
  ].join(' \\\n');
  return { endpoint, command, json: { mcpServers: { [SERVER]: { type: 'http', url: endpoint, headers } } } };
}

/**
 * `--headers`: the headers Claude Code sends to /mcp, for the plugin's `headersHelper` (CLI-9,
 * docs/specs/IDEA-25-claude-plugin.md, section 4). Claude Code reads them as JSON from standard output, so the token is
 * its value here, and only there. Outside a repository the board tracks there's only Authorization, and the repository's
 * tools say what's missing; without a token there's none, so a session's proxy can add it.
 * @param {{ token?: string | null, agent: string, repo?: string | null }} options
 * @returns {Record<string, string>}
 */
export function mcpHeaders({ token = null, agent, repo = null }) {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(repo ? { 'X-Breakaway-Agent': agent, 'X-Breakaway-Repo': repo } : {}),
  };
}

/**
 * The repository `--headers` names: the board's slug for the checkout when the board says which (`GET /api/repos`), and
 * null when it tracks none of them. A plugin's headersHelper runs without the plugin's settings, so with only the
 * plugin set up there's no token to ask with: then it's the checkout's GitHub `owner/name`, which /mcp matches against
 * its repositories itself (src/mcp.js). `named` is --repo or BREAKAWAY_REPO. Never throws: Claude Code is waiting.
 * @param {{ base?: string | null, token?: string | null, named?: string | null, remote?: string | null, fetch: typeof globalThis.fetch }} options
 * @returns {Promise<string | null>}
 */
export async function headersRepo({ base = null, token = null, named = null, remote = null, fetch }) {
  let registry = null;
  if (base)
    try {
      const res = await fetch(`${String(base).replace(/\/+$/u, '')}/api/repos`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) registry = await res.json();
    } catch {
      /* the board can't be reached: /mcp will say so itself */
    }
  if (registry) {
    try {
      return pickRepo({ named, remote, registry });
    } catch {
      return null; // --repo names a repository the board doesn't have
    }
  }
  if (named) return String(named).trim().toLowerCase();
  return githubFromRemote(remote)?.toLowerCase() ?? null;
}

/**
 * What `npx breakaway mcp` prints: the line, the `.mcp.json` entry, and what to check.
 * @param {{ endpoint: string, command: string, json: object }} config
 * @param {{ repo?: string | null, tokenVar: string }} options
 */
export function mcpLines(config, { repo = null, tokenVar }) {
  return [
    `Connect Claude Code to the board's MCP server at ${config.endpoint}:`,
    '',
    config.command,
    '',
    `Run it where ${tokenVar} is set, then type /mcp in Claude Code. Or put this in the checkout's .mcp.json, which`,
    `Claude Code fills in from ${tokenVar} when it starts:`,
    '',
    JSON.stringify(config.json, null, 2),
    '',
    ...(repo
      ? []
      : [
          'This checkout isn’t a repository the board tracks, so there’s no X-Breakaway-Repo header: the tools that work',
          'in a repository will ask for one. Run this in a tracked checkout, or name one with --repo <slug>.',
          '',
        ]),
    `The token is the board's full token: give it only to a client you run. npx breakaway mcp --check tests the connection.`,
  ];
}

/**
 * `--check`: an `initialize` and a `tools/list` against /mcp with the same headers the config sends, and what came
 * back. `ok` is false with the board's own error when either fails.
 * @param {{ endpoint: string, token?: string | null, agent: string, repo?: string | null, fetch: typeof globalThis.fetch }} options
 * @returns {Promise<{ ok: boolean, lines: string[] }>}
 */
export async function checkMcp({ endpoint, token = null, agent, repo = null, fetch }) {
  const headers = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'X-Breakaway-Agent': agent,
    ...(repo ? { 'X-Breakaway-Repo': repo } : {}),
  };
  const rpc = async (id, method, params, version) => {
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { ...headers, ...(version ? { 'MCP-Protocol-Version': version } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
    } catch (error) {
      return { error: `can't reach ${endpoint} (${reasonOf(error)})` };
    }
    const data = await res.json().catch(() => null);
    // An install from before /mcp answers it with the web app, a 404, or a 405: anything but JSON-RPC.
    if (res.status !== 401 && (res.status === 404 || res.status === 405 || (res.ok && !data?.jsonrpc)))
      return {
        error: `${endpoint} answered ${res.status}: this install has no MCP server yet. Update and deploy it (docs/tasks.md#updates).`,
      };
    if (res.status === 401)
      return {
        error: `${endpoint} refused the token (401)${data?.error ? `: ${data.error}` : ''}${token ? '' : '. No token is set'}`,
      };
    if (data?.error)
      return { error: `${method} failed: ${data.error.message ?? data.error}${res.ok ? '' : ` (HTTP ${res.status})`}` };
    if (!res.ok || !data?.result) return { error: `${method} failed: HTTP ${res.status}` };
    return { result: data.result };
  };

  const init = await rpc(1, 'initialize', {
    protocolVersion: CHECK_PROTOCOL,
    capabilities: {},
    clientInfo: { name: 'breakaway-cli', version: '1' },
  });
  if (init.error) return { ok: false, lines: [`The board's MCP server didn't answer: ${init.error}`] };
  const listed = await rpc(2, 'tools/list', {}, init.result.protocolVersion ?? CHECK_PROTOCOL);
  if (listed.error) return { ok: false, lines: [`The board's MCP server didn't answer: ${listed.error}`] };
  const server = init.result.serverInfo ?? {};
  const tools = (listed.result.tools ?? []).map((t) => t.name);
  return {
    ok: true,
    lines: [
      `The board's MCP server answers at ${endpoint}: ${server.name ?? SERVER}${server.version ? ` ${server.version}` : ''}, MCP ${init.result.protocolVersion}.`,
      `${tools.length} tools: ${tools.join(', ') || 'none'}.`,
      `As ${agent}${repo ? `, in ${repo}` : ', in no repository (set X-Breakaway-Repo, or run it in a tracked checkout)'}.`,
    ],
  };
}

/** Why a fetch failed: the innermost cause, like ECONNREFUSED. */
function reasonOf(error) {
  let root = error;
  while (root?.cause) root = root.cause;
  return typeof root?.code === 'string' ? root.code : (root?.message ?? String(error));
}
