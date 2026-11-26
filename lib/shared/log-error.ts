/**
 * Logs that an error happened, with no detail that can hold a secret: only `where`, the error
 * name and its code (and the code of its cause). It never logs `error.message`.
 */
export function logError(where: string, error: unknown, log: (line: string) => void = console.error): void {
  const name = error instanceof Error ? error.name : typeof error;
  const code = (value: unknown) => {
    const raw = value && typeof value === "object" && "code" in value ? (value as { code: unknown }).code : undefined;
    return typeof raw === "string" || typeof raw === "number" ? String(raw).replace(/[^\w.-]/g, "_").slice(0, 40) : undefined;
  };
  const cause = error instanceof Error ? code(error.cause) : undefined;
  log(`[error] where=${where.replace(/[^\w.:-]/g, "_")} name=${name.replace(/[^\w]/g, "_")}`
    + `${code(error) ? ` code=${code(error)}` : ""}${cause ? ` cause=${cause}` : ""}`);
}
