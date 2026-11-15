import { assertSelfHostEnvironment } from "./selfhost-guard.mjs";
assertSelfHostEnvironment();
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
const listenHostname = process.env.HOST ?? "127.0.0.1";
// Self-host binds 0.0.0.0 for port mapping, but Next builds route request URLs from the
// hostname AND port given here — so they must be the trusted origin (EMULY_BASE_URL),
// or origin checks reject every browser request from the published address while the
// listener works. A base URL without an explicit port gets its scheme's default.
const selfHost = process.env.EMULY_SELF_HOST === "1";
const selfHostBase = selfHost ? new URL(process.env.EMULY_BASE_URL || `http://localhost:${port}`) : null;
const nextHostname = selfHostBase ? selfHostBase.hostname : listenHostname;
const nextPort = selfHostBase
  ? Number(selfHostBase.port) || (selfHostBase.protocol === "https:" ? 443 : 80)
  : port;
// Next attaches its own "upgrade" listener to httpServer on the first request.
// That listener ends phone stream sockets (it matches the page route) while our
// proxy still opens the runner. Next listens on this private emitter instead,
// and the proxy re-emits every other upgrade (HMR) on it.
const nextUpgrades = new EventEmitter();
const app = next({ dev: !process.argv.includes("--production"), hostname: nextHostname, port: nextPort, httpServer: nextUpgrades });
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
server.listen(port, listenHostname, () => {
  if (process.env.EMULY_SELF_HOST === "1") console.log("emuly: self-host mode — sign-in is the gh credential store, no session cookies");
  console.log(`emuly: http://${nextHostname}:${nextPort}`);
});
