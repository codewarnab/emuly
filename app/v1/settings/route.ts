import { getUser } from "../../../lib/auth/auth";
import { asyncDb } from "../../../lib/data/async-db";
import { createSettingsApi } from "../../../lib/data/settings-api";

export async function GET() {
  return createSettingsApi({ database: asyncDb(), user: getUser }).get();
}

export async function PATCH(request: Request) {
  return createSettingsApi({ database: asyncDb(), user: getUser }).patch(request);
}
