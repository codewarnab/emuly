import { redact } from "./phone-mutations.ts";

/** The header an agent sets to say, in a few words, what a call does. Shown in the phone's activity log. */
export const AGENT_NOTE_HEADER = "x-emuly-note";
export const AGENT_NOTE_MAX = 80;

/**
 * Cleans an agent's note for display. Headers carry only ASCII, so agents percent-encode other text.
 * The note is a label from the agent, not a record: the stored command stays the true record.
 */
export function cleanAgentNote(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let text = raw;
  try { text = decodeURIComponent(raw); } catch { /* not percent-encoded: keep the raw text */ }
  text = text.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  text = redact(text);
  const chars = Array.from(text);
  return chars.length > AGENT_NOTE_MAX ? `${chars.slice(0, AGENT_NOTE_MAX - 1).join("").trimEnd()}…` : text;
}

export function readAgentNote(request: Request | undefined): string | null {
  return cleanAgentNote(request?.headers.get(AGENT_NOTE_HEADER));
}
