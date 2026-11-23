import { crossOrigin } from "../auth/origin.ts";
import { LinkError, linkPort, linkPorts, linkRoute, parseTarget } from "./phone-links-contract.ts";
import { classifyTarget, netCheckFix } from "./net-check.ts";
import type { LinksPath } from "./phone-link.ts";
import { runnerUpdateMessage } from "./phone-response.ts";

type Identity = { id: number; authKind?: "session" | "agent" };
type PhoneView = { id: string; state: string; android_state: string };
type LogcatHint = { kind: string; line: string; hint: string; target?: string };

/**
 * Links: GET/POST/DELETE /v1/phones/<id>/links and
 * GET /v1/phones/<id>/net-check. The runner holds the links; this layer checks input and owner.
 */
export function createPhoneLinksApi({ user, phone, runner, issue, baseUrl, owner }: {
  user: () => Promise<Identity | null>;
  phone: (userId: number, id: string) => Promise<PhoneView | undefined>;
  runner: (userId: number, id: string, path: LinksPath, body?: Record<string, unknown>) => Promise<{ codespaceName: string; response: Response }>;
  issue: (ticket: { userId: number; phoneId: string; ports: number[] }) => Promise<string>;
  baseUrl: () => string;
  /** The GitHub login that owns the user's codespaces. The CLI uses it to pick the gh account. */
  owner?: (userId: number) => Promise<string | undefined>;
}) {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
  const bad = (message: string, status = 400) => json({ error: "invalid_input", message }, status);

  /** Owner, origin and state checks shared by every route. Returns a Response on failure. */
  async function access(request: Request, id: string, needAndroid: boolean) {
    const identity = await user();
    if (!identity) return json({ error: "unauthorized" }, 401);
    if (request.method !== "GET" && crossOrigin(request, identity.authKind)) return json({ error: "forbidden" }, 403);
    const stored = await phone(identity.id, id);
    if (!stored) return json({ error: "not_found", message: "Phone not found." }, 404);
    if (stored.state !== "running" || (needAndroid && stored.android_state !== "ready")) {
      return json({ error: "phone_not_ready", message: `The phone is ${stored.state} with Android ${stored.android_state}. `
        + `Start it with POST /v1/phones/${id}/start, then retry when GET /v1/phones/${id} shows running and ready.` }, 409);
    }
    return identity;
  }

  /** The runner's JSON, or an error body the agent can act on. */
  async function relay(response: Response, id: string) {
    let value: Record<string, unknown> = {};
    try { value = await response.json() as Record<string, unknown>; } catch {}
    if (response.ok) return { ok: true as const, value };
    const message = typeof value.error === "string" ? value.error : "The phone runner could not do this. Try again.";
    if (value.errorCode === "runner_update_required" || response.status === 404) {
      return { ok: false as const, response: json({ error: "runner_update_required",
        message: runnerUpdateMessage(id, "Links") }, 503) };
    }
    const status = [400, 409].includes(response.status) ? response.status : 502;
    return { ok: false as const, response: json({ error: status === 400 ? "invalid_input" : status === 409 ? "phone_conflict" : "link_failed", message }, status) };
  }

  async function call(identity: Identity, id: string, path: LinksPath, body?: Record<string, unknown>) {
    try {
      const { codespaceName, response } = await runner(identity.id, id, path, body);
      const result = await relay(response, id);
      return result.ok ? { ok: true as const, value: result.value, codespaceName } : result;
    } catch {
      return { ok: false as const, response: json({ error: "request_failed", message: "The phone connection failed. Try again." }, 502) };
    }
  }

  /** `github_login` names the gh account for Route A: `gh auth token -h github.com -u <login>`. */
  async function login(identity: Identity) {
    const value = await owner?.(identity.id).catch(() => undefined);
    return value && /^[A-Za-z0-9-]{1,39}$/.test(value) ? { github_login: value } : {};
  }

  const withFix = (id: string) => (hint: LogcatHint) => {
    if (!hint.target || !hint.target.includes(":")) return hint;
    try {
      const target = parseTarget(hint.target);
      return { ...hint, class: classifyTarget(target.host), fix: netCheckFix(target, classifyTarget(target.host), false, id) };
    } catch { return hint; }
  };

  return {
    async list(request: Request, id: string) {
      const identity = await access(request, id, false);
      if (identity instanceof Response) return identity;
      const result = await call(identity, id, "/links");
      if (!result.ok) return result.response;
      return json({ ...result.value, codespace_name: result.codespaceName, ...await login(identity) });
    },

    async create(request: Request, id: string) {
      const identity = await access(request, id, false);
      if (identity instanceof Response) return identity;
      let body: Record<string, unknown>;
      try { body = await request.json() as Record<string, unknown>; } catch { return bad("Send JSON, for example {\"ports\":[3000]}."); }
      let ports: number[], route: string;
      try { ports = linkPorts(body?.ports); route = linkRoute(body?.route); }
      catch (error) { return bad(error instanceof LinkError ? error.message : "Invalid link."); }
      const result = await call(identity, id, "/links", { ports, route });
      if (!result.ok) return result.response;
      const answer: Record<string, unknown> = { ...result.value, route, ports, codespace_name: result.codespaceName, ...await login(identity) };
      if (route === "relay") {
        answer.ticket = await issue({ userId: identity.id, phoneId: id, ports });
        answer.relay_url = `${baseUrl().replace(/\/$/, "").replace(/^http/, "ws")}/v1/phones/${encodeURIComponent(id)}/links/relay`;
      } else {
        answer.ssh = ["gh", "codespace", "ssh", "-c", result.codespaceName, "--", "-N", "-o", "ExitOnForwardFailure=yes",
          ...ports.flatMap(port => ["-R", `${port}:127.0.0.1:${port}`])];
      }
      return json(answer, 201);
    },

    async remove(request: Request, id: string) {
      const identity = await access(request, id, false);
      if (identity instanceof Response) return identity;
      const value = new URL(request.url).searchParams.get("port");
      let port: number | undefined;
      try { port = value === null ? undefined : linkPort(value); }
      catch (error) { return bad(error instanceof LinkError ? error.message : "Invalid port."); }
      const result = await call(identity, id, "/links/remove", port === undefined ? {} : { port });
      if (!result.ok) return result.response;
      return json(result.value);
    },

    async netCheck(request: Request, id: string) {
      const identity = await access(request, id, true);
      if (identity instanceof Response) return identity;
      const value = new URL(request.url).searchParams.get("target");
      if (value === null) {
        const result = await call(identity, id, "/link-hints");
        if (!result.ok) return result.response;
        const logcat = Array.isArray(result.value.logcat) ? result.value.logcat as LogcatHint[] : [];
        return json({ logcat: logcat.map(withFix(id)) });
      }
      let target: { host: string; port: number };
      try { target = parseTarget(value); }
      catch (error) { return bad(error instanceof LinkError ? error.message : "Invalid target."); }
      const result = await call(identity, id, "/net-check", target);
      if (!result.ok) return result.response;
      const reachable = result.value.reachable === true;
      const kind = classifyTarget(target.host);
      const logcat = Array.isArray(result.value.logcat) ? result.value.logcat as LogcatHint[] : [];
      // A port with a live tunnel needs the laptop server, not a new link.
      let linked = false;
      if (!reachable && (kind === "laptop-loopback" || kind === "codespace-host")) {
        const links = await call(identity, id, "/links");
        linked = links.ok && Array.isArray(links.value.links) && (links.value.links as { port?: unknown; listening?: unknown }[])
          .some(link => link.port === target.port && link.listening === true);
      }
      return json({ target: `${target.host.includes(":") ? `[${target.host}]` : target.host}:${target.port}`, reachable, class: kind,
        fix: netCheckFix(target, kind, reachable, id, linked) ?? null,
        ...(linked ? { linked: true } : {}),
        ...(typeof result.value.detail === "string" && result.value.detail ? { detail: result.value.detail } : {}),
        logcat: logcat.map(withFix(id)) });
    },
  };
}
