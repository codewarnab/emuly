import type { WebSocket } from "ws";

/** Serialize captures and bound slow viewers. No PNG data is kept between captures. */
export async function servePngFrames(socket: WebSocket, read: () => Promise<Response>) {
  const deadline = Date.now() + 270_000;
  try {
    while (socket.readyState === 1 && Date.now() < deadline) {
      if (socket.bufferedAmount > 4 * 1024 * 1024) break;
      const response = await read();
      if (!response.ok) break;
      const reader = response.body?.getReader();
      if (!reader) break;
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 4 * 1024 * 1024) throw new Error("Frame too large");
          chunks.push(value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      const bytes = Buffer.concat(chunks);
      if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) break;
      if (socket.readyState !== 1) break;
      socket.send(bytes, { binary: true });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch { /* Transport/provider details stay private. */ }
  finally { socket.close(1012, "Reconnect"); }
}
