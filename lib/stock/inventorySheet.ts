// =============================================================================
// Planillas de Inventario (ADR-137). Puro: arma las hojas del Excel de stock
// (una por sucursal, con el desglose por depósito y el costo si el usuario lo
// puede ver) y la planilla para contar (formato de la importación de ajustes,
// con Operación = Fijar y Motivo = Conteo ya puestos). exportXlsx las dibuja.
// =============================================================================

import type { XlsxColumn, XlsxSheet } from "@/lib/utils/xlsx";
import { ADJUST_MODE_LABEL, ADJUST_REASON_LABEL } from "./adjustments";

export interface StockSheetRow {
  product_id: string;
  variant_id: string | null;
  product_name: string;
  variant_label: string | null;
  sku: string | null;
  barcode: string | null;
  image_url: string | null;
  unit: string;
  category_name: string | null;
  cost: number | null;
  price: number | null;
  store_qty: number;
  min_qty: number | null;
  max_qty: number | null;
  location: string | null;
  /** Salón de ventas (lo que queda de la sucursal); null sin depósitos. */
  principal_qty: number | null;
  /** warehouse_id → cantidad en ese depósito interno. */
  by_warehouse: Record<string, number>;
  total_count: number;
}

export interface SheetWarehouse {
  id: string;
  name: string;
  kind: string;
}

export interface SheetStore {
  id: string;
  name: string;
}

/** Nombre de hoja válido para Excel (31 caracteres, sin \ / ? * [ ] :). */
export function sheetName(s: string): string {
  const clean = s.replace(/[\\/?*[\]:]/g, " ").replace(/\s+/g, " ").trim();
  return (clean || "Hoja").slice(0, 31);
}

/** Etiqueta del ítem: "Remera (M / Negro)". */
export function itemLabel(r: Pick<StockSheetRow, "product_name" | "variant_label">): string {
  return r.variant_label ? `${r.product_name} (${r.variant_label})` : r.product_name;
}

/** ¿Tiene stock bajo el mínimo? */
export function isLow(r: Pick<StockSheetRow, "store_qty" | "min_qty">): boolean {
  return r.min_qty != null && r.store_qty <= r.min_qty;
}

const others = (whs: SheetWarehouse[]) => whs.filter((w) => w.kind !== "principal");

/** Columnas de la hoja de stock de una sucursal. */
export function stockSheetColumns(warehouses: SheetWarehouse[], showCost: boolean): XlsxColumn[] {
  const extra = others(warehouses);
  return [
    { header: "Producto", key: "product", width: 34 },
    { header: "Variante", key: "variant", width: 16 },
    { header: "SKU", key: "sku", width: 14 },
    { header: "Código de barras", key: "barcode", width: 18 },
    { header: "Categoría", key: "category", width: 18 },
    { header: "Unidad", key: "unit", width: 8 },
    ...(showCost ? [{ header: "Costo", key: "cost", type: "money" as const, width: 12 }] : []),
    { header: "Stock sucursal", key: "store_qty", type: "number" as const, width: 14 },
    ...(extra.length > 0
      ? [
          { header: "Salón de ventas", key: "principal_qty", type: "number" as const, width: 14 },
          ...extra.map((w) => ({ header: w.name, key: `wh_${w.id}`, type: "number" as const, width: 14 })),
        ]
      : []),
    { header: "Mínimo", key: "min_qty", type: "number" as const, width: 10 },
    { header: "Ubicación", key: "location", width: 14 },
    ...(showCost ? [{ header: "Valor al costo", key: "value", type: "money" as const, width: 16 }] : []),
  ];
}

export function stockSheetRows(rows: StockSheetRow[], warehouses: SheetWarehouse[]): Record<string, unknown>[] {
  const extra = others(warehouses);
  return rows.map((r) => ({
    product: r.product_name,
    variant: r.variant_label ?? "",
    sku: r.sku ?? "",
    barcode: r.barcode ?? "",
    category: r.category_name ?? "",
    unit: r.unit,
    cost: r.cost,
    store_qty: r.store_qty,
    principal_qty: r.principal_qty ?? r.store_qty,
    ...Object.fromEntries(extra.map((w) => [`wh_${w.id}`, r.by_warehouse[w.id] ?? 0])),
    min_qty: r.min_qty,
    location: r.location ?? "",
    value: r.cost == null ? null : Math.round(Math.max(r.store_qty, 0) * r.cost * 100) / 100,
  }));
}

/** Totales de la hoja (stock y valor al costo, sin contar negativos). */
export function stockSheetTotals(rows: StockSheetRow[], showCost: boolean): Record<string, number> {
  const units = rows.reduce((a, r) => a + Math.max(r.store_qty, 0), 0);
  const out: Record<string, number> = { store_qty: Math.round(units * 1000) / 1000 };
  if (showCost) {
    out.value = Math.round(rows.reduce((a, r) => a + Math.max(r.store_qty, 0) * (r.cost ?? 0), 0) * 100) / 100;
  }
  return out;
}

export function stockSheet(
  store: SheetStore,
  rows: StockSheetRow[],
  warehouses: SheetWarehouse[],
  opts: { showCost: boolean; businessName?: string | null; generatedAt: string },
): XlsxSheet {
  return {
    name: sheetName(`Stock ${store.name}`),
    title: `Stock de ${store.name}`,
    subtitle: [opts.businessName, `Generado el ${opts.generatedAt}`].filter(Boolean).join(" · "),
    columns: stockSheetColumns(warehouses, opts.showCost),
    rows: stockSheetRows(rows, warehouses),
    totals: stockSheetTotals(rows, opts.showCost),
  };
}

/**
 * Filas de la planilla para contar (formato de la importación de ajustes):
 * Operación Fijar, Motivo Conteo, cantidad vacía para completar y el stock del
 * sistema como referencia. Con depósito, el stock de referencia es el de ese
 * depósito.
 */
export function countSheetRows(
  rows: StockSheetRow[],
  store: { label: string },
  warehouse: SheetWarehouse | null = null,
): Record<string, unknown>[] {
  return rows.map((r) => ({
    store: store.label,
    warehouse: warehouse?.name ?? "",
    warehouse_code: "",
    sku: r.sku ?? "",
    barcode: r.barcode ?? "",
    product: itemLabel(r),
    system_qty: !warehouse
      ? r.store_qty
      : warehouse.kind === "principal"
        ? (r.principal_qty ?? r.store_qty)
        : (r.by_warehouse[warehouse.id] ?? 0),
    op: ADJUST_MODE_LABEL.set,
    qty: null,
    reason: ADJUST_REASON_LABEL.conteo,
    notes: "",
  }));
}

/** Filas sin SKU ni código de barras: no se pueden importar (avisar). */
export function rowsWithoutCode(rows: StockSheetRow[]): number {
  return rows.filter((r) => !r.sku && !r.barcode).length;
}

/** Fecha y hora de Argentina (dd/mm/aaaa hh:mm), sin depender del huso del navegador. */
export function fmtDateTimeAR(iso: string | Date | null | undefined): string {
  if (!iso) return "";
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${p("day")}/${p("month")}/${p("year")} ${p("hour")}:${p("minute")}`;
}
