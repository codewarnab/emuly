// @ts-check
// Shared by the dashboard and the standalone runner. No runtime dependencies.
export const APK_MAX_BYTES = 250 * 1024 * 1024;
export const APK_CHUNK_BYTES = 4 * 1024 * 1024;

// Each stage declares whether the installation has finished.
const stages = Object.freeze({
  uploading: false,
  downloading: false,
  validating: false,
  installing: false,
  succeeded: true,
  failed: true,
  cancelled: true,
  expired: true,
  interrupted: true,
});
/** @typedef {keyof typeof stages} AppInstallStage */

/** @param {unknown} value @returns {value is AppInstallStage} */
export function isAppInstallStage(value) {
  return typeof value === "string" && Object.hasOwn(stages, value);
}

/** @param {AppInstallStage} stage */
export function installFinished(stage) {
  return stages[stage];
}
