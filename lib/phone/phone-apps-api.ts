import "server-only";
import { APK_CHUNK_BYTES, APK_MAX_BYTES, installFinished } from "./phone-apps-contract.ts";
import type { AppsPath, AppsRequest } from "./phone-link.ts";
import type { sharedAppAdmission } from "./app-admission.ts";
import { PhoneResponseError, parseAppsResponse, parsePhoneError, parseRunnerUpdate, readPhoneResponse } from "./phone-response.ts";

type Phone = { state: string; android_state: string };
const global = globalThis as unknown as { __appAdmission?: Map<string, { userId: number; key: string; expires: number }>; __appTransfers?: number };
const admission = global.__appAdmission ??= new Map();
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
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

/** One authorization boundary for inventory, operations, binary upload and launch. */
export function createPhoneAppsApi({ user, phone, runner, upgrade, sharedAdmission }: {
  user: () => Promise<{ id: number } | null>;
  phone: (userId: number, id: string) => Phone | undefined | Promise<Phone | undefined>;
  runner: (userId: number, id: string, path: AppsPath, options: AppsRequest) => Promise<Response>;
  upgrade?: (userId: number, id: string) => Promise<{ status: string }>;
  sharedAdmission?: ReturnType<typeof sharedAppAdmission>;
}) {
  return async (request: Request, id: string, parts: string[]) => {
    let transfer = false;
    /** The account admission this request took, so a failed request can give it back. */
    let claimed: { userId: number; key: string } | null = null;
    try {
      const identity = await user();
      if (!identity) bad(401, "Sign in again.");
      const stored = await phone(identity.id, id);
      if (!stored) bad(404, "Phone not found.");
      if (stored.state !== "running" || stored.android_state !== "ready") bad(409, "Start the phone to use Apps.");
      if (request.method !== "GET") {
        const origin = request.headers.get("origin");
        // Non-browser clients such as an agent send no Origin. A present Origin must still be same-origin.
        if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") bad(403, "Forbidden.");
      }
      const route = parts.join("/");
      if (route === "apps/update" && request.method === "POST" && upgrade) {
        return Response.json(parseRunnerUpdate(await upgrade(identity.id, id)), { headers });
      }
      const resource = /^app-installs\/([0-9a-f-]{36})(?:\/(content|complete|cancel))?$/.exec(route);
      const allowed = (request.method === "GET" && (["apps", "app-installs"].includes(route) || (resource && !resource[2])))
        || (request.method === "POST" && (["apps/open", "app-installs"].includes(route) || (resource && ["complete", "cancel"].includes(resource[2]))))
        || (request.method === "PUT" && resource?.[2] === "content");
      if (!allowed) bad(404, "Apps route not found.");
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
            || typeof input.filename !== "string" || input.filename.length > 255 || !/\.apk$/i.test(input.filename))) bad(400, "Choose a standalone .apk file up to 250 MiB.");
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
          options.json = input.source === "upload" ? { source: "upload", key: input.key, filename: input.filename, totalBytes: input.totalBytes }
            : { source: "url", key: input.key, url: input.url };
        }
      }
      const response = await runner(identity.id, id, `/${route}` as AppsPath, options);
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
      return Response.json(payload, { status: response.ok && route === "app-installs" && request.method === "POST" ? 202 : response.status, headers });
    } catch (error) {
      // The claim named an operation the runner never created. Holding it would block
      // every retry on this account until the lease expired.
      if (claimed) try { await sharedAdmission?.release(claimed.userId, id, claimed.key); } catch {}
      if (error instanceof PhoneResponseError) return Response.json({ error: error.message, errorCode: "invalid_response" }, { status: 502, headers });
      return Response.json({ error: error instanceof InputError ? error.message : "Phone connection unavailable. Refresh status before retrying.", errorCode: error instanceof InputError ? "invalid_request" : "connection_unavailable" },
        { status: error instanceof InputError ? error.status : 502, headers });
    } finally { if (transfer) global.__appTransfers = Math.max(0, (global.__appTransfers ?? 1) - 1); }
  };
}
