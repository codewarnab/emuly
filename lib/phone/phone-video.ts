export const retryDelays = [1000, 2000, 5000];
export function videoPacket(bytes: ArrayBuffer) {
  if (bytes.byteLength <= 17 || bytes.byteLength > 8 * 1024 * 1024 + 17) throw new Error("Invalid video packet");
  const view = new DataView(bytes);
  if (view.getUint8(0) > 3) throw new Error("Invalid flags");
  const pts = Number(view.getBigUint64(1));
  if (!Number.isFinite(view.getFloat64(9)) || !Number.isSafeInteger(pts)) throw new Error("Invalid timestamp");
  return { key: !!(view.getUint8(0) & 1), config: !!(view.getUint8(0) & 2), pts,
    sent: view.getFloat64(9), data: new Uint8Array(bytes, 17) };
}
export function avcCodec(data: Uint8Array) {
  for (let i = 0; i + 7 < data.length; i++) {
    const start = data[i] === 0 && data[i + 1] === 0 && (data[i + 2] === 1 ? i + 3 : data[i + 2] === 0 && data[i + 3] === 1 ? i + 4 : -1);
    if (start !== false && start !== -1 && (data[start] & 31) === 7) {
      return "avc1." + Array.from(data.subarray(start + 1, start + 4), n => n.toString(16).padStart(2, "0")).join("");
    }
  }
  throw new Error("Missing H.264 configuration");
}
export function screenPoint(x: number, y: number, rect: { left: number; top: number; width: number; height: number }, width: number, height: number) {
  return { x: Math.max(0, Math.min(width - 1, Math.floor((x - rect.left) / rect.width * width))),
    y: Math.max(0, Math.min(height - 1, Math.floor((y - rect.top) / rect.height * height))), width, height };
}

export const phoneKeys = new Set(["Enter", "Backspace", "Delete", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"]);
