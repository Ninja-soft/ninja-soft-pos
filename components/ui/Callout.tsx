import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils/cn";

// Aviso tonal. Se destaca con relleno, nunca con borde de color.
const TONES = {
  brand: { box: "bg-ninja-flame/[0.08]", icon: "text-ninja-flameSoft" },
  info: { box: "bg-info/10", icon: "text-info" },
  success: { box: "bg-success/10", icon: "text-success" },
  warning: { box: "bg-warning/10", icon: "text-warning" },
  danger: { box: "bg-danger/10", icon: "text-danger" },
  neutral: { box: "bg-muted", icon: "text-muted-foreground" },
} as const;

export type CalloutTone = keyof typeof TONES;

export function Callout({
  tone = "brand",
  icon: Icon,
  title,
  children,
  actions,
  className,
}: {
  tone?: CalloutTone;
  icon?: LucideIcon;
  title?: React.ReactNode;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  const t = TONES[tone];
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-xl p-3.5 text-sm",
        t.box,
        className,
      )}
    >
      {Icon && <Icon size={18} className={cn("mt-0.5 shrink-0", t.icon)} aria-hidden />}
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold text-foreground">{title}</p>}
        {children && (
          <div className={cn("text-muted-foreground", title && "mt-0.5")}>{children}</div>
        )}
        {actions && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  );
}
Callout.displayName = "Callout";

/** Clases de relleno tonal para cajas que no pueden usar <Callout /> tal cual. */
export function calloutTone(tone: CalloutTone = "brand") {
  return TONES[tone].box;
}
