import { getUser } from "../../../../../../lib/auth/auth";
import { findPhone } from "../../../../../../lib/phone/phones";
import { runnerRequest } from "../../../../../../lib/phone/phone-runner";
import { createPhoneScreenApi } from "../../../../../../lib/phone/phone-screen-api";

const screen = createPhoneScreenApi({ user: getUser, phone: findPhone, runner: runnerRequest });
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return screen(request, (await context.params).id);
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return screen(request, (await context.params).id);
}
