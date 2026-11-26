import { CLOSE } from "../../phone/runner/contracts.mjs";
import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { asyncDb } from "../data/async-db.ts";
import { takeLinkTicket } from "./link-ticket.ts";
import { runnerRelay } from "./phone-runner.ts";
import { pipeRelay } from "./link-relay.ts";
import { RELAY_MAX_PAYLOAD } from "./phone-links-contract.ts";

export class LinkTicketError extends Error {}

/**
 * Takes the one-use ticket and opens the runner end of a Route B relay over the connection that
 * the control plane already keeps to the runner. Throws LinkTicketError for a bad ticket.
 */
export async function openLinkRelay(phoneId: string, ticket: string) {
  const taken = await takeLinkTicket(asyncDb(), ticket, phoneId);
  if (!taken) throw new LinkTicketError("Invalid or used link ticket");
  const lease = await runnerRelay(taken.userId, phoneId, taken.ports);
  const upstream = new WebSocket(lease.url, { headers: lease.headers, followRedirects: false,
    handshakeTimeout: 15_000, maxPayload: RELAY_MAX_PAYLOAD, perMessageDeflate: false });
  try {
    await new Promise<void>((resolve, reject) => { upstream.once("open", resolve); upstream.once("error", reject); });
  } catch (error) { upstream.terminate(); lease.release(); throw error; }
  upstream.on("error", () => {});
  return {
    /** Connects the laptop socket. `deadlineMs` ends the relay with 4012 so the CLI reconnects at once. */
    attach(laptop: WebSocket, deadlineMs?: number) {
      const stop = () => close(CLOSE.RECONNECT, "reconnect");
      const deadline = deadlineMs ? setTimeout(stop, deadlineMs) : undefined;
      const close = pipeRelay(laptop, upstream, () => {
        clearTimeout(deadline);
        lease.signal.removeEventListener("abort", stop);
        lease.release();
      });
      // The phone stopped or its connection failed: the CLI reconnects or reports it.
      lease.signal.addEventListener("abort", stop, { once: true });
      if (lease.signal.aborted) stop();
    },
    cancel() { upstream.terminate(); lease.release(); },
  };
}

let relays: WebSocketServer | undefined;

/** Self-host: bin/server.mjs hands the upgrade for /v1/phones/<id>/links/relay to this function. */
export async function handleLinkRelayUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, phoneId: string, ticket: string) {
  // Attach the error listener before the first await: a reset during the lookup must not crash the server.
  socket.on("error", () => socket.destroy());
  let relay: Awaited<ReturnType<typeof openLinkRelay>>;
  try { relay = await openLinkRelay(phoneId, ticket); }
  catch (error) {
    const status = error instanceof LinkTicketError ? "403 Forbidden" : "503 Service Unavailable";
    return void socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  }
  if (socket.destroyed) return relay.cancel();
  relays ??= new WebSocketServer({ noServer: true, maxPayload: RELAY_MAX_PAYLOAD, perMessageDeflate: false });
  relays.handleUpgrade(req, socket, head, laptop => relay.attach(laptop));
}
