import { getUser } from "../../../lib/auth/auth";
import { asyncDb } from "../../../lib/data/async-db";
import { createSettingsApi } from "../../../lib/data/settings-api";

export async function PATCH(request: Request) {
  return createSettingsApi({ database: asyncDb(), user: getUser })(request);
}
