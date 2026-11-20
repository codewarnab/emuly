import "server-only";
import { asyncDb } from "../data/async-db.ts";
import { seal } from "../auth/crypto.ts";
import { getAccessToken } from "../github/github-token.ts";
import { createGitHubClient } from "../github/github.ts";
import type { Codespace } from "../github/github.ts";
import { createPhoneService, PhoneInputError } from "./phone-mutations.ts";
import { createPhoneSetup } from "./phone-setup.ts";
import { runnerRequest, closeRunner } from "./phone-runner.ts";
import type { SyncError } from "../shared/sync-error.ts";
import { SELF_HOST } from "../selfhost.ts";
import { after } from "next/server";
import { createSyncGate } from "./sync-gate.ts";

// Share mutation guards across requests and development hot reloads.
// Hot reload keeps globalThis but runs this module again, so a service built by older code
// (an older setup script, missing methods) is rebuilt when the module's build mark changes.
const build = Symbol("phone-control build");
const global = globalThis as unknown as { __phoneControl?: ReturnType<typeof createPhoneService>; __phoneControlBuild?: symbol;
  __latestPhoneControl?: () => ReturnType<typeof createPhoneService> };
export function phoneControl() {
  if (global.__phoneControlBuild !== build) { global.__phoneControl = undefined; global.__phoneControlBuild = build; }
  return global.__phoneControl ??= createPhoneService({
    database: asyncDb(), github: createGitHubClient({ database: asyncDb(), accessToken: getAccessToken }), encrypt: seal,
    setup: createPhoneSetup({ token: userId => getAccessToken(userId) }),
    collectProgress: createPhoneSetup({ token: userId => getAccessToken(userId) }).collect,
    runner: runnerRequest, disconnect: closeRunner, // Off Vercel (self-host, the VM scheduler) the process lives on, so a boot runs in it.
    dispatchBoot: SELF_HOST || !process.env.VERCEL ? undefined : dispatchBoot,
    maxPhones: process.env.EMULY_MAX_PHONES ? Number(process.env.EMULY_MAX_PHONES) : undefined,
  });
}

// The poller starts once and keeps its first import; it calls through this, so it uses the newest code after a hot reload.
global.__latestPhoneControl = phoneControl;
export const latestPhoneControl = () => (global.__latestPhoneControl ?? phoneControl)();

/** The one gate for GitHub state syncs from pages and the scheduler. */
export function phoneSyncGate() {
  return createSyncGate({ database: asyncDb(), sync: userId => latestPhoneControl().sync(userId) });
}

/** Pages render from the database and call this; the sync runs after the response is sent. */
export function syncPhoneStateLater(userId: number) {
  after(async () => {
    try { await phoneSyncGate().run(userId, "due"); }
    catch { console.warn("Phone state sync could not start."); }
  });
}

/** The result of the last finished sync, or null. A database failure must not break the page. */
export async function lastSyncError(userId: number): Promise<SyncError | null> {
  try { return await phoneSyncGate().lastError(userId); } catch { return null; }
}

// The stream proxy checks the provider only after a WebSocket upgrade failed. A 5 s ceiling keeps
// the browser from waiting while still distinguishing a stopped codespace from a transient 401.
export async function codespaceSnapshot(userId: number, phoneId: string): Promise<Codespace> {
  const github = createGitHubClient({ database: asyncDb(), accessToken: getAccessToken });
  return github.getCodespace(userId, phoneId, { signal: AbortSignal.timeout(5000) });
}

/** Record an observed codespace state through the poller's own transition and event code. */
export async function recordCodespaceState(userId: number, phoneId: string, codespace: Codespace) {
  await phoneControl().observeCodespace(userId, phoneId, codespace);
}

// Phones run in a codespace of this repository, with .devcontainer/phone/devcontainer.json.
// emuly installs the emulator and runner over the codespace tunnel after GitHub reports
// the codespace Available. The repository is private for now: a user must be a collaborator
// to create a phone. github/codespaces-blank does not work here, because the github org
// blocks OAuth apps that it has not approved.
const PHONE_TEMPLATE = {
  repository: "codewarnab/emuly", repositoryId: 1448948156,
  devcontainerPath: ".devcontainer/phone/devcontainer.json",
};

export function templateRepository() {
  const custom = Boolean(process.env.EMULY_TEMPLATE_REPO);
  const repository = custom ? process.env.EMULY_TEMPLATE_REPO! : PHONE_TEMPLATE.repository;
  const repositoryId = custom ? Number(process.env.EMULY_TEMPLATE_REPOSITORY_ID) : PHONE_TEMPLATE.repositoryId;
  const devcontainerPath = custom ? process.env.EMULY_DEVCONTAINER_PATH || undefined : PHONE_TEMPLATE.devcontainerPath;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new PhoneInputError("EMULY_TEMPLATE_REPO needs a matching EMULY_TEMPLATE_REPOSITORY_ID. Unset both to use codewarnab/emuly.");
  }
  return { repository, repositoryId, devcontainerPath };
}

/**
 * On Vercel, a boot started as background work shares the time limit of the request that
 * started it. After a long setup that request can end before Android boots, and the result
 * is lost. So the boot runs in its own request, which answers at once and boots in waitUntil.
 */
async function dispatchBoot(userId: number, id: string): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!process.env.VERCEL || !secret) throw new Error("Boot dispatch needs Vercel and CRON_SECRET");
  const base = (process.env.EMULY_BASE_URL ?? "").replace(/\/$/, "");
  if (!/^https:\/\//.test(base)) throw new Error("Boot dispatch needs an https EMULY_BASE_URL");
  const response = await fetch(`${base}/api/internal/boot`, { method: "POST", cache: "no-store", redirect: "manual",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ userId, id }), signal: AbortSignal.timeout(15_000) });
  if (response.status !== 202) throw new Error(`Boot dispatch returned ${response.status}`);
}
