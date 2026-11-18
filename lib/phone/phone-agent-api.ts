import "server-only";
import { crossOrigin } from "../auth/origin.ts";
import { RateLimitError } from "../data/rate-limit.ts";
import { CoordinationBusyError } from "../data/coordination.ts";
import { GitHubError } from "../github/github.ts";
import {
  ADB_FILES_MAX, ADB_UPLOAD_MAX_BYTES, AdbError, adbArguments, adbResult, adbTimeout, isDownload, isScreencap,
} from "./phone-adb-contract.ts";
import { PhoneInputError, redact, type createPhoneService } from "./phone-mutations.ts";
import { agentDeviceBaseUrl, agentDeviceInfo, agentDeviceSession, agentDeviceUnavailable } from "./agent-device.ts";
import type { Phone } from "./phones.ts";
import type { RecordingAction } from "./phone-link.ts";

type Identity = { id: number; authKind?: "session" | "agent"; agentKeyId?: number };
type PhoneView = Pick<Phone, "id" | "name" | "state" | "android_state" | "idle_timeout_min"> & { device_preset?: string };
type AdbCall = { userId: number; phoneId: string; args: string[]; agentKeyId?: number; exitCode: number };

const WAIT_STATES = new Set(["stopped", "running", "ready"]);

/** Did the phone reach `target`, or did it fail on the way? */
export function waitResult(stored: Pick<PhoneView, "state" | "android_state">, target: string): { done: boolean; failed: boolean } {
  const done = target === "stopped" ? stored.state === "stopped"
    : target === "running" ? stored.state === "running"
    : stored.state === "running" && stored.android_state === "ready";
  const failed = !done && (stored.state === "error" || stored.state === "deleted"
    || (target === "ready" && stored.state === "running" && stored.android_state === "failed")
    || (target !== "stopped" && stored.state === "stopped"));
  return { done, failed };
}

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
export function createPhoneAgentApi({ user, phones, phone, service, adb, agentDevice, recording, baseUrl, log, update, skillUpdate, waitStepMs = 1_000 }: {
  user: () => Promise<Identity | null>;
  phones: (userId: number) => Promise<PhoneView[]>;
  phone: (userId: number, id: string) => Promise<PhoneView | undefined>;
  service: Pick<ReturnType<typeof createPhoneService>, "start" | "stop"> & Partial<Pick<ReturnType<typeof createPhoneService>, "requestStop">>;
  adb: (userId: number, id: string, input: { args: string[]; timeout_s: number; binary?: boolean;
    files?: { name: string; bytes: Uint8Array }[] }) => Promise<Response>;
  agentDevice: (userId: number, id: string) => Promise<unknown>;
  /** Screen recording on the runner. Optional so tests and older wiring need not supply it. */
  recording?: (userId: number, id: string, action: RecordingAction, body?: Record<string, unknown>) => Promise<Response>;
  baseUrl: () => string;
  log?: (call: AdbCall) => void | Promise<void>;
  /** Self-host only: a once-per-version "newer Emuly on GitHub" hint for the agent. */
  update?: () => Promise<unknown>;
  /** Hosted and self-host: a "newer skill on this server" hint, from the request headers. Null when current. */
  skillUpdate?: (request?: Request) => unknown;
  /** The wait between reads of a `wait_for` request. Tests make it short. */
  waitStepMs?: number;
}) {
  const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
    Response.json(body, { status, headers: { "Cache-Control": "private, no-store", ...headers } });
  const view = (stored: PhoneView) => ({
    id: stored.id, name: stored.name, state: stored.state, android_state: stored.android_state,
    idle_timeout_min: stored.idle_timeout_min, device_preset: stored.device_preset ?? "generic",
    browser_url: `${baseUrl().replace(/\/$/, "")}/app/phones/${encodeURIComponent(stored.id)}`,
  });
  const record = async (identity: Identity, id: string, args: string[], exitCode: number) => {
    try { await log?.({ userId: identity.id, phoneId: id, args, agentKeyId: identity.agentKeyId, exitCode }); } catch {}
  };
  const fail = (error: unknown, fallback: string) => {
    if (error instanceof GitHubError) return json({ error: "github_refused", message: redact(error.message) }, 409);
    if (error instanceof CoordinationBusyError) return json({ error: "busy", message: "Another request for this phone is still running. Retry in a few seconds." }, 409, { "Retry-After": "5" });
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
      if (operation === "stop") await (service.requestStop ?? service.stop)(identity.id, id);
      else await service.start(identity.id, id);
      const target = operation === "start" ? "ready" : "stopped";
      const wait = `/v1/phones/${encodeURIComponent(id)}?wait_for=${target}&timeout_s=60`;
      return json({ id, status: operation === "start" ? "starting" : "stopping", wait,
        message: operation === "start"
          ? `Start accepted. GET ${wait} answers when Android is ready, or after 60 s. Repeat it until done is true.`
          : `Stop accepted. Android saves its state, then GitHub stops the codespace. GET ${wait} answers when the phone is stopped, or after 60 s.` }, 202);
    } catch (error) {
      return fail(error, `The ${operation} request could not be confirmed. Check the phone before retrying.`);
    }
  }
  return {
    async list(request?: Request) {
      const identity = await user();
      if (!identity) return json({ error: "unauthorized" }, 401);
      try {
        const [list, hint] = await Promise.all([phones(identity.id), update?.().catch(() => null)]);
        const skill = skillUpdate?.(request);
        return json({ phones: list.map(view), ...(hint ? { update: hint } : {}), ...(skill ? { skill_update: skill } : {}) });
      }
      catch { return json({ error: "request_failed", message: "The phone list could not be loaded." }, 502); }
    },
    /**
     * `?wait_for=stopped|running|ready&timeout_s=1..120` holds the request until the phone reaches
     * that state, fails, or the time ends. One request replaces a loop of polls.
     */
    async read(request: Request, id: string) {
      const identity = await user();
      if (!identity) return json({ error: "unauthorized" }, 401);
      const params = new URL(request.url).searchParams;
      const waitFor = params.get("wait_for");
      if (waitFor !== null && !WAIT_STATES.has(waitFor)) {
        return json({ error: "invalid_input", message: "wait_for is stopped, running or ready." }, 400);
      }
      const timeoutRaw = params.get("timeout_s") ?? "60";
      if (!/^\d{1,3}$/.test(timeoutRaw) || Number(timeoutRaw) < 1 || Number(timeoutRaw) > 120) {
        return json({ error: "invalid_input", message: "timeout_s is a whole number from 1 to 120." }, 400);
      }
      const deadline = Date.now() + Number(timeoutRaw) * 1000;
      try {
        for (;;) {
          const stored = await phone(identity.id, id);
          if (!stored) return json({ error: "not_found", message: "Phone not found." }, 404);
          if (waitFor === null) return json(view(stored));
          const result = waitResult(stored, waitFor);
          if (result.done || result.failed || Date.now() >= deadline || request.signal.aborted) {
            return json({ ...view(stored), wait: { for: waitFor, ...result, timed_out: !result.done && !result.failed } });
          }
          await new Promise(resolve => setTimeout(resolve, Math.min(waitStepMs, Math.max(0, deadline - Date.now()))));
        }
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
    /**
     * Screen recording: POST start ({quality?, max_s?}), POST stop, GET status, GET file (MP4), POST discard.
     * The runner muxes the H.264 stream the viewers already get, so a recording starts no second encoder.
     */
    async recording(request: Request, id: string, action: string) {
      const identity = await user();
      if (!identity) return json({ error: "unauthorized" }, 401);
      if (crossOrigin(request, identity.authKind)) return json({ error: "forbidden" }, 403);
      const methods: Record<string, { method: string; action: RecordingAction }> = {
        start: { method: "POST", action: "start" }, stop: { method: "POST", action: "stop" },
        discard: { method: "POST", action: "discard" }, status: { method: "GET", action: "status" },
        file: { method: "GET", action: "file" } };
      const route = Object.hasOwn(methods, action) ? methods[action] : undefined;
      if (!route) return json({ error: "not_found", message: "Use recording/start, recording/stop, recording/status, recording/file or recording/discard." }, 404);
      if (route.method !== request.method) return json({ error: "method_not_allowed", message: `Use ${route.method} for recording/${action}.` }, 405, { Allow: route.method });
      if (!recording) return json({ error: "not_available", message: "Recording is not available on this server." }, 503);
      try {
        const stored = await phone(identity.id, id);
        if (!stored) return json({ error: "not_found", message: "Phone not found." }, 404);
        if (stored.state !== "running" || (action === "start" && stored.android_state !== "ready")) {
          return json({ error: "phone_not_ready",
            message: `The phone is ${stored.state} with Android ${stored.android_state}. Start it with POST /v1/phones/${id}/start, then retry when GET /v1/phones/${id} shows running and ready.` }, 409);
        }
        let body: Record<string, unknown> | undefined;
        if (route.action === "start") {
          const raw = request.headers.get("content-length") === "0" || !request.body ? {} : await readJson(request, 4 * 1024);
          body = {};
          if (raw.quality !== undefined) body.quality = raw.quality;
          if (raw.max_s !== undefined) body.max_s = raw.max_s;
        }
        const response = await recording(identity.id, id, route.action, body);
        if (response.headers.get("content-type")?.startsWith("video/mp4")) {
          const headers = new Headers({ "Content-Type": "video/mp4", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
          for (const name of ["content-length", "content-disposition"]) { const value = response.headers.get(name); if (value) headers.set(name, value); }
          return new Response(response.body, { headers });
        }
        let value: Record<string, unknown> = {};
        try { value = await response.json() as Record<string, unknown>; } catch {}
        // A runner without the recording routes answers its generic 404 with no errorCode.
        if (response.status === 404 && typeof value.errorCode !== "string") {
          return json({ error: "runner_update_required", message: "Update the phone runner before recording." }, 503);
        }
        if (!response.ok) {
          const code = typeof value.errorCode === "string" ? value.errorCode : "recording_failed";
          const message = typeof value.error === "string" ? value.error : "The recording request failed. Retry.";
          return json({ error: code, message }, [400, 404, 409, 503].includes(response.status) ? response.status : 502);
        }
        return json(value);
      } catch (error) {
        if (error instanceof InputError) return json({ error: "invalid_input", message: error.message }, error.status);
        return fail(error, "The recording request could not be confirmed. Retry.");
      }
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
