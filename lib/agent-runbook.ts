import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { AGENT_DEVICE_VERSION } from "./agent-device-version.ts";

/**
 * Agent docs are Markdown in content/:
 * - agent/setup/: key setup. shared.md goes in the copied prompt; <os>.md has the commands.
 * - skills/emuly-playbook/: the skill that operates phones. Agents install it or fetch it.
 * To add Linux or a new agent, add one Markdown file. No code change is needed.
 */
export const AGENT_RUNBOOK_VERSION = "2026-11-21.1";
export const SKILL_NAME = "emuly-playbook";

const SETUP = path.join(process.cwd(), "content", "agent", "setup");
const SKILL = path.join(process.cwd(), "content", "skills", SKILL_NAME);
const ID = /^[a-z0-9-]+$/;
const SKILL_DESCRIPTION = /^description:\s*(.+)$/m;

const trim = (base: string) => base.replace(/\/$/, "");
const md = (name: string) => name.endsWith(".md");
/**
 * The Markdown uses {{EMULY_BASE_URL}}, {{AGENT_DEVICE_VERSION}} and {{EMULY_SKILL_VERSION}}, so every
 * served copy names this host, the pinned CLI and its own version.
 */
const withBase = (text: string, base: string) => text
  .replaceAll("{{EMULY_BASE_URL}}", trim(base))
  .replaceAll("{{AGENT_DEVICE_VERSION}}", AGENT_DEVICE_VERSION)
  .replaceAll("{{EMULY_SKILL_VERSION}}", skillVersion());

let skillVersionCache: string | undefined;
/**
 * The version of the skill: 12 hex digits of the SHA-256 of every skill file (path and text, before
 * the tokens are replaced). Any edit to the skill changes it, so nobody has to bump it by hand.
 * The same skill gives the same version on every server, hosted or self-hosted.
 */
export function skillVersion() {
  if (skillVersionCache && process.env.NODE_ENV === "production") return skillVersionCache;
  const hash = createHash("sha256");
  for (const file of skillFiles()) {
    hash.update(`${file}\0`).update(readFileSync(path.join(SKILL, ...file.split("/")), "utf8").split("\r").join("")).update("\0");
  }
  return skillVersionCache = hash.digest("hex").slice(0, 12);
}

export function setupShared(baseUrl: string) {
  return withBase(readFileSync(path.join(SETUP, "shared.md"), "utf8"), baseUrl);
}

export function setupOsIds() {
  return readdirSync(SETUP).filter(name => md(name) && name !== "shared.md").map(name => name.slice(0, -3));
}

/** Returns null for an unknown id, so a route can answer 404. */
export function setupOs(id: string | null | undefined, baseUrl: string) {
  if (!id || !ID.test(id) || !setupOsIds().includes(id)) return null;
  return withBase(readFileSync(path.join(SETUP, `${id}.md`), "utf8"), baseUrl);
}

export function setupOsUrl(baseUrl: string, id: string) {
  return `${trim(baseUrl)}/agent/setup/${id}.md`;
}

/** Every skill file, as paths relative to the skill folder, SKILL.md first. */
export function skillFiles() {
  const files = readdirSync(SKILL, { recursive: true, encoding: "utf8" })
    .map(name => name.split(path.sep).join("/"))
    .filter(md);
  return ["SKILL.md", ...files.filter(name => name !== "SKILL.md").sort()];
}

/** Only listed files are served, so a request path can never leave the skill folder. */
export function skillFile(relative: string, baseUrl: string) {
  if (!skillFiles().includes(relative)) return null;
  return withBase(readFileSync(path.join(SKILL, ...relative.split("/")), "utf8"), baseUrl);
}

/** The /.well-known/skills/index.json body that `npx skills add <base>` reads. */
export function skillIndex(baseUrl: string) {
  const description = SKILL_DESCRIPTION.exec(skillFile("SKILL.md", baseUrl) ?? "")?.[1] ?? "";
  return { skills: [{ name: SKILL_NAME, description, files: skillFiles() }] };
}

export function skillUrl(baseUrl: string, file = "SKILL.md") {
  return `${trim(baseUrl)}/.well-known/skills/${SKILL_NAME}/${file}`;
}
