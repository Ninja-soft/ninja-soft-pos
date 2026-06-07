"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export interface PaginationProps {
  /** Página actual (1-based). */
  page: number;
  /** Filas por página. */
  pageSize: number;
  /** Total de filas (count exacto del server). */
  total: number;
  /** Cambia de página (recibe la nueva página 1-based). */
  onPageChange: (page: number) => void;
  /** Deshabilita los controles mientras carga (evita saltos al pasar página). */
  loading?: boolean;
  className?: string;
}

// Paginador reutilizable: indicador "X–Y de N" + Anterior/Siguiente. Mobile-first
// (se apila en pantallas chicas) y respeta el tema ninja. Pensado para listados
// paginados server-side (.range + count exact). No renderiza nada si total === 0.
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  loading = false,
  className,
}: PaginationProps) {
  if (total <= 0) return null;

  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), lastPage);
  const from = (current - 1) * pageSize + 1;
  const to = Math.min(current * pageSize, total);

  const canPrev = current > 1 && !loading;
  const canNext = current < lastPage && !loading;

  const btn =
    "inline-flex h-9 items-center gap-1 rounded-lg border border-border px-3 text-sm font-medium text-foreground transition hover:bg-muted disabled:pointer-events-none disabled:opacity-40";

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 px-1 py-3 text-sm",
        className,
      )}
    >
      <span className="text-muted-foreground">
        <span className="font-medium text-foreground">
          {from.toLocaleString("es-AR")}–{to.toLocaleString("es-AR")}
        </span>{" "}
        de {total.toLocaleString("es-AR")}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onPageChange(current - 1)}
          disabled={!canPrev}
          className={btn}
          aria-label="Página anterior"
        >
          <ChevronLeft size={16} /> Anterior
        </button>
        <span className="px-1 text-muted-foreground" aria-live="polite">
          {current} / {lastPage}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(current + 1)}
          disabled={!canNext}
          className={btn}
          aria-label="Página siguiente"
        >
          Siguiente <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
