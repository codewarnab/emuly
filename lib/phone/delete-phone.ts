import "server-only";
import { RateLimitError } from "../data/rate-limit.ts";
import { GitHubError } from "../github/github.ts";
import { phoneControl } from "./phone-control.ts";
import { PhoneInputError, redact } from "./phone-mutations.ts";

export type PhoneRemovalResult =
  | { ok: true }
  | { ok: false; status: number; error: string; message: string; retryAfter?: string };

/** The one deletion path for the session route and an approved request. */
export async function removePhone(userId: number, id: string): Promise<PhoneRemovalResult> {
  try {
    await phoneControl().remove(userId, id);
    return { ok: true };
  } catch (error) {
    if (error instanceof GitHubError) return { ok: false, status: 409, error: "github_refused", message: redact(error.message) };
    if (error instanceof RateLimitError) return { ok: false, status: 429, error: "rate_limited", message: error.message,
      retryAfter: String(error.retryAfter) };
    if (error instanceof PhoneInputError) return { ok: false, status: 400, error: "invalid_input", message: error.message };
    return { ok: false, status: 502, error: "request_failed", message: "The phone could not be deleted. Try again." };
  }
}
