import { cn } from "@/lib/utils/cn";

// Pastilla de estado. Relleno tonal, sin borde de color.
const TONES = {
  brand: "bg-ninja-flame/15 text-ninja-flameSoft",
  gold: "bg-ninja-gold/15 text-warning",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-danger/15 text-danger",
  info: "bg-info/15 text-info",
  neutral: "bg-muted text-muted-foreground",
} as const;

export type BadgeTone = keyof typeof TONES;

export function Badge({
  tone = "neutral",
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold",
        TONES[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
Badge.displayName = "Badge";
