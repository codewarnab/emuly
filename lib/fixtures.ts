import type { PillKind } from "@/components/ui/pill";

/** Mock data for Phase 1 — matches design/console-v1.html boards 02/03.
    Replaced by DB-backed data in Phase 2+. */

export type LogPart = { type: "text" | "code"; value: string };

export type PhoneRow = {
  id: string;
  name: string;
  state: PillKind;
  statusLabel?: string;
  /** 5 meta rows on the card, [key, value] */
  meta: Array<[string, string]>;
  thumbDim?: boolean;
  screenReady?: boolean;
  foot: { ghost: string; primary: string };
};

export const mockUser = {
  login: "sutanukaa",
  initials: "SU",
};

export const mockQuota = {
  usedHours: 18.6,
  totalHours: 45,
  leftHours: 26.4,
};

export const mockPhones: PhoneRow[] = [
  {
    id: "phone-7f2a",
    name: "phone-7f2a",
    state: "running",
    meta: [
      ["slot", "damp-cape-wr7q"],
      ["machine", "4 vCPU / 16 GB"],
      ["up", "1 h 12 m"],
      ["boot", "15 s snapshot"],
      ["idle stop", "in 2 h 48 m"],
    ],
    foot: { ghost: "Stop", primary: "Open phone →" },
  },
  {
    id: "phone-3c19",
    name: "phone-3c19",
    state: "stopped",
    thumbDim: true,
    meta: [
      ["slot", "silent-oyster-fce3"],
      ["saved", "4 h ago"],
      ["disk", "26.1 GB"],
      ["resume", "~15 s"],
      ["delete on", "Nov 12"],
    ],
    foot: { ghost: "Backups", primary: "Wake →" },
  },
];

export const mockLog = {
  phone: "phone-7f2a",
  rows: [
    {
      time: "12:04",
      ok: false,
      parts: [
        { type: "text" as const, value: "waking codespace " },
        { type: "code" as const, value: "damp-cape-wr7q" },
      ],
    },
    {
      time: "12:04",
      ok: true,
      parts: [{ type: "text" as const, value: "phone booted in 15 s (snapshot)" }],
    },
    {
      time: "12:05",
      ok: false,
      parts: [
        { type: "text" as const, value: "adb install " },
        { type: "code" as const, value: "app-debug.apk" },
        { type: "text" as const, value: " (24.8 MB)" },
      ],
    },
    {
      time: "12:05",
      ok: false,
      parts: [
        { type: "text" as const, value: "launch " },
        { type: "code" as const, value: "com.example.app" },
      ],
    },
    { time: "12:06", ok: false, parts: [{ type: "text" as const, value: "tap (540, 1200)" }] },
    {
      time: "12:06",
      ok: false,
      parts: [{ type: "text" as const, value: 'input text "hello world"' }],
    },
    {
      time: "12:06",
      ok: true,
      parts: [{ type: "text" as const, value: "Screenshot saved" }],
    },
    {
      time: "12:07",
      ok: false,
      parts: [{ type: "text" as const, value: "waiting for your next prompt…" }],
    },
  ],
};

export const mockDetail = {
  phone: "phone-7f2a",
  state: "running" as PillKind,
  upFor: "1 h 12 m",
  streamUrl: "https://damp-cape-8443.app.github.dev",
  thisPhone: [
    ["Android", "API 36 with Google APIs"],
    ["Memory", "2.9 GB / 16 GB"],
    ["CPU", "180% / 400%"],
    ["adb", "localhost:15555"],
  ] as Array<[string, string]>,
  lastBackup: [
    ["Generation", "gen-3"],
    ["Size", "2.4 GB"],
    ["Hash", "Verified"],
    ["Kept", "2 generations"],
  ] as Array<[string, string]>,
};
