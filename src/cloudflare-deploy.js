/**
 * The slice of Cloudflare's API a Worker uses to update itself (BRK-53, docs/specs/IDEA-20-self-updating-installs.md,
 * section 3): read its own settings and deployments, upload a Worker version (modules and web app), deploy a version,
 * and keep a secret. The token is the install's own, with Workers Scripts: edit on this one account; it is only ever
 * sent to api.cloudflare.com. Every call goes through the injected `fetchImpl`, so tests mock Cloudflare.
 */

const API = 'https://api.cloudflare.com/client/v4';

export class CloudflareError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  /** Whether Cloudflare refused the token (or it can't reach this Worker). */
  get refused() {
    return this.status === 401 || this.status === 403;
  }
}

/** @param {ArrayBuffer | Uint8Array} bytes */
const base64 = (bytes) => {
  const view = new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < view.length; i += 0x8000) out += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(out);
};

const TYPES = {
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  webmanifest: 'application/manifest+json',
  woff2: 'font/woff2',
  ico: 'image/x-icon',
  txt: 'text/plain',
};
const extensionOf = (path) => /\.([a-z0-9]+)$/iu.exec(path)?.[1].toLowerCase() ?? '';

/** The hash Cloudflare's asset upload names a file by: SHA-256 of its base64 text and extension, first 32 hex digits. */
export async function assetHash(content, path) {
  const data = new TextEncoder().encode(base64(content) + extensionOf(path));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

export class Cloudflare {
  /**
   * @param {{ token: string, accountId: string, worker: string, fetchImpl?: typeof fetch }} o
   */
  constructor({ token, accountId, worker, fetchImpl = fetch }) {
    this.token = token;
    this.account = accountId;
    this.worker = worker;
    this.fetch = fetchImpl;
  }

  get script() {
    return `${API}/accounts/${this.account}/workers/scripts/${encodeURIComponent(this.worker)}`;
  }

  /** One call; the `result` of Cloudflare's envelope, or a CloudflareError that says what it answered. */
  /** @param {string} url @param {{ method?: string, body?: BodyInit, token?: string, headers?: Record<string, string> }} [options] */
  async call(url, { method = 'GET', body, token = this.token, headers = {} } = {}) {
    let res;
    try {
      res = await this.fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body,
      });
    } catch (error) {
      throw new CloudflareError(0, `couldn’t reach Cloudflare: ${error.message}`);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* not JSON */
    }
    if (!res.ok || data?.success === false) {
      const reason = data?.errors?.map((e) => e.message).join('; ') || `answered ${res.status}`;
      throw new CloudflareError(res.status, reason.slice(0, 300));
    }
    return data?.result ?? null;
  }

  /** The Worker's settings (bindings, compatibility date, observability): proves the token reaches this Worker. */
  settings() {
    return this.call(`${this.script}/settings`);
  }

  /** The Worker's cron triggers (`{ schedules: [{ cron }] }`). */
  schedules() {
    return this.call(`${this.script}/schedules`);
  }

  /** The version that has 100% of traffic now, or null. */
  async current() {
    const result = await this.call(`${this.script}/deployments`);
    const latest = result?.deployments?.[0];
    const full = latest?.versions?.find((v) => v.percentage === 100) ?? latest?.versions?.[0];
    return full?.version_id ?? null;
  }

  /** Keeps a Worker secret (the install's own token). */
  putSecret(name, value) {
    return this.call(`${this.script}/secrets`, {
      method: 'PUT',
      body: JSON.stringify({ name, text: value, type: 'secret_text' }),
    });
  }

  deleteSecret(name) {
    return this.call(`${this.script}/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' });
  }

  /**
   * Uploads the web app's files and returns the completion token a version names them by. Files Cloudflare already
   * holds are not sent again.
   * @param {Map<string, Uint8Array>} files by served path
   */
  async uploadAssets(files) {
    /** @type {Record<string, { hash: string, size: number }>} */
    const manifest = {};
    /** @type {Map<string, { path: string, content: Uint8Array }>} */
    const byHash = new Map();
    for (const [path, content] of files) {
      const hash = await assetHash(content, path);
      manifest[path] = { hash, size: content.length };
      byHash.set(hash, { path, content });
    }
    const session = await this.call(`${this.script}/assets-upload-session`, {
      method: 'POST',
      body: JSON.stringify({ manifest }),
    });
    let jwt = session?.jwt;
    for (const bucket of session?.buckets ?? []) {
      const form = new FormData();
      for (const hash of bucket) {
        const file = byHash.get(hash);
        if (!file) continue;
        form.append(
          hash,
          new File([base64(file.content)], hash, { type: TYPES[extensionOf(file.path)] ?? 'application/octet-stream' }),
          hash,
        );
      }
      const done = await this.call(`${API}/accounts/${this.account}/workers/assets/upload?base64=true`, {
        method: 'POST',
        body: form,
        token: session.jwt,
      });
      if (done?.jwt) jwt = done.jwt;
    }
    if (!jwt) throw new CloudflareError(0, 'Cloudflare didn’t accept the web app’s files');
    return jwt;
  }

  /**
   * Uploads a Worker version (it takes no traffic until deployed) and returns its ID.
   * @param {{ main: string, modules: { name: string, type: string, content: Uint8Array | string }[] }} code
   * @param {Record<string, unknown>} metadata
   */
  async uploadVersion(code, metadata) {
    const form = new FormData();
    form.append(
      'metadata',
      new Blob([JSON.stringify({ ...metadata, main_module: code.main })], { type: 'application/json' }),
    );
    for (const m of code.modules) form.append(m.name, new File([m.content], m.name, { type: m.type }), m.name);
    const result = await this.call(`${this.script}/versions`, { method: 'POST', body: form });
    if (!result?.id) throw new CloudflareError(0, 'Cloudflare didn’t return the new version');
    return /** @type {string} */ (result.id);
  }

  /** Sends all traffic to `versionId`. */
  deploy(versionId, message) {
    return this.call(`${this.script}/deployments`, {
      method: 'POST',
      body: JSON.stringify({
        strategy: 'percentage',
        versions: [{ percentage: 100, version_id: versionId }],
        annotations: { 'workers/message': message.slice(0, 100) },
      }),
    });
  }
}
