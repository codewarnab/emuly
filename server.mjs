// A single Node process is required: Next's HTTP routes issue one-use socket tickets.
import next from "next";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { EventEmitter } from "node:events";

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
// Next attaches its own "upgrade" listener to httpServer on the first request.
// That listener ends phone stream sockets (it matches the page route) while our
// proxy still opens the runner. Next listens on this private emitter instead,
// and the proxy re-emits every other upgrade (HMR) on it.
const nextUpgrades = new EventEmitter();
const app = next({ dev: !process.argv.includes("--production"), hostname, port, httpServer: nextUpgrades });
await app.prepare();
const handle = app.getRequestHandler();
const server = createServer((req, res) => handle(req, res));
// getUpgradeHandler() alone does not serve dev HMR, so it is only the fallback
// before Next has attached its listener.
const upgradeHandler = app.getUpgradeHandler();
attachPhoneStreams(server, (req, socket, head) => {
  if (nextUpgrades.listenerCount("upgrade") > 0) nextUpgrades.emit("upgrade", req, socket, head);
  else void upgradeHandler(req, socket, head);
});
server.listen(port, hostname, () => console.log(`emuly: http://${hostname}:${port}`));
