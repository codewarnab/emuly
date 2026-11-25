"use client";
import { useEffect, useState } from "react";
import { Mini, type MiniRow } from "@/components/ui/mini";

type Link = { port: number; route: string; listening: boolean; relay_connected: boolean };
type Egress = { mode?: string; port?: number | null; lock?: boolean; laptop_connected?: boolean | null; udp?: string };

/**
 * The links of this phone. Shown only when a link exists, so
 * the user can see each port that apps on the phone can reach on their computer.
 * When `emuly proxy` runs, an "Internet" row says in plain words where the phone's traffic goes.
 * The details (DNS, UDP, the tunnel kind) sit behind an ⓘ, so the row stays short.
 */
export function PhoneLinks({ id, running }: { id: string; running: boolean }) {
  const [links, setLinks] = useState<Link[]>([]);
  const [egress, setEgress] = useState<Egress>({});
  useEffect(() => {
    if (!running) { setLinks([]); setEgress({}); return; }
    let cancelled = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch(`/v1/phones/${encodeURIComponent(id)}/links`, { cache: "no-store" });
        const body = response.ok ? await response.json() as { links?: Link[] } : {};
        if (!cancelled) setLinks(Array.isArray(body.links) ? body.links : []);
        // An old runner has no /egress: the proxy row stays hidden.
        const proxy = await fetch(`/v1/phones/${encodeURIComponent(id)}/proxy`, { cache: "no-store" });
        const mode = proxy.ok ? await proxy.json() as Egress : {};
        if (!cancelled) setEgress(mode);
      } catch { /* The next poll tries again; a failed read hides nothing that was shown. */ }
    };
    void load();
    const timer = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [id, running]);
  const laptop = egress.mode === "laptop";
  if (!links.length && !laptop) return null;
  const internet: MiniRow[] = !laptop ? [] : egress.laptop_connected
    ? [["Internet", "Through your computer", "Sites see your computer's IP address. Lookups go there too."
      + (egress.udp === "blocked" ? " Other UDP is blocked, so apps use TCP." : "") + " Stop emuly proxy to switch back."]]
    : [["Internet", egress.lock ? "Off until you turn it back on" : "Paused, reconnecting",
      egress.lock ? "The proxy is locked. Run: emuly proxy <phone> off" : "The link to your computer dropped. Nothing goes out directly while it reconnects."]];
  // The proxy's own port is part of the Internet row, so it gets no row of its own.
  const ports: MiniRow[] = links.filter(link => !(laptop && link.port === egress.port)).map(link => [`Port ${link.port}`,
    (link.route === "ssh" ? link.listening : link.relay_connected) ? "Open" : "Waiting",
    link.route === "ssh" ? "Through an SSH tunnel from your computer." : "Through the Emuly relay (slower)."]);
  if (!internet.length && !ports.length) return null;
  return <Mini title="Your computer" rows={[...internet, ...ports]} />;
}
