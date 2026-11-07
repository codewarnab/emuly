import { getUser } from "../../../../../../lib/auth";
import { findPhone } from "../../../../../../lib/phones";
import { runnerRequest } from "../../../../../../lib/phone-runner";
import { createPhoneScreenApi } from "../../../../../../lib/phone-screen-api";

export const runtime = "nodejs";
const screen = createPhoneScreenApi({ user: getUser, phone: findPhone, runner: runnerRequest });
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return screen(request, (await context.params).id);
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return screen(request, (await context.params).id);
}
