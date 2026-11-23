import type { GitHubError } from "../github/github.ts";
import { redact } from "./phone-mutations.ts";

/** The body for a GitHub refusal. github_login names the account GitHub refused, such as a billing block. */
export function githubRefused(error: GitHubError, login?: string | null) {
  return { error: "github_refused", message: redact(error.message), ...(login ? { github_login: login } : {}) };
}
