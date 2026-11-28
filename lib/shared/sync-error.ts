import { GitHubError } from "../github/github.ts";
import { githubReason } from "../github/github-reason.ts";
import { redact } from "../phone/phone-mutations.ts";
import { shortMessage } from "./short-message.ts";

export type SyncError = {
  kind: "signin" | "quota" | "busy" | "other";
  message: string;
  retryAfter?: number;
};

/** Turn a failed state refresh into the message and recovery action shown on both pages. */
export function syncError(error: unknown): SyncError {
  if (!(error instanceof GitHubError)) {
    return { kind: "other", message: "Phone state could not be refreshed. Try again shortly." };
  }
  const reason = githubReason(error);
  if (reason === "signed_out") return { kind: "signin", message: "GitHub sign-in expired." };
  if (reason === "billing") return { kind: "quota", message: "Your Codespaces hours or spending limit ran out." };
  if (reason === "rate_limited") return { kind: "busy", message: "GitHub is busy.", retryAfter: error.retryAfter ?? 60 };
  return { kind: "other", message: shortMessage(redact(error.message)) };
}
