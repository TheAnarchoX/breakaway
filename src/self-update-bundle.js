/**
 * Reading a release's bundle for a Worker that updates itself (BRK-53, docs/specs/IDEA-20-self-updating-installs.md
 * section 3, step 2). The bundle (`breakaway-bundle.tar.gz`) holds `worker/` (src, package.json), `dist/` (the web
 * app), and `node_modules/` (the packages the Worker imports, BRK-56). Uploading a Worker version through the API
 * takes modules by name and no bundler, so this unpacks the tarball, names the modules the way their imports spell
 * them, and gives a bare import (`fflate`, `@noble/ciphers/chacha.js`) a small module of that name that re-exports the
 * package's file. Pure: nothing here calls Cloudflare.
 */
import { gunzipSync } from 'fflate';

const MAX_FILES = 5000;
const MAX_UNPACKED = 80 * 1024 * 1024;
const text = new TextDecoder();

/**
 * The files of a gzipped tarball, by path without a leading `./`.
 * @param {ArrayBuffer | Uint8Array} gz
 * @returns {Map<string, Uint8Array>}
 */
export function untar(gz) {
  const tar = gunzipSync(new Uint8Array(gz));
  if (tar.length > MAX_UNPACKED) throw new Error('the bundle is larger than expected');
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  const field = (at, len) => text.decode(tar.subarray(at, at + len)).replace(/\0.*$/su, '');
  let at = 0;
  while (at + 512 <= tar.length) {
    if (tar[at] === 0) break;
    const name = field(at, 100);
    const prefix = field(at + 345, 155);
    const size = Number.parseInt(field(at + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(tar[at + 156] || 48);
    if (!Number.isFinite(size) || size < 0) throw new Error('the bundle is not a valid tarball');
    const start = at + 512;
    if (type === '0') {
      const path = (prefix ? `${prefix}/${name}` : name).replace(/^(\.\/)+/u, '');
      if (path.split('/').includes('..') || path.startsWith('/')) throw new Error('the bundle holds an unsafe path');
      files.set(path, tar.slice(start, start + size));
      if (files.size > MAX_FILES) throw new Error('the bundle holds more files than expected');
    }
    at = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** `./a/b.js` joined onto the folder of `from` (a module name), with `..` resolved. */
function resolveFrom(from, spec) {
  const parts = from.split('/').slice(0, -1);
  for (const part of spec.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.' && part !== '') parts.push(part);
  }
  return parts.join('/');
}

/** The path of `to` as written from the folder of module `from`: `../../node_modules/x.js`. */
function relative(from, to) {
  const a = from.split('/').slice(0, -1);
  const b = to.split('/');
  while (a.length && b.length > 1 && a[0] === b[0]) {
    a.shift();
    b.shift();
  }
  return `${a.map(() => '..').join('/') || '.'}/${b.join('/')}`.replace(/^\.\/\.\.\//u, '../');
}

/** The file a package's `exports` entry (or `module`, `main`) names, for the conditions a Worker meets. */
function pick(entry) {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return null;
  for (const condition of ['workerd', 'worker', 'browser', 'import', 'default']) {
    if (condition in entry) {
      const found = pick(entry[condition]);
      if (found) return found;
    }
  }
  return null;
}

/** Where a bare import (`name`, `name/sub`, `@scope/name/sub`) lives in the bundle's node_modules, or null. */
function packageFile(spec, files) {
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const sub = spec.slice(name.length);
  const raw = files.get(`node_modules/${name}/package.json`);
  if (!raw) return null;
  let pkg;
  try {
    pkg = JSON.parse(text.decode(raw));
  } catch {
    return null;
  }
  const key = sub ? `.${sub}` : '.';
  const target =
    pkg.exports && typeof pkg.exports === 'object'
      ? pick(pkg.exports[key])
      : sub
        ? `.${sub}`
        : (pkg.module ?? pkg.main ?? 'index.js');
  if (!target) return null;
  const path = `node_modules/${name}/${target.replace(/^\.\//u, '')}`;
  return files.has(path) ? path : null;
}

/** Every specifier a module's source imports or re-exports from. */
function specifiers(source) {
  const found = [];
  for (const m of source.matchAll(
    /^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gmu,
  ))
    found.push(m[1] ?? m[2]);
  return found;
}

/**
 * @typedef {{ name: string, type: 'application/javascript+module' | 'application/json', content: Uint8Array | string }} WorkerModule
 */

/**
 * The modules of the Worker the bundle holds: its `worker/src` files and `worker/package.json` (named without
 * `worker/`, so `../package.json` from `src/build.js` finds it), the files of the packages they import, and a module
 * named for each bare import.
 * @param {Map<string, Uint8Array>} files
 * @returns {{ main: string, modules: WorkerModule[] }}
 */
export function workerModules(files) {
  /** @type {Map<string, WorkerModule>} */
  const modules = new Map();
  const add = (name, content) =>
    modules.set(name, {
      name,
      type: name.endsWith('.json') ? 'application/json' : 'application/javascript+module',
      content,
    });
  for (const [path, content] of files) {
    if (path === 'worker/package.json') add('package.json', content);
    else if (/^worker\/src\/.+\.(js|json)$/u.test(path) && !path.endsWith('.test.js'))
      add(path.slice('worker/'.length), content);
  }
  const main = 'src/worker.js';
  if (!modules.has(main)) throw new Error('the bundle holds no Worker (worker/src/worker.js)');

  // Packages: each bare import gets a module of that name; the package files it reaches come along.
  const queue = [...modules.values()].filter((m) => m.name.endsWith('.js'));
  const seen = new Set();
  while (queue.length) {
    const module = /** @type {WorkerModule} */ (queue.pop());
    if (seen.has(module.name)) continue;
    seen.add(module.name);
    for (const spec of specifiers(text.decode(/** @type {Uint8Array} */ (module.content)))) {
      if (/^[a-z]+:/u.test(spec)) continue; // cloudflare:workers, node:…
      if (/^\.{1,2}\//u.test(spec)) {
        const path = resolveFrom(module.name, spec);
        if (!modules.has(path) && files.has(path) && module.name.startsWith('node_modules/')) {
          add(path, files.get(path));
          queue.push(/** @type {WorkerModule} */ (modules.get(path)));
        }
        continue;
      }
      if (modules.has(spec)) continue;
      const file = packageFile(spec, files);
      if (!file) throw new Error(`the bundle is missing the package ${spec}`);
      const source = text.decode(/** @type {Uint8Array} */ (files.get(file)));
      const target = relative(spec, file);
      const hasDefault = /\bexport\s+default\b|\bexport\s*\{[^}]*\bdefault\b/u.test(source);
      add(spec, `export * from '${target}';\n${hasDefault ? `export { default } from '${target}';\n` : ''}`);
      if (!modules.has(file)) add(file, /** @type {Uint8Array} */ (files.get(file)));
      queue.push(/** @type {WorkerModule} */ (modules.get(file)));
    }
  }
  return { main, modules: [...modules.values()] };
}

/** The web app's files, from `dist/`, by the path they are served at (`/index.html`). */
export function assetFiles(files) {
  /** @type {Map<string, Uint8Array>} */
  const out = new Map();
  for (const [path, content] of files) if (path.startsWith('dist/')) out.set(`/${path.slice('dist/'.length)}`, content);
  if (!out.has('/index.html')) throw new Error('the bundle holds no web app (dist/index.html)');
  return out;
}
