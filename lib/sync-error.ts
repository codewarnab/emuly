import { GitHubError } from "./github.ts";
import { redact } from "./phone/phone-mutations.ts";
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
  if (error.status === 401) return { kind: "signin", message: "GitHub sign-in expired." };
  if (error.status === 402 || /quota|billing|spending limit/i.test(error.message)) {
    return { kind: "quota", message: "Your Codespaces hours or spending limit ran out." };
  }
  if (error.status === 429 || (error.status === 403
    && (error.rateLimited || error.retryAfter !== undefined || /rate limit/i.test(error.message)))) {
    return { kind: "busy", message: "GitHub is busy.", retryAfter: error.retryAfter ?? 60 };
  }
  return { kind: "other", message: shortMessage(redact(error.message)) };
}
