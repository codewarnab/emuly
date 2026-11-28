// Points git at .githooks so the pre-push check runs. Does nothing outside a git checkout
// (Vercel, Docker, a tarball), so `pnpm install` never fails because of it.
import { execFileSync } from "node:child_process";
try {
  execFileSync("git", ["rev-parse", "--git-dir"], { stdio: "ignore" });
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
} catch { /* Not a git checkout, or no git: skip. */ }
