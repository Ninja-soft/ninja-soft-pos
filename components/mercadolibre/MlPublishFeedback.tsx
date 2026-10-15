"use client";

import { AlertTriangle, ExternalLink, Info, Truck } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { mlCauseInfo } from "@/lib/mercadolibre/labels";

// Resultado de validar o publicar en Mercado Libre, igual en el modal
// individual y en la publicación rápida: errores y avisos de ML en español con
// la acción, el código crudo en un desplegable y, si la cuenta no tiene
// Mercado Envíos, cómo activarlo.

export function MlCauseList({
  items,
  names,
  tone = "danger",
  compact = false,
  max = 8,
}: {
  items: string[];
  names?: Record<string, string>;
  tone?: "danger" | "warning" | "info";
  compact?: boolean;
  max?: number;
}) {
  if (items.length === 0) return null;
  const infos = items.slice(0, max).map((e) => mlCauseInfo(e, names));
  const raw = infos.filter((i) => i.code);
  const Icon = tone === "danger" ? AlertTriangle : Info;
  const color = tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-info";
  return (
    <div className={cn("space-y-1.5", compact ? "text-xs" : "text-sm")}>
      <ul className="space-y-1.5">
        {infos.map((i, k) => (
          <li key={k} className="flex gap-1.5">
            <Icon size={compact ? 13 : 15} className={cn("mt-0.5 shrink-0", color)} aria-hidden />
            <span className="min-w-0">
              <span className="text-foreground">{i.message}</span>
              {i.action && <span className="block text-muted-foreground">{i.action}</span>}
            </span>
          </li>
        ))}
      </ul>
      {items.length > max && <p className="text-muted-foreground">Y {items.length - max} más.</p>}
      {raw.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">Ver detalle técnico</summary>
          <ul className="mt-1 space-y-1 break-all font-mono">
            {raw.map((i, k) => (
              <li key={k}>{i.raw}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Cómo activar Mercado Envíos en la cuenta de Mercado Libre. */
export function MlMeActivationHint({ url, path, compact = false }: { url: string; path: string; compact?: boolean }) {
  return (
    <p className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground", compact ? "text-xs" : "text-sm")}>
      <Truck size={compact ? 13 : 15} className="shrink-0" aria-hidden />
      <span>Para ofrecer Mercado Envíos, activalo en Mercado Libre ({path}).</span>
      <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-foreground hover:underline">
        Abrir Mercado Libre <ExternalLink size={12} aria-hidden />
      </a>
    </p>
  );
}
