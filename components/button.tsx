import s from "./console.module.css";

export type ButtonVariant = "default" | "ghost" | "dim" | "danger";

export function Button({
  variant = "default",
  tiny = false,
  className,
  children,
  ...rest
}: {
  variant?: ButtonVariant;
  tiny?: boolean;
  className?: string;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const variantClass =
    variant === "ghost"
      ? s.btnGhost
      : variant === "dim"
        ? s.btnDim
        : variant === "danger"
          ? s.btnDanger
          : "";
  return (
    <button
      className={[s.btn, variantClass, tiny ? s.btnTiny : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
}
