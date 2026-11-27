export const HEARTBEAT = Symbol("SSE heartbeat");

export type EventStreamOptions = {
  /** Time between reads while the stream is active. */
  intervalMs?: number;
  /** Time between reads after `quietAfterMs` with no change. Defaults to `intervalMs` (no slow down). */
  quietIntervalMs?: number;
  /** How long after the last change the stream stays active. */
  quietAfterMs?: number;
};

/**
 * The wait before the next read. Most Active CPU of an SSE stream is its reads, and most open
 * tabs see no change for minutes. So a stream reads fast only near a change. The first snapshot
 * is not a change: a new connection (each 270 s rotation) starts quiet.
 */
export function nextReadDelay(lastChangeAt: number, now: number, options: EventStreamOptions = {}) {
  const fast = options.intervalMs ?? 1500;
  const quiet = options.quietIntervalMs ?? fast;
  return now - lastChangeAt < (options.quietAfterMs ?? 60_000) ? fast : quiet;
}

/** One bounded connection. EventSource reconnects after rotation or transport failure. */
export function eventStream(request: Request, read: () => Promise<unknown | undefined>, options: EventStreamOptions = {}) {
  const abort = new AbortController();
  const signal = AbortSignal.any([request.signal, abort.signal, AbortSignal.timeout(270_000)]);
  const encoder = new TextEncoder();
  let previous = "";
  let lastChangeAt = -Infinity;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (!signal.aborted) {
          const value = await read();
          if (value === undefined) break;
          if (signal.aborted || (controller.desiredSize ?? 0) <= 0) break;
          const next = value === HEARTBEAT ? previous : JSON.stringify(value);
          if (next !== previous) {
            if (previous) lastChangeAt = Date.now();
            controller.enqueue(encoder.encode(`data: ${next}\n\n`)); previous = next;
          }
          else controller.enqueue(encoder.encode(": heartbeat\n\n"));
          const delay = nextReadDelay(lastChangeAt, Date.now(), options);
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
            const timer = setTimeout(done, delay);
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
