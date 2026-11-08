// Fixed, bounded, write-only browser observations. No phone content enters this module.
export function phoneTiming(id: string, attemptId: string | undefined, started: number) {
  return (code: "first_decoded" | "first_painted" | "presence" | "reconnect" | "screenshot_fallback",
    reason: "none" | "socket_closed" | "decoder_failed" | "queue_full" | "hidden" | "stale" = "none") => {
    if (!attemptId) return;
    void fetch(`/app/phones/${encodeURIComponent(id)}/timing`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attemptId, code, durationMs: Math.min(1800000, Math.max(0, Math.round(performance.now() - started))),
        visible: !document.hidden, reason }), keepalive: true }).catch(() => {});
  };
}
