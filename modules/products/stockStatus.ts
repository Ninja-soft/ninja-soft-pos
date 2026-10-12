import { formatQty } from "@/lib/utils/format";

export type StockTone = "untracked" | "out" | "low" | "ok";

export interface StockStatus {
  tone: StockTone;
  /** Texto del listado: cantidad con unidad, o "Sin control de stock". */
  label: string;
}

type StockFields = {
  track_stock: boolean | null;
  stock: number | null;
  stock_min?: number | null;
  unit?: string | null;
};

/**
 * Estado de stock de un producto para el listado del panel: la cantidad con su
 * unidad cuando controla stock (marcando agotado o bajo el mínimo), o
 * "Sin control de stock" cuando no lo controla.
 */
export function productStockStatus(p: StockFields): StockStatus {
  if (!p.track_stock) return { tone: "untracked", label: "Sin control de stock" };
  const stock = Number(p.stock ?? 0);
  const unit = (p.unit ?? "").trim();
  const label = unit ? `${formatQty(stock)} ${unit}` : formatQty(stock);
  if (stock <= 0) return { tone: "out", label };
  const min = Number(p.stock_min ?? 0);
  if (min > 0 && stock <= min) return { tone: "low", label };
  return { tone: "ok", label };
}
