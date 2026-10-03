/**
 * Cloud sessions (Claude Code on the web, routines the board starts) reach the internet through
 * a proxy named in HTTPS_PROXY, and that proxy is where the environment's API credential for the
 * board is added. Node's fetch ignores HTTPS_PROXY unless it's told otherwise, so without this it
 * goes around the proxy and the sandbox refuses it with a bare 403 (CLD-37).
 *
 * routeThroughSessionProxy() sends fetch through the proxy and trusts the system's CA store too, which
 * holds the proxy's certificate. Without a proxy in the environment it does nothing.
 */
import http from 'node:http';
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
