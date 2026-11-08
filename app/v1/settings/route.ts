import { getUser } from "../../../lib/auth/auth";
import { db } from "../../../lib/data/db";
import { createSettingsApi } from "../../../lib/data/settings-api";

export async function PATCH(request: Request) {
  return createSettingsApi({ database: db(), user: getUser })(request);
}
