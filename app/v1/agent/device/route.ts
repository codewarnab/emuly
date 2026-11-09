import { allowAgentDeviceStart } from "../../../../lib/auth/agent";
import { asyncDb } from "../../../../lib/data/async-db";
import { createDeviceCode } from "../../../../lib/data/agents";
import { env } from "../../../../lib/env";

/** Starts an RFC 8628 device login. No cookie or key is needed. */
export async function POST(request: Request) {
  const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
    Response.json(body, { status, headers: { "Cache-Control": "private, no-store", ...headers } });
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || request.headers.get("x-real-ip") || "unknown";
  if (!allowAgentDeviceStart(ip)) {
    return json({ error: "rate_limited", message: "Too many sign-in attempts. Wait a minute and try again." }, 429,
      { "Retry-After": "60" });
  }
  try {
    const { deviceCode, userCode, expiresIn, interval } = await createDeviceCode(asyncDb());
    return json({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${env.baseUrl}/link`,
      verification_uri_complete: `${env.baseUrl}/link?code=${encodeURIComponent(userCode)}`,
      expires_in: expiresIn,
      interval,
    });
  } catch {
    return json({ error: "request_failed", message: "The sign-in request could not be started. Try again." }, 500);
  }
}
