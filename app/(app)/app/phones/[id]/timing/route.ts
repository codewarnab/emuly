import { getUser } from "../../../../../../lib/auth/auth";
import { findPhone } from "../../../../../../lib/phone/phones";
import { asyncDb } from "../../../../../../lib/data/async-db";
import { phoneObservations } from "../../../../../../lib/phone/phone-observation";
import { createDiagnosticBrowserApi } from "../../../../../../lib/diagnostics/diagnostic-browser-api";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return createDiagnosticBrowserApi({ user: getUser, phone: findPhone, observations: phoneObservations(asyncDb()) })(request, (await context.params).id);
}
