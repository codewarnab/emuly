/** A single connection supplies fallback images. Consumers discard superseded frames. */
export function pngConnection(id: string, signal: AbortSignal) {
  let socket: WebSocket | undefined;
  let opening: Promise<void> | undefined;
  let latest: Blob | undefined;
  let wake: (() => void) | undefined;
  const close = () => { socket?.close(); socket = undefined; latest = undefined; wake?.(); };
  signal.addEventListener("abort", close, { once: true });
  async function connect() {
    const response = await fetch(`/app/phones/${encodeURIComponent(id)}/stream-ticket`, {
      method: "POST", signal, cache: "no-store",
    });
    if (!response.ok) throw new Error("Stream unavailable");
    const { ticket } = await response.json();
    signal.throwIfAborted();
    const url = new URL(`/app/phones/${encodeURIComponent(id)}/frames`, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", ticket);
    const current = new WebSocket(url);
    socket = current;
    current.onmessage = event => { if (event.data instanceof Blob) { latest = event.data; wake?.(); } };
    current.onclose = () => { if (socket === current) socket = undefined; wake?.(); };
    await new Promise<void>((resolve, reject) => {
      const fail = () => { clearTimeout(timeout); current.close(); if (socket === current) socket = undefined; reject(new Error("Stream unavailable")); };
      const timeout = setTimeout(fail, 10_000);
      current.onopen = () => { clearTimeout(timeout); resolve(); };
      current.onerror = fail;
      current.addEventListener("close", fail, { once: true });
    });
  }
  return async () => {
    signal.throwIfAborted();
    if (!socket) { opening ??= connect().finally(() => { opening = undefined; }); await opening; }
    if (!latest) await new Promise<void>(resolve => {
      const timeout = setTimeout(done, 15_000);
      function done() { clearTimeout(timeout); wake = undefined; resolve(); }
      wake = done;
      if (signal.aborted || !socket) done();
    });
    signal.throwIfAborted();
    const result = latest;
    latest = undefined;
    if (!result) throw new Error("Frame unavailable");
    return result;
  };
}
