"use client";

import { forwardRef } from "react";
import { Banknote, CornerDownLeft, SearchX, X } from "lucide-react";
import type { Product } from "@/modules/products/api";
import { cn } from "@/lib/utils/cn";
import { Keypad, type KeypadKey } from "../ui/Keypad";
import { POS_EYEBROW, POS_PANEL, money } from "../ui/posStyles";
import { PosSearch } from "./ProductPane";

// Caja rápida: el escáner / PLU arriba, resultados de búsqueda en lista y el
// ticket en curso como protagonista. El teclado escribe en el mismo campo:
// número + "×" fija la cantidad del próximo producto; Enter busca el código.

export const QuickScanPane = forwardRef<
  HTMLInputElement,
  {
    search: string;
    onSearch: (v: string) => void;
    onScan: () => void;
    onEnter: () => void;
    pendingQty: number;
    onClearQty: () => void;
    results: Product[] | undefined;
    onPick: (p: Product) => void;
    canFreeSale: boolean;
    onFreeSale: () => void;
    ticket: React.ReactNode;
  }
>(function QuickScanPane(p, ref) {
  const typing = p.search.trim().length > 0;
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <PosSearch
            ref={ref}
            big
            value={p.search}
            onChange={p.onSearch}
            onScan={p.onScan}
            onEnter={p.onEnter}
            placeholder="Escaneá o tipeá PLU, código o nombre"
          />
        </div>
        {p.canFreeSale && (
          <button
            type="button"
            onClick={p.onFreeSale}
            className="grid h-14 w-14 shrink-0 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:bg-fg-4 hover:text-foreground"
            aria-label="Venta libre (monto manual)"
            title="Monto libre"
          >
            <Banknote size={20} aria-hidden />
          </button>
        )}
      </div>
      {p.pendingQty > 1 && (
        <div className="flex h-9 items-center gap-2 self-start rounded-md bg-fg-6 pl-3 pr-1 text-sm">
          <span className="text-muted-foreground">Próximo producto</span>
          <span className="font-price font-semibold tabular-nums">× {p.pendingQty}</span>
          <button
            type="button"
            onClick={p.onClearQty}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-fg-10 hover:text-foreground"
            aria-label="Quitar cantidad"
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      )}
      {typing && (
        <div className="rounded-lg border border-border bg-popover p-1 shadow-sm">
          {(p.results ?? []).length === 0 ? (
            <p className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
              <SearchX size={16} aria-hidden /> Sin coincidencias. Enter busca el código exacto.
            </p>
          ) : (
            <ul className="slim-scrollbar max-h-64 overflow-y-auto">
              {(p.results ?? []).slice(0, 30).map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => p.onPick(r)}
                    className="flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-fg-6"
                  >
                    <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground">{r.plu ?? ""}</span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{r.name}</span>
                    <span className="font-price text-sm font-semibold tabular-nums">
                      {money(r.price)}
                      {r.unit === "kg" && <span className="text-xs font-medium text-muted-foreground">/kg</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className={cn("slim-scrollbar min-h-[220px] flex-1 overflow-y-auto p-1.5", POS_PANEL)}>
        <div className={cn("flex items-center justify-between px-2.5 pb-1.5 pt-2", POS_EYEBROW)}>
          <span>Ticket</span>
          <span className="hidden sm:inline">Cant. · Importe</span>
        </div>
        {p.ticket}
      </div>
    </div>
  );
});

export function QuickKeypadPanel({
  onKey,
  onTimes,
  onEnter,
}: {
  onKey: (k: KeypadKey) => void;
  onTimes: () => void;
  onEnter: () => void;
}) {
  const action =
    "flex h-12 items-center justify-center gap-2 rounded-lg bg-fg-6 text-sm font-semibold text-foreground transition-colors hover:bg-fg-10 active:bg-[color-mix(in_srgb,var(--foreground)_18%,transparent)]";
  return (
    <div className="space-y-2">
      <Keypad onKey={onKey} lastKey="00" />
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={onTimes} className={action} title="Cantidad para el próximo producto">
          <span className="font-price text-base">×</span> Cantidad
        </button>
        <button type="button" onClick={onEnter} className={action}>
          <CornerDownLeft size={16} aria-hidden /> Buscar
        </button>
      </div>
    </div>
  );
}
