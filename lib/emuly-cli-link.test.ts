import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const cli = resolve("bin/emuly.mjs");

test("emuly link reconnects at once after the planned relay close 4012, with no error line", async () => {
  const opens: number[] = [];
  let closedAt = 0;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url === "/v1/phones/p/links") return response.end(JSON.stringify({ ticket: "t" }));
    if (request.url === "/v1/phones/p/links") return response.end(JSON.stringify({ links: [{ port: 3000, route: "relay", relay_connected: true }] }));
    if (request.url === "/v1/phones/p") return response.end(JSON.stringify({ state: "running" }));
    response.statusCode = 404; response.end("{}");
  });
  const relay = new WebSocketServer({ server });
  relay.on("connection", socket => {
    opens.push(Date.now());
    if (opens.length === 1) setTimeout(() => { closedAt = Date.now(); socket.close(4012, "reconnect"); }, 300);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  const child = spawn(process.execPath, [cli, "link", "p", "3000", "--route", "relay"], {
    env: { ...process.env, EMULY_CLI_AUTO_UPDATE: "0", EMULY_KEY: "test", EMULY_BASE_URL: `http://127.0.0.1:${port}` } });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  try {
    const until = Date.now() + 10_000;
    while (opens.length < 2 && Date.now() < until) await new Promise(done => setTimeout(done, 50));
    assert.equal(opens.length, 2, stderr);
    assert.ok(opens[1]! - closedAt < 1000, `reconnected after ${opens[1]! - closedAt} ms`);
    assert.doesNotMatch(stderr, /4012|relay closed/);
  } finally {
    child.kill();
    relay.close();
    server.close();
  }
});
