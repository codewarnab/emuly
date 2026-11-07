import "server-only";
import { db } from "./db.ts";
import { seal } from "./crypto.ts";
import { getAccessToken } from "./github-token.ts";
import { createGitHubClient, GitHubError } from "./github.ts";
import { createPhoneService, PhoneInputError, redact } from "./phone-mutations.ts";

// Share mutation guards across requests and development hot reloads.
const global = globalThis as unknown as { __phoneControl?: ReturnType<typeof createPhoneService> };
export function phoneControl() {
  return global.__phoneControl ??= createPhoneService({
    database: db(), github: createGitHubClient({ database: db(), accessToken: getAccessToken }), encrypt: seal,
    maxPhones: process.env.PHONELINK_MAX_PHONES ? Number(process.env.PHONELINK_MAX_PHONES) : undefined,
  });
}

export async function syncPhoneState(userId: number) {
  try { await phoneControl().sync(userId); return null; }
  catch (error) {
    return error instanceof GitHubError ? redact(error.message) : "Phone state could not be refreshed. Try again shortly.";
  }
}

export function templateRepository() {
  const repository = process.env.PHONELINK_TEMPLATE_REPO ?? "";
  const repositoryId = Number(process.env.PHONELINK_TEMPLATE_REPOSITORY_ID);
  const devcontainerPath = process.env.PHONELINK_DEVCONTAINER_PATH ?? ".devcontainer/devcontainer.json";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new PhoneInputError("Phone creation is not configured. Ask the local operator to set up the template repository.");
  }
  return { repository, repositoryId, devcontainerPath };
}
