import { randomUUID, createHash } from "node:crypto";
import { mkdir, open, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { AppError, fail, httpsUrl, safeDownload } from "./safe-download.mjs";

// File fetch: the runner downloads one public HTTPS file and pushes it to the phone.
// POST /file-fetches {key, url, dest, sha256?, overwrite?} starts a job; GET /file-fetches/<id>
// reads it; POST /file-fetches/<id>/cancel stops it. The bytes never pass through Vercel or
// the agent's machine. All URL safety lives in safe-download.mjs.
//
// Limits: one active job per phone, 6 starts a minute, 200 MiB, 10 minutes. Jobs live in memory:
// a runner restart forgets them and deletes their temp files.

export const FETCH_MAX_BYTES = 200 * 1024 * 1024;
const TOTAL_MS = 10 * 60_000;
const RESERVE = 512 * 1024 * 1024;
const KEEP = 20;
const STAGES = new Set(["downloading", "verifying", "pushing", "done", "failed", "cancelled"]);
export const fetchFinished = stage => stage === "done" || stage === "failed" || stage === "cancelled";

/** A full file path on the phone, in shared storage or /data/local/tmp. Plain characters only, so
 * the path is safe in the device shell (`test -e`) as well as in adb push. */
export function fetchDest(value) {
  if (typeof value !== "string" || value.length > 255) fail(400, "invalid_dest", "dest must be a file path of at most 255 characters.");
  if (!value.startsWith("/sdcard/") && !value.startsWith("/data/local/tmp/"))
    fail(400, "invalid_dest", "dest must start with /sdcard/ or /data/local/tmp/.");
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) fail(400, "invalid_dest", "dest may use only letters, digits, '.', '_', '-' and '/'.");
  const parts = value.split("/");
  if (parts.includes("..") || parts.includes(".") || value.includes("//")) fail(400, "invalid_dest", "dest cannot contain '.', '..' or '//' parts.");
  if (value.endsWith("/")) fail(400, "invalid_dest", "dest must name a file, not a folder: /sdcard/Download/data.json.");
  return value;
}

/**
 * @param {{ root: string, booted: () => Promise<boolean>, exists: (dest: string) => Promise<boolean>,
 *   push: (local: string, dest: string) => Promise<void>, lookup?: any, download?: typeof safeDownload, now?: () => number,
 *   log?: (line: string) => void, maxBytes?: number, totalMs?: number }} options
 */
export async function createFileFetches({ root, booted, exists, push, lookup, download = safeDownload, now = Date.now, log = console.log,
  maxBytes = FETCH_MAX_BYTES, totalMs = TOTAL_MS }) {
  // Files from a killed runner have no job any more.
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  /** @type {Map<string, any>} */
  const records = new Map();
  const jobs = new Map();
  const starts = [];

  function view(record) {
    const { id, key: _key, fingerprint: _fingerprint, ...rest } = record;
    return { id, ...rest, can_cancel: !fetchFinished(record.stage) };
  }
  function get(id) {
    const record = records.get(id);
    if (!record) fail(404, "not_found", "This file fetch is unknown. A runner restart forgets old fetches.");
    return record;
  }
  function touch(record, changes) {
    Object.assign(record, changes, { updated_at: new Date(now()).toISOString() });
  }
  function prune() {
    const done = [...records.values()].filter(item => fetchFinished(item.stage));
    for (const item of done.slice(0, Math.max(0, records.size - KEEP))) records.delete(item.id);
  }

  async function run(record, input, signal) {
    const path = join(root, `${record.id}.bin`);
    const hash = createHash("sha256");
    const handle = await open(path, "wx", 0o600);
    try {
      try {
        const result = await download(input.url, { signal, maxBytes, lookup, userAgent: "Emuly-Fetch/1",
          write: async (bytes, total) => {
            signal.throwIfAborted();
            await handle.write(bytes);
            hash.update(bytes);
            touch(record, { bytes_received: record.bytes_received + bytes.length, total_bytes: total });
          } });
        touch(record, { content_type: result.contentType || null, total_bytes: result.bytes });
      } finally { await handle.close(); }
      touch(record, { stage: "verifying", sha256: hash.digest("hex") });
      if (input.sha256 && input.sha256 !== record.sha256)
        fail(422, "checksum_mismatch", `The file's SHA-256 is ${record.sha256}, not the sha256 you sent. Nothing was pushed.`);
      signal.throwIfAborted();
      touch(record, { stage: "pushing" });
      if (!(await booted())) fail(409, "phone_not_ready", "Android is not ready. Start the phone first.");
      if (!input.overwrite && await exists(record.dest))
        fail(409, "dest_exists", `${record.dest} already exists. Send "overwrite": true to replace it.`);
      await push(path, record.dest);
      touch(record, { stage: "done" });
    } finally {
      await rm(path, { force: true }).catch(() => {});
    }
  }

  function launch(record, input) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(totalMs)]);
    const done = run(record, input, signal).catch(error => {
      if (controller.signal.aborted) return touch(record, { stage: "cancelled", error_code: "cancelled", message: "The fetch was cancelled." });
      if (signal.aborted) return touch(record, { stage: "failed", error_code: "timeout", message: `The fetch took longer than ${Math.round(totalMs / 60_000)} minutes.` });
      if (error instanceof AppError) return touch(record, { stage: "failed", error_code: error.code, message: error.message });
      const message = String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 200);
      touch(record, { stage: "failed", error_code: "download_failed", message: `The download failed: ${message}` });
    }).finally(() => {
      jobs.delete(record.id);
      // Host only: a query string can hold a token.
      log(`[file-fetch] id=${record.id} host=${record.url_host} stage=${record.stage} bytes=${record.bytes_received} sha256=${record.sha256 ?? "-"} code=${record.error_code ?? "-"}`);
      prune();
    });
    jobs.set(record.id, { controller, done });
  }

  return {
    async create(input) {
      if (!input || typeof input !== "object") fail(400, "invalid_input", "Send JSON {key, url, dest}.");
      if (typeof input.key !== "string" || !/^[0-9a-f-]{36}$/.test(input.key)) fail(400, "invalid_input", "key must be a UUID.");
      const url = httpsUrl(input.url);
      const dest = fetchDest(input.dest);
      if (input.sha256 !== undefined && (typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256)))
        fail(400, "invalid_input", "sha256 must be 64 lowercase hex characters.");
      if (input.overwrite !== undefined && typeof input.overwrite !== "boolean") fail(400, "invalid_input", "overwrite must be true or false.");
      const fingerprint = createHash("sha256").update(JSON.stringify([url.href, dest, input.sha256 ?? null, input.overwrite === true])).digest("hex");
      const previous = [...records.values()].find(item => item.key === input.key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail(409, "key_conflict", "This key belongs to another fetch. Use a new key.");
        return view(previous);
      }
      if ([...records.values()].some(item => !fetchFinished(item.stage)))
        fail(409, "operation_active", "Another file fetch is running. Wait for it or cancel it.");
      while (starts.length && now() - starts[0] > 60_000) starts.shift();
      if (starts.length >= 6) fail(429, "rate_limit", "Too many file fetches. Try again in a minute.");
      if (!(await booted())) fail(409, "phone_not_ready", "Android is not ready. Start the phone first.");
      const disk = await statfs(root);
      if (disk.bavail * disk.bsize < RESERVE + maxBytes) fail(507, "storage_full", "The codespace does not have enough free disk space.");
      // Fail fast; the push checks again, because the file can appear while the download runs.
      if (input.overwrite !== true && await exists(dest)) fail(409, "dest_exists", `${dest} already exists. Send "overwrite": true to replace it.`);
      starts.push(now());
      const at = new Date(now()).toISOString();
      const record = { id: randomUUID(), key: input.key, fingerprint, url_host: url.hostname, dest, stage: "downloading",
        bytes_received: 0, total_bytes: null, created_at: at, updated_at: at };
      records.set(record.id, record);
      launch(record, { url: url.href, sha256: input.sha256, overwrite: input.overwrite === true });
      return view(record);
    },
    status: id => view(get(id)),
    list: () => ({ fetches: [...records.values()].map(view) }),
    async cancel(id) {
      const record = get(id);
      if (fetchFinished(record.stage)) return view(record);
      if (record.stage === "pushing") fail(409, "pushing", "The push to the phone has started and cannot be cancelled.");
      const job = jobs.get(id);
      job?.controller.abort();
      await job?.done;
      return view(record);
    },
    /** Running jobs: GET /health counts them as busy work, so an in-place runner update waits. */
    active: () => jobs.size,
    /** For tests and shutdown: wait for every running job. */
    idle: () => Promise.all([...jobs.values()].map(job => job.done)),
    stages: STAGES,
  };
}
