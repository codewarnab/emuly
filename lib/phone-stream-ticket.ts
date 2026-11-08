import { randomBytes } from "node:crypto";

type Lease = { url: string; headers: Record<string, string>; signal: AbortSignal; release: () => void; failed?: () => void; acceptedInput?: () => void };
type Ticket = { userId: number; phoneId: string; origin: string; cookie: string; expires: number; open: () => Promise<Lease> };
const g = globalThis as unknown as { __phoneTickets?: Map<string, Ticket> };
const tickets = () => g.__phoneTickets ??= new Map();
export function issueStreamTicket(ticket: Omit<Ticket, "expires">, now = Date.now()) {
  const store = tickets();
  for (const [key, value] of store) if (value.expires <= now) store.delete(key);
  if (store.size >= 1000) throw new Error("Too many pending streams");
  const value = randomBytes(32).toString("base64url");
  store.set(value, { ...ticket, expires: now + 60_000 });
  return value;
}
export function takeStreamTicket(value: string, phoneId: string, origin: string, cookie: string, now = Date.now()) {
  const ticket = tickets().get(value);
  if (!ticket || ticket.expires <= now || ticket.phoneId !== phoneId || ticket.origin !== origin || ticket.cookie !== cookie) return;
  tickets().delete(value);
  return ticket;
}
