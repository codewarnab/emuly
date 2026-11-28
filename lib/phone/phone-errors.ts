/** A refusal the person can fix: the message is shown as is. Bad input, unless it is a PhoneStateError. */
export class PhoneInputError extends Error {}

export type PhoneStateCode = "busy" | "phone_conflict" | "limit_reached" | "unauthorized" | "not_found";
const STATUS: Record<PhoneStateCode, number> = { busy: 409, phone_conflict: 409, limit_reached: 409, unauthorized: 401, not_found: 404 };

/**
 * A refusal that is not bad input: the phone is busy or in the wrong state, a limit is hit, or the
 * sign-in is gone. The API gives it its own code, so an agent knows a retry or a wait can work.
 * It extends PhoneInputError, so the dashboard still shows its message.
 */
export class PhoneStateError extends PhoneInputError {
  readonly code: PhoneStateCode;
  readonly extra: Record<string, unknown>;
  constructor(code: PhoneStateCode, message: string, extra: Record<string, unknown> = {}) {
    super(message); this.code = code; this.extra = extra;
  }
}

/** The API reply for a PhoneInputError: its own code for a PhoneStateError, else 400 invalid_input. */
export function phoneInputReply(error: PhoneInputError): { status: number; body: Record<string, unknown>; headers?: Record<string, string> } {
  if (!(error instanceof PhoneStateError)) return { status: 400, body: { error: "invalid_input", message: error.message } };
  // Same reply as every other missing phone, so it says nothing about other accounts.
  const message = error.code === "not_found" ? "Phone not found." : error.message;
  const busy = error.code === "busy";
  return { status: STATUS[error.code], body: { error: error.code, message, ...error.extra, ...(busy ? { retry_after: 5 } : {}) },
    ...(busy ? { headers: { "Retry-After": "5" } } : {}) };
}
