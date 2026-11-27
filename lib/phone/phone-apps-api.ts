import { apiError, NO_STORE } from "../http.ts";
import "server-only";
import { unknownRouteBody } from "../v1-routes.ts";
import { crossOrigin } from "../auth/origin.ts";
import { APK_CHUNK_BYTES, APK_MAX_BYTES, installFinished } from "./phone-apps-contract.ts";
import type { AppsPath, AppsRequest } from "./phone-link.ts";
import type { sharedAppAdmission } from "./app-admission.ts";
import { readAgentNote } from "./agent-note.ts";
import { PhoneResponseError, parseAppsResponse, parseFileFetch, parseFileFetches, parsePhoneError, parseRunnerUpdate, readPhoneResponse } from "./phone-response.ts";

type Phone = { state: string; android_state: string; codespace_name?: string | null };
/** A direct chunk URL and ticket for a browser upload (lib/phone/direct-stream.ts). */
export type DirectChunkTicket = { url: string; ticket: string; exp: number };
const global = globalThis as unknown as { __appAdmission?: Map<string, { userId: number; key: string; expires: number }>; __appTransfers?: number };
const admission = global.__appAdmission ??= new Map();
const headers = { "Cache-Control": NO_STORE, "X-Content-Type-Options": "nosniff" };
/** The API code for each refusal status. */
const CODES: Record<number, string> = { 401: "unauthorized", 403: "forbidden", 404: "not_found", 408: "timeout", 409: "phone_not_ready",
  413: "upload_too_large", 415: "invalid_input", 429: "rate_limited" };
class InputError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function bad(status: number, message: string): never { throw new InputError(status, message); }

async function readBounded(request: Request, limit: number) {
  if (Number(request.headers.get("content-length")) > limit) bad(413, "Request too large.");
  const reader = request.body?.getReader();
  if (!reader) bad(400, "Request body required.");
  const chunks: Uint8Array[] = []; let size = 0;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; void reader.cancel(); }, 30_000);
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); bad(413, "Request too large."); }
      chunks.push(value);
    }
  } finally { clearTimeout(timeout); reader.releaseLock(); }
  if (timedOut) bad(408, "The upload request timed out. Retry this chunk.");
  return Buffer.concat(chunks);
}

/**
 * POST file-fetches input. The runner checks it again (file-fetch.mjs) and also checks DNS;
 * this check only gives a quick, clear error. The URL is never logged in full.
 */
function fileFetchInput(input: unknown): Record<string, unknown> & { host: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) bad(400, "Send JSON {key, url, dest}.");
  const value = input as Record<string, unknown>;
  if (typeof value.key !== "string" || !/^[0-9a-f-]{36}$/.test(value.key)) bad(400, "key must be a UUID.");
  if (typeof value.url !== "string" || value.url.length > 4096) bad(400, "Enter a direct HTTPS download URL.");
  let url: URL;
  try { url = new URL(value.url); } catch { bad(400, "Enter a direct HTTPS download URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) bad(400, "Use HTTPS on port 443 without URL credentials or fragments.");
  if (typeof value.dest !== "string" || value.dest.length > 255 || !/^\/(?:sdcard|data\/local\/tmp)\/[A-Za-z0-9._/-]+$/.test(value.dest)
    || value.dest.split("/").some(part => part === ".." || part === ".") || value.dest.includes("//") || value.dest.endsWith("/"))
    bad(400, "dest must be a file path under /sdcard/ or /data/local/tmp/ with letters, digits, '.', '_', '-' and '/' only.");
  if (value.sha256 !== undefined && (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256))) bad(400, "sha256 must be 64 lowercase hex characters.");
  if (value.overwrite !== undefined && typeof value.overwrite !== "boolean") bad(400, "overwrite must be true or false.");
  // Only these fields reach the runner. The caller logs `host` and does not send it.
  return { key: value.key, url: value.url, dest: value.dest, ...(value.sha256 ? { sha256: value.sha256 } : {}),
    ...(value.overwrite !== undefined ? { overwrite: value.overwrite } : {}), host: url.hostname };
}

/** One authorization boundary for inventory, operations, binary upload and launch. */
export function createPhoneAppsApi({ user, phone, runner, upgrade, sharedAdmission, action, direct }: {
  user: () => Promise<{ id: number; authKind?: "session" | "agent"; agentKeyId?: number } | null>;
  /** An activity row for an agent's file fetch, with its X-Emuly-Note. Agent keys only. */
  action?: (call: { userId: number; phoneId: string; agentKeyId: number; label: string; command: string; note: string | null }) => void | Promise<void>;
  phone: (userId: number, id: string) => Phone | undefined | Promise<Phone | undefined>;
  runner: (userId: number, id: string, path: AppsPath, options: AppsRequest) => Promise<Response>;
  upgrade?: (userId: number, id: string) => Promise<{ status: string }>;
  sharedAdmission?: ReturnType<typeof sharedAppAdmission>;
  /**
   * A ticket so the browser can PUT chunks straight to the codespace, or undefined to keep the Vercel path.
   * Asked only for a signed-in browser (session and Origin) and an upload still in the "uploading" stage.
   */
  direct?: (input: { userId: number; phoneId: string; codespaceName: string; operationId: string; origin: string }) => Promise<DirectChunkTicket | undefined>;
}) {
  return async (request: Request, id: string, parts: string[]) => {
    let transfer = false;
    let fetchHost = "";
    /** The account admission this request took, so a failed request can give it back. */
    let claimed: { userId: number; key: string } | null = null;
    try {
      const identity = await user();
      if (!identity) bad(401, "Sign in again.");
      const stored = await phone(identity.id, id);
      if (!stored) bad(404, "Phone not found.");
      if (stored.state !== "running" || stored.android_state !== "ready") bad(409, "Start the phone to use Apps.");
      if (request.method !== "GET") {
        // Non-browser clients such as an agent send no Origin. A cookie request without
        // Origin, or any foreign Origin, is still rejected.
        if (crossOrigin(request, identity.authKind)) bad(403, "Forbidden.");
      }
      const route = parts.join("/");
      if (route === "apps/update" && request.method === "POST" && upgrade) {
        return Response.json(parseRunnerUpdate(await upgrade(identity.id, id)), { headers });
      }
      const resource = /^app-installs\/([0-9a-f-]{36})(?:\/(content|complete|cancel))?$/.exec(route);
      const fetchJob = /^file-fetches\/([0-9a-f-]{36})(?:\/(cancel))?$/.exec(route);
      const allowed = (request.method === "GET" && (["apps", "app-installs", "file-fetches"].includes(route) || (resource && !resource[2]) || (fetchJob && !fetchJob[2])))
        || (request.method === "POST" && (["apps/open", "app-installs", "file-fetches"].includes(route) || (resource && ["complete", "cancel"].includes(resource[2])) || fetchJob?.[2] === "cancel"))
        || (request.method === "PUT" && resource?.[2] === "content");
      if (!allowed) {
        const body = unknownRouteBody(request.method, new URL(request.url).pathname);
        return Response.json({ ...body, error: "not_found" }, { status: 404, headers });
      }
      const options: AppsRequest = { method: request.method as AppsRequest["method"], signal: request.signal };
      const admissionId = `${identity.id}:${id}`;
      let admissionKey = await sharedAdmission?.current(identity.id, id);
      if (request.method === "PUT") {
        if (request.headers.get("content-type") !== "application/octet-stream") bad(415, "Expected binary APK content.");
        if ((global.__appTransfers ?? 0) >= 6) bad(429, "Uploads are busy. Retry this chunk shortly.");
        global.__appTransfers = (global.__appTransfers ?? 0) + 1; transfer = true;
        options.offset = Number(request.headers.get("x-upload-offset"));
        options.digest = request.headers.get("x-chunk-sha256") ?? "";
        if (!/^\d+$/.test(request.headers.get("x-upload-offset") ?? "") || !Number.isSafeInteger(options.offset) || !/^[a-f0-9]{64}$/.test(options.digest)) bad(400, "Invalid upload offset or digest.");
        options.bytes = await readBounded(request, APK_CHUNK_BYTES);
        if (!options.bytes.length) bad(400, "Empty upload chunk.");
      } else if (request.method === "POST" && route === "file-fetches") {
        if (!request.headers.get("content-type")?.startsWith("application/json")) bad(415, "Expected JSON.");
        let input;
        try { input = JSON.parse((await readBounded(request, 8192)).toString("utf8")); }
        catch (error) { if (error instanceof InputError) throw error; bad(400, "Invalid JSON."); }
        const { host, ...body } = fileFetchInput(input);
        options.json = body; fetchHost = host;
      } else if (request.method === "POST" && ["apps/open", "app-installs"].includes(route)) {
        if (!request.headers.get("content-type")?.startsWith("application/json")) bad(415, "Expected JSON.");
        let input;
        try { input = JSON.parse((await readBounded(request, 8192)).toString("utf8")); }
        catch (error) { if (error instanceof InputError) throw error; bad(400, "Invalid JSON."); }
        if (!input || typeof input !== "object" || Array.isArray(input)) bad(400, "Invalid request.");
        if (route === "apps/open") {
          if (typeof input.packageId !== "string" || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(input.packageId) || input.packageId.length > 255) bad(400, "Invalid package ID.");
          options.json = { packageId: input.packageId };
        } else {
          if (!["url", "upload"].includes(input.source) || typeof input.key !== "string" || !/^[0-9a-f-]{36}$/.test(input.key)) bad(400, "Invalid installation request.");
          if (input.source === "upload" && (!Number.isSafeInteger(input.totalBytes) || input.totalBytes < 1 || input.totalBytes > APK_MAX_BYTES
            || typeof input.filename !== "string" || input.filename.length > 255 || !/\.apk$/i.test(input.filename))) bad(400, "Choose a standalone .apk file up to 1 GiB.");
          if (input.source === "url") {
            let url: URL;
            try { url = new URL(input.url); } catch { bad(400, "Enter a direct HTTPS download URL."); }
            if (typeof input.url !== "string" || input.url.length > 4096 || url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) bad(400, "Use HTTPS without URL credentials or fragments.");
          }
          if (sharedAdmission) {
            if (!await sharedAdmission.claim(identity.id, id, input.key)) bad(429, "Two installations are already active. Refresh their status first.");
            claimed = { userId: identity.id, key: input.key };
            admissionKey = input.key;
          } else {
          for (const [key, item] of admission) if (item.expires < Date.now()) admission.delete(key);
          const previous = admission.get(admissionId);
          if ((!previous || previous.key !== input.key) && [...admission.values()].filter(item => item.userId === identity.id).length >= 2) bad(429, "Two installations are already active. Refresh their status first.");
          admission.set(admissionId, { userId: identity.id, key: input.key, expires: Date.now() + 1_800_000 });
          }
          if (input.allowDowngrade !== undefined && typeof input.allowDowngrade !== "boolean") bad(400, "allowDowngrade must be true or false.");
          const downgrade = input.allowDowngrade === true ? { allowDowngrade: true } : {};
          options.json = input.source === "upload" ? { source: "upload", key: input.key, filename: input.filename, totalBytes: input.totalBytes, ...downgrade }
            : { source: "url", key: input.key, url: input.url, ...downgrade };
        }
      }
      const response = await runner(identity.id, id, `/${route}` as AppsPath, options);
      if (route.startsWith("file-fetches")) {
        const fetched = response.ok
          ? await readPhoneResponse(response, value => route === "file-fetches" && request.method === "GET" ? parseFileFetches(value) : parseFileFetch(value))
          : await readPhoneResponse(response, parsePhoneError);
        // Host only: a query string can hold a token.
        if (request.method === "POST" && route === "file-fetches") console.log(`[file-fetch] user=${identity.id} phone=${id} host=${fetchHost} status=${response.status}`);
        if (request.method === "POST" && route === "file-fetches" && response.ok && identity.agentKeyId !== undefined) {
          // Host only, never the full URL: a query string can hold a token.
          try {
            await action?.({ userId: identity.id, phoneId: id, agentKeyId: identity.agentKeyId, label: "Started a file download to the phone",
              command: `POST file-fetches ${fetchHost} -> ${String((options.json as { dest?: unknown }).dest)}`, note: readAgentNote(request) });
          } catch {}
        }
        return Response.json(fetched, { status: response.ok && route === "file-fetches" && request.method === "POST" ? 202 : response.status, headers });
      }
      const payload = response.ok
        ? await readPhoneResponse(response, value => parseAppsResponse(value, route, request.method))
        : await readPhoneResponse(response, parsePhoneError);
      const release = async () => {
        if (sharedAdmission && admissionKey) await sharedAdmission.release(identity.id, id, admissionKey);
        else admission.delete(admissionId);
      };
      if (response.ok && (resource || (route === "app-installs" && request.method === "POST"))
        && "stage" in payload && installFinished(payload.stage)) await release();
      if (response.ok && route === "app-installs" && request.method === "GET"
        && "operations" in payload && payload.operations.every(item => installFinished(item.stage))) await release();
      if (!response.ok && route === "app-installs" && request.method === "POST" && response.status !== 409) await release();
      // A browser upload gets a direct chunk ticket on create, and a new one on `GET app-installs/<id>?direct=1`.
      const wantsDirect = (route === "app-installs" && request.method === "POST")
        || (resource && !resource[2] && request.method === "GET" && new URL(request.url).searchParams.get("direct") === "1");
      // A same-origin GET carries no Origin header. Then Sec-Fetch-Site proves the page origin.
      const origin = request.headers.get("origin") && !crossOrigin(request, identity.authKind) ? request.headers.get("origin")
        : request.method === "GET" && request.headers.get("sec-fetch-site") === "same-origin" ? new URL(request.url).origin : null;
      let ticket: DirectChunkTicket | undefined;
      if (direct && wantsDirect && response.ok && identity.authKind !== "agent" && origin && stored.codespace_name
        && "stage" in payload && payload.stage === "uploading" && "source" in payload && payload.source === "upload" && "id" in payload) {
        try { ticket = await direct({ userId: identity.id, phoneId: id, codespaceName: stored.codespace_name, operationId: String(payload.id), origin }); }
        catch { ticket = undefined; }
      }
      return Response.json(ticket ? { ...payload, direct: ticket } : payload,
        { status: response.ok && route === "app-installs" && request.method === "POST" ? 202 : response.status, headers });
    } catch (error) {
      // The claim named an operation the runner never created. Holding it would block
      // every retry on this account until the lease expired.
      if (claimed) try { await sharedAdmission?.release(claimed.userId, id, claimed.key); } catch {}
      if (error instanceof PhoneResponseError) return apiError("invalid_response", error.message, 502, headers);
      if (error instanceof InputError) return apiError(CODES[error.status] ?? "invalid_input", error.message, error.status, headers);
      return apiError("connection_unavailable", "Phone connection unavailable. Refresh status before retrying.", 502, headers);
    } finally { if (transfer) global.__appTransfers = Math.max(0, (global.__appTransfers ?? 1) - 1); }
  };
}
