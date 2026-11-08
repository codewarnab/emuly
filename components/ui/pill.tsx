import s from "@/components/console.module.css";

export type PillKind = "running" | "stopped" | "stopping" | "booting" | "needsyou";

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
