/**
 * What an address means to an app inside the emulator, and the fix when the app cannot reach it.
 * The emulator's own localhost is the phone, not the laptop. 10.0.2.2 is the codespace.
 */
export type TargetClass = "laptop-loopback" | "codespace-host" | "private-lan" | "tailscale" | "public";

function ipv4(host: string) {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return;
  return parts.map(Number);
}

export function classifyTarget(host: string): TargetClass {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (name === "localhost" || name.endsWith(".localhost") || name === "::1" || name === "0.0.0.0") return "laptop-loopback";
  if (name === "10.0.2.2") return "codespace-host";
  if (name.endsWith(".ts.net")) return "tailscale";
  if (/\.(local|lan|home|internal|home\.arpa)$/.test(name) || !name.includes(".") && !name.includes(":")) return "private-lan";
  const ip = ipv4(name);
  if (ip) {
    const [a, b] = ip as [number, number, number, number];
    if (a === 127) return "laptop-loopback";
    if (a === 100 && b >= 64 && b <= 127) return "tailscale";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return "private-lan";
    return "public";
  }
  if (/^f[cd]/.test(name) || name.startsWith("fe80:")) return "private-lan";
  if (name.startsWith("fd7a:115c:a1e0:")) return "tailscale";
  return "public";
}

/**
 * One line the agent can act on. Undefined when the phone reached the target.
 * `linked` is true when a link for the port already has a working tunnel: then the laptop server is missing, not the link.
 */
export function netCheckFix(target: { host: string; port: number }, kind: TargetClass, reachable: boolean, phone = "<phone>", linked = false) {
  if (reachable) return;
  const { host, port } = target;
  if (linked && (kind === "laptop-loopback" || kind === "codespace-host")) {
    return `The link for port ${port} works, but nothing answers on the laptop. Start the server on the laptop on port ${port}. Do not create the link again.`;
  }
  if (kind === "laptop-loopback") return `emuly link ${phone} ${port}`;
  if (kind === "codespace-host") {
    return `If the server runs on the laptop: emuly link ${phone} ${port}. If it runs in the codespace, start it there on 127.0.0.1:${port}.`;
  }
  if (kind === "private-lan" || kind === "tailscale") {
    return `emuly link ${phone} ${port} --to ${host.includes(":") ? `[${host}]` : host}:${port}, then point the app at localhost:${port}. Ask the user first: the target is not localhost.`;
  }
  return "The phone cannot reach this public server. Check that it runs and that its name resolves. A link does not help.";
}
