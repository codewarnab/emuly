import { PORTS } from "../../phone/runner/contracts.mjs";
import { APK_MAX_BYTES, isAppInstallStage, type AppInstall, type InstalledApp } from "./phone-apps-contract.ts";

/** A response failed its runtime contract. Never include the received payload in errors. */
export class PhoneResponseError extends Error {
  constructor() { super("Invalid phone response. Refresh status before retrying."); }
}

function requireField(condition: unknown): asserts condition {
  if (!condition) throw new PhoneResponseError();
}
function object(value: unknown): Record<string, unknown> {
  requireField(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
const text = (value: unknown, limit: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= limit;
const bytes = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= APK_MAX_BYTES;
const packageId = (value: unknown): value is string => text(value, 255) && /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(value);
const version = (value: unknown): value is string => text(value, 32) && /^\d+$/.test(value);
const code = (value: unknown): value is string => text(value, 128) && /^[a-z0-9_]+$/.test(value);

/** Validate fields that consumers use; retain extension fields for API compatibility. */
export function parseAppInventory(value: unknown): { apps: InstalledApp[]; fetchedAt?: string } {
  const result = object(value);
  requireField(Array.isArray(result.apps));
  for (const value of result.apps) {
    const app = object(value);
    requireField(packageId(app.packageId) && (app.versionCode === null || version(app.versionCode)) && typeof app.launchable === "boolean");
  }
  requireField(result.fetchedAt === undefined || (text(result.fetchedAt, 64) && Number.isFinite(Date.parse(result.fetchedAt))));
  return result as { apps: InstalledApp[]; fetchedAt?: string };
}

export function parseAppInstall(value: unknown): AppInstall {
  const result = object(value);
  requireField(text(result.id, 36) && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(result.id));
  requireField(result.source === "upload" || result.source === "url");
  requireField(text(result.filename, 255) && isAppInstallStage(result.stage));
  requireField(bytes(result.bytesReceived) && (result.totalBytes === null || (bytes(result.totalBytes) && result.totalBytes > 0)));
  requireField(result.totalBytes === null || result.bytesReceived <= result.totalBytes);
  requireField(typeof result.canCancel === "boolean");
  requireField(result.createdAt === undefined || (text(result.createdAt, 64) && Number.isFinite(Date.parse(result.createdAt))));
  requireField(result.updatedAt === undefined || (text(result.updatedAt, 64) && Number.isFinite(Date.parse(result.updatedAt))));
  requireField(result.packageId === undefined || packageId(result.packageId));
  requireField(result.versionCode === undefined || version(result.versionCode));
  requireField(result.errorCode === undefined || code(result.errorCode));
  requireField(result.message === undefined || text(result.message, 2048));
  return result as AppInstall;
}

export function parseAppInstalls(value: unknown): { operations: AppInstall[] } {
  const result = object(value);
  requireField(Array.isArray(result.operations));
  result.operations.forEach(parseAppInstall);
  return result as { operations: AppInstall[] };
}

/**
 * An error in the one API shape, `{ error: code, message }`. The runner still sends
 * `{ error: message, errorCode? }`; that form is read too and turned into the API shape.
 */
export function parsePhoneError(value: unknown): { error: string; message: string } {
  const result = object(value);
  if (result.message !== undefined) {
    requireField(code(result.error) && text(result.message, 2048));
    return { error: result.error as string, message: result.message as string };
  }
  requireField(text(result.error, 2048) && (result.errorCode === undefined || code(result.errorCode)));
  return { error: (result.errorCode as string | undefined) ?? "request_failed", message: result.error as string };
}

export function parseAppOpened(value: unknown): { ok: true } {
  const result = object(value);
  requireField(result.ok === true);
  return result as { ok: true };
}

/** The one fix for every `runner_update_required`: the agent can do it alone, with no click from the user. */
export function runnerUpdateMessage(id: string, what: string): string {
  return `${what} needs a newer phone runner. POST /v1/phones/${id}/apps/update and repeat it until it returns {"status":"ready"}, then retry. If it fails, stop and start the phone.`;
}

export function parseRunnerUpdate(value: unknown): { status: "ready" | "working" } {
  const result = object(value);
  requireField(result.status === "ready" || result.status === "working");
  return result as { status: "ready" | "working" };
}

export type DirectStreamTicket = { url: string; ticket: string };
export function parseStreamTicket(value: unknown): { ticket: string; attemptId?: string; direct?: DirectStreamTicket } {
  const result = object(value);
  requireField(text(result.ticket, 256) && /^[A-Za-z0-9_-]+$/.test(result.ticket));
  requireField(result.attemptId === undefined || text(result.attemptId, 128));
  // A bad direct part is dropped, not an error: the Vercel ticket still works.
  const direct = result.direct as { url?: unknown; ticket?: unknown } | undefined;
  const valid = direct && typeof direct === "object" && typeof direct.url === "string" && new RegExp(`^wss://[\\w-]{1,100}-${PORTS.DIRECT}\\.app\\.github\\.dev$`).test(direct.url)
    && typeof direct.ticket === "string" && direct.ticket.length <= 2048 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(direct.ticket);
  return { ticket: result.ticket as string, ...(result.attemptId !== undefined ? { attemptId: result.attemptId as string } : {}),
    ...(valid ? { direct: { url: direct.url as string, ticket: direct.ticket as string } } : {}) };
}

/** Decode JSON as unknown, then validate it before returning application data. */
export async function readPhoneResponse<T>(response: Response, parse: (value: unknown) => T): Promise<T> {
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new PhoneResponseError(); }
  return parse(value);
}

/** Only call for routes that passed the Apps API's method and path checks. */
export const FILE_FETCH_STAGES = ["downloading", "verifying", "pushing", "done", "failed", "cancelled"] as const;
export type FileFetch = {
  id: string; url_host: string; dest: string; stage: (typeof FILE_FETCH_STAGES)[number]; bytes_received: number;
  total_bytes: number | null; sha256?: string; content_type?: string | null; error_code?: string; message?: string;
  created_at: string; updated_at: string; can_cancel: boolean;
};
export const fileFetchFinished = (stage: string) => stage === "done" || stage === "failed" || stage === "cancelled";

/** A file fetch job (runner file-fetch.mjs). Only known fields pass through to the agent. */
export function parseFileFetch(value: unknown): FileFetch {
  const r = object(value);
  requireField(text(r.id, 36) && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(r.id));
  requireField(text(r.url_host, 255) && text(r.dest, 255) && (FILE_FETCH_STAGES as readonly unknown[]).includes(r.stage));
  requireField(bytes(r.bytes_received) && (r.total_bytes === null || bytes(r.total_bytes)));
  requireField(r.sha256 === undefined || (typeof r.sha256 === "string" && /^[a-f0-9]{64}$/.test(r.sha256)));
  requireField(r.content_type === undefined || r.content_type === null || (typeof r.content_type === "string" && r.content_type.length <= 200));
  requireField(r.error_code === undefined || code(r.error_code));
  requireField(r.message === undefined || text(r.message, 2048));
  requireField(text(r.created_at, 64) && text(r.updated_at, 64) && typeof r.can_cancel === "boolean");
  const out: FileFetch = { id: r.id, url_host: r.url_host, dest: r.dest, stage: r.stage as FileFetch["stage"],
    bytes_received: r.bytes_received, total_bytes: r.total_bytes as number | null, created_at: r.created_at, updated_at: r.updated_at,
    can_cancel: r.can_cancel };
  if (r.sha256 !== undefined) out.sha256 = r.sha256 as string;
  if (r.content_type !== undefined) out.content_type = r.content_type as string | null;
  if (r.error_code !== undefined) out.error_code = r.error_code as string;
  if (r.message !== undefined) out.message = r.message as string;
  return out;
}

export function parseFileFetches(value: unknown): { fetches: FileFetch[] } {
  const result = object(value);
  requireField(Array.isArray(result.fetches));
  return { fetches: result.fetches.map(parseFileFetch) };
}

export function parseAppsResponse(value: unknown, route: string, method: string) {
  if (route === "apps") return parseAppInventory(value);
  if (route === "apps/open") return parseAppOpened(value);
  if (route === "app-installs" && method === "GET") return parseAppInstalls(value);
  return parseAppInstall(value);
}
