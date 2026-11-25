import { getUser } from "../../../lib/auth/auth";
import { asyncDb } from "../../../lib/data/async-db";
import { createSettingsApi } from "../../../lib/data/settings-api";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

async function handleGET() {
  return createSettingsApi({ database: asyncDb(), user: getUser }).get();
}

async function handlePATCH(request: Request) {
  return createSettingsApi({ database: asyncDb(), user: getUser }).patch(request);
}

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const GET = withApiUsage(handleGET);
export const PATCH = withApiUsage(handlePATCH);
