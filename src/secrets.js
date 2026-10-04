import { SECRET_KEYS } from './install.js';

/**
 * Reads a secret binding: a Secrets Store binding in production (`await binding.get()`), or a
 * plain string in tests and `wrangler dev` (`.dev.vars`).
 */
export async function secret(env, name) {
  const binding = env[name];
  if (!binding) throw new Error(`${name} is not configured`);
  return typeof binding === 'string' ? binding : binding.get();
}

/**
 * Whether each bound secret can be read, as names only, never a value: the names of the Secrets Store bindings
 * (`TASKS_<key>`) whose `get()` throws. A binding that is a plain string (tests, `wrangler dev`)
 * reads. The deploy's and the self-update's health check use it, since a version whose bindings can't be read
 * answers /api/ping and then fails every request that needs a secret (BRK-96).
 * @param {Record<string, any>} env
 * @returns {Promise<string[]>}
 */
export async function unreadableSecrets(env) {
  const names = SECRET_KEYS.map((key) => `TASKS_${key}`).filter((name) => env?.[name]);
  const results = await Promise.all(
    names.map(async (name) => {
      try {
        await secret(env, name);
        return true;
      } catch {
        return false;
      }
    }),
  );
  return names.filter((_, i) => !results[i]);
}
