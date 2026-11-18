import { createMp4Muxer, HEAD_SIZE } from "../../phone/runner/mp4-mux.mjs";

// The Record button. The browser already receives the phone's H.264 packets for the live view.
// A recording keeps a copy of each packet as an MP4 sample (phone/runner/mp4-mux.mjs): no second
// encoder, no upload, and the same quality as the live view. The file stays on this computer.
// Packets are kept even when the live view skips old frames, so the file has every frame it received.
// Audio packets become a second track, also while the speaker is off.

export const RECORDING_MAX_BYTES = 512 * 1024 * 1024;
export const RECORDING_MAX_MS = 30 * 60_000;

type Packet = { audio?: boolean; config: boolean; key: boolean; pts: number; data: Uint8Array };

export function createBrowserRecording(now = Date.now) {
  const muxer = createMp4Muxer();
  const parts: Uint8Array[] = [new Uint8Array(HEAD_SIZE)];
  const startedAt = now();
  return {
    startedAt,
    /** Returns true when the recording reached a limit and must stop. */
    add(packet: Packet) {
      const sample = muxer.add({ ...packet, at: now() });
      if (sample) parts.push(sample);
      return muxer.bytes >= RECORDING_MAX_BYTES || now() - startedAt >= RECORDING_MAX_MS;
    },
    /** The MP4, or null when no frame arrived (for example, the screen never changed and no keyframe came). */
    finish(): Blob | null {
      if (!muxer.frames) return null;
      const result = muxer.finish(now());
      parts[0] = result.head;
      parts.push(result.tail);
      return new Blob(parts as BlobPart[], { type: "video/mp4" });
    },
  };
}
