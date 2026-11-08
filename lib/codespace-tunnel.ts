import "server-only";
import net from "node:net";
import { Client as GrpcClient, credentials, Metadata } from "@grpc/grpc-js";
import { TunnelRelayTunnelClient } from "@microsoft/dev-tunnels-connections";
import type { Tunnel } from "@microsoft/dev-tunnels-contracts";
import { ManagementApiVersions, TunnelManagementHttpClient } from "@microsoft/dev-tunnels-management";
import ssh2 from "ssh2";
import { measure } from "./diagnostics.ts";

/**
 * Runs a shell command in a codespace without the gh binary. Same path as `gh codespace ssh`:
 *   GET /user/codespaces/{name}?internal=true  -> Dev Tunnels keys (undocumented flag)
 *   Dev Tunnels relay -> forward port 16634     -> gRPC StartRemoteServerAsync starts sshd
 *   forward the sshd port                       -> ssh exec
 * Every step uses the owner's token, so it only reaches the owner's codespaces.
 */
export class CodespaceTunnelError extends Error {
  constructor(message: string, readonly diagnosticCode: "connection_failed" | "timeout" = "connection_failed") { super(message); }
}

const AGENT_PORT = 16634;
const API_VERSION = ManagementApiVersions.Version20230927preview;
const SSH_METHOD = "/Codespaces.Grpc.SshServerHostService.v1.SshServerHost/StartRemoteServerAsync";

type TunnelProperties = {
  connectAccessToken: string; managePortsAccessToken: string; serviceUri: string;
  tunnelId: string; clusterId: string; domain: string;
};

/** A reusable TCP bridge to the runner; no SSH process or command per request. */
export async function openCodespacePort(token: string, codespaceName: string, signal: AbortSignal) {
  if (!/^[\w-]{1,100}$/.test(codespaceName)) throw new CodespaceTunnelError("Invalid codespace name");
  const res = await measure("metadata_fetch", () => fetch(`https://api.github.com/user/codespaces/${codespaceName}?internal=true&refresh=true`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "phonelink" }, signal,
  }));
  if (!res.ok) throw new CodespaceTunnelError(`GitHub returned ${res.status} for the codespace connection.`);
  const body = await res.json() as { connection?: { tunnelProperties?: TunnelProperties } };
  const tp = body.connection?.tunnelProperties;
  if (!tp) throw new CodespaceTunnelError("The codespace has no connection yet.");
  const manager = new TunnelManagementHttpClient("phonelink", API_VERSION, undefined, tp.serviceUri);
  const accessTokens = { connect: tp.connectAccessToken, "manage:ports": tp.managePortsAccessToken };
  const tunnel = await measure("tunnel_lookup", () => manager.getTunnel({ ...tp, accessTokens } as Tunnel, { includePorts: true }));
  if (!tunnel) throw new CodespaceTunnelError("The codespace tunnel was not found.");
  tunnel.accessTokens = accessTokens;
  const client = new TunnelRelayTunnelClient();
  client.acceptLocalConnectionsForForwardedPorts = false;
  const sockets = new Set<net.Socket>();
  let bridge: net.Server | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", close);
    for (const socket of sockets) socket.destroy();
    bridge?.close();
    void client.dispose().catch(() => {});
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    signal.throwIfAborted();
    await measure("relay_connect", () => client.connect(tunnel));
    try {
      await manager.createTunnelPort(tunnel, { portNumber: 8790, protocol: "http", labels: ["InternalPort"] }, {});
    } catch (error) {
      if (!/409|conflict|already exists/i.test(String((error as { response?: { status?: number } }).response?.status ?? error))) throw error;
    }
    await client.refreshPorts();
    await measure("port_wait", () => client.waitForForwardedPort(8790));
    signal.throwIfAborted();
    bridge = net.createServer(socket => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      client.connectToForwardedPort(8790).then(stream => {
        if (closed || socket.destroyed) { stream.destroy(); return; }
        socket.pipe(stream).pipe(socket);
        socket.on("error", () => stream.destroy());
        stream.on("error", () => socket.destroy());
        socket.on("close", () => stream.destroy());
        stream.on("close", () => socket.destroy());
      }, () => socket.destroy());
    });
    await new Promise<void>((resolve, reject) => bridge!.once("error", reject).listen(0, "127.0.0.1", resolve));
    signal.throwIfAborted();
    return { url: `http://127.0.0.1:${(bridge.address() as net.AddressInfo).port}`, close };
  } catch (error) {
    close();
    // A relay connect may settle after cancellation; dispose that late session too.
    await client.dispose().catch(() => {});
    throw error;
  }
}

export async function codespaceExec({ token, codespaceName, command, stdin, pty = false, timeoutMs = 60_000, api = "https://api.github.com", outputLimit = 4000 }: {
  token: string; codespaceName: string; command: string; stdin?: string; pty?: boolean; timeoutMs?: number; api?: string; outputLimit?: number;
}): Promise<{ code: number; output: string }> {
  if (!/^[\w-]{1,100}$/.test(codespaceName)) throw new CodespaceTunnelError("Invalid codespace name");
  const res = await measure("metadata_fetch", () => fetch(`${api}/user/codespaces/${codespaceName}?internal=true&refresh=true`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "phonelink" },
  }));
  if (!res.ok) throw new CodespaceTunnelError(`GitHub returned ${res.status} for the codespace connection.`);
  const body = await res.json() as { state?: string; connection?: { tunnelProperties?: TunnelProperties } };
  const tp = body.connection?.tunnelProperties;
  if (!tp) throw new CodespaceTunnelError(`The codespace has no connection yet (state: ${body.state ?? "unknown"}).`);

  const accessTokens = { connect: tp.connectAccessToken, "manage:ports": tp.managePortsAccessToken };
  const manager = new TunnelManagementHttpClient("phonelink", API_VERSION, undefined, tp.serviceUri);
  const options = { includePorts: true };
  const tunnel = await measure("tunnel_lookup", () => manager.getTunnel({ tunnelId: tp.tunnelId, clusterId: tp.clusterId, domain: tp.domain, accessTokens } as Tunnel, options));
  if (!tunnel) throw new CodespaceTunnelError("The codespace tunnel was not found.");
  tunnel.accessTokens = accessTokens;

  const client = new TunnelRelayTunnelClient();
  client.acceptLocalConnectionsForForwardedPorts = false;
  let bridge: net.Server | undefined;
  let rpc: GrpcClient | undefined;
  let ssh: ssh2.Client | undefined;
  const forward = async (port: number) => {
    try {
      await manager.createTunnelPort(tunnel, { portNumber: port, protocol: "http", labels: ["InternalPort"] }, options);
    } catch (error) {
      if (!/409|conflict|already exists/i.test(String((error as { response?: { status?: number } }).response?.status ?? error))) throw error;
    }
    await client.refreshPorts();
    await measure("port_wait", () => client.waitForForwardedPort(port));
  };

  const work = (async () => {
    await measure("relay_connect", () => client.connect(tunnel));
    await forward(AGENT_PORT);

    // grpc-js dials a TCP address, so bridge a loopback socket to the forwarded agent port.
    bridge = await new Promise<net.Server>(resolve => {
      const server = net.createServer(socket => {
        socket.on("error", () => {});
        client.connectToForwardedPort(AGENT_PORT).then(stream => {
          socket.pipe(stream).pipe(socket);
          // Streams close in any order when the tunnel is disposed; errors here are expected.
          socket.on("error", () => stream.destroy());
          stream.on("error", () => socket.destroy());
          socket.on("close", () => stream.destroy());
          stream.on("close", () => socket.destroy());
        }, () => socket.destroy());
      }).listen(0, "127.0.0.1", () => resolve(server));
    });
    const address = bridge.address() as net.AddressInfo;
    rpc = new GrpcClient(`127.0.0.1:${address.port}`, credentials.createInsecure());
    const keys = ssh2.utils.generateKeyPairSync("ed25519");
    const metadata = new Metadata();
    // The tunnel already checked the token; the agent expects this fixed value.
    metadata.add("Authorization", "Bearer token");
    const started = await measure("ssh_server", () => new Promise<{ ok: boolean; port: number; user: string; message: string }>((resolve, reject) =>
      rpc!.makeUnaryRequest(SSH_METHOD, encodeRequest, decodeResponse, keys.public, metadata, (error, value) =>
        error || !value ? reject(error ?? new Error("empty reply")) : resolve(value))));
    if (!started.ok || !started.port) throw new CodespaceTunnelError(`The codespace could not start SSH: ${started.message}`);

    await forward(started.port);
    const sock = await client.connectToForwardedPort(started.port);
    sock.on("error", () => {});
    ssh = new ssh2.Client();
    await measure("ssh_auth", () => new Promise<void>((resolve, reject) => ssh!.on("ready", resolve).on("error", reject)
      .connect({ sock, username: started.user, privateKey: keys.private, readyTimeout: 30_000 })));
    return await measure("command", () => new Promise<{ code: number; output: string }>((resolve, reject) => ssh!.exec(command, { pty }, (error, channel) => {
      if (error) return reject(error);
      let output = "";
      const limit = Number.isSafeInteger(outputLimit) ? Math.max(4000, Math.min(65536, outputLimit)) : 4000;
      const keep = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-limit); };
      channel.on("data", keep);
      channel.stderr.on("data", keep);
      channel.on("close", (code: number | null) => resolve({ code: code ?? 1, output }));
      channel.end(stdin ?? "");
    })));
  })();

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CodespaceTunnelError("The codespace connection timed out.", "timeout")), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
    ssh?.end();
    rpc?.close();
    bridge?.close();
    await client.dispose().catch(() => {});
    work.catch(() => {});
  }
}

// StartRemoteServerRequest { string UserPublicKey = 1; }
function encodeRequest(publicKey: string) {
  const value = Buffer.from(publicKey, "utf8");
  return Buffer.concat([Buffer.from([0x0a]), varint(value.length), value]);
}

// StartRemoteServerResponse { bool Result = 1; string ServerPort = 2; string User = 3; string Message = 4; }
function decodeResponse(buffer: Buffer) {
  const out = { ok: false, port: 0, user: "", message: "" };
  let i = 0;
  const read = () => { let n = 0, shift = 0, b; do { b = buffer[i++]; n |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80); return n; };
  while (i < buffer.length) {
    const tag = read(); const field = tag >> 3;
    if ((tag & 7) === 0) { const v = read(); if (field === 1) out.ok = v !== 0; continue; }
    if ((tag & 7) !== 2) throw new Error("unexpected protobuf wire type");
    const len = read(); const text = buffer.subarray(i, i + len).toString("utf8"); i += len;
    if (field === 2) out.port = Number(text); else if (field === 3) out.user = text; else if (field === 4) out.message = text;
  }
  return out;
}

function varint(n: number) {
  const bytes: number[] = [];
  while (n > 0x7f) { bytes.push((n & 0x7f) | 0x80); n >>>= 7; }
  bytes.push(n);
  return Buffer.from(bytes);
}
