"use client";
import { useEffect, useState } from "react";
import { Mini } from "@/components/ui/mini";

type Link = { port: number; route: string; listening: boolean; relay_connected: boolean };

/**
 * The links of this phone (docs/link-plan.html, section 8). Shown only when a link exists, so
 * the user can see each port that apps on the phone can reach on their computer.
 */
export function PhoneLinks({ id, running }: { id: string; running: boolean }) {
  const [links, setLinks] = useState<Link[]>([]);
  useEffect(() => {
    if (!running) { setLinks([]); return; }
    let cancelled = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch(`/v1/phones/${encodeURIComponent(id)}/links`, { cache: "no-store" });
        const body = response.ok ? await response.json() as { links?: Link[] } : {};
        if (!cancelled) setLinks(Array.isArray(body.links) ? body.links : []);
      } catch { /* The next poll tries again; a failed read hides nothing that was shown. */ }
    };
    void load();
    const timer = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [id, running]);
  if (!links.length) return null;
  return <Mini title="Links to your computer" rows={links.map(link => [`Port ${link.port}`,
    `${link.route === "ssh" ? "SSH tunnel" : "Emuly relay"} · ${(link.route === "ssh" ? link.listening : link.relay_connected) ? "open" : "waiting"}`])} />;
}
