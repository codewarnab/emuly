import { readFileSync } from "node:fs";
import path from "node:path";
import type { NextRequest } from "next/server";
import { env } from "../../../lib/env";

const DIR = path.join(process.cwd(), "content", "open");
// Phone ids are lowercase words joined by dashes, for example phone-silver-dolphin.
const FILE = /^(phone-[a-z0-9]+(?:-[a-z0-9]+){0,4})\.(ps1|sh)$/;

/** Serves the script that opens one phone in scrcpy on the user's computer, for example
    /open/phone-silver-dolphin.ps1. It holds no key or token: the user's own gh sign-in does the GitHub access. */
export async function GET(_request: NextRequest, ctx: RouteContext<"/open/[file]">) {
  const match = FILE.exec((await ctx.params).file);
  if (!match) return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  const [, phone, kind] = match;
  const script = readFileSync(path.join(DIR, `open.${kind}`), "utf8")
    .replace(/\r\n/g, "\n")
    .replaceAll("{{PHONE_ID}}", phone!)
    .replaceAll("{{EMULY_BASE_URL}}", env.baseUrl.replace(/\/$/, ""));
  return new Response(script, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
}
