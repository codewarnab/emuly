import type { DatabaseSync } from "node:sqlite";

export class RateLimitError extends Error {
  readonly retryAfter: number;
  constructor(retryAfter: number) {
    super(`Too many phone requests. Try again in ${retryAfter} seconds.`);
    this.retryAfter = retryAfter;
  }
}

/** Call inside the same transaction that records the action, before any network I/O. */
export function assertMutationRate(database: DatabaseSync, userId: number, create: boolean, clock: () => number) {
  const timestamp = clock();
  const recent = database.prepare(`SELECT ts, message FROM events WHERE user_id = ? AND kind = 'action'
    AND message IN ('create requested', 'start requested', 'stop requested', 'keep requested') AND ts > ? ORDER BY ts`)
    .all(userId, new Date(timestamp - 60_000).toISOString()) as { ts: string; message: string }[];
  const creation = create ? recent.find(row => row.message === "create requested") : undefined;
  if (recent.length >= 6 || creation) {
    const first = creation ?? recent[0]!;
    throw new RateLimitError(Math.max(1, Math.ceil((Date.parse(first.ts) + 60_000 - timestamp) / 1000)));
  }
}
