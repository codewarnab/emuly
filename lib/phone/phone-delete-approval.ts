import "server-only";
import type { DatabaseQueries } from "../data/async-database.ts";
import {
  claimPhoneDeleteRequest, denyPhoneDeleteRequest, finishPhoneDeleteRequest,
  getPhoneDeleteRequestByToken, reopenPhoneDeleteRequest, type PhoneDeleteStatus,
} from "../data/phone-deletions.ts";

export type DeletePhoneActionResult = { ok: boolean; message: string; phoneId?: string };
export type PhoneDeleteApproval = ReturnType<typeof createPhoneDeleteApproval>;

const AGENT_APPROVE_MESSAGE = "Open this link in a browser to approve phone deletion.";
const AGENT_KEEP_MESSAGE = "Open this link in a browser to keep this phone.";

function statusMessage(status: PhoneDeleteStatus | "invalid") {
  switch (status) {
    case "done": return "This phone was already deleted.";
    case "denied": return "You kept this phone.";
    case "expired": return "This deletion request expired. Ask the agent for a new one.";
    case "approved": return "The deletion is already in progress.";
    case "pending": return "This request is still pending.";
    default: return "This deletion link is not valid.";
  }
}

/** Session-only decisions for an agent's deletion request. The agent can only poll. */
export function createPhoneDeleteApproval({ database, user, phone, remove, record, now = Date.now }: {
  database: DatabaseQueries;
  user: { id: number; authKind?: "session" | "agent" };
  phone: (userId: number, id: string) => Promise<{ id: string; name: string } | undefined>;
  remove: (userId: number, id: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  record: (userId: number, phoneName: string, agentKeyId?: number | null) => Promise<unknown>;
  now?: () => number;
}) {
  return {
    async approve(rawToken: unknown, confirmation: unknown): Promise<DeletePhoneActionResult> {
      if (user.authKind === "agent") return { ok: false, message: AGENT_APPROVE_MESSAGE };
      const at = now();
      const request = await getPhoneDeleteRequestByToken(database, rawToken, user.id, at);
      if (!request) return { ok: false, message: statusMessage("invalid") };
      if (request.status !== "pending") return { ok: false, message: statusMessage(request.status), phoneId: request.phoneId };
      const stored = await phone(user.id, request.phoneId);
      if (!stored) {
        await finishPhoneDeleteRequest(database, request.id);
        return { ok: true, message: "This phone was already deleted.", phoneId: request.phoneId };
      }
      if (confirmation !== stored.name) return { ok: false, message: `Type ${stored.name} to confirm.`, phoneId: request.phoneId };
      const claim = await claimPhoneDeleteRequest(database, rawToken, user.id, at);
      if (!claim.claimed || claim.status !== "approved" || !claim.phoneId) {
        return { ok: false, message: statusMessage(claim.status), phoneId: claim.phoneId ?? request.phoneId };
      }
      const result = await remove(user.id, claim.phoneId);
      if (!result.ok) {
        await reopenPhoneDeleteRequest(database, request.id, at);
        return { ok: false, message: result.message, phoneId: claim.phoneId };
      }
      await finishPhoneDeleteRequest(database, request.id);
      try { await record(user.id, stored.name, claim.agentKeyId); } catch {}
      return { ok: true, message: "Phone deleted.", phoneId: claim.phoneId };
    },
    async deny(rawToken: unknown): Promise<DeletePhoneActionResult> {
      if (user.authKind === "agent") return { ok: false, message: AGENT_KEEP_MESSAGE };
      const at = now();
      const request = await getPhoneDeleteRequestByToken(database, rawToken, user.id, at);
      const status = await denyPhoneDeleteRequest(database, rawToken, user.id, at);
      if (status === "denied") return { ok: true, message: "Kept. Your phone was not deleted.", phoneId: request?.phoneId };
      return { ok: false, message: statusMessage(status), phoneId: request?.phoneId };
    },
  };
}
