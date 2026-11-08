import type { DatabaseQueries } from "../data/async-database.ts";

export type StreamQuality = "auto" | "sharp" | "saver";

export async function streamQuality(database: DatabaseQueries, userId: number): Promise<StreamQuality> {
  const row = (await database.execute({ sql: "SELECT stream_quality FROM display_settings WHERE user_id = ?", args: [userId] })).rows[0];
  return row?.stream_quality === "sharp" || row?.stream_quality === "saver" ? row.stream_quality : "auto";
}

export async function saveStreamQuality(database: DatabaseQueries, userId: number, value: unknown) {
  if (value !== "auto" && value !== "sharp" && value !== "saver") {
    return { ok: false, message: "Choose Auto, Sharp, or Saver." };
  }
  await database.execute({ sql: `INSERT INTO display_settings (user_id, stream_quality) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET stream_quality = excluded.stream_quality`, args: [userId, value] });
  return { ok: true, message: "Saved" };
}
