"use client";
import { useEffect, useState } from "react";
import { Mini } from "@/components/ui/mini";

type Link = { port: number; route: string; listening: boolean; relay_connected: boolean };
type Egress = { mode?: string; port?: number | null; lock?: boolean; laptop_connected?: boolean | null; udp?: string };

/**
 * The links of this phone. Shown only when a link exists, so
 * the user can see each port that apps on the phone can reach on their computer.
 * When `emuly proxy` runs, a "Traffic" row says that all phone traffic goes through the computer,
 * or that it is blocked because the proxy is offline (fail closed).
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
  const traffic: [string, string][] = laptop ? [["Traffic", egress.laptop_connected
    ? `via your computer${egress.udp === "blocked" ? " · UDP blocked" : ""}`
    : `blocked: proxy offline${egress.lock ? " (locked)" : ""}`]] : [];
  return <Mini title="Links to your computer" rows={[...traffic, ...links.map(link => [
    laptop && link.port === egress.port ? "Traffic proxy" : `Port ${link.port}`,
    `${link.route === "ssh" ? "SSH tunnel" : "Emuly relay"} · ${(link.route === "ssh" ? link.listening : link.relay_connected) ? "open" : "waiting"}`] as [string, string])]} />;
}
