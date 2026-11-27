import { getUser } from "../../../../../lib/auth/auth";
import { findPhone } from "../../../../../lib/phone/phones";
import { runnerApps, runnerRequest, closeRunner } from "../../../../../lib/phone/phone-runner";
import { createPhoneSetup } from "../../../../../lib/phone/phone-setup";
import { getAccessToken } from "../../../../../lib/github/github-token";
import { createPhoneAppsApi } from "../../../../../lib/phone/phone-apps-api";
import { asyncDb } from "../../../../../lib/data/async-db";
import { sharedAppAdmission } from "../../../../../lib/phone/app-admission";
import { withLease } from "../../../../../lib/data/coordination";
import { recordPhoneAgentAction } from "../../../../../lib/phone/phone-activity";
import { runnerUpdateMessage } from "@/lib/phone/phone-response";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";
import { createRunnerCapabilities } from "@/lib/phone/runner-capabilities";
import { directChunks } from "@/lib/phone/direct-stream";

const setup = createPhoneSetup({ token: getAccessToken });
const capabilities = createRunnerCapabilities((userId, id) => runnerRequest(userId, id, "/health"));
const upgrades = new Map<string, Promise<{ status: string }>>();
const handle = createPhoneAppsApi({ user: getUser, phone: findPhone, action: recordPhoneAgentAction,
  // Old runners have no CORS on the direct port, so only a runner with `directChunk` gets a ticket.
  direct: async input => (await capabilities.get(input.userId, input.phoneId)).includes("directChunk") ? directChunks(input) : undefined,
  sharedAdmission: {
  current: (...args) => sharedAppAdmission(asyncDb()).current(...args),
  claim: (...args) => sharedAppAdmission(asyncDb()).claim(...args),
  release: (...args) => sharedAppAdmission(asyncDb()).release(...args),
}, runner: async (userId, id, path, options) => {
  const can = await capabilities.get(userId, id);
  if (!can.includes("apkUpload")) return Response.json({ error: runnerUpdateMessage(id, "Apps"), errorCode: "runner_update_required" }, { status: 503 });
  if (path.startsWith("/file-fetches") && !can.includes("fileFetch"))
    return Response.json({ error: runnerUpdateMessage(id, "File fetch"), errorCode: "runner_update_required" }, { status: 503 });
  return runnerApps(userId, id, path, options);
}, upgrade: async (userId, id) => {
  const key = `${userId}:${id}`;
  const current = upgrades.get(key);
  if (current) return current;
  const work = withLease(asyncDb(), `setup:${id}`, async () => {
    const phone = (await findPhone(userId, id));
    if (!phone) throw new Error("Phone not found");
    const result = await setup(userId, phone.codespace_name);
    const status = result.state;
    if (status === "failed") throw new Error("Phone setup failed. Try again.");
    capabilities.forget(userId, id);
    if (status === "ready") closeRunner(userId, id, phone.codespace_name, "scripts_updated");
    return { status };
  }).finally(() => upgrades.delete(key));
  upgrades.set(key, work);
  return work;
} });
type Context = { params: Promise<{ id: string; apps: string[] }> };
async function route(request: Request, { params }: Context) {
  const { id, apps } = await params;
  return handle(request, id, apps);
}
// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
const counted = withApiUsage(route);
export { counted as GET, counted as POST, counted as PUT };
