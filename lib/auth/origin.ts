/** Browser requests must prove their origin. Agent keys are not driven by a browser,
    so only they may omit Origin; a cookie request without it is treated as cross-site. */
export function crossOrigin(request: Request, authKind?: "session" | "agent") {
  if (request.headers.get("sec-fetch-site") === "cross-site") return true;
  const origin = request.headers.get("origin");
  if (!origin) return authKind !== "agent";
  return origin !== new URL(request.url).origin;
}
