/** Agent keys have a deliberately smaller surface than a browser session.
    Routes call this after authentication and return the response unchanged. */
export function forbidAgent(user: { authKind?: "session" | "agent" }, message: string): Response | null {
  if (user.authKind !== "agent") return null;
  return Response.json({ error: "forbidden", message },
    { status: 403, headers: { "Cache-Control": "private, no-store" } });
}

export const AGENT_SETTINGS_MESSAGE = "Agent keys cannot change account settings. Use the Emuly console.";
export const AGENT_WEBHOOK_MESSAGE = "Agent keys can create and list webhooks, but cannot change, test or delete them. Use the Emuly console.";
export const AGENT_DELETE_PHONE_MESSAGE = "Agent keys cannot delete a phone. Delete it in the Emuly console.";
