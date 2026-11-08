import { getUser } from "../../../../../../lib/auth";
import { findPhone } from "../../../../../../lib/phones";
import { db } from "../../../../../../lib/db";
import { phoneObservations } from "../../../../../../lib/phone-observation";
import { createDiagnosticBrowserApi } from "../../../../../../lib/diagnostic-browser-api";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return createDiagnosticBrowserApi({ user: getUser, phone: findPhone, observations: phoneObservations(db()) })(request, (await context.params).id);
}
