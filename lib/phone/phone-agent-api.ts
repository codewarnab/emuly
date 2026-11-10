import "server-only";
import { crossOrigin } from "../auth/origin.ts";
import { RateLimitError } from "../data/rate-limit.ts";
import { GitHubError } from "../github/github.ts";
import {
  ADB_FILES_MAX, ADB_UPLOAD_MAX_BYTES, AdbError, adbArguments, adbResult, adbTimeout, isDownload, isScreencap,
} from "./phone-adb-contract.ts";
import { PhoneInputError, redact, type createPhoneService } from "./phone-mutations.ts";
import { agentDeviceBaseUrl, agentDeviceInfo, agentDeviceSession, agentDeviceUnavailable } from "./agent-device.ts";
import type { Phone } from "./phones.ts";

type Identity = { id: number; authKind?: "session" | "agent"; agentKeyId?: number };
type PhoneView = Pick<Phone, "id" | "name" | "state" | "android_state" | "idle_timeout_min">;
type AdbCall = { userId: number; phoneId: string; args: string[]; agentKeyId?: number; exitCode: number };

class InputError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function bad(status: number, message: string): never { throw new InputError(status, message); }

async function readJson(request: Request, limit: number): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) bad(415, "Expected JSON.");
  if (Number(request.headers.get("content-length")) > limit) bad(413, "Request too large.");
  const reader = request.body?.getReader();
  if (!reader) bad(400, "Request body required.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); bad(413, "Request too large."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { bad(400, "Invalid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) bad(400, "Expected a JSON object.");
  return value as Record<string, unknown>;
}

type UploadedFile = { name: string; bytes: Buffer };

/** Multipart adb carries `args` plus file0, file1, … . The client never names a runner path. */
async function readAdbMultipart(request: Request): Promise<{ args: unknown; timeout?: number; files: UploadedFile[] }> {
  if (Number(request.headers.get("content-length")) > ADB_UPLOAD_MAX_BYTES + 2 * 1024 * 1024) {
    bad(413, `Attach at most ${ADB_UPLOAD_MAX_BYTES / (1024 * 1024)} MB in total.`);
  }
  let form: FormData;
  try { form = await request.formData(); }
  catch { bad(400, "Send multipart/form-data with args and file0, file1, …"); }
  const rawArgs = form.get("args");
  if (typeof rawArgs !== "string") bad(400, "The args field must be a JSON array of strings.");
  let args: unknown;
  try { args = JSON.parse(rawArgs); }
  catch { bad(400, "The args field must be valid JSON."); }
  const rawTimeout = form.get("timeout_s");
  let timeout: number | undefined;
  if (rawTimeout !== null) {
    if (typeof rawTimeout !== "string" || !/^\d+$/.test(rawTimeout)) bad(400, "timeout_s must be a whole number.");
    timeout = Number(rawTimeout);
  }
  const files: UploadedFile[] = [];
  let total = 0;
  for (const [key, value] of form.entries()) {
    if (key === "args" || key === "timeout_s") continue;
    const match = /^file(0|[1-9]\d*)$/.exec(key);
    if (!match || typeof value === "string" || typeof value.arrayBuffer !== "function") {
      bad(400, "Attach files as file0, file1, … and nothing else.");
    }
    const index = Number(match[1]);
    if (index !== files.length) bad(400, "Attach file0, file1, … without gaps.");
    if (files.length >= ADB_FILES_MAX) bad(400, `Attach at most ${ADB_FILES_MAX} files.`);
    const bytes = Buffer.from(await value.arrayBuffer());
    total += bytes.length;
    if (total > ADB_UPLOAD_MAX_BYTES) bad(413, `Attach at most ${ADB_UPLOAD_MAX_BYTES / (1024 * 1024)} MB in total.`);
    files.push({ name: value.name || `file${index}`, bytes });
  }
  return { args, timeout, files };
}

/** The agent-facing phone routes: list/read plus lifecycle and adb. Both auth kinds may use them. */
export function createPhoneAgentApi({ user, phones, phone, service, adb, agentDevice, baseUrl, log }: {
  user: () => Promise<Identity | null>;
  phones: (userId: number) => Promise<PhoneView[]>;
  phone: (userId: number, id: string) => Promise<PhoneView | undefined>;
  service: Pick<ReturnType<typeof createPhoneService>, "start" | "stop">;
  adb: (userId: number, id: string, input: { args: string[]; timeout_s: number; binary?: boolean;
    files?: { name: string; bytes: Uint8Array }[] }) => Promise<Response>;
  agentDevice: (userId: number, id: string) => Promise<unknown>;
  baseUrl: () => string;
  log?: (call: AdbCall) => void | Promise<void>;
}) {
  const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
    Response.json(body, { status, headers: { "Cache-Control": "private, no-store", ...headers } });
  const view = (stored: PhoneView) => ({
    id: stored.id, name: stored.name, state: stored.state, android_state: stored.android_state,
    idle_timeout_min: stored.idle_timeout_min,
    browser_url: `${baseUrl().replace(/\/$/, "")}/app/phones/${encodeURIComponent(stored.id)}`,
  });
  const record = async (identity: Identity, id: string, args: string[], exitCode: number) => {
    try { await log?.({ userId: identity.id, phoneId: id, args, agentKeyId: identity.agentKeyId, exitCode }); } catch {}
  };
  const fail = (error: unknown, fallback: string) => {
    if (error instanceof GitHubError) return json({ error: "github_refused", message: redact(error.message) }, 409);
    if (error instanceof RateLimitError) return json({ error: "rate_limited", message: error.message }, 429, { "Retry-After": String(error.retryAfter) });
    if (error instanceof PhoneInputError || error instanceof AdbError) return json({ error: "invalid_input", message: error.message }, 400);
    if (error instanceof InputError) return json({ error: "invalid_input", message: error.message }, error.status);
    return json({ error: "request_failed", message: fallback }, 502);
  };
  async function change(request: Request, id: string, operation: "start" | "stop") {
    const identity = await user();
    if (!identity) return json({ error: "unauthorized" }, 401);
    if (crossOrigin(request, identity.authKind)) return json({ error: "forbidden" }, 403);
    try {
      await service[operation](identity.id, id);
      return json({ id, status: operation === "start" ? "starting" : "stopping" }, 202);
    } catch (error) {
      return fail(error, `The ${operation} request could not be confirmed. Check the phone before retrying.`);
    }
  }
  return {
    async list() {
      const identity = await user();
      if (!identity) return json({ error: "unauthorized" }, 401);
      try { return json({ phones: (await phones(identity.id)).map(view) }); }
      catch { return json({ error: "request_failed", message: "The phone list could not be loaded." }, 502); }
    },
    async read(_request: Request, id: string) {
      const identity = await user();
      if (!identity) return json({ error: "unauthorized" }, 401);
      try {
        const stored = await phone(identity.id, id);
        return stored ? json(view(stored)) : json({ error: "not_found", message: "Phone not found." }, 404);
      } catch { return json({ error: "request_failed", message: "The phone could not be loaded." }, 502); }
    },
    start: (request: Request, id: string) => change(request, id, "start"),
    stop: (request: Request, id: string) => change(request, id, "stop"),
    async agentDevice(request: Request, id: string) {
      const identity = await user();
      if (!identity) return json({ error: "unauthorized" }, 401);
      if (crossOrigin(request, identity.authKind)) return json({ error: "forbidden" }, 403);
      try {
        const stored = await phone(identity.id, id);
        if (!stored || stored.state !== "running" || stored.android_state !== "ready") return agentDeviceUnavailable();
        const info = agentDeviceInfo(await agentDevice(identity.id, id));
        if (!info) return agentDeviceUnavailable();
        // The token is relayed to the caller and never logged here or by the runner.
        return Response.json({ base_url: agentDeviceBaseUrl(baseUrl(), id), token: info.token, version: info.version,
          session: agentDeviceSession(id) }, { headers: { "Cache-Control": "no-store" } });
      } catch { return agentDeviceUnavailable(); }
    },
    async adb(request: Request, id: string) {
      const identity = await user();
      if (!identity) return json({ error: "unauthorized" }, 401);
      if (crossOrigin(request, identity.authKind)) return json({ error: "forbidden" }, 403);
      let args: string[] = [];
      let loggable = false;
      try {
        const stored = await phone(identity.id, id);
        if (!stored) return json({ error: "not_found", message: "Phone not found." }, 404);
        if (stored.state !== "running" || stored.android_state !== "ready") {
          return json({ error: "phone_not_ready",
            message: `The phone is ${stored.state} with Android ${stored.android_state}. Start it with POST /v1/phones/${id}/start, then retry when GET /v1/phones/${id} shows running and ready.` }, 409);
        }
        const multipart = request.headers.get("content-type")?.startsWith("multipart/form-data") === true;
        let argsValue: unknown;
        let timeoutValue: unknown;
        let uploaded: UploadedFile[] = [];
        if (multipart) {
          const form = await readAdbMultipart(request);
          argsValue = form.args;
          timeoutValue = form.timeout;
          uploaded = form.files;
        } else {
          const body = await readJson(request, 64 * 1024);
          argsValue = body.args;
          timeoutValue = body.timeout_s;
        }
        args = adbArguments(argsValue, uploaded.length);
        const timeout_s = adbTimeout(timeoutValue, args);
        loggable = true;
        const download = isDownload(args);
        const binary = download || request.headers.get("accept")?.includes("image/png") === true || isScreencap(args);
        const files = uploaded.length
          ? uploaded.map(file => ({ name: file.name, bytes: file.bytes }))
          : undefined;
        const response = await adb(identity.id, id, { args, timeout_s, binary, ...(files ? { files } : {}) });
        if (!response.ok) {
          await record(identity, id, args, -1);
          let message = "adb could not run. Try again.";
          try {
            const value: unknown = await response.json();
            if (value && typeof value === "object" && typeof (value as Record<string, unknown>).error === "string") {
              message = (value as Record<string, string>).error;
            }
          } catch {}
          if (response.status === 404 || response.status === 405) {
            return json({ error: "runner_update_required", message: "Update the phone runner before using adb." }, 503);
          }
          const status = [400, 409, 413, 504].includes(response.status) ? response.status : 502;
          const error = status === 409 ? "phone_conflict" : status === 413 ? "output_too_large"
            : status === 504 ? "adb_timeout" : "adb_failed";
          return json({ error, message }, status);
        }
        if (binary) {
          const bytes = await response.arrayBuffer();
          await record(identity, id, args, 0);
          const headers: Record<string, string> = { "Content-Type": "image/png", "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff" };
          if (download) {
            headers["Content-Type"] = response.headers.get("content-type") ?? "application/octet-stream";
            const disposition = response.headers.get("content-disposition");
            if (disposition) headers["Content-Disposition"] = disposition;
          }
          return new Response(bytes, { headers });
        }
        let payload: unknown;
        try { payload = await response.json(); }
        catch { await record(identity, id, args, -1); return json({ error: "invalid_response", message: "Invalid adb response. Retry the command." }, 502); }
        try {
          const result = adbResult(payload);
          await record(identity, id, args, result.exit_code);
          return json(result);
        } catch {
          await record(identity, id, args, -1);
          return json({ error: "invalid_response", message: "Invalid adb response. Retry the command." }, 502);
        }
      } catch (error) {
        if (loggable) await record(identity, id, args, -1);
        if (error instanceof InputError) return json({ error: "invalid_input", message: error.message }, error.status);
        return fail(error, "The adb request could not be confirmed. Retry the command.");
      }
    },
  };
}
