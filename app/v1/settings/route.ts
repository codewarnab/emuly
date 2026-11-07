import { getUser } from "../../../lib/auth";
import { db } from "../../../lib/db";
import { createSettingsApi } from "../../../lib/settings-api";

export async function PATCH(request: Request) {
  return createSettingsApi({ database: db(), user: getUser })(request);
}
