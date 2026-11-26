// Push events from the runner to Emuly (lib/phone/runner-events.ts), so a phone shows "ready"
// about 1 s after Android is up. Push is only a hint: Emuly checks /health before it trusts
// "ready", and its sync loop still finds every boot if an event is lost.
//
// ~/emuly/.events is written by setup through private SSH input:
//   line 1: the events URL, for example https://emuly.xyz/api/runner/events
//   line 2: the phone key (HMAC key, from the server's secret and the codespace name)
//   line 3: the codespace name
// The file is read again for each event, and each answer from Emuly carries its current URL.
// So a new Emuly domain reaches a running phone without a new runner or a restart.
import { isCodespaceName } from "./contracts.mjs";
import { createHmac } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";

export const EVENT_TYPES = ["boot.ready", "boot.failed"];
/** Wait before each try: about 2 min in total, then the sync loop is the backstop. */
export const RETRY_MS = [0, 2_000, 5_000, 10_000, 20_000, 40_000, 60_000];

export function signEvent(key, body) {
  return createHmac("sha256", key).update(`emuly-runner-event-v1\n${body}`).digest("hex");
}

/** Parse ~/emuly/.events. Returns undefined for a missing or bad file: then push is off. */
export function parseEventsFile(text) {
  const [url, key, codespace] = String(text ?? "").split("\n").map(line => line.trim());
  if (!url || !/^https:\/\/[^\s/]+\/[^\s]*$/.test(url) || !/^[a-f0-9]{64}$/.test(key ?? "") || !isCodespaceName(codespace)) return undefined;
  return { url, key, codespace };
}

export function createEvents({ file, fetcher = fetch, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), log = () => {} }) {
  const read = () => readFile(file, "utf8").then(parseEventsFile, () => undefined);

  /** Keep the URL that Emuly reports, so a domain change reaches this runner. */
  async function follow(config, reported) {
    if (typeof reported !== "string" || reported === config.url || !parseEventsFile(`${reported}\n${config.key}\n${config.codespace}`)) return;
    const next = `${file}.next`;
    await writeFile(next, `${reported}\n${config.key}\n${config.codespace}\n`, { mode: 0o600 });
    await rename(next, file);
    log(`[events] Emuly moved; the events URL is now updated`);
  }

  /** Send one event and retry for about 2 min. Never throws: the sync loop is the backstop. */
  async function send(type, attempt) {
    if (!EVENT_TYPES.includes(type) || typeof attempt !== "string") return false;
    for (const wait of RETRY_MS) {
      if (wait) await pause(wait);
      const config = await read();
      if (!config) return false;
      const body = JSON.stringify({ type, attempt });
      try {
        const response = await fetcher(config.url, { method: "POST", body, redirect: "error", signal: AbortSignal.timeout(15_000),
          headers: { "content-type": "application/json", "x-emuly-phone": config.codespace, "x-emuly-signature": signEvent(config.key, body) } });
        const reply = await response.json().catch(() => ({}));
        await follow(config, reply?.events_url).catch(() => {});
        // 2xx: taken. 4xx: Emuly refused it for good (a bad key, an unknown phone); do not retry.
        if (response.ok) return true;
        if (response.status >= 400 && response.status < 500 && response.status !== 429) { log(`[events] ${type} refused: ${response.status}`); return false; }
      } catch { /* A network fault: try again. */ }
    }
    log(`[events] ${type} not delivered; Emuly's sync loop finds the boot`);
    return false;
  }
  return { send };
}
