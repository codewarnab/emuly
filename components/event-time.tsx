"use client";

import { useEffect, useState } from "react";
import { timeAgo, utcLabel } from "../lib/relative-time";

/** Re-renders every minute so relative times and timers stay current. */
function useNow() {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** "6 min ago", with the full UTC time as a tooltip. The server render shows UTC, so nothing jumps. */
export function TimeAgo({ at }: { at: string }) {
  const now = useNow();
  return <time dateTime={at} title={utcLabel(at)}>{now === null ? utcLabel(at).slice(11) : timeAgo(at, now)}</time>;
}

/** A live timer for the step that still runs. */
export function Elapsed({ since }: { since: string }) {
  const now = useNow();
  if (now === null) return null;
  const minutes = Math.floor((now - Date.parse(since)) / 60_000);
  return <span>{minutes < 1 ? "under 1 min" : `${minutes} min`}</span>;
}
