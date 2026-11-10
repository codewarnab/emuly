import { agentDevicePath, agentDeviceUnavailable, bearerToken, proxyRequestHeaders } from "../../../../../../../lib/phone/agent-device";
import { runnerProxy } from "../../../../../../../lib/phone/phone-runner";

type Context = { params: Promise<{ id: string; path: string[] }> };

/**
 * Raw passthrough for the agent-device CLI. The CLI is not signed in to Emuly: it sends
 * `Authorization: Bearer <proxy token>`, and the runner's proxy validates that token.
 * Here we only require the credential's shape, find a running, ready, unblocked phone by id,
 * and stream the request through the codespace tunnel without buffering either body.
 */
async function route(request: Request, context: Context) {
  const { id, path } = await context.params;
  if (!bearerToken(request.headers.get("authorization"))) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const target = agentDevicePath(path, new URL(request.url).search);
  if (!target) return Response.json({ error: "invalid_path" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  try {
    return await runnerProxy(id, target, { method: request.method, headers: proxyRequestHeaders(request.headers),
      body: request.body, signal: request.signal });
  } catch { return agentDeviceUnavailable(); }
}

export { route as GET, route as POST, route as PUT, route as DELETE, route as PATCH };
