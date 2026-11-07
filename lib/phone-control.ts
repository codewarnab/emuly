import "server-only";
import { db } from "./db.ts";
import { seal } from "./crypto.ts";
import { getAccessToken } from "./github-token.ts";
import { createGitHubClient, GitHubError } from "./github.ts";
import { createPhoneService, PhoneInputError, redact } from "./phone-mutations.ts";
import { createPhoneSetup } from "./phone-setup.ts";

// Share mutation guards across requests and development hot reloads.
const global = globalThis as unknown as { __phoneControl?: ReturnType<typeof createPhoneService> };
export function phoneControl() {
  return global.__phoneControl ??= createPhoneService({
    database: db(), github: createGitHubClient({ database: db(), accessToken: getAccessToken }), encrypt: seal,
    setup: createPhoneSetup({ token: userId => getAccessToken(userId) }),
    maxPhones: process.env.PHONELINK_MAX_PHONES ? Number(process.env.PHONELINK_MAX_PHONES) : undefined,
  });
}

export async function syncPhoneState(userId: number) {
  try { await phoneControl().sync(userId); return null; }
  catch (error) {
    return error instanceof GitHubError ? redact(error.message) : "Phone state could not be refreshed. Try again shortly.";
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
