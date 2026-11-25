import { phoneApi } from "../../../lib/api";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

/** The GitHub account behind this key or session. */
async function handleGET() {
  return phoneApi().me();
}

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const GET = withApiUsage(handleGET);
