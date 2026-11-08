import { getUser } from "../../../../../../lib/auth/auth";
import { findPhone } from "../../../../../../lib/phone/phones";
import { db } from "../../../../../../lib/data/db";
import { phoneObservations } from "../../../../../../lib/phone/phone-observation";
import { createDiagnosticBrowserApi } from "../../../../../../lib/diagnostics/diagnostic-browser-api";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return createDiagnosticBrowserApi({ user: getUser, phone: findPhone, observations: phoneObservations(db()) })(request, (await context.params).id);
}
