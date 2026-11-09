"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../lib/auth/auth";
import { AGENT_DEVICE_MESSAGE, forbidAgent } from "../../lib/auth/scope";
import { asyncDb } from "../../lib/data/async-db";
import { approveDeviceCode, denyDeviceCode } from "../../lib/data/agents";

export type DeviceActionResult = { ok: boolean; message: string };

/** A browser session approves a device login. An agent bearer key is never allowed to. */
export async function approveDevice(_previous: DeviceActionResult, form: FormData): Promise<DeviceActionResult> {
  const user = await requireUser();
  if (forbidAgent(user, AGENT_DEVICE_MESSAGE, "/link")) return { ok: false, message: AGENT_DEVICE_MESSAGE };
  const status = await approveDeviceCode(asyncDb(), form.get("code"), user.id);
  revalidatePath("/link");
  switch (status) {
    case "approved": return { ok: true, message: "Approved. You can go back to your agent." };
    case "expired": return { ok: false, message: "This code expired. Ask your agent for a new link." };
    case "denied": return { ok: false, message: "This sign-in request was already denied." };
    case "used": return { ok: false, message: "This code was already used." };
    default: return { ok: false, message: "That code doesn't match a sign-in request." };
  }
}

/** A browser session denies a pending device login. */
export async function denyDevice(_previous: DeviceActionResult, form: FormData): Promise<DeviceActionResult> {
  const user = await requireUser();
  if (forbidAgent(user, AGENT_DEVICE_MESSAGE, "/link")) return { ok: false, message: AGENT_DEVICE_MESSAGE };
  const status = await denyDeviceCode(asyncDb(), form.get("code"));
  revalidatePath("/link");
  switch (status) {
    case "denied": return { ok: true, message: "Denied. Your agent was not connected." };
    case "expired": return { ok: false, message: "This code expired. Ask your agent for a new link." };
    case "approved": return { ok: false, message: "This sign-in request was already approved." };
    case "used": return { ok: false, message: "This code was already used." };
    default: return { ok: false, message: "That code doesn't match a sign-in request." };
  }
}
