import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { eventStatement, type OutgoingEvent } from "./events.ts";

export type LegacyEventEmitter = (event: OutgoingEvent) => void | string;

/** Temporary bridge until phone/poller lifecycle transactions use async handles. */
export function emitEvent(event: OutgoingEvent, database: DatabaseSync) {
  const statement = eventStatement(event);
  database.prepare(statement.sql).run(...statement.args as SQLInputValue[]);
  return String(statement.args[0]);
}
