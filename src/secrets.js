/**
 * Reads a secret binding: a Secrets Store binding in production (`await binding.get()`), or a
 * plain string in tests and `wrangler dev` (`.dev.vars`).
 */
export async function secret(env, name) {
  const binding = env[name];
  if (!binding) throw new Error(`${name} is not configured`);
  return typeof binding === 'string' ? binding : binding.get();
}
