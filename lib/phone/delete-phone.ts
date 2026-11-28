import "server-only";
import { RateLimitError } from "../data/rate-limit.ts";
import { GitHubError } from "../github/github.ts";
import { phoneControl } from "./phone-control.ts";
import { revokeDirect } from "./phone-runner.ts";
import { PhoneInputError } from "./phone-mutations.ts";
import { phoneInputReply } from "./phone-errors.ts";
import { githubRefused } from "./github-refused.ts";

export type PhoneRemovalResult =
  | { ok: true }
  | { ok: false; status: number; error: string; message: string; retryAfter?: string; extra?: Record<string, unknown> };

/** The one deletion path for the session route and an approved request. */
export async function removePhone(userId: number, id: string): Promise<PhoneRemovalResult> {
  try {
    // Close direct streams first. The codespace delete ends them too, but it can take minutes.
    await revokeDirect(userId, id).catch(() => {});
    await phoneControl().remove(userId, id);
    return { ok: true };
  } catch (error) {
    if (error instanceof GitHubError) {
      const { error: code, message, ...extra } = githubRefused(error) as { error: string; message: string; retry_after?: number };
      return { ok: false, status: 409, error: code, message, extra, ...(extra.retry_after ? { retryAfter: String(extra.retry_after) } : {}) };
    }
    if (error instanceof RateLimitError) return { ok: false, status: 429, error: "rate_limited", message: error.message,
      retryAfter: String(error.retryAfter) };
    if (error instanceof PhoneInputError) {
      const { status, body: { error: code, message, ...extra }, headers } = phoneInputReply(error);
      return { ok: false, status, error: String(code), message: String(message), extra, ...(headers ? { retryAfter: headers["Retry-After"] } : {}) };
    }
    return { ok: false, status: 502, error: "request_failed", message: "The phone could not be deleted. Try again." };
  }
}
