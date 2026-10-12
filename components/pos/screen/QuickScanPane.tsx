"use client";

import { forwardRef } from "react";
import { Banknote, CornerDownLeft, X } from "lucide-react";
import type { Product } from "@/modules/products/api";
import { cn } from "@/lib/utils/cn";
import { Keypad, type KeypadKey } from "../ui/Keypad";
import { money } from "../ui/posStyles";
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
            className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-card shadow-[inset_0_0_0_1px_var(--border)] transition hover:bg-muted"
            aria-label="Venta libre (monto manual)"
            title="Monto libre"
          >
            <Banknote size={20} />
          </button>
        )}
      </div>
      {p.pendingQty > 1 && (
        <div className="flex items-center gap-2 self-start rounded-full bg-[color-mix(in_srgb,var(--pos-from)_16%,transparent)] py-1 pl-3 pr-1 text-sm font-bold">
          Próximo producto × {p.pendingQty}
          <button type="button" onClick={p.onClearQty} className="grid h-6 w-6 place-items-center rounded-full hover:bg-black/10" aria-label="Quitar cantidad">
            <X size={13} />
          </button>
        </div>
      )}
      {typing && (
        <div className="rounded-2xl bg-card p-1.5 shadow-sm">
          {(p.results ?? []).length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted-foreground">
              Sin coincidencias. Enter busca el código exacto.
            </p>
          ) : (
            <ul className="slim-scrollbar max-h-64 overflow-y-auto">
              {(p.results ?? []).slice(0, 30).map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => p.onPick(r)}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition hover:bg-muted"
                  >
                    {r.plu && (
                      <span className="w-14 shrink-0 font-mono text-xs font-bold text-muted-foreground">{r.plu}</span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">{r.name}</span>
                    <span className="font-price text-sm font-black tabular-nums">
                      {money(r.price)}
                      {r.unit === "kg" && <span className="text-[11px] text-muted-foreground">/kg</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="slim-scrollbar min-h-[220px] flex-1 overflow-y-auto rounded-[24px] bg-card p-1.5">
        <div className="flex items-center justify-between px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
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
  return (
    <div className="space-y-2">
      <Keypad onKey={onKey} lastKey="00" />
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onTimes}
          className="h-12 rounded-2xl bg-fg-6 font-price text-lg font-black transition hover:bg-fg-10 active:scale-95"
          title="Cantidad para el próximo producto"
        >
          × Cant.
        </button>
        <button
          type="button"
          onClick={onEnter}
          className={cn(
            "flex h-12 items-center justify-center gap-2 rounded-2xl bg-foreground text-sm font-black text-background transition active:scale-95",
          )}
        >
          <CornerDownLeft size={16} /> Buscar
        </button>
      </div>
    </div>
  );
}
