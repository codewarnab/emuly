// Points git at .githooks so the pre-push check runs. Does nothing outside a git checkout
// (Vercel, Docker, a tarball), so `pnpm install` never fails because of it.
// It never replaces a hooks setting someone else made, and never sets one on a parent repo.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const root = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));
try {
  if (realpathSync(git("rev-parse", "--show-toplevel")) !== root) process.exit(0);
  let current = "";
  try { current = git("config", "--local", "--get", "core.hooksPath"); } catch { /* Not set. */ }
  if (current && current !== ".githooks") {
    console.log(`Emuly: core.hooksPath is already "${current}", so the pre-push check is off. To turn it on: git config core.hooksPath .githooks`);
    process.exit(0);
  }
  if (!current) git("config", "core.hooksPath", ".githooks");
} catch { /* Not a git checkout, or no git: skip. */ }
