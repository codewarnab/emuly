/** WebMCP tools: each tool does one whole task in one call.
    The tools call the same-origin /v1 API with the browser cookie. They never approve
    a device or a delete, and never change agent permissions: only a human click does that. */

export type ToolResult = { content: { type: "text"; text: string }[] };

export type WebTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
  execute: (input: Record<string, unknown>) => Promise<ToolResult>;
};

/** What the tools need from the browser. Tests pass fakes. */
export type ToolDeps = {
  fetch: typeof fetch;
  path: () => string;
  search: () => URLSearchParams;
  navigate: (url: string) => void;
  /** Resolves with the result of the human's click on /link, or null after the timeout. */
  waitForDeviceResult: (timeoutMs: number) => Promise<"approved" | "denied" | null>;
  /** The final state that /link shows, when the request is not pending. */
  deviceState: () => string | null;
  /** Clicks a plan button on /app/welcome. Returns false when the page has no such button. */
  choosePlan: (plan: "free" | "pro") => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

const text = (value: unknown): ToolResult =>
  ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });

type Phone = { id: string; name: string; state: string; android_state: string; browser_url: string };

async function api(deps: ToolDeps, path: string, init?: { method?: string; body?: unknown }) {
  const response = await deps.fetch(path, {
    method: init?.method ?? "GET",
    credentials: "same-origin",
    headers: init?.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body: body as Record<string, unknown> };
}

const NOT_SIGNED_IN = "The user is not signed in. Call connect_agent first.";
const CODE = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/i;
const PHONE = { type: "string", description: "The phone ID or name. Leave it out when the user has only one phone." };

async function findPhone(deps: ToolDeps, phone: unknown): Promise<Phone | string> {
  const list = await api(deps, "/v1/phones");
  if (list.status === 401) return NOT_SIGNED_IN;
  if (list.status !== 200) return String(list.body.message ?? "The phone list could not be loaded.");
  const phones = (list.body.phones ?? []) as Phone[];
  if (typeof phone === "string" && phone) {
    return phones.find(item => item.id === phone || item.name === phone) ?? `No phone matches "${phone}".`;
  }
  if (phones.length === 1) return phones[0];
  return phones.length ? `Name the phone. Phones: ${phones.map(item => item.name).join(", ")}.` : "The user has no phones.";
}

/** Checks the phone until it is ready, failed, or the time ends. */
async function waitReady(deps: ToolDeps, id: string, timeoutMs: number) {
  const end = deps.now() + timeoutMs;
  for (;;) {
    const read = await api(deps, `/v1/phones/${encodeURIComponent(id)}`);
    const phone = read.body as unknown as Phone;
    if (read.status === 200) {
      if (phone.state === "running" && phone.android_state === "ready") return { ready: true, phone };
      if (["failed", "error", "deleted"].includes(phone.state) || phone.android_state === "failed") return { ready: false, phone };
    }
    if (deps.now() >= end) return { ready: false, phone: read.status === 200 ? phone : null };
    await deps.sleep(5000);
  }
}

export function createTools(deps: ToolDeps): WebTool[] {
  const connectAgent: WebTool = {
    name: "connect_agent",
    description: "Connect a coding agent to the user's Emuly account with its sign-in code. "
      + "Runs sign-in, the plan choice, and the approval page in order. The user must click Approve. "
      + "If the result says the user must sign in, call this tool again after the page loads.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "The sign-in code that the agent shows, for example ABCD-2345." },
        plan: { type: "string", enum: ["free", "pro"], description: "The user's GitHub plan, only if the user told you." },
      },
    },
    async execute(input) {
      const raw = typeof input.code === "string" ? input.code.trim().toUpperCase() : deps.search().get("code") ?? "";
      if (!CODE.test(raw)) return text("Ask the user for the sign-in code that the agent shows, for example ABCD-2345.");
      const code = raw.includes("-") ? raw : `${raw.slice(0, 4)}-${raw.slice(4)}`;
      const link = `/link?code=${encodeURIComponent(code)}`;
      const usage = await api(deps, "/v1/usage");
      if (usage.status === 401) {
        deps.navigate(`/auth/start?next=${encodeURIComponent(link)}`);
        return text({ status: "sign_in_required", next: "The user must click Authorize on GitHub. Then call connect_agent again." });
      }
      if (deps.path() === "/app/welcome") {
        const plan = input.plan === "free" || input.plan === "pro" ? input.plan : null;
        if (plan && deps.choosePlan(plan)) return text({ status: "plan_saved", next: "Call connect_agent again after the page loads." });
        return text({ status: "plan_required", next: "Ask the user: Free or Pro GitHub plan? Then call connect_agent with plan." });
      }
      if (deps.path() !== "/link" || deps.search().get("code") !== code) {
        deps.navigate(link);
        return text({ status: "opening", next: "Call connect_agent again after the page loads." });
      }
      const done = deps.deviceState();
      if (done) return text({ status: done });
      const result = await deps.waitForDeviceResult(5 * 60_000);
      return text(result
        ? { status: result }
        : { status: "waiting", next: "The user did not click yet. Ask the user to click Approve, then call connect_agent again." });
    },
  };

  const createPhone: WebTool = {
    name: "create_phone",
    description: "Create a new Android phone and wait until it is ready. Returns the phone and its URL. Takes up to 10 minutes.",
    inputSchema: {
      type: "object",
      properties: { idle_timeout_min: { type: "number", description: "Minutes without use before the phone stops. Leave it out for the user's default." } },
    },
    async execute(input) {
      const body = typeof input.idle_timeout_min === "number" ? { idle_timeout_min: input.idle_timeout_min } : {};
      const created = await api(deps, "/v1/phones", { method: "POST", body });
      if (created.status === 401) return text(NOT_SIGNED_IN);
      if (created.status !== 201) return text({ error: created.body.error, message: created.body.message });
      const result = await waitReady(deps, String(created.body.id), 10 * 60_000);
      return text(result.ready
        ? { status: "ready", phone: result.phone }
        : { status: "not_ready", phone: result.phone, next: "Call get_status later to check the phone." });
    },
  };

  const managePhone: WebTool = {
    name: "manage_phone",
    description: "Start, stop, or keep a phone running, and wait for the result. "
      + "keep: keep the phone started when GitHub stops it for low hours.",
    inputSchema: {
      type: "object",
      properties: { phone: PHONE, action: { type: "string", enum: ["start", "stop", "keep"] } },
      required: ["action"],
    },
    async execute(input) {
      const action = input.action;
      if (action !== "start" && action !== "stop" && action !== "keep") return text("Choose start, stop, or keep.");
      const phone = await findPhone(deps, input.phone);
      if (typeof phone === "string") return text(phone);
      const sent = await api(deps, `/v1/phones/${encodeURIComponent(phone.id)}/${action}`, { method: "POST" });
      if (sent.status >= 400) return text({ error: sent.body.error, message: sent.body.message });
      if (action === "start") {
        const result = await waitReady(deps, phone.id, 5 * 60_000);
        return text({ status: result.ready ? "ready" : "not_ready", phone: result.phone });
      }
      if (action === "stop") {
        const end = deps.now() + 2 * 60_000;
        for (;;) {
          const read = await api(deps, `/v1/phones/${encodeURIComponent(phone.id)}`);
          if (read.body.state === "stopped" || deps.now() >= end) return text({ status: read.body.state, phone: read.body });
          await deps.sleep(5000);
        }
      }
      return text({ status: sent.body.status, phone: phone.name });
    },
  };

  const getStatus: WebTool = {
    name: "get_status",
    description: "Get all of the user's phones with their states, and the phone hours that are left this month.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    async execute() {
      const [phones, usage] = await Promise.all([api(deps, "/v1/phones"), api(deps, "/v1/usage")]);
      if (phones.status === 401 || usage.status === 401) return text(NOT_SIGNED_IN);
      return text({ phones: phones.body.phones ?? [], usage: usage.body });
    },
  };

  const updateSettings: WebTool = {
    name: "update_settings",
    description: "Change the user's Emuly settings in one call. Send only the fields to change.",
    inputSchema: {
      type: "object",
      properties: {
        default_idle_min: { type: "number", description: "Default minutes without use before a phone stops." },
        allowance_core_hours: { type: "number", description: "Monthly Codespaces core-hours." },
        auto_stop_before_empty: { type: "boolean", description: "Stop phones before the hours run out." },
        auto_keep: { type: "boolean", description: "Keep phones started when GitHub is available again." },
      },
    },
    async execute(input) {
      // agent_delete_phones is left out on purpose: only the user changes delete permission.
      const keys = ["default_idle_min", "allowance_core_hours", "auto_stop_before_empty", "auto_keep"];
      const patch = Object.fromEntries(Object.entries(input).filter(([key]) => keys.includes(key)));
      if (!Object.keys(patch).length) return text(`Send one or more of: ${keys.join(", ")}.`);
      const saved = await api(deps, "/v1/settings", { method: "PATCH", body: patch });
      if (saved.status === 401) return text(NOT_SIGNED_IN);
      return text(saved.status === 200 ? { status: "saved", settings: saved.body } : { error: saved.body.error, message: saved.body.message });
    },
  };

  return [connectAgent, createPhone, managePhone, getStatus, updateSettings];
}
