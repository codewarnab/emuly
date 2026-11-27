// @ts-check
// Constants that the CLI, the server and the runner must agree on. bin/emuly.mjs holds a pasted
// copy of the block between the markers; lib/emuly-cli-proxy.test.ts fails when the two differ.
// phone/scripts/ports.sh repeats the ports for the shell scripts; lib/contracts.test.ts checks it.
// No runtime dependencies.

// contracts:start
/** Ports in the codespace. */
const PORTS = Object.freeze({
  /** agent-device daemon, behind the runner. */
  AGENT_DEVICE: 4310,
  /** adb server. */
  ADB_SERVER: 5037,
  /** Emulator console. The serial is `emulator-5554`. */
  EMULATOR_CONSOLE: 5554,
  /** Emulator adbd. */
  EMULATOR_ADB: 5555,
  /** The private runner API. */
  RUNNER: 8790,
  /** The public, ticket-only direct stream and upload port. */
  DIRECT: 8791,
  /** The egress gateway that the emulator uses as its HTTP proxy. */
  EGRESS: 8792,
});
/** Ports that a link or a phone app (through 10.0.2.2) must not take or reach. */
const RESERVED_PORTS = new Set(/** @type {number[]} */ (Object.values(PORTS)));
/** The emulator serial that adb uses. */
const EMULATOR_SERIAL = `emulator-${PORTS.EMULATOR_CONSOLE}`;

/**
 * The forwarded host of one codespace port.
 * @param {string} codespaceName @param {number} port @returns {string}
 */
const runnerHost = (codespaceName, port) => `${codespaceName}-${port}.app.github.dev`;

/** Relay frame types. The runner sends OPEN; both ends send DATA and CLOSE. */
const FRAME = Object.freeze({ OPEN: 1, DATA: 2, CLOSE: 3 });
/** A relay frame carries at most this many payload bytes. */
const RELAY_CHUNK = 64 * 1024;
/** Relay close codes. RECONNECT is not a failure; the others are fatal for the CLI. */
const CLOSE = Object.freeze({ RECONNECT: 4012, PORTS_REFUSED: 4400, NO_RELAY_LINK: 4404, PORT_IN_USE: 4409 });
/** HTTP statuses for which the CLI stops retrying a link. */
const FATAL_STATUSES = new Set([400, 401, 404, 409]);

/** The host refuses a request body over 4.5 MB, so POST /adb takes at most 4 MB of files. */
const INLINE_MAX = 4 * 1024 * 1024;
/** One chunk of a chunked APK upload. */
const APK_CHUNK_BYTES = 4 * 1024 * 1024;
/** The `adb install` options that the runner allows. */
const INSTALL_FLAGS = new Set(["-r", "-t", "-g", "-d", "--abi"]);
// contracts:end

/**
 * A GitHub codespace name: letters, digits, `_` and `-`, at most 100. It goes into host names and
 * URLs, so every place that builds one checks it first.
 * @param {unknown} name @returns {name is string}
 */
const isCodespaceName = name => typeof name === "string" && /^[\w-]{1,100}$/.test(name);

/** The runner reports this in /health. A server with another number updates the runner. */
const RUNNER_VERSION = 38;

export { PORTS, RESERVED_PORTS, EMULATOR_SERIAL, runnerHost, FRAME, RELAY_CHUNK, CLOSE, FATAL_STATUSES,
  INLINE_MAX, APK_CHUNK_BYTES, INSTALL_FLAGS, RUNNER_VERSION, isCodespaceName };
