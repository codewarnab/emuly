// Spike only: a WebSocket server that answers {type:"ping"} with {type:"pong"} and logs the Origin header.
// It has no auth. Run it only on a throwaway codespace, never on a phone.
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
const port = Number(process.argv[2] ?? 8791);
const server = createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, path: req.url })); });
const wss = new WebSocketServer({ server, perMessageDeflate: false });
wss.on("connection", (socket, req) => {
  console.log("connect", JSON.stringify({ origin: req.headers.origin, ua: req.headers["user-agent"]?.slice(0, 40) }));
  socket.on("message", data => {
    const message = JSON.parse(String(data));
    if (message.type === "ping") socket.send(JSON.stringify({ type: "pong", time: message.time }));
    if (message.type === "blob") socket.send(Buffer.alloc(message.size));
  });
});
server.listen(port, "127.0.0.1", () => console.log("listening", port));
