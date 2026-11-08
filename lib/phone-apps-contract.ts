export const APK_MAX_BYTES = 250 * 1024 * 1024;
export const APK_CHUNK_BYTES = 4 * 1024 * 1024;
export type InstalledApp = { packageId: string; versionCode: string | null; launchable: boolean };
export type AppInstall = {
  id: string; source: "upload" | "url"; filename: string; stage: string;
  bytesReceived: number; totalBytes: number | null; canCancel: boolean;
  packageId?: string; versionCode?: string; errorCode?: string; message?: string;
};
export const installFinished = (stage: string) => ["succeeded", "failed", "cancelled", "expired", "interrupted"].includes(stage);
