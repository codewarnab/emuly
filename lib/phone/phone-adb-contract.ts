export {
  ADB_TIMEOUT_DEFAULT_S, ADB_TIMEOUT_MAX_S, ADB_TIMEOUT_LONG_MAX_S, ADB_OUTPUT_MAX_BYTES,
  ADB_DOWNLOAD_MAX_BYTES, ADB_UPLOAD_MAX_BYTES, ADB_ARGS_MAX, ADB_ARG_MAX_CHARS, ADB_FILES_MAX,
  AdbError, adbArguments, adbTimeout, isScreencap, isDownload, adbResult,
} from "../../phone/runner/adb-protocol.mjs";

/** A valid Idempotency-Key header. The runner (phone/runner/runner.mjs, adbKeyed) checks the same rule. */
export const IDEMPOTENCY_KEY = /^[\w.:-]{1,100}$/;
