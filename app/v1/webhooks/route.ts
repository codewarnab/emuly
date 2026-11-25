import { webhookApi } from "../../../lib/api";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const GET = withApiUsage((request: Request) => webhookApi()(request));
export const POST = withApiUsage((request: Request) => webhookApi()(request));
