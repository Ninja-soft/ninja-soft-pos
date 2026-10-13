"use client";

// Export XLSX de listas de precios (F18 · H100, ADR-058). Una hoja "Precios":
// Lista (desplegable con las listas y "Precio de venta"), SKU, Código de
// barras, Producto, Precio y Vigente desde. La importación del mismo archivo
// va por el asistente único (TX-4, ADR-078: modules/imports/entities.ts →
// import_price_lists, con revisión en el servidor y confirmación).

import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import { exportXlsx, type XlsxColumn } from "@/lib/utils/xlsx";
import type { ProList } from "./proApi";

export const BASE_LIST_LABEL = "Precio de venta";

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
