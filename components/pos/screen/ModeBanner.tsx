import { X } from "lucide-react";
import { cn } from "@/lib/utils/cn";

// Aviso de modo de cobro (turno, mesa o delivery): relleno suave, sin bordes
// de color, con la salida a mano.
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
      className={cn(
        "mx-3 mb-2 flex shrink-0 items-center gap-3 rounded-2xl px-3.5 py-2.5 md:mx-4",
        tone === "info" ? "bg-sky-400/15" : "bg-[color-mix(in_srgb,var(--pos-from)_14%,transparent)]",
      )}
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[color-mix(in_srgb,var(--background)_55%,transparent)]">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-black">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{text}</span>
      </span>
      <button
        type="button"
        onClick={onExit}
        className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-[color-mix(in_srgb,var(--background)_55%,transparent)] px-3 text-xs font-bold text-muted-foreground transition hover:text-foreground"
      >
        <X size={14} />
        <span className="hidden sm:inline">{exitLabel}</span>
      </button>
    </div>
  );
}
