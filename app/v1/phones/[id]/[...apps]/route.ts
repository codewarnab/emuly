import { getUser } from "../../../../../lib/auth";
import { findPhone } from "../../../../../lib/phones";
import { runnerApps, runnerRequest, closeRunner } from "../../../../../lib/phone-runner";
import { createPhoneSetup } from "../../../../../lib/phone-setup";
import { getAccessToken } from "../../../../../lib/github-token";
import { createPhoneAppsApi } from "../../../../../lib/phone-apps-api";

const setup = createPhoneSetup({ token: getAccessToken });
const upgrades = new Map<string, Promise<{ status: string }>>();
const handle = createPhoneAppsApi({ user: getUser, phone: findPhone, runner: async (userId, id, path, options) => {
  const health = await runnerRequest(userId, id, "/health");
  const status = await health.json();
  if (!status.capabilities?.includes("apkUpload")) return Response.json({ error: "Update the phone runner to use Apps.", errorCode: "runner_update_required" }, { status: 503 });
  return runnerApps(userId, id, path, options);
}, upgrade: async (userId, id) => {
  const key = `${userId}:${id}`;
  const current = upgrades.get(key);
  if (current) return current;
  const work = (async () => {
    const phone = findPhone(userId, id);
    if (!phone) throw new Error("Phone not found");
    const status = await setup(userId, phone.codespace_name);
    if (status === "ready") closeRunner(userId, id, phone.codespace_name);
    return { status };
  })().finally(() => upgrades.delete(key));
  upgrades.set(key, work);
  return work;
} });
type Context = { params: Promise<{ id: string; apps: string[] }> };
async function route(request: Request, { params }: Context) {
  const { id, apps } = await params;
  return handle(request, id, apps);
}
export { route as GET, route as POST, route as PUT };
