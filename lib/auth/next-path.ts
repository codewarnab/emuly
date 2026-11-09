/** Only same-site absolute paths may be used after sign-in. `//host` and `/\host` are rejected. */
export function safeNext(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2000 || !value.startsWith("/")) return null;
  try {
    const url = new URL(value, "https://emuly.invalid");
    if (url.origin !== "https://emuly.invalid") return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
