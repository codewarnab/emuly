import { agentPhoneApi, phoneApi } from "../../../lib/api";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

async function handleGET(request: Request) {
  return agentPhoneApi().list(request);
}

async function handlePOST(request: Request) {
  return phoneApi().create(request);
}

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const GET = withApiUsage(handleGET);
export const POST = withApiUsage(handlePOST);
