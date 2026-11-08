// A single Node process is required: Next's HTTP routes issue one-use socket tickets.
import next from "next";
import { createServer } from "node:http";
import { attachPhoneStreams } from "./lib/phone/phone-stream-proxy.mjs";

const port = Number(process.env.PORT ?? 4321);
const hostname = process.env.HOST ?? "127.0.0.1";
const app = next({ dev: !process.argv.includes("--production"), hostname, port });
await app.prepare();
const handle = app.getRequestHandler();
const server = createServer((req, res) => handle(req, res));
attachPhoneStreams(server, app.getUpgradeHandler());
server.listen(port, hostname, () => console.log(`phonelink: http://${hostname}:${port}`));
