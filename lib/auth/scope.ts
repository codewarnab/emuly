import { env } from "../env.ts";

/** Agent keys have a deliberately smaller surface than a browser session.
    Routes call this after authentication and return the response unchanged.
    Every denial names the exact Settings or phone page that can do the action. */
export function forbidAgent(user: { authKind?: "session" | "agent" }, message: string,
  managePath: string): Response | null {
  if (user.authKind !== "agent") return null;
  return Response.json({ error: "forbidden", message, manage_url: manageUrl(managePath) },
    { status: 403, headers: { "Cache-Control": "private, no-store" } });
}

/** An absolute link even when the request reached the app through an internal host. */
export function manageUrl(path: string) {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  try { return `${env.baseUrl}${suffix}`; }
  catch { return suffix; }
}

export const AGENT_DEVICE_MESSAGE = "Agent keys cannot approve sign-in requests. Open manage_url to do this yourself.";
export const AGENT_SETTINGS_MESSAGE = "Agent keys cannot change account settings. Open manage_url to do this yourself.";
export const AGENT_WEBHOOK_MESSAGE = "Agent keys can create and list webhooks, but cannot change, test or delete them. Open manage_url to do this yourself.";
export const AGENT_DELETE_PHONE_MESSAGE = "Agent keys cannot delete a phone without approval. Open manage_url to do this yourself.";
