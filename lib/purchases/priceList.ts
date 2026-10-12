// lib/purchases/priceList.ts
//
// Importación de la lista de precios del proveedor (F18 · H100 + H101,
// ADR-059). Lógica PURA: mapeo de columnas (con sugerencia por encabezado),
// lectura de filas, cruce con los productos del proveedor y del catálogo y
// vista previa con la diferencia contra el costo de lista actual. Lo aplica
// supplier_price_list_apply (migración 20261022100500).

import { round } from "./costs";

export type PriceListField = "supplier_sku" | "sku" | "barcode" | "name" | "cost" | "units";

export const PRICE_LIST_FIELDS: PriceListField[] = ["supplier_sku", "sku", "barcode", "name", "cost", "units"];

export const PRICE_LIST_FIELD_LABEL: Record<PriceListField, string> = {
  supplier_sku: "Código del proveedor",
  sku: "SKU propio",
  barcode: "Código de barras",
  name: "Descripción",
  cost: "Costo / precio de lista",
  units: "Unidades por bulto",
};

const ALIASES: Record<PriceListField, string[]> = {
  supplier_sku: ["codigo proveedor", "cod proveedor", "codigo", "cod", "cod.", "art", "articulo", "item", "ref", "referencia"],
  sku: ["sku", "sku propio", "codigo interno"],
  barcode: ["ean", "ean13", "codigo de barras", "cod barras", "barcode", "gtin", "upc"],
  name: ["descripcion", "producto", "detalle", "nombre", "articulo descripcion"],
  cost: ["precio", "costo", "precio lista", "precio de lista", "lista", "p. lista", "neto", "precio neto", "importe", "valor"],
  units: ["unidades", "unidades por bulto", "bulto", "x bulto", "pack", "cantidad por caja", "u/bulto"],
};

/** Columna del archivo por campo (índice 0-based); null = no se usa. */
export type PriceListMapping = Partial<Record<PriceListField, number | null>>;

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sugerencia de mapeo por encabezado (exacto primero, después "contiene"). */
export function guessMapping(headers: string[]): PriceListMapping {
  const h = headers.map(norm);
  const used = new Set<number>();
  const out: PriceListMapping = {};
  const order: PriceListField[] = ["barcode", "sku", "supplier_sku", "units", "cost", "name"];
  for (const pass of ["exact", "contains"] as const) {
    for (const field of order) {
      if (out[field] != null) continue;
      const idx = h.findIndex(
        (x, i) =>
          !used.has(i) &&
          x !== "" &&
          ALIASES[field].some((a) => (pass === "exact" ? x === a : x.includes(a))),
      );
      if (idx >= 0) {
        out[field] = idx;
        used.add(idx);
      }
    }
  }
  return out;
}

/**
 * Número de una celda de lista: "$ 1.234,56", "1,234.56", "1234.5", "12,5".
 * Con punto y coma, el último separador es el decimal. null si no es número.
 */
export function parsePrice(raw: string | number | null | undefined): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  let s = String(raw ?? "").replace(/[^\d.,\-]/g, "");
  if (!s || s === "-") return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    // "1.234" sin coma queda como está; "12,5" es decimal; "1,234,567" son miles.
    s = (s.match(/,/g) ?? []).length > 1 ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if ((s.match(/\./g) ?? []).length > 1) {
    s = s.replace(/\./g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export interface PriceListRow {
  line: number;
  supplier_sku: string | null;
  sku: string | null;
  barcode: string | null;
  name: string | null;
  cost: number | null;
  units: number | null;
  error: string | null;
}

const cell = (row: string[], idx: number | null | undefined): string | null => {
  if (idx == null || idx < 0) return null;
  const v = (row[idx] ?? "").trim();
  return v === "" ? null : v;
};

/** Filas del archivo según el mapeo (la fila 0 es el encabezado). */
export function rowsFromGrid(grid: string[][], mapping: PriceListMapping): PriceListRow[] {
  const out: PriceListRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    if (r.every((c) => !String(c ?? "").trim())) continue;
    const costRaw = cell(r, mapping.cost);
    const unitsRaw = cell(r, mapping.units);
    const cost = parsePrice(costRaw);
    const units = unitsRaw == null ? null : parsePrice(unitsRaw);
    const row: PriceListRow = {
      line: i + 1,
      supplier_sku: cell(r, mapping.supplier_sku),
      sku: cell(r, mapping.sku),
      barcode: cell(r, mapping.barcode),
      name: cell(r, mapping.name),
      cost,
      units,
      error: null,
    };
    if (!row.supplier_sku && !row.sku && !row.barcode) row.error = "Sin código para identificar el producto.";
    else if (cost == null) row.error = "Costo vacío o inválido.";
    else if (cost < 0) row.error = "Costo negativo.";
    else if (units != null && !(units > 0)) row.error = "Unidades por bulto inválidas.";
    out.push(row);
  }
  return out;
}

export interface SupplierProductRef {
  id: string;
  product_id: string;
  variant_id: string | null;
  supplier_sku: string | null;
  list_cost: number | null;
  currency: string;
  units_per_purchase: number;
  product_name?: string;
}

export interface CatalogRef {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
}

export type PreviewStatus = "update" | "same" | "link" | "unmatched" | "invalid";

export interface PreviewRow extends PriceListRow {
  status: PreviewStatus;
  product_id: string | null;
  variant_id: string | null;
  product_name: string | null;
  supplier_product_id: string | null;
  old_cost: number | null;
  new_cost: number | null;
  /** Variación en % contra el costo de lista anterior (misma moneda). */
  change_pct: number | null;
}

const key = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/**
 * Cruza cada fila: por código del proveedor contra sus productos; si no, por
 * SKU o código de barras contra el catálogo (y el producto del proveedor de
 * ese producto, si existe). `discountPct` aplica la bonificación de la lista.
 */
export function previewPriceList(
  rows: PriceListRow[],
  supplierProducts: SupplierProductRef[],
  catalog: CatalogRef[],
  opts: { currency: string; discountPct?: number } = { currency: "ARS" },
): PreviewRow[] {
  const bySupplierSku = new Map<string, SupplierProductRef>();
  const byProduct = new Map<string, SupplierProductRef>();
  for (const sp of supplierProducts) {
    if (sp.supplier_sku) bySupplierSku.set(key(sp.supplier_sku), sp);
    if (!sp.variant_id && !byProduct.has(sp.product_id)) byProduct.set(sp.product_id, sp);
  }
  const bySku = new Map<string, CatalogRef>();
  const byBarcode = new Map<string, CatalogRef>();
  const names = new Map<string, string>();
  for (const p of catalog) {
    if (p.sku) bySku.set(key(p.sku), p);
    if (p.barcode) byBarcode.set(key(p.barcode), p);
    names.set(p.id, p.name);
  }
  const factor = 1 - Math.min(Math.max(Number(opts.discountPct) || 0, 0), 99.999) / 100;
  const seen = new Set<string>();

  return rows.map((r) => {
    const base: PreviewRow = {
      ...r,
      status: "invalid",
      product_id: null,
      variant_id: null,
      product_name: null,
      supplier_product_id: null,
      old_cost: null,
      new_cost: r.cost == null ? null : round(r.cost * factor, 4),
      change_pct: null,
    };
    if (r.error) return base;

    let sp = r.supplier_sku ? bySupplierSku.get(key(r.supplier_sku)) : undefined;
    let productId = sp?.product_id ?? null;
    if (!sp) {
      const p = (r.sku && bySku.get(key(r.sku))) || (r.barcode && byBarcode.get(key(r.barcode))) || null;
      if (p) {
        productId = p.id;
        sp = byProduct.get(p.id);
      }
    }
    if (!productId) return { ...base, status: "unmatched" };

    const dupKey = `${productId}:${sp?.variant_id ?? ""}`;
    if (seen.has(dupKey)) return { ...base, status: "invalid", error: "Producto repetido en la lista." };
    seen.add(dupKey);

    const out: PreviewRow = {
      ...base,
      product_id: productId,
      variant_id: sp?.variant_id ?? null,
      product_name: sp?.product_name ?? names.get(productId) ?? null,
      supplier_product_id: sp?.id ?? null,
      old_cost: sp?.list_cost ?? null,
    };
    if (!sp) return { ...out, status: "link" };
    const sameCurrency = sp.currency === opts.currency;
    const sameUnits = r.units == null || r.units === sp.units_per_purchase;
    if (sameCurrency && sameUnits && sp.list_cost != null && Math.abs(sp.list_cost - (out.new_cost ?? 0)) < 0.00005) {
      return { ...out, status: "same", change_pct: 0 };
    }
    return {
      ...out,
      status: "update",
      change_pct:
        sameCurrency && sp.list_cost != null && sp.list_cost > 0 && out.new_cost != null
          ? round(((out.new_cost - sp.list_cost) / sp.list_cost) * 100, 2)
          : null,
    };
  });
}

export interface PreviewSummary {
  update: number;
  same: number;
  link: number;
  unmatched: number;
  invalid: number;
  /** Variación promedio de los que cambian (en %). */
  avgChange: number | null;
}

export function previewSummary(rows: PreviewRow[]): PreviewSummary {
  const s: PreviewSummary = { update: 0, same: 0, link: 0, unmatched: 0, invalid: 0, avgChange: null };
  const changes: number[] = [];
  for (const r of rows) {
    s[r.status]++;
    if (r.status === "update" && r.change_pct != null) changes.push(r.change_pct);
  }
  s.avgChange = changes.length ? round(changes.reduce((t, x) => t + x, 0) / changes.length, 2) : null;
  return s;
}

/** Filas que se mandan al servidor (actualizar y, si se pidió, vincular). */
export function rowsToApply(
  rows: PreviewRow[],
  linkNew: boolean,
): Array<{ product_id: string; variant_id: string | null; supplier_sku: string | null; list_cost: number; units_per_purchase: number | null }> {
  return rows
    .filter((r) => r.product_id && r.new_cost != null && (r.status === "update" || (linkNew && r.status === "link")))
    .map((r) => ({
      product_id: r.product_id!,
      variant_id: r.variant_id,
      supplier_sku: r.supplier_sku,
      list_cost: r.new_cost!,
      units_per_purchase: r.units,
    }));
}
