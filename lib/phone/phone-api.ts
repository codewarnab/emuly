import { errorResponse, json, readJsonObject } from "../http.ts";
import { crossOrigin } from "../auth/origin.ts";
import { DEFAULT_DEVICE_PRESET, DEVICE_PRESETS, devicePreset } from "../shared/device-presets.ts";
import type { createPhoneService } from "./phone-mutations.ts";
import { PhoneInputError } from "./phone-mutations.ts";
import { phoneInputReply } from "./phone-errors.ts";
import { PHONE_MACHINE } from "../github/github.ts";
import { IDLE_MAX, IDLE_MIN, validIdle } from "../shared/idle.ts";
import type { Usage } from "../data/usage.ts";

/** HTTP boundary shared by route handlers. Identity always comes from the session. */
export function createPhoneApi({ user, service, template, usage, defaults, clientIp }: {
  user: () => Promise<{ id: number; login?: string; name?: string | null; avatarUrl?: string | null; authKind?: "session" | "agent" } | null>;
  service: Pick<ReturnType<typeof createPhoneService>, "create" | "keep">;
  template: () => { repository: string; repositoryId: number; devcontainerPath?: string };
  usage: (userId: number) => Usage | Promise<Usage>;
  defaults: (userId: number) => { default_machine: string | null; default_idle_min: number } | Promise<{ default_machine: string | null; default_idle_min: number }>;
  /** The caller IP. GitHub creates the codespace in the region closest to it. */
  clientIp?: (request: Request) => string;
}) {
  return {
    async keep(request: Request, id: string) {
      const identity = await user();
      if (!identity) return json({ error: "unauthorized" }, 401);
      if (crossOrigin(request, identity.authKind)) {
        return json({ error: "forbidden", message: "This request is not allowed from this origin." }, 403);
      }
      try {
        await service.keep(identity.id, id);
        return json({ id, status: "keeping" }, 202);
      } catch (error) {
        if (error instanceof PhoneInputError) { const reply = phoneInputReply(error); return json(reply.body, reply.status, reply.headers); }
        return errorResponse(error, identity.login, "Keep it could not be confirmed. Refresh to check progress.");
      }
    },
    /** The GitHub account that owns the phones. Agents use it to name the account in billing problems. */
    async me() {
      const identity = await user();
      if (!identity) return json({ error: "unauthorized" }, 401);
      return json({ github_login: identity.login ?? null, name: identity.name ?? null, avatar_url: identity.avatarUrl ?? null });
    },
    async usage() {
      const identity = await user();
      return identity ? json(await usage(identity.id)) : json({ error: "unauthorized" }, 401);
    },
    async create(request: Request) {
      const identity = await user();
      if (!identity) return json({ error: "unauthorized" }, 401);
      if (crossOrigin(request, identity.authKind)) {
        return json({ error: "forbidden", message: "This request is not allowed from this origin." }, 403);
      }
      const read = await readJsonObject(request);
      if (read.response) return read.response;
      try {
        const body = read.value;
        const settings = await defaults(identity.id);
        // Every phone uses the 4-core machine; see PHONE_MACHINE.
        const machine = PHONE_MACHINE.name;
        const idle = body.idle_timeout_min ?? settings.default_idle_min;
        if (!validIdle(idle)) {
          return json({ error: "invalid_input", message: `Choose an idle timeout from ${IDLE_MIN} to ${IDLE_MAX} minutes.`,
            field: "idle_timeout_min", allowed: { min: IDLE_MIN, max: IDLE_MAX } }, 400);
        }
        const preset = body.device_preset ?? DEFAULT_DEVICE_PRESET;
        if (!devicePreset(preset)) {
          return json({ error: "invalid_input", message: `Choose device_preset from: ${DEVICE_PRESETS.map(p => p.id).join(", ")}.`,
            field: "device_preset", allowed: DEVICE_PRESETS.map(p => p.id) }, 400);
        }
        const id = await service.create(identity.id, { ...template(), machine, idleTimeoutMin: idle, devicePreset: preset as string,
          clientIp: clientIp?.(request) });
        return json({ id }, 201);
      } catch (error) {
        if (error instanceof PhoneInputError) { const reply = phoneInputReply(error); return json(reply.body, reply.status, reply.headers); }
        return errorResponse(error, identity.login, "The request could not be confirmed. Check GitHub before trying again.");
      }
    },
  };
}
