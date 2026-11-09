// A single Node process is required: Next's HTTP routes issue one-use socket tickets.
import next from "next";
import { createServer } from "node:http";
import { registerHooks } from "node:module";

// This entrypoint is always a Node server. Next's bundler still enforces the
// server-only boundary for app imports; native stream imports need the marker
// resolved here without enabling react-server globally (which breaks Next).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { attachPhoneStreams } = await import("./lib/phone/phone-stream-proxy.mjs");

const port = Number(process.env.PORT ?? 4321);
const hostname = process.env.HOST ?? "127.0.0.1";
const app = next({ dev: !process.argv.includes("--production"), hostname, port });
await app.prepare();
const handle = app.getRequestHandler();
const server = createServer((req, res) => handle(req, res));
attachPhoneStreams(server, app.getUpgradeHandler());
server.listen(port, hostname, () => console.log(`emuly: http://${hostname}:${port}`));
