// Spike only: open a page on the Emuly origin in headless Chrome, then open a WebSocket to a
// public codespace port from that page and time 30 pings. Usage: node browser-ws.mjs <wss-url> [page-url]
import { chromium } from "playwright";
const [url, page = "https://emuly.xyz/"] = process.argv.slice(2);
const browser = await chromium.launch();
const tab = await browser.newPage();
await tab.goto(page);
const result = await tab.evaluate(async url => {
  const t0 = performance.now();
  return await new Promise(resolve => {
    const ws = new WebSocket(url); const rtts = []; let open;
    ws.onopen = () => { open = performance.now() - t0; let i = 0;
      const tick = () => { if (i++ >= 30) return setTimeout(finish, 400); ws.send(JSON.stringify({ type: "ping", time: performance.now() })); setTimeout(tick, 150); }; tick(); };
    ws.onmessage = event => { const m = JSON.parse(event.data); if (m.type === "pong") rtts.push(performance.now() - m.time); };
    ws.onerror = () => resolve({ error: `error after ${(performance.now() - t0).toFixed(0)} ms` });
    function finish() { ws.close(); rtts.sort((a, b) => a - b);
      resolve({ open_ms: Math.round(open), n: rtts.length, min: Math.round(rtts[0]), median: Math.round(rtts[rtts.length >> 1]), max: Math.round(rtts.at(-1)) }); }
  });
}, url);
console.log(JSON.stringify(result));
await browser.close();
