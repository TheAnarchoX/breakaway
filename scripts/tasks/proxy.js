/**
 * Cloud sessions (Claude Code on the web, routines the board starts) reach the internet through
 * a proxy named in HTTPS_PROXY, and that proxy is where the environment's API credential for the
 * board is added. Node's fetch ignores HTTPS_PROXY unless it's told otherwise, so without this it
 * goes around the proxy and the sandbox refuses it with a bare 403 (CLD-37).
 *
 * routeThroughSessionProxy() sends fetch through the proxy and trusts the system's CA store too, which
 * holds the proxy's certificate. Without a proxy in the environment it does nothing.
 */
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';

export function sessionProxy(env = process.env) {
  return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || null;
}

export function routeThroughSessionProxy(env = process.env) {
  if (!sessionProxy(env)) return false;
  http.setGlobalProxyFromEnv?.(env);
  try {
    const cas = new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
    tls.setDefaultCACertificates([...cas]);
  } catch {
    /* no system store here: Node's own list still applies */
  }
  return true;
}

/** Runs `command` with `args`, `input` on stdin, and resolves with stdout; rejects with stderr when it fails. */
function runWithInput(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(Object.assign(new Error(err.trim() || `${command} exited ${code}`), { code })),
    );
    child.stdin.end(input ?? '');
  });
}

/**
 * A hook's request to the board (BRK-86). Claude Code runs hooks with the image's default Node, which in a cloud session
 * can be too old to send fetch through the session proxy (Node 20 has neither http.setGlobalProxyFromEnv nor the CA
 * calls above), and the sandbox refuses a request that goes around it. So with a proxy the request goes through curl,
 * which reads HTTPS_PROXY and the system's certificates on any Node; without curl, or without a proxy, through fetch.
 * Answers like fetch's response: { ok, status, json() }.
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string, timeoutMs?: number }} [request]
 */
export async function sessionRequest(
  url,
  { method = 'GET', headers = {}, body, timeoutMs = 4000 } = {},
  { env = process.env, run = runWithInput, fetch = globalThis.fetch } = {},
) {
  if (sessionProxy(env)) {
    const args = ['-sS', '--max-time', String(Math.max(1, Math.ceil(timeoutMs / 1000))), '-X', method];
    for (const [name, value] of Object.entries(headers)) args.push('-H', `${name}: ${value}`);
    if (body !== undefined) args.push('--data-binary', '@-');
    args.push('-w', '\n%{http_code}', url);
    try {
      const out = await run('curl', args, body);
      const at = out.lastIndexOf('\n');
      const status = Number(out.slice(at + 1));
      const text = out.slice(0, Math.max(0, at));
      return { ok: status >= 200 && status < 300, status, json: async () => (text.trim() ? JSON.parse(text) : null) };
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'ENOENT') throw error;
      // No curl here: fetch, through the proxy if this Node can.
    }
  }
  routeThroughSessionProxy(env);
  return fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * Where a hook notes why it couldn't post for a task (BRK-86): the system's temp folder, never the repository, where a
 * cloud session's Stop check would take a new file as work to commit. The CLI shows it on its next command here.
 */
const failurePath = (uuid, dir) => join(dir, `breakaway-hook-${String(uuid).replace(/[^\w-]/gu, '')}.json`);

/** Records that the hook couldn't post for task `uuid`, and why. */
export function noteHookFailure(uuid, reason, dir = tmpdir(), at = new Date()) {
  try {
    writeFileSync(
      failurePath(uuid, dir),
      `${JSON.stringify({ at: at.toISOString(), reason: String(reason).slice(0, 300) })}\n`,
    );
  } catch {
    /* nowhere to note it */
  }
}

/** Clears that note, after a post that went through. */
export function clearHookFailure(uuid, dir = tmpdir()) {
  rmSync(failurePath(uuid, dir), { force: true });
}

/** The hook's last failure for task `uuid`, or null. */
export function hookFailure(uuid, dir = tmpdir()) {
  try {
    return JSON.parse(readFileSync(failurePath(uuid, dir), 'utf8'));
  } catch {
    return null;
  }
}
