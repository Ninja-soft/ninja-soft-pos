"use client";

import { ChevronDown, Truck } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { formatQty } from "@/lib/utils/format";
import {
  storeStockTone,
  type StoreRef,
  type StoreStockRow,
} from "@/lib/stock/byStore";

const TONE_CLS = {
  ok: "text-foreground",
  low: "text-warning",
  out: "text-danger",
  negative: "text-danger",
} as const;

interface InlineProduct {
  id: string;
  has_variants: boolean | null;
  stock_min: number | null;
}

interface StoreQty {
  store: StoreRef;
  qty: number;
  min: number;
  inTransitIn: number;
  current: boolean;
}

/** Stock de un producto por sucursal (suma variantes si tiene). */
export function storeQuantities(
  product: InlineProduct,
  stores: StoreRef[],
  rows: StoreStockRow[],
  currentStoreId: string | null,
): StoreQty[] {
  const hasVariants = Boolean(product.has_variants);
  const list = stores.map((store) => {
    const mine = rows.filter(
      (r) =>
        r.product_id === product.id &&
        r.store_id === store.id &&
        (hasVariants ? r.variant_id != null : r.variant_id == null),
    );
    const own = mine.find((r) => r.variant_id == null);
    return {
      store,
      qty: mine.reduce((t, r) => t + Number(r.qty ?? 0), 0),
      min: hasVariants ? 0 : Number(own?.min_qty ?? product.stock_min ?? 0),
      inTransitIn: mine.reduce((t, r) => t + Number(r.in_transit_in ?? 0), 0),
      current: store.id === currentStoreId,
    };
  });
  return list.sort((a, b) =>
    a.current === b.current ? 0 : a.current ? -1 : 1,
  );
}

// Resumen bajo el stock total en la lista de Productos: la sucursal actual y
// un botón para ver las demás.
export function StoreStockInlineSummary({
  quantities,
  expanded,
  onToggle,
}: {
  quantities: StoreQty[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const current = quantities.find((q) => q.current) ?? quantities[0];
  if (!current) return null;
  const others = quantities.length - 1;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground transition hover:text-foreground"
      title="Ver stock por sucursal"
    >
      <span className="max-w-[9rem] truncate">{current.store.name}</span>
      <span
        className={cn(
          "font-mono tabular-nums",
          TONE_CLS[storeStockTone(current.qty, current.min)],
        )}
      >
        {formatQty(current.qty)}
      </span>
      {others > 0 && <span>· +{others}</span>}
      <ChevronDown
        size={12}
        className={cn("transition", expanded && "rotate-180")}
      />
    </button>
  );
}

// Fila expandida: una pastilla por sucursal.
export function StoreStockChips({ quantities }: { quantities: StoreQty[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {quantities.map((q) => (
        <span
          key={q.store.id}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs",
            q.current
              ? "bg-ninja-flame/10 text-foreground ring-1 ring-ninja-flame/30"
              : "bg-muted text-muted-foreground",
          )}
        >
          <span className="font-medium">{q.store.name}</span>
          <span
            className={cn(
              "font-mono font-semibold tabular-nums",
              TONE_CLS[storeStockTone(q.qty, q.min)],
            )}
          >
            {formatQty(q.qty)}
          </span>
          {q.inTransitIn > 0 && (
            <span
              className="inline-flex items-center gap-0.5 text-info"
              title="En camino"
            >
              <Truck size={11} /> +{formatQty(q.inTransitIn)}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}
