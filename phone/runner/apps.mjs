import { randomUUID, createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile, rename, open, rm, lstat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { constants, createReadStream } from "node:fs";
import { AppError, fail, apkUrl, downloadApk } from "./apk-download.mjs";

export const MAX_APK = 250 * 1024 * 1024;
export const CHUNK_SIZE = 4 * 1024 * 1024;
const RESERVE = 1024 * 1024 * 1024;
const STAGING_QUOTA = 512 * 1024 * 1024;
const terminal = stage => ["succeeded", "failed", "cancelled", "expired", "interrupted"].includes(stage);
const validPackage = value => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(value) && value.length <= 255;
const validId = value => typeof value === "string" && /^[0-9a-f-]{36}$/.test(value);

const errors = [
  [/UPDATE_INCOMPATIBLE|INCONSISTENT_CERTIFICATES/, "signature_mismatch", "The installed app uses a different signing certificate. Its data was kept."],
  [/VERSION_DOWNGRADE/, "version_downgrade", "This APK is older than the installed app. Choose a newer version."],
  [/INSUFFICIENT_STORAGE|ENOSPC/, "storage_full", "The phone does not have enough free storage."],
  [/NO_MATCHING_ABIS|CPU_ABI_INCOMPATIBLE/, "unsupported_abi", "This APK does not support this phone's processor. Try a universal APK."],
  [/OLDER_SDK|NEWER_SDK|DEPRECATED_SDK/, "unsupported_sdk", "This APK does not support this Android version."],
  [/MISSING_SPLIT/, "split_apk", "Choose a standalone or universal APK. Split APK sets are not supported."],
];
function safeFailure(error) {
  if (error instanceof AppError) return { errorCode: error.code, message: error.message };
  const detail = `${error?.stdout ?? ""} ${error?.stderr ?? ""} ${error?.message ?? ""}`;
  const known = errors.find(([pattern]) => pattern.test(detail));
  return known ? { errorCode: known[1], message: known[2] }
    : { errorCode: "install_failed", message: "The APK could not be installed. Check the file and try again." };
}

/** Durable runner-owned operations. All paths derive from generated IDs, never filenames. */
export async function createApps({ root, sdk, run, adb, exclusive, booted }) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Invalid app staging directory");
  const records = new Map();
  const jobs = new Map();
  let stopping = false;
  let mutation = Promise.resolve();
  /** @template T @param {() => Promise<T>} work @returns {Promise<T>} */
  const locked = work => {
    const result = mutation.then(work);
    mutation = result.catch(() => {});
    return result;
  };
  const dir = id => { if (!validId(id)) fail(404, "not_found", "Installation not found."); return join(root, id); };
  const file = id => join(dir(id), "source.apk");
  const save = async record => {
    record.updatedAt = new Date().toISOString();
    const target = join(dir(record.id), "operation.json");
    await writeFile(`${target}.new`, JSON.stringify(record), { mode: 0o600, flag: "w" });
    await rename(`${target}.new`, target);
  };
  const get = id => { dir(id); const record = records.get(id); if (!record) fail(404, "not_found", "Installation not found."); return record; };
  const view = record => {
    const { key, fingerprint, chunks, ...result } = record;
    return { ...result, canCancel: ["uploading", "downloading", "validating"].includes(record.stage) };
  };
  const space = async extra => {
    const info = await statfs(root);
    if (info.bavail * info.bsize < RESERVE + extra) fail(507, "storage_full", "The phone needs more free disk space before installation.");
  };
  const stagingSpace = async extra => {
    let used = 0;
    for (const item of await readdir(root, { withFileTypes: true })) {
      if (!item.isDirectory() || !validId(item.name)) continue;
      try { used += (await lstat(file(item.name))).size; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (used + extra > STAGING_QUOTA) fail(507, "staging_full", "APK staging is full. Remove abandoned installation files before retrying.");
  };
  const source = async id => {
    const handle = await open(file(id), constants.O_RDWR | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) { await handle.close(); fail(400, "invalid_apk", "Invalid staged APK."); }
    return handle;
  };
  const cleanupSource = record => rm(file(record.id), { force: true });
  const finish = async (record, stage, failure = {}) => {
    record.stage = stage;
    Object.assign(record, failure);
    await save(record);
    await cleanupSource(record);
  };
  const guardReady = async () => {
    if (stopping || !await booted()) fail(409, "not_ready", "Start the phone before installing apps.");
  };
  async function inventory() {
    await guardReady();
    const output = await adb(["shell", "pm", "list", "packages", "-3", "--show-versioncode"]);
    const launchers = await adb(["shell", "cmd", "package", "query-activities", "--components", "--user", "0", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER"]);
    const launchable = new Set(launchers.split("\n").map(line => line.trim()).filter(line => /^[A-Za-z0-9_.$]+\/[A-Za-z0-9_.$]+$/.test(line)).map(line => line.split("/")[0]));
    const apps = [];
    for (const line of output.split("\n")) {
      const match = line.trim().match(/^package:(\S+)(?:\s+versionCode:(\d+))?$/);
      if (!match || !validPackage(match[1])) continue;
      apps.push({ packageId: match[1], versionCode: match[2] ?? null, launchable: launchable.has(match[1]) });
    }
    return { apps: apps.sort((a, b) => a.packageId.localeCompare(b.packageId)), fetchedAt: new Date().toISOString() };
  }
  async function installedVersion(packageId) {
    const output = await adb(["shell", "pm", "list", "packages", "--show-versioncode", packageId]);
    return output.split("\n").map(line => line.trim().match(/^package:(\S+)\s+versionCode:(\d+)$/))
      .find(match => match?.[1] === packageId)?.[2] ?? null;
  }
  // APK parsers run without network, home, credentials or writable SDK access.
  async function inspect(record) {
    const javaHome = (await run("readlink", ["-f", "/usr/bin/java"])).trim().replace(/\/bin\/java$/, "");
    const common = ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
      "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin", "--ro-bind", "/lib", "/lib", "--proc", "/proc", "--dev", "/dev",
      "--tmpfs", "/tmp", "--clearenv", "--setenv", "PATH", `${javaHome}/bin:/usr/bin:/bin`, "--setenv", "HOME", "/tmp",
      "--setenv", "JAVA_HOME", javaHome,
      "--setenv", "JAVA_TOOL_OPTIONS", "-Xmx256m -XX:CompressedClassSpaceSize=64m -XX:ReservedCodeCacheSize=64m -Xss512k",
      "--ro-bind", sdk, "/sdk", "--ro-bind", file(record.id), "/input.apk"];
    // Ubuntu x86_64 has a separate loader path; arm64 generally does not.
    try { await lstat("/lib64"); common.push("--ro-bind", "/lib64", "/lib64"); } catch {}
    // JVM config binds are optional. A host without /etc/java-* still runs the parser.
    try { for (const name of await readdir("/etc")) if (/^java-\d+-openjdk$/.test(name)) common.push("--ro-bind", `/etc/${name}`, `/etc/${name}`); } catch {}
    // RLIMIT_NPROC counts every process for the host UID, including unrelated Codespace services.
    // Keep parser CPU/address-space limits without preventing namespace creation on a busy UID.
    const sandbox = (tool, args) => run("prlimit", ["--as=2147483648", "--cpu=60", "--", "bwrap", ...common, tool, ...args], { timeout: 60_000 });
    const analyzer = "/sdk/cmdline-tools/latest/bin/apkanalyzer";
    let summary;
    try {
      await sandbox(`${javaHome}/bin/java`, ["-version"]);
    } catch { fail(503, "isolation_unavailable", "APK inspection isolation is unavailable. Update the phone setup."); }
    try {
      summary = (await sandbox(analyzer, ["apk", "summary", "/input.apk"])).trim().split(/\s+/);
      const minimum = Number((await sandbox(analyzer, ["manifest", "min-sdk", "/input.apk"])).trim());
      if (!Number.isFinite(minimum) || minimum > 36) fail(400, "unsupported_sdk", "This APK requires a newer Android version.");
      const manifest = await sandbox(analyzer, ["manifest", "print", "/input.apk"]);
      record.testOnly = /android:testOnly="true"/.test(manifest);
      const tools = (await readdir(join(sdk, "build-tools"))).filter(name => /^[\d.]+$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (!tools.length) fail(503, "tools_unavailable", "APK verification tools are missing. Update the phone setup.");
      await sandbox(`/sdk/build-tools/${tools.at(-1)}/apksigner`, ["verify", "/input.apk"]);
    } catch (error) {
      if (error instanceof AppError) throw error;
      fail(400, "invalid_apk", "Choose a valid, signed standalone APK. The file could not be verified.");
    }
    if (!validPackage(summary[0]) || !/^\d+$/.test(summary[1] ?? "")) fail(400, "invalid_apk", "The APK has invalid package metadata.");
    record.packageId = summary[0];
    record.versionCode = summary[1];
    record.priorVersionCode = await installedVersion(record.packageId);
  }
  async function validateAndInstall(record, signal) {
    await locked(async () => { signal.throwIfAborted(); record.stage = "validating"; await save(record); });
    await inspect(record);
    signal.throwIfAborted();
    await exclusive(async () => {
      await guardReady();
      await locked(async () => { signal.throwIfAborted(); record.stage = "installing"; await save(record); });
      // Cancellation cannot race past the persisted installing transition.
      try { await adb(["install", "-r", ...(record.testOnly ? ["-t"] : []), file(record.id)], { timeout: 300_000 }); }
      catch (error) {
        if (!error.killed && /INSTALL_(?:FAILED|PARSE_FAILED)/.test(String(error.stdout) + String(error.stderr))) {
          await finish(record, "failed", safeFailure(error)); return;
        }
        throw error;
      }
      if (await installedVersion(record.packageId) !== record.versionCode) fail(502, "verification_failed", "Android did not confirm the installed version.");
      await finish(record, "succeeded");
    });
  }
  function launchJob(record, work) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort("deadline"), 600_000);
    const done = Promise.resolve().then(() => work(controller.signal)).catch(async error => {
      if (record.stage === "installing") return finish(record, "interrupted", { errorCode: "uncertain_outcome", message: "Installation was interrupted. Refresh apps before trying again." });
      if (terminal(record.stage)) return;
      if (controller.signal.aborted) {
        const cancelled = controller.signal.reason === "cancelled";
        return finish(record, cancelled ? "cancelled" : "failed", { errorCode: cancelled ? "cancelled" : "transfer_timeout", message: cancelled ? "Installation cancelled." : "The transfer timed out. Submit the APK again." });
      }
      const failure = record.stage === "downloading" && !(error instanceof AppError)
        ? { errorCode: "download_failed", message: "The APK download failed. Check the direct HTTPS link and try again." } : safeFailure(error);
      await finish(record, "failed", failure);
    }).catch(() => {}).finally(() => { clearTimeout(deadline); jobs.delete(record.id); });
    jobs.set(record.id, { controller, done });
  }
  async function create(input) {
    return locked(async () => {
      await guardReady();
      if (!input || !["upload", "url"].includes(input.source) || !validId(input.key)) fail(400, "invalid_input", "Invalid installation request.");
      if (input.source === "url") apkUrl(input.url);
      if (input.source === "upload" && (!Number.isSafeInteger(input.totalBytes) || input.totalBytes <= 0 || input.totalBytes > MAX_APK))
        fail(413, "too_large", "Choose an APK between 1 byte and 250 MiB.");
      const fingerprint = createHash("sha256").update(JSON.stringify([input.source, input.source === "url" ? input.url : [input.filename, input.totalBytes]])).digest("hex");
      const previous = [...records.values()].find(item => item.key === input.key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail(409, "key_conflict", "This request key belongs to another file.");
        return view(previous);
      }
      const active = [...records.values()].find(item => !terminal(item.stage));
      if (active) fail(409, "operation_active", "Another installation is active. Refresh its status first.");
      if ([...records.values()].filter(item => Date.now() - Date.parse(item.createdAt) < 60_000).length >= 6)
        fail(429, "rate_limit", "Too many installation requests. Try again in a minute.");
      await space(input.source === "upload" ? input.totalBytes : MAX_APK);
      await stagingSpace(input.source === "upload" ? input.totalBytes : MAX_APK);
      const record = { id: randomUUID(), key: input.key, fingerprint, source: input.source,
        filename: input.source === "upload" ? String(input.filename ?? "APK").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 150) : apkUrl(input.url).hostname,
        stage: input.source === "upload" ? "uploading" : "downloading", bytesReceived: 0,
        totalBytes: input.source === "upload" ? input.totalBytes : null, chunks: [], createdAt: new Date().toISOString() };
      await mkdir(dir(record.id), { mode: 0o700 });
      await writeFile(file(record.id), "", { mode: 0o600, flag: "wx" });
      await save(record);
      records.set(record.id, record);
      if (input.source === "url") launchJob(record, async signal => {
        const handle = await source(record.id);
        const hash = createHash("sha256");
        try {
          await downloadApk(input.url, { signal, maxBytes: MAX_APK, write: async (bytes, total) => {
            signal.throwIfAborted(); await space(bytes.length);
            await handle.writeFile(bytes); hash.update(bytes); record.bytesReceived += bytes.length; record.totalBytes = total;
          } });
          await handle.sync(); record.sha256 = hash.digest("hex"); await save(record);
        } finally { await handle.close(); }
        await validateAndInstall(record, signal);
      });
      return view(record);
    });
  }
  async function content(id, bytes, offset, digest) {
    return locked(async () => {
      const record = get(id);
      if (record.stage !== "uploading") fail(409, "invalid_stage", "This installation is not accepting file chunks.");
      if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > CHUNK_SIZE || !Number.isSafeInteger(offset) || offset < 0)
        fail(400, "invalid_chunk", "Invalid upload chunk.");
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== digest) fail(400, "digest_mismatch", "The upload chunk failed its integrity check. Try again.");
      const prior = record.chunks.find(chunk => chunk.offset === offset);
      if (prior?.digest === digest && prior.size === bytes.length) return view(record);
      if (offset !== record.bytesReceived || offset + bytes.length > record.totalBytes) fail(409, "offset_conflict", "Upload offset conflict. Refresh installation status.");
      await space(bytes.length);
      const handle = await source(id);
      try {
        await handle.truncate(offset);
        let written = 0;
        while (written < bytes.length) written += (await handle.write(bytes, written, bytes.length - written, offset + written)).bytesWritten;
        await handle.sync();
      } finally { await handle.close(); }
      record.bytesReceived += bytes.length;
      record.chunks.push({ offset, size: bytes.length, digest });
      await save(record);
      return view(record);
    });
  }
  async function complete(id) {
    return locked(async () => {
      const record = get(id);
      if (record.stage !== "uploading") return view(record);
      if (record.bytesReceived !== record.totalBytes) fail(409, "incomplete", "The upload is incomplete.");
      const hash = createHash("sha256");
      let size = 0;
      for await (const bytes of createReadStream(file(id), { flags: constants.O_RDONLY | constants.O_NOFOLLOW })) { size += bytes.length; hash.update(bytes); }
      if (size !== record.totalBytes) fail(409, "incomplete", "The staged file has an unexpected size. Submit the APK again.");
      record.sha256 = hash.digest("hex");
      record.stage = "validating"; await save(record);
      launchJob(record, signal => validateAndInstall(record, signal));
      return view(record);
    });
  }
  async function cancel(id) {
    let job;
    await locked(async () => {
      const record = get(id);
      if (record.stage === "installing") fail(409, "installing", "Installation has started and cannot be cancelled.");
      if (terminal(record.stage)) return;
      job = jobs.get(id);
      job?.controller.abort("cancelled");
      if (!job) await finish(record, "cancelled");
    });
    if (job) await job.done;
    return view(get(id));
  }
  async function cleanup() {
    await locked(async () => {
      for (const record of records.values()) {
        const age = Date.now() - Date.parse(record.updatedAt);
        if (terminal(record.stage) && age > 86_400_000) {
          await rm(dir(record.id), { recursive: true, force: true }); records.delete(record.id);
        } else if (record.stage === "uploading" && age > 1_800_000) await finish(record, "expired", { message: "Upload expired. Select the APK again." });
      }
    });
  }
  for (const item of await readdir(root, { withFileTypes: true })) {
    if (!item.isDirectory() || !validId(item.name)) continue;
    try {
      const record = JSON.parse(await readFile(join(dir(item.name), "operation.json"), "utf8"));
      if (record.id !== item.name) continue;
      records.set(record.id, record);
      if (record.stage === "installing") {
        const version = await installedVersion(record.packageId).catch(() => null);
        await finish(record, record.priorVersionCode !== record.versionCode && version === record.versionCode ? "succeeded" : "interrupted",
          { message: "The runner restarted. Refresh apps before trying again." });
      } else if (!terminal(record.stage)) await finish(record, "expired", { message: "The runner restarted. Submit the APK again." });
      else await cleanupSource(record);
    } catch {
      // IDs and direct-child directory type were checked before any recursive removal.
      await rm(dir(item.name), { recursive: true, force: true });
      records.delete(item.name);
    }
  }
  await cleanup();
  const timer = setInterval(() => { void cleanup().catch(() => {}); }, 60_000);
  timer.unref();
  return {
    inventory, create, content, complete, cancel,
    list: () => ({ operations: [...records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20).map(view) }),
    status: id => view(get(id)),
    async open(packageId) {
      await guardReady();
      if (!validPackage(packageId)) fail(400, "invalid_package", "Invalid package ID.");
      if (!await installedVersion(packageId)) fail(404, "not_installed", "This app is no longer installed.");
      const output = await adb(["shell", "cmd", "package", "resolve-activity", "--brief", "--user", "0", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", packageId]);
      const component = output.trim().split("\n").at(-1);
      if (!component || !/^[A-Za-z0-9_.$]+\/[A-Za-z0-9_.$]+$/.test(component) || component.split("/")[0] !== packageId)
        fail(409, "no_launcher", "This app has no launcher activity.");
      // adb joins shell arguments; preserve a valid inner-class '$' literally.
      const result = await adb(["shell", "am", "start", "--user", "0", "-n", `'${component}'`]);
      if (/^Error:|Error type \d+|SecurityException/m.test(result)) fail(409, "launch_failed", "Android could not open this app. Refresh apps and try again.");
      return { ok: true };
    },
    async stop() {
      stopping = true;
      for (const record of records.values()) if (!terminal(record.stage) && record.stage !== "installing") await cancel(record.id);
    },
    resume() { stopping = false; },
  };
}
