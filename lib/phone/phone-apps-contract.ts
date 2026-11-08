export { APK_MAX_BYTES, APK_CHUNK_BYTES, isAppInstallStage, installFinished } from "../../phone/runner/apps-protocol.mjs";
export type { AppInstallStage } from "../../phone/runner/apps-protocol.mjs";
import type { AppInstallStage } from "../../phone/runner/apps-protocol.mjs";
export type InstalledApp = { packageId: string; versionCode: string | null; launchable: boolean };
export type AppInstall = {
  id: string; source: "upload" | "url"; filename: string; stage: AppInstallStage;
  bytesReceived: number; totalBytes: number | null; canCancel: boolean;
  packageId?: string; versionCode?: string; errorCode?: string; message?: string;
};
