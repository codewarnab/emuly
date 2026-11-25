import { agentPhoneApi } from "../../../../../lib/api";
import { withApiUsage } from "@/lib/diagnostics/api-usage-route";

type Context = { params: Promise<{ id: string }> };

/**
 * Option 2: the agent sends argv-style adb calls; the codespace runner executes them
 * against its fixed emulator serial. No shell string ever reaches the runner host.
 *
 * Option 3 (not built): a small local relay helper could expose `adb connect` so a
 * desktop tool drives the emulator directly. Until then, use this route or the
 * gh codespace ssh tunnel described in /agent.md.
 */
async function handlePOST(request: Request, context: Context) {
  const { id } = await context.params;
  return agentPhoneApi().adb(request, id);
}

// Each call is counted anonymously (docs/diagnostics-overhaul-plan.md, Part 3).
export const POST = withApiUsage(handlePOST);
