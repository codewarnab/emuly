import s from "@/components/console.module.css";

export type PillKind = "running" | "stopped" | "stopping" | "booting" | "needsyou";

/** The word that each pill shows. The card and the list row use the same words. */
export const PILL_LABEL: Record<PillKind, string> = { running: "running", stopped: "stopped", stopping: "stopping", booting: "starting", needsyou: "failed" };

const kinds: Record<PillKind, string> = {
  running: s.pillRun,
  stopped: s.pillStop,
  stopping: s.pillBoot,
  booting: s.pillBoot,
  needsyou: s.pillErr,
};

export function Pill({
  kind,
  children,
  dot = true,
}: {
  kind: PillKind;
  children: React.ReactNode;
  dot?: boolean;
}) {
  return (
    <span className={`${s.pill} ${kinds[kind]}`}>
      {dot && <i />}
      {children}
    </span>
  );
}
