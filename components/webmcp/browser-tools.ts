import { createTools, type ToolDeps, type WebTool } from "@/lib/webmcp/tools";
import { DEVICE_RESULT_EVENT } from "@/lib/webmcp/events";

type ModelContext = {
  registerTool: (tool: WebTool, options?: { signal?: AbortSignal }) => unknown;
  unregisterTool?: (name: string) => void;
};

const deps: ToolDeps = {
  fetch: (...args) => fetch(...args),
  path: () => location.pathname,
  search: () => new URLSearchParams(location.search),
  navigate: url => { location.assign(url); },
  waitForDeviceResult: timeoutMs => new Promise(resolve => {
    const done = (value: "approved" | "denied" | null) => {
      clearTimeout(timer);
      removeEventListener(DEVICE_RESULT_EVENT, onResult);
      resolve(value);
    };
    const onResult = (event: Event) => done((event as CustomEvent<"approved" | "denied">).detail);
    const timer = setTimeout(() => done(null), timeoutMs);
    addEventListener(DEVICE_RESULT_EVENT, onResult);
  }),
  deviceState: () => document.querySelector("[data-device-state]")?.getAttribute("data-device-state") ?? null,
  choosePlan: plan => {
    const button = document.querySelector<HTMLButtonElement>(`button[name="plan"][value="${plan}"]`);
    button?.click();
    return Boolean(button);
  },
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/** Registers every tool. Aborting the signal removes them. */
export function registerAll(context: ModelContext, signal: AbortSignal) {
  for (const tool of createTools(deps)) {
    try { context.registerTool(tool, { signal }); }
    catch (error) { console.warn("WebMCP tool was not registered", tool.name, error); }
    // Older Chrome builds use unregisterTool instead of the signal.
    signal.addEventListener("abort", () => { try { context.unregisterTool?.(tool.name); } catch {} });
  }
}
