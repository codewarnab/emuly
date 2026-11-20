import { AppError, fail, httpsUrl, safeDownload } from "./safe-download.mjs";

// APK installs use the shared safe downloader (safe-download.mjs). This file keeps the APK words.
export { AppError, fail };

export function apkUrl(input) {
  return httpsUrl(input);
}

export async function downloadApk(input, { signal, maxBytes, write }) {
  const result = await safeDownload(input, { signal, maxBytes, write,
    accept: "application/vnd.android.package-archive, application/octet-stream",
    messages: { tooLarge: "APK files must be 250 MiB or smaller.", encoded: "Use a direct, uncompressed APK download.",
      status: () => "The download server did not return an APK. Check the link." } });
  if (!result.bytes) fail(400, "empty_apk", "The downloaded file is empty.");
}
