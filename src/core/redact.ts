// RL-1: best-effort secret redaction of text a machine sends to the hub (artifacts, transcripts).

const PEM = /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g;
const TOKENS = [
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9]{32,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
];
const ASSIGNMENT = /\b(password|passwd|secret|token|api[_-]?key)(\s*[=:]\s*)(["']?)([^\s"']{6,})\3/gi;
const MARK = "[REDACTED";
const WHOLE_MARK = /^\[REDACTED[^\]]*\]$/;

/**
 * Replaces private key blocks, the given literals (each at least 8 characters), known token forms
 * and `password=…`-style values with `[REDACTED…]`, in this order: PEM blocks, literals, tokens,
 * assignments. `count` is the number of secrets replaced, each counted once: an assignment whose value
 * is exactly a redaction mark is left as it is, and one whose value contains a mark among other text is
 * redacted whole, in both cases without being counted again.
 */
export function redactSecrets(text: string, literals?: readonly string[]): { text: string; count: number } {
  let count = 0;
  let out = text.replace(PEM, () => {
    count++;
    return "[REDACTED private key]";
  });
  for (const l of literals ?? []) {
    if (!l || l.length < 8) continue;
    const parts = out.split(l);
    if (parts.length > 1) {
      count += parts.length - 1;
      out = parts.join("[REDACTED]");
    }
  }
  for (const re of TOKENS) {
    out = out.replace(re, () => {
      count++;
      return "[REDACTED]";
    });
  }
  out = out.replace(ASSIGNMENT, (m: string, key: string, sep: string, q: string, value: string) => {
    // `[REDACTED private key]` stops at its first space, so a bare `[REDACTED` is a whole mark too.
    if (WHOLE_MARK.test(value) || value === MARK) return m;
    // A value that holds a secret an earlier pass replaced (with text around it): redact all of it,
    // so no tail is kept, but the secret was counted already.
    if (!value.includes(MARK)) count++;
    return `${key}${sep}${q}[REDACTED]${q}`;
  });
  return { text: count ? out : text, count };
}
