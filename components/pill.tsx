import s from "./console.module.css";

export type PillKind = "running" | "stopped" | "booting" | "needsyou";

const kinds: Record<PillKind, string> = {
  running: s.pillRun,
  stopped: s.pillStop,
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
