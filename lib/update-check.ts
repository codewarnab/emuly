import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Self-host only: tells the agent once that a newer Emuly (server + skill) is on GitHub.
    One small GitHub read per day. Nothing about the user is sent. A "no" from the user is
    stored next to the database, so the hint stays quiet until a still newer version ships.
    Turn it off with EMULY_UPDATE_CHECK=0. */

const SOURCE = "https://raw.githubusercontent.com/codewarnab/emuly/main/lib/agent-runbook.ts";
const NOTES = "https://github.com/codewarnab/emuly/commits/main";
const VERSION = /AGENT_RUNBOOK_VERSION\s*=\s*"(\d{4}-\d{2}-\d{2}\.\d+)"/;
const DAY = 24 * 60 * 60_000;

export type UpdateHint = { current: string; latest: string; notes: string; dismiss: string };

/** Versions look like 2026-11-15.2: compare the date, then the number. */
export function newer(a: string, b: string) {
  const [dateA, numA] = a.split("."); const [dateB, numB] = b.split(".");
  return dateA !== dateB ? dateA > dateB : Number(numA) > Number(numB);
}

export function createUpdateCheck({ current, enabled, dismissFile, fetchText, clock = Date.now }: {
  current: string;
  enabled: boolean;
  dismissFile: string;
  fetchText: (url: string) => Promise<string>;
  clock?: () => number;
}) {
  let cache: { at: number; latest: string | null } | undefined;
  let pending: Promise<string | null> | undefined;

  async function latest(): Promise<string | null> {
    if (cache && clock() - cache.at < DAY) return cache.latest;
    pending ??= fetchText(SOURCE)
      .then(text => VERSION.exec(text)?.[1] ?? null, () => null)
      .then(found => { cache = { at: clock(), latest: found }; return found; })
      .finally(() => { pending = undefined; });
    return pending;
  }

  function dismissed() {
    try { return readFileSync(dismissFile, "utf8").trim(); } catch { return ""; }
  }

  return {
    /** Null when off, up to date, unreachable, or the user already said no to this version. */
    async hint(baseUrl: string): Promise<UpdateHint | null> {
      if (!enabled) return null;
      const found = await latest();
      if (!found || !newer(found, current)) return null;
      const skipped = dismissed();
      if (skipped && !newer(found, skipped)) return null;
      return { current, latest: found, notes: NOTES, dismiss: `${baseUrl.replace(/\/$/, "")}/v1/update/dismiss` };
    },
    /** Remember the user's "no" for this version and every older one. */
    async dismiss(): Promise<string | null> {
      const found = await latest();
      if (!found) return null;
      mkdirSync(dirname(dismissFile), { recursive: true });
      writeFileSync(dismissFile, `${found}\n`);
      return found;
    },
  };
}

export function dismissFileFor(dbPath: string) {
  return join(dirname(dbPath), "update-dismissed");
}
