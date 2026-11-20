import { createHmac, timingSafeEqual } from "node:crypto";
import type { Client } from "@libsql/client";
import { finishBoot } from "./boot-finish.ts";

/**
 * Runner push events: the runner tells Emuly "boot.ready" or "boot.failed" at once, so the
 * phone does not wait for the next sync. Push is only a hint; the sync loop stays the backstop.
 *
 * Trust: the user controls the codespace, so an event can be false. Emuly
 * - accepts only events signed with the phone key (HMAC of the server secret and the codespace name);
 * - applies an event only to the boot attempt it names, while the row is still `booting`;
 * - asks the runner's /health before it marks a phone ready;
 * - uses its own clock, never a time from the codespace.
 * A repeated or late event changes nothing, so the runner sends no timestamp and no nonce.
 */

export const EVENTS_PATH = "/api/runner/events";
const KEY_LABEL = "emuly-runner-events-v1:";
const MAX_BODY = 1024;

/** The phone key for one codespace. Each server key gives one; the first is current. */
export function runnerEventKey(codespaceName: string, secret: string) {
  return createHmac("sha256", secret).update(`${KEY_LABEL}${codespaceName}`).digest("hex");
}

/**
 * The events URL from the server's own base URL. A new domain only needs a new EMULY_BASE_URL:
 * setup writes it, and each event answer carries it, so running phones follow.
 * Undefined when the base URL is not https (self-host on localhost: a codespace cannot reach it).
 */
export function runnerEventsUrl(baseUrl: string | undefined) {
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
  return /^https:\/\/[^\s/]+$/.test(base) ? `${base}${EVENTS_PATH}` : undefined;
}

/** The content of ~/emuly/.events in the codespace (phone/runner/events.mjs), or undefined: push off. */
export function runnerEventsFile(codespaceName: string, { baseUrl, secret }: { baseUrl?: string; secret?: string }) {
  const url = runnerEventsUrl(baseUrl);
  if (!url || !secret || !/^[\w-]{1,100}$/.test(codespaceName)) return undefined;
  return `${url}\n${runnerEventKey(codespaceName, secret)}\n${codespaceName}\n`;
}

export type RunnerEventDeps = {
  database: Client;
  /** Server keys, current first. An old key still checks during a key rotation. */
  secrets: string[];
  baseUrl?: string;
  /** Asks the runner's /health. True only when Android is booted. */
  confirmBooted: (userId: number, id: string) => Promise<boolean>;
  clock?: () => number;
  redact?: (message: string) => string;
};

type Result = "applied" | "already" | "stale" | "unconfirmed";

/** POST /api/runner/events. Answers 401 for a bad signature, 400 for a bad body, else 200 with the result. */
export async function handleRunnerEvent(request: Request, deps: RunnerEventDeps): Promise<Response> {
  const answer = (status: number, body: Record<string, unknown>) => Response.json(
    { ...body, events_url: runnerEventsUrl(deps.baseUrl) }, { status, headers: { "Cache-Control": "no-store" } });
  const codespace = request.headers.get("x-emuly-phone") ?? "";
  const body = await readLimited(request);
  if (body === undefined || !/^[\w-]{1,100}$/.test(codespace)) return answer(400, { error: "bad_request" });
  if (!signedByPhone(codespace, body, request.headers.get("x-emuly-signature") ?? "", deps.secrets)) return answer(401, { error: "bad_signature" });
  const event = parseEvent(body);
  if (!event) return answer(400, { error: "bad_event" });
  const result = await applyEvent(codespace, event, deps);
  return answer(200, { result });
}

/** The core: which boot the event names, whether it is still open, and whether Android is really up. */
async function applyEvent(codespace: string, event: { type: string; attempt: string }, deps: RunnerEventDeps): Promise<Result> {
  const row = (await deps.database.execute({ sql: `SELECT user_id, id, android_state, android_started_at FROM phones
    WHERE codespace_name = ? AND state = 'running'`, args: [codespace] })).rows[0];
  // No running phone, another attempt, or a boot that already ended: an old or early event.
  // An early event (before Emuly wrote "booting") is safe to drop: the sync loop joins the boot.
  if (!row || row.android_started_at !== event.attempt) return "stale";
  const booted = event.type === "boot.ready";
  if (row.android_state !== "booting") return row.android_state === (booted ? "ready" : "failed") ? "already" : "stale";
  const userId = Number(row.user_id); const id = String(row.id);
  if (booted && !(await deps.confirmBooted(userId, id).catch(() => false))) return "unconfirmed";
  return finishBoot(deps.database, { userId, id, attempt: event.attempt, booted }, (deps.clock ?? Date.now)(), deps.redact);
}

function signedByPhone(codespace: string, body: string, signature: string, secrets: string[]) {
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  const supplied = Buffer.from(signature, "hex");
  return secrets.some(secret => {
    const expected = createHmac("sha256", runnerEventKey(codespace, secret)).update(`emuly-runner-event-v1\n${body}`).digest();
    return timingSafeEqual(supplied, expected);
  });
}

function parseEvent(body: string) {
  try {
    const value = JSON.parse(body) as { type?: unknown; attempt?: unknown };
    if ((value.type === "boot.ready" || value.type === "boot.failed") && typeof value.attempt === "string" && value.attempt.length <= 40) {
      return { type: value.type, attempt: value.attempt };
    }
  } catch { /* A bad body is answered with 400 below. */ }
  return undefined;
}

async function readLimited(request: Request) {
  const text = await request.text().catch(() => undefined);
  return text !== undefined && text.length <= MAX_BODY ? text : undefined;
}
