import { X } from "lucide-react";
import { cn } from "@/lib/utils/cn";

// Aviso de modo de cobro (turno, mesa o delivery): superficie neutra con
// borde sutil, ícono en el color del modo y la salida a mano. Sin rellenos
// de color ni bordes de color.
export function ModeBanner({
  icon,
  title,
  text,
  exitLabel,
  onExit,
  tone = "accent",
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
  exitLabel: string;
  onExit: () => void;
  tone?: "accent" | "info";
}) {
  return (
    <div
      role="status"
      className="mx-3 mb-3 flex shrink-0 items-center gap-3 rounded-lg border border-border bg-card py-2 pl-2 pr-2 md:mx-4"
    >
      <span
        aria-hidden
        className={cn(
          "grid h-9 w-9 shrink-0 place-items-center rounded-md",
          tone === "info" ? "bg-info/15 text-info" : "bg-ninja-flame/10 text-ninja-flameSoft",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{text}</span>
      </span>
      <button
        type="button"
        onClick={onExit}
        aria-label={exitLabel}
        className="flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground"
      >
        <X size={16} aria-hidden />
        <span className="hidden sm:inline">{exitLabel}</span>
      </button>
    </div>
  );
}
