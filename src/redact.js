/**
 * Secrets redacted before anything an agent session shows leaves it (docs/specs/CLD-35-cloud-agents.md):
 * the session hook (scripts/tasks/session-log.js) runs it on every entry, and the board runs it again on
 * what Connections shows. Pure, so it runs in the hook (Node) and in the Worker.
 */
const PATTERNS = [
  // Private keys, whole blocks.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, '[redacted key]'],
  // An install's own settings (breakaway's prefix and the legacy one): KEY=value where the name says it's secret.
  [
    /\b((?:BREAKAWAY|SAMEWAVE|CLOUDFLARE|GITHUB|ANTHROPIC)_[A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)[A-Z0-9_]*\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gu,
    '$1[redacted]',
  ],
  // Anthropic, GitHub, Slack-style tokens.
  [/\bsk-ant-[\w-]{8,}/gu, '[redacted]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/gu, '[redacted]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/gu, '[redacted]'],
  [/\bxox[abpr]-[\w-]{10,}/gu, '[redacted]'],
  // Bearer tokens in headers.
  [/(\bBearer\s+)[\w.~+/=-]{16,}/giu, '$1[redacted]'],
  // Long base64 blobs with mixed case and digits (keys, secrets); hex SHAs and UUIDs don't match.
  [
    /\b(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{32,}={0,2}/gu,
    '[redacted]',
  ],
];

export function redact(text) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, /** @type {string} */ (replacement));
  return out;
}
