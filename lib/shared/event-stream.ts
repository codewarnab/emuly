/** One bounded connection. EventSource reconnects after rotation or transport failure. */
export function eventStream(request: Request, read: () => Promise<unknown | undefined>) {
  const abort = new AbortController();
  const signal = AbortSignal.any([request.signal, abort.signal, AbortSignal.timeout(270_000)]);
  const encoder = new TextEncoder();
  let previous = "";
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (!signal.aborted) {
          const value = await read();
          if (value === undefined) break;
          if (signal.aborted || (controller.desiredSize ?? 0) <= 0) break;
          const next = JSON.stringify(value);
          if (next !== previous) { controller.enqueue(encoder.encode(`data: ${next}\n\n`)); previous = next; }
          else controller.enqueue(encoder.encode(": heartbeat\n\n"));
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
            const timer = setTimeout(done, 1500);
            signal.addEventListener("abort", done, { once: true });
            if (signal.aborted) done();
          });
        }
      } catch { /* Closing prompts the browser to reconnect and authorize again. */ }
      finally { try { controller.close(); } catch { /* Reader cancelled. */ } }
    },
    cancel() { abort.abort(); },
  }, { highWaterMark: 1 });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "private, no-store, no-transform", "X-Accel-Buffering": "no" } });
}
