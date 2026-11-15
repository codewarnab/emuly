"use client";
import { useEffect } from "react";

/** Loads the WebMCP tools only in a browser that has the API. Other browsers load no tool code. */
export function WebMcpLoader() {
  useEffect(() => {
    const scope = { document, navigator } as unknown as { document: { modelContext?: unknown }; navigator: { modelContext?: unknown } };
    const context = scope.document.modelContext ?? scope.navigator.modelContext;
    if (!context) return;
    const controller = new AbortController();
    import("./browser-tools").then(module => {
      if (!controller.signal.aborted) module.registerAll(context as Parameters<typeof module.registerAll>[0], controller.signal);
    }).catch(() => {});
    return () => controller.abort();
  }, []);
  return null;
}
