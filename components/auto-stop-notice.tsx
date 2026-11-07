"use client";
import { useEffect, useRef } from "react";
import { dismissAutoStops } from "../app/actions/settings";
import { useToast } from "./ui-provider";

export function AutoStopNotice({ notices }: { notices: { id: number; message: string }[] }) {
  const shown = useRef(new Set<number>());
  const notify = useToast();
  useEffect(() => {
    const unread = notices.filter(notice => !shown.current.has(notice.id));
    if (!unread.length) return;
    unread.forEach(notice => shown.current.add(notice.id));
    notify(`Auto-stop requested for ${unread.length} ${unread.length === 1 ? "phone" : "phones"} with about 30 minutes of estimated hours left. Your codespaces keep them.`);
    void dismissAutoStops(unread.map(notice => notice.id)).catch(() => {
      // Keep the events unread so the next page load can show them again.
    });
  }, [notices, notify]);
  return null;
}
