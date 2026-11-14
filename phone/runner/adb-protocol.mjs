// @ts-check
// Shared by the dashboard and the standalone runner. No runtime dependencies.

/** Default wall-clock limit for one adb call. */
export const ADB_TIMEOUT_DEFAULT_S = 30;
/** Hard limit for ordinary commands and JSON output. */
export const ADB_TIMEOUT_MAX_S = 120;
/** Installs and bugreports may take longer. */
export const ADB_TIMEOUT_LONG_MAX_S = 300;
/** Bounds a normal JSON response held in memory on both sides of the tunnel. */
export const ADB_OUTPUT_MAX_BYTES = 5 * 1024 * 1024;
/** Pull and bugreport stream from the runner's temporary directory. */
export const ADB_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;
/** Total size of files attached to one multipart adb call. */
export const ADB_UPLOAD_MAX_BYTES = 200 * 1024 * 1024;
export const ADB_ARGS_MAX = 64;
export const ADB_ARG_MAX_CHARS = 4096;
export const ADB_FILES_MAX = 20;

/** The runner already pins `-s emulator-5554`; these would pick another target or server. */
const FORBIDDEN_OPTIONS = new Set(["-s", "-H", "-P"]);
/** Global adb options that must never appear before the command. */
const FORBIDDEN_OPTION_PREFIXES = ["-s", "-H", "-P", "-L"];
const FILE_COMMANDS = new Set(["install", "install-multiple", "push"]);
const ALLOWED_COMMANDS = new Set([
  "shell", "exec-out", "logcat", "get-state", "get-serialno", "get-devpath", "uninstall",
  "install", "install-multiple", "push", "pull", "bugreport", "emu", "wait-for-device",
]);
const COMMAND_LIST = [...ALLOWED_COMMANDS].join(", ");
const APPS_ENDPOINT = "POST /v1/phones/<id>/app-installs";
const INSTALL_FLAGS = new Set(["-r", "-t", "-g", "-d", "--abi"]);
const GSM_ACTIONS = new Set(["call", "accept", "cancel", "busy", "hold"]);
const POWER_STATUS = new Set(["charging", "discharging", "not-charging", "full", "unknown"]);
const NETWORK_SPEED = new Set(["gsm", "hscsd", "gprs", "edge", "umts", "hsdpa", "lte", "full"]);
const NETWORK_DELAY = new Set(["gprs", "edge", "umts", "none"]);
const PLACEHOLDER = /^@file(0|[1-9]\d*)$/;
const EMU_USAGE = "Use geo fix, sms send, gsm call|accept|cancel|busy|hold, power capacity|status|ac, "
  + "network speed|delay, finger touch|remove, or rotate.";

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

/** @param {string} value @returns {number | null} */
function placeholder(value) {
  const match = PLACEHOLDER.exec(value);
  return match ? Number(match[1]) : null;
}

/** @param {string} value @param {number} min @param {number} max @returns {boolean} */
function numberInRange(value, min, max) {
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) return false;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max;
}

/** @param {string} value @param {number} min @param {number} max @returns {boolean} */
function integerInRange(value, min, max) {
  if (!/^\d+$/.test(value)) return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max;
}

/** @param {string} value @returns {boolean} */
function phoneNumber(value) {
  return /^\+?\d{1,20}$/.test(value);
}

/** Device paths accepted by push and pull. The runner host is never exposed.
 * @param {string} value */
function devicePath(value) {
  if (!value.startsWith("/sdcard/") && !value.startsWith("/data/local/tmp/")) {
    fail("The device path must start with /sdcard/ or /data/local/tmp/.");
  }
  if (value.split("/").includes("..")) fail("The device path cannot contain ..");
  if (/[\0\r\n]/.test(value)) fail("The device path has an invalid character.");
}

/** @param {string[]} args */
function emuArguments(args) {
  const group = args[1];
  if (group === "geo") {
    if (args[2] !== "fix" || (args.length !== 5 && args.length !== 6)) fail(`emu geo must be "geo fix <lon> <lat> [alt]". ${EMU_USAGE}`);
    if (!numberInRange(args[3], -180, 180)) fail("Longitude must be between -180 and 180.");
    if (!numberInRange(args[4], -90, 90)) fail("Latitude must be between -90 and 90.");
    if (args.length === 6 && !numberInRange(args[5], -100000, 100000)) fail("Altitude must be a number.");
    return;
  }
  if (group === "sms" && args[2] === "send") {
    if (args.length < 5 || !phoneNumber(args[3])) fail(`emu sms must be "sms send <number> <text...>". ${EMU_USAGE}`);
    return;
  }
  if (group === "gsm" && GSM_ACTIONS.has(args[2] ?? "")) {
    if (args.length !== 4 || !phoneNumber(args[3])) fail(`emu gsm must be "${args[2]} <number>". ${EMU_USAGE}`);
    return;
  }
  if (group === "power") {
    if (args[2] === "capacity" && args.length === 4 && integerInRange(args[3], 0, 100)) return;
    if (args[2] === "status" && args.length === 4 && POWER_STATUS.has(args[3])) return;
    if (args[2] === "ac" && args.length === 4 && (args[3] === "on" || args[3] === "off")) return;
    fail(`emu power must be "capacity <0-100>", "status <${[...POWER_STATUS].join("|")}>" or "ac <on|off>". ${EMU_USAGE}`);
  }
  if (group === "network") {
    if (args[2] === "speed" && args.length === 4 && NETWORK_SPEED.has(args[3])) return;
    if (args[2] === "delay" && args.length === 4 && NETWORK_DELAY.has(args[3])) return;
    fail(`emu network must be "speed <${[...NETWORK_SPEED].join("|")}>" or "delay <${[...NETWORK_DELAY].join("|")}>". ${EMU_USAGE}`);
  }
  if (group === "finger") {
    if (args[2] === "touch" && args.length === 4 && integerInRange(args[3], 0, 32)) return;
    if (args[2] === "remove" && args.length === 3) return;
    fail(`emu finger must be "touch <id>" or "remove". ${EMU_USAGE}`);
  }
  if (group === "rotate" && args.length === 2) return;
  fail(`emu ${group ?? ""} is not allowed. ${EMU_USAGE}`.replace("emu  ", "emu "));
}

/** @param {string[]} args @param {number} fileCount */
function installArguments(args, fileCount) {
  const multiple = args[0] === "install-multiple";
  const files = [];
  for (let index = 1; index < args.length; index++) {
    const item = args[index];
    if (item === "--abi") {
      const abi = args[++index];
      if (!abi || abi.startsWith("-") || placeholder(abi) !== null) fail("--abi needs an ABI name.");
      continue;
    }
    if (item.startsWith("-")) {
      if (!INSTALL_FLAGS.has(item)) fail(`The ${item} install option is not allowed. Use only -r, -t, -g, -d and --abi.`);
      continue;
    }
    const file = placeholder(item);
    if (file === null) {
      fail(`${multiple ? "install-multiple" : "install"} needs uploaded file placeholders such as @file0, not a runner path.`);
    }
    files.push(file);
  }
  if (!files.length) fail(`${multiple ? "install-multiple" : "install"} needs an uploaded file. Attach it as file0 and pass @file0.`);
  if (!multiple && files.length !== 1) fail("adb install takes exactly one uploaded file. Use install-multiple for several.");
  if (files.length > fileCount) fail(`${multiple ? "install-multiple" : "install"} references a file that was not uploaded.`);
}

/**
 * Validate an argv-style adb call. The runner always prepends its own serial, and
 * a string is rejected so a shell never parses the arguments on the runner host.
 * `fileCount` is the number of `file0`, `file1`, … parts uploaded with a multipart call.
 * @param {unknown} value
 * @param {number} [fileCount]
 * @returns {string[]}
 */
export function adbArguments(value, fileCount = 0) {
  if (!Array.isArray(value) || value.length === 0) fail("Send args as a non-empty array of strings.");
  if (value.length > ADB_ARGS_MAX) fail(`Send at most ${ADB_ARGS_MAX} adb arguments.`);
  if (!Number.isInteger(fileCount) || fileCount < 0 || fileCount > ADB_FILES_MAX) {
    fail(`Attach at most ${ADB_FILES_MAX} files.`);
  }
  /** @type {string[]} */
  const args = [];
  for (const item of value) {
    if (typeof item !== "string" || !item || item.length > ADB_ARG_MAX_CHARS) {
      fail(`Each adb argument must be a non-empty string up to ${ADB_ARG_MAX_CHARS} characters.`);
    }
    // The emulator console reads one command per line. A CR or LF (for example in "emu sms send"
    // text) would run a second console command, such as "kill". Reject them in every argument.
    if (/[\0\r\n]/.test(item)) fail("An adb argument cannot contain a line break or a NUL character.");
    args.push(item);
  }
  const command = args[0];
  if (command.startsWith("-")) fail("Start with an adb command, not an option.");
  if (!ALLOWED_COMMANDS.has(command)) {
    if (command === "sideload") {
      fail(`adb sideload is not allowed. Install an uploaded APK with ["install","-r","@file0"] on this route, or use ${APPS_ENDPOINT}.`);
    }
    if (command === "backup" || command === "restore") {
      fail(`adb ${command} is not allowed. Read a device file with adb exec-out cat /sdcard/....`);
    }
    if (command === "sync") fail("adb sync is not allowed. Push one file at a time with [\"push\",\"@file0\",\"/sdcard/...\"].");
    if (command === "keygen") fail("adb keygen is not allowed. The runner manages its own adb keys.");
    if (command === "ppp") fail("adb ppp is not allowed. Use the phone's normal network through the app.");
    if (command === "forward" || command === "reverse") {
      fail(`adb ${command} is not allowed. The phone serial and adb server are fixed.`);
    }
    if (["root", "unroot", "reboot"].includes(command)) {
      fail(`adb ${command} is not allowed. The runner manages the emulator lifecycle. Use POST /v1/phones/<id>/start or /stop.`);
    }
    if (["connect", "disconnect", "kill-server", "start-server", "tcpip", "usb"].includes(command)) {
      fail(`adb ${command} is not allowed. The runner pins its own emulator serial and adb server.`);
    }
    if (["install-multi-package", "remount", "disable-verity"].includes(command)) {
      fail(`adb ${command} is not allowed. Use install-multiple for several uploaded APKs, or the Apps endpoint.`);
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
  if (command === "install" || command === "install-multiple") installArguments(args, fileCount);
  if (command === "push") {
    if (args.length !== 3) fail('adb push takes an uploaded @file0 and one device path: ["push","@file0","/sdcard/Download/x.txt"].');
    const file = placeholder(args[1]);
    if (file === null) fail("adb push needs an uploaded file placeholder such as @file0, not a runner path.");
    devicePath(args[2]);
    if (file >= fileCount) fail(`${args[1]} was not uploaded. Attach it as file0.`);
  }
  if (command === "pull") {
    if (args.length !== 2) fail('adb pull takes only a device path: ["pull","/sdcard/x.png"]. The runner picks the temporary local path.');
    devicePath(args[1]);
  }
  if (command === "bugreport" && args.length !== 1) fail('adb bugreport takes no arguments; the runner writes and streams a temporary zip.');
  if (command === "wait-for-device" && args.length !== 1) fail("adb wait-for-device takes no arguments.");
  if (command === "emu") emuArguments(args);
  if (!FILE_COMMANDS.has(command) && args.some(item => placeholder(item) !== null)) {
    fail("File placeholders are only supported for install, install-multiple and push.");
  }
  const referenced = new Set(args.flatMap(item => { const index = placeholder(item); return index === null ? [] : [index]; }));
  for (const index of referenced) {
    if (index >= fileCount) fail(`@file${index} was not uploaded. Attach it as file${index} in the same multipart request.`);
  }
  for (let index = 0; index < fileCount; index++) {
    if (!referenced.has(index)) fail(`Uploaded file${index} is not referenced by args. Add @file${index} or remove the file.`);
  }
  return args;
}

/**
 * @param {unknown} value
 * @param {string[]} [args]
 * @returns {number}
 */
export function adbTimeout(value, args = []) {
  const long = ["install", "install-multiple", "bugreport"].includes(args[0] ?? "");
  const max = long ? ADB_TIMEOUT_LONG_MAX_S : ADB_TIMEOUT_MAX_S;
  if (value === undefined) return ADB_TIMEOUT_DEFAULT_S;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > max) {
    fail(`timeout_s must be a whole number from 1 to ${max} for this command.`);
  }
  return Number(value);
}

/** A screenshot is binary instead of JSON encoded.
 * @param {string[]} args @returns {boolean} */
export function isScreencap(args) {
  return args[0] === "exec-out" && args[1] === "screencap" && args[2] === "-p" && args.length === 3;
}

/** Pull and bugreport return file bytes and a Content-Disposition filename.
 * @param {string[]} args @returns {boolean} */
export function isDownload(args) {
  return args[0] === "pull" || args[0] === "bugreport";
}

/** Validate the runner's JSON result before handing it to a client.
 * @param {unknown} value */
export function adbResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Invalid adb response.");
  const result = /** @type {Record<string, unknown>} */ (value);
  if (!Number.isInteger(result.exit_code) || typeof result.stdout !== "string" || typeof result.stderr !== "string") {
    fail("Invalid adb response.");
  }
  return { exit_code: /** @type {number} */ (result.exit_code), stdout: /** @type {string} */ (result.stdout), stderr: /** @type {string} */ (result.stderr) };
}
