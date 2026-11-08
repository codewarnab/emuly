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

export function parsePhoneError(value: unknown): { error: string; errorCode?: string } {
  const result = object(value);
  requireField(text(result.error, 2048) && (result.errorCode === undefined || code(result.errorCode)));
  return result as { error: string; errorCode?: string };
}

export function parseAppOpened(value: unknown): { ok: true } {
  const result = object(value);
  requireField(result.ok === true);
  return result as { ok: true };
}

export function parseRunnerUpdate(value: unknown): { status: "ready" | "working" } {
  const result = object(value);
  requireField(result.status === "ready" || result.status === "working");
  return result as { status: "ready" | "working" };
}

export function parseStreamTicket(value: unknown): { ticket: string; attemptId?: string } {
  const result = object(value);
  requireField(text(result.ticket, 256) && /^[A-Za-z0-9_-]+$/.test(result.ticket));
  requireField(result.attemptId === undefined || text(result.attemptId, 128));
  return result as { ticket: string; attemptId?: string };
}

/** Decode JSON as unknown, then validate it before returning application data. */
export async function readPhoneResponse<T>(response: Response, parse: (value: unknown) => T): Promise<T> {
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new PhoneResponseError(); }
  return parse(value);
}

/** Only call for routes that passed the Apps API's method and path checks. */
export function parseAppsResponse(value: unknown, route: string, method: string) {
  if (route === "apps") return parseAppInventory(value);
  if (route === "apps/open") return parseAppOpened(value);
  if (route === "app-installs" && method === "GET") return parseAppInstalls(value);
  return parseAppInstall(value);
}
