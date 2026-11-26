/**
 * Removes secrets from text before it reaches a log, an event or a user: each value in
 * `extraSecrets`, GitHub tokens (gh[opsu]_ and github_pat_), `token=`, `ticket=`, `secret=` and
 * `cookie=` values, and Authorization or Cookie header lines.
 */
export function redactSecrets(text: string, extraSecrets: readonly (string | null | undefined)[] = []): string {
  let out = text;
  for (const secret of extraSecrets) if (secret) out = out.replaceAll(secret, "[redacted]");
  return out
    .replace(/(?:gh[opsu]_|github_pat_)[A-Za-z0-9_]{8,}/g, "[redacted]")
    .replace(/\b(token|ticket|secret|cookies?)=[^&\s;]+/gi, "$1=[redacted]")
    .replace(/(authorization\s*[:=]\s*|cookie\s*[:=]\s*)[^\r\n]+/gi, "$1[redacted]");
}
