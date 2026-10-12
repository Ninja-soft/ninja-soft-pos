import { CircleDashed } from "lucide-react";

import { cn } from "@/lib/utils/cn";

/**
 * Marcador inline para celdas o campos sin valor. Reemplaza al guion largo,
 * que está prohibido en toda la UI.
 *
 * `relative`: el texto sr-only (absolute) queda contenido en el marcador. Sin
 * eso, dentro de una tabla con scroll horizontal escapa del recorte y
 * ensancha la página (scroll horizontal a 390 en /clientes).
 */
export function NoData({ className }: { className?: string }) {
  return (
    <span
      title="Sin datos"
      className={cn("relative inline-flex items-center align-middle text-muted-foreground/60", className)}
    >
      <CircleDashed size={14} aria-hidden="true" />
      <span className="sr-only">Sin datos</span>
    </span>
  );
}

NoData.displayName = "NoData";
