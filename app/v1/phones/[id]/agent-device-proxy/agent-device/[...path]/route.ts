import { recordPhoneAgentDevice } from "../../../../../../../lib/phone/phone-activity";
import { agentDeviceCommand, agentDevicePath, agentDeviceUnavailable, bearerToken, proxyRequestHeaders } from "../../../../../../../lib/phone/agent-device";
import { runnerProxy } from "../../../../../../../lib/phone/phone-runner";

type Context = { params: Promise<{ id: string; path: string[] }> };

/**
 * Raw passthrough for the agent-device CLI. The CLI is not signed in to Emuly: it sends
 * `Authorization: Bearer <proxy token>`. That token is checked here against the digest stored
 * when GET /agent-device last handed it out, so an id alone cannot open a tunnel.
 */
async function route(request: Request, context: Context) {
  const { id, path } = await context.params;
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const target = agentDevicePath(path, new URL(request.url).search);
  if (!target) return Response.json({ error: "invalid_path" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  const command = await commandOf(request);
  try {
    return await runnerProxy(id, token, target, { method: request.method, headers: proxyRequestHeaders(request.headers),
      body: request.body, signal: request.signal },
      command === undefined ? undefined : (userId, status) => recordPhoneAgentDevice({ userId, phoneId: id, command, status }));
  } catch { return agentDeviceUnavailable(); }
}

/** Reads a copy of a small JSON body for the activity log. GET and file uploads are not logged. */
async function commandOf(request: Request): Promise<string | null | undefined> {
  if (request.method !== "POST") return undefined;
  if (!(request.headers.get("content-type") ?? "").includes("json")) return undefined;
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!length || length > 64_000) return null;
  try { return agentDeviceCommand(await request.clone().json()); } catch { return null; }
}

export { route as GET, route as POST, route as PUT, route as DELETE, route as PATCH };
