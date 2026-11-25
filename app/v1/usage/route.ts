import { phoneApi } from "../../../lib/api";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

async function handleGET() {
  return phoneApi().usage();
}

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const GET = withApiUsage(handleGET);
