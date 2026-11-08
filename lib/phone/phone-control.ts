import "server-only";
import { db } from "../data/db.ts";
import { seal } from "../auth/crypto.ts";
import { getAccessToken } from "../github/github-token.ts";
import { createGitHubClient } from "../github/github.ts";
import { createPhoneService, PhoneInputError } from "./phone-mutations.ts";
import { createPhoneSetup } from "./phone-setup.ts";
import { runnerRequest, closeRunner } from "./phone-runner.ts";
import { syncError, type SyncError } from "../shared/sync-error.ts";

// Share mutation guards across requests and development hot reloads.
// Hot reload keeps globalThis but runs this module again, so a service built by older code
// (an older setup script, missing methods) is rebuilt when the module's build mark changes.
const build = Symbol("phone-control build");
const global = globalThis as unknown as { __phoneControl?: ReturnType<typeof createPhoneService>; __phoneControlBuild?: symbol;
  __latestPhoneControl?: () => ReturnType<typeof createPhoneService> };
export function phoneControl() {
  if (global.__phoneControlBuild !== build) { global.__phoneControl = undefined; global.__phoneControlBuild = build; }
  return global.__phoneControl ??= createPhoneService({
    database: db(), github: createGitHubClient({ database: db(), accessToken: getAccessToken }), encrypt: seal,
    setup: createPhoneSetup({ token: userId => getAccessToken(userId) }),
    collectProgress: createPhoneSetup({ token: userId => getAccessToken(userId) }).collect,
    runner: runnerRequest, disconnect: closeRunner,
    maxPhones: process.env.PHONELINK_MAX_PHONES ? Number(process.env.PHONELINK_MAX_PHONES) : undefined,
  });
}

// The poller starts once and keeps its first import; it calls through this, so it uses the newest code after a hot reload.
global.__latestPhoneControl = phoneControl;
export const latestPhoneControl = () => (global.__latestPhoneControl ?? phoneControl)();

export async function syncPhoneState(userId: number): Promise<SyncError | null> {
  try { await phoneControl().sync(userId); return null; }
  catch (error) {
    return syncError(error);
  }
}

// Phones run in a codespace of this repository, with .devcontainer/phone/devcontainer.json.
// phonelink installs the emulator and runner over the codespace tunnel after GitHub reports
// the codespace Available. The repository is private for now: a user must be a collaborator
// to create a phone. github/codespaces-blank does not work here, because the github org
// blocks OAuth apps that it has not approved.
const PHONE_TEMPLATE = {
  repository: "codewarnab/phonelink", repositoryId: 1448948156,
  devcontainerPath: ".devcontainer/phone/devcontainer.json",
};

export function templateRepository() {
  const custom = Boolean(process.env.PHONELINK_TEMPLATE_REPO);
  const repository = custom ? process.env.PHONELINK_TEMPLATE_REPO! : PHONE_TEMPLATE.repository;
  const repositoryId = custom ? Number(process.env.PHONELINK_TEMPLATE_REPOSITORY_ID) : PHONE_TEMPLATE.repositoryId;
  const devcontainerPath = custom ? process.env.PHONELINK_DEVCONTAINER_PATH || undefined : PHONE_TEMPLATE.devcontainerPath;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new PhoneInputError("PHONELINK_TEMPLATE_REPO needs a matching PHONELINK_TEMPLATE_REPOSITORY_ID. Unset both to use codewarnab/phonelink.");
  }
  return { repository, repositoryId, devcontainerPath };
}
