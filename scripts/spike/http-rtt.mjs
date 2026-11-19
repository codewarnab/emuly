// Spike only: time N sequential HTTPS requests on one kept-alive connection; prints min/median/p95.
// Usage: node http-rtt.mjs <url> [n]
const [url, n = "30"] = process.argv.slice(2);
await fetch(url).then(r => r.arrayBuffer()); // warm the connection
const times = [];
for (let i = 0; i < +n; i++) { const t = performance.now(); await fetch(url, { cache: "no-store" }).then(r => r.arrayBuffer()); times.push(performance.now() - t); }
times.sort((a, b) => a - b);
const q = p => Math.round(times[Math.min(times.length - 1, Math.floor(p * times.length))]);
console.log(JSON.stringify({ url: new URL(url).host + new URL(url).pathname, n: times.length, min: q(0), median: q(0.5), p95: q(0.95) }));
