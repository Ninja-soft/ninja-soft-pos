import { CircleDashed } from "lucide-react";

import { cn } from "@/lib/utils/cn";

/**
 * Marcador inline para celdas o campos sin valor. Reemplaza al guion largo,
 * que está prohibido en toda la UI.
 */
export function NoData({ className }: { className?: string }) {
  return (
    <span
      title="Sin datos"
      className={cn("inline-flex items-center align-middle text-muted-foreground/60", className)}
    >
      <CircleDashed size={14} aria-hidden="true" />
      <span className="sr-only">Sin datos</span>
    </span>
  );
}

NoData.displayName = "NoData";
