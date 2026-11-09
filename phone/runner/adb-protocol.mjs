// @ts-check
// Shared by the dashboard and the standalone runner. No runtime dependencies.

/** Default wall-clock limit for one adb call. */
export const ADB_TIMEOUT_DEFAULT_S = 30;
/** Hard limit so a stuck command cannot hold the phone forever. */
export const ADB_TIMEOUT_MAX_S = 120;
/** Bounds the response body held in memory on both sides of the tunnel. */
export const ADB_OUTPUT_MAX_BYTES = 5 * 1024 * 1024;
export const ADB_ARGS_MAX = 64;
export const ADB_ARG_MAX_CHARS = 4096;

/** The runner already pins `-s emulator-5554`; these would pick another target or server. */
const FORBIDDEN_OPTIONS = new Set(["-s", "-H", "-P"]);
/** Global adb options that must never appear before the command. */
const FORBIDDEN_OPTION_PREFIXES = ["-s", "-H", "-P", "-L"];
/** Only these commands run on the runner host. File transfer stays off the endpoint. */
const ALLOWED_COMMANDS = new Set([
  "shell", "exec-out", "logcat", "get-state", "get-serialno", "get-devpath", "uninstall",
]);
const COMMAND_LIST = [...ALLOWED_COMMANDS].join(", ");
const APPS_ENDPOINT = "POST /v1/phones/<id>/app-installs";

export class AdbError extends Error {}

/** @param {string} value @returns {never} */
function fail(value) {
  throw new AdbError(value);
}

/** logcat options that write or rotate a file.
 * @param {string} item @returns {boolean} */
function forbiddenLogcatOption(item) {
  const name = item.split("=")[0];
  return name.startsWith("-f") || name === "--file"
    || name.startsWith("--rotate-") || /^-[rn]\d*$/.test(name);
}

/**
 * Validate an argv-style adb call. The runner always prepends its own serial, and
 * a string is rejected so a shell never parses the arguments on the runner host.
 * @param {unknown} value
 * @returns {string[]}
 */
export function adbArguments(value) {
  if (!Array.isArray(value) || value.length === 0) fail("Send args as a non-empty array of strings.");
  if (value.length > ADB_ARGS_MAX) fail(`Send at most ${ADB_ARGS_MAX} adb arguments.`);
  /** @type {string[]} */
  const args = [];
  for (const item of value) {
    if (typeof item !== "string" || !item || item.length > ADB_ARG_MAX_CHARS) {
      fail(`Each adb argument must be a non-empty string up to ${ADB_ARG_MAX_CHARS} characters.`);
    }
    args.push(item);
  }
  const command = args[0];
  if (command.startsWith("-")) fail("Start with an adb command, not an option.");
  if (!ALLOWED_COMMANDS.has(command)) {
    if (command === "pull") {
      fail("adb pull is not allowed because it reads a file on the runner host. Read a device file with exec-out cat /sdcard/....");
    }
    if (command === "push") {
      fail("adb push is not allowed because it writes a file on the runner host. Put text on the device with shell echo or redirection; install an APK with POST /v1/phones/<id>/app-installs.");
    }
    if (["install", "install-multiple", "install-multi-package", "sideload"].includes(command)) {
      fail(`adb ${command} is not allowed. Install an APK with the Apps upload endpoint: ${APPS_ENDPOINT}.`);
    }
    fail(`The ${command} command is not allowed. Use one of: ${COMMAND_LIST}.`);
  }
  for (let index = 0; index < args.length; index++) {
    const item = args[index];
    if (FORBIDDEN_OPTIONS.has(item)) fail(`The ${item} argument is not allowed. The phone serial is fixed.`);
    if (index < 1 && FORBIDDEN_OPTION_PREFIXES.some(prefix => item.startsWith(prefix))) {
      fail(`The ${item} argument is not allowed. The phone serial and adb server are fixed.`);
    }
  }
  if (command === "logcat") {
    for (const item of args.slice(1)) {
      if (forbiddenLogcatOption(item)) {
        fail("logcat file and rotation options (-f, --file, -r, -n, --rotate-*) are not allowed. Use logcat -d to read the current buffer.");
      }
    }
  }
  return args;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
export function adbTimeout(value) {
  if (value === undefined) return ADB_TIMEOUT_DEFAULT_S;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > ADB_TIMEOUT_MAX_S) {
    fail(`timeout_s must be a whole number from 1 to ${ADB_TIMEOUT_MAX_S}.`);
  }
  return Number(value);
}

/** A screenshot is the one call that must stay binary instead of being JSON encoded.
 * @param {string[]} args @returns {boolean} */
export function isScreencap(args) {
  return args[0] === "exec-out" && args[1] === "screencap" && args[2] === "-p" && args.length === 3;
}

/** Validate the runner's JSON result before handing it to a client.
 * @param {unknown} value */
export function adbResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Invalid adb response.");
  const result = /** @type {Record<string, unknown>} */ (value);
  if (!Number.isInteger(result.exit_code) || typeof result.stdout !== "string" || typeof result.stderr !== "string") {
    fail("Invalid adb response.");
  }
  return { exit_code: /** @type {number} */ (result.exit_code), stdout: result.stdout, stderr: result.stderr };
}
