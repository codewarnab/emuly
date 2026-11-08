import type { DatabaseSync } from "node:sqlite";

export type StreamQuality = "auto" | "sharp" | "saver";

export function streamQuality(database: DatabaseSync, userId: number): StreamQuality {
  const row = database.prepare("SELECT stream_quality FROM display_settings WHERE user_id = ?").get(userId);
  return row?.stream_quality === "sharp" || row?.stream_quality === "saver" ? row.stream_quality : "auto";
}

export function saveStreamQuality(database: DatabaseSync, userId: number, value: unknown) {
  if (value !== "auto" && value !== "sharp" && value !== "saver") {
    return { ok: false, message: "Choose Auto, Sharp, or Saver." };
  }
  database.prepare(`INSERT INTO display_settings (user_id, stream_quality) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET stream_quality = excluded.stream_quality`).run(userId, value);
  return { ok: true, message: "Saved" };
}
