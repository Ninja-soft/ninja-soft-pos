"use client";

// Export / import XLSX de listas de precios (F18 · H100, ADR-058). Una hoja
// "Precios": Lista (desplegable con las listas y "Precio de venta"), SKU,
// Código de barras, Producto, Precio y Vigente desde (vacío = ahora). El
// import busca el producto por SKU o código de barras y manda todo a
// price_list_import (servidor: plan, rol, programado e historial "import").

import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import { exportXlsx, type XlsxColumn } from "@/lib/utils/xlsx";
import { parseXlsx, type ImportColumn, type ParseXlsxResult } from "@/lib/utils/xlsxImport";
import type { ProList } from "./proApi";

export const BASE_LIST_LABEL = "Precio de venta";

export interface PriceImportRow {
  list: string;
  sku: string | null;
  barcode: string | null;
  name: string | null;
  price: number;
  effective: string | null;
}

export function priceColumns(lists: ProList[]): XlsxColumn[] {
  return [
    { header: "Lista", key: "list", width: 24, options: [BASE_LIST_LABEL, ...lists.map((l) => l.name)] },
    { header: "SKU", key: "sku", width: 16 },
    { header: "Código de barras", key: "barcode", width: 18 },
    { header: "Producto", key: "name", width: 36 },
    { header: "Precio", key: "price", type: "money", width: 14 },
    { header: "Vigente desde", key: "effective", width: 16 },
  ];
}

const SPEC: ImportColumn[] = [
  { header: "Lista", key: "list", required: true, aliases: ["list", "lista"] },
  { header: "SKU", key: "sku", aliases: ["sku"] },
  { header: "Código de barras", key: "barcode", aliases: ["barcode", "codigo de barras", "ean"] },
  { header: "Producto", key: "name", aliases: ["name", "nombre"] },
  {
    header: "Precio",
    key: "price",
    type: "number",
    required: true,
    aliases: ["price", "precio"],
    transform: (v: number | null) => (v != null && v >= 0 ? { value: v } : { error: "El precio tiene que ser 0 o más." }),
  },
  {
    header: "Vigente desde",
    key: "effective",
    aliases: ["effective_at", "desde", "vigencia"],
    transform: (v: string | null, raw: string) => {
      const s = (raw ?? v ?? "").trim();
      if (!s) return { value: null };
      // dd/mm/aaaa o aaaa-mm-dd.
      const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
      const iso = m ? `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}` : s.slice(0, 10);
      const d = new Date(`${iso}T00:00:00-03:00`);
      return Number.isNaN(d.getTime()) ? { error: `Fecha inválida ("${s}").` } : { value: d.toISOString() };
    },
  },
];

export function parsePricesXlsx(buffer: ArrayBuffer): Promise<ParseXlsxResult<PriceImportRow>> {
  return parseXlsx<PriceImportRow>(buffer, SPEC);
}

interface ProductRow {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  price: number;
}

async function allProducts(): Promise<ProductRow[]> {
  const tenantId = await getCurrentTenantId();
  const out: ProductRow[] = [];
  const db = createClient() as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (c: string, v: string) => {
          is: (c: string, v: null) => {
            order: (c: string) => { range: (a: number, b: number) => Promise<{ data: unknown; error: unknown }> };
          };
        };
      };
    };
  };
  for (let from = 0; from < 50_000; from += 1000) {
    const { data, error } = await db
      .from("products")
      .select("id, name, sku, barcode, price")
      .eq("tenant_id", tenantId ?? "")
      .is("deleted_at", null)
      .order("name")
      .range(from, from + 999);
    if (error) throw error;
    const rows = (data ?? []) as ProductRow[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

/** Descarga el XLSX: precio de venta de todos los productos + los precios fijos de cada lista. */
export async function exportPriceLists(lists: ProList[]): Promise<void> {
  const products = await allProducts();
  const byId = new Map(products.map((p) => [p.id, p]));
  const rows: Record<string, unknown>[] = products.map((p) => ({
    list: BASE_LIST_LABEL,
    sku: p.sku,
    barcode: p.barcode,
    name: p.name,
    price: Number(p.price),
    effective: null,
  }));
  if (lists.length > 0) {
    const { data } = await (createClient() as unknown as {
      from: (t: string) => {
        select: (c: string) => {
          in: (c: string, v: string[]) => { is: (c: string, v: null) => Promise<{ data: unknown }> };
        };
      };
    })
      .from("price_list_items")
      .select("price_list_id, product_id, price")
      .in(
        "price_list_id",
        lists.map((l) => l.id),
      )
      .is("variant_id", null);
    const names = new Map(lists.map((l) => [l.id, l.name]));
    for (const it of (data ?? []) as { price_list_id: string; product_id: string; price: number }[]) {
      const p = byId.get(it.product_id);
      if (!p) continue;
      rows.push({
        list: names.get(it.price_list_id),
        sku: p.sku,
        barcode: p.barcode,
        name: p.name,
        price: Number(it.price),
        effective: null,
      });
    }
  }
  await exportXlsx("listas-de-precios", [{ name: "Precios", title: "Listas de precios", columns: priceColumns(lists), rows }]);
}

export interface PriceImportPlan {
  byList: Map<string | null, { product_id: string; price: number; effective_at: string | null }[]>;
  unknownList: number;
  unknownProduct: number;
}

/** Arma lo que se manda al servidor: producto por SKU o código, lista por nombre. */
export async function planPriceImport(rows: PriceImportRow[], lists: ProList[]): Promise<PriceImportPlan> {
  const products = await allProducts();
  const bySku = new Map(products.filter((p) => p.sku).map((p) => [p.sku!.trim().toLowerCase(), p.id]));
  const byCode = new Map(products.filter((p) => p.barcode).map((p) => [p.barcode!.trim(), p.id]));
  const listByName = new Map(lists.map((l) => [l.name.trim().toLowerCase(), l.id]));
  const byList = new Map<string | null, { product_id: string; price: number; effective_at: string | null }[]>();
  let unknownList = 0;
  let unknownProduct = 0;
  for (const r of rows) {
    const ln = (r.list ?? "").trim().toLowerCase();
    const listId = ln === BASE_LIST_LABEL.toLowerCase() ? null : (listByName.get(ln) ?? undefined);
    if (listId === undefined) {
      unknownList++;
      continue;
    }
    const pid =
      (r.sku ? bySku.get(String(r.sku).trim().toLowerCase()) : undefined) ??
      (r.barcode ? byCode.get(String(r.barcode).trim()) : undefined);
    if (!pid) {
      unknownProduct++;
      continue;
    }
    const arr = byList.get(listId) ?? [];
    arr.push({ product_id: pid, price: r.price, effective_at: r.effective });
    byList.set(listId, arr);
  }
  return { byList, unknownList, unknownProduct };
}
