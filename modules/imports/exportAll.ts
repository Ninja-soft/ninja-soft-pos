// Export de la base completa en un solo XLSX (TX-4, ADR-078): productos,
// clientes, stock por sucursal, listas de precios, sucursales, garantías y
// motivos de devolución. Cada hoja usa los mismos encabezados que la plantilla
// de su importación, así que el archivo se puede editar y volver a importar
// (el asistente toma la hoja con el nombre de la entidad).
import { createClient } from "@/lib/supabase/client";
import { exportXlsx, type XlsxSheet } from "@/lib/utils/xlsx";
import { exportColumns } from "@/lib/import/engine";
import { productImportDefinition } from "@/modules/products/import";
import { customerImportDefinition } from "@/modules/customers/import";
import { DOC_TYPE_LABELS, IVA_LABELS } from "@/modules/customers/schemas";
import { STOCK_DESTINATIONS } from "@/modules/sales/api";
import {
  BASE_PRICE_LABEL,
  priceListImportDefinition,
  returnReasonImportDefinition,
  stockImportDefinition,
  storeImportDefinition,
  warrantyImportDefinition,
} from "./entities";

type Row = Record<string, unknown>;
type Loose = {
  from: (t: string) => {
    select: (c: string) => {
      order: (c: string) => {
        range: (a: number, b: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
      };
    };
  };
};

const PAGE = 1000;

/** Lee una tabla entera por páginas (RLS: sólo el negocio actual). */
async function fetchAll(table: string, select: string, order = "id"): Promise<Row[]> {
  const db = createClient() as unknown as Loose;
  const out: Row[] = [];
  for (let from = 0; from < 200_000; from += PAGE) {
    const { data, error } = await db.from(table).select(select).order(order).range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

const alive = (r: Row) => r.deleted_at == null;
const rel = (v: unknown, key: string): string => {
  const o = (Array.isArray(v) ? v[0] : v) as Row | null | undefined;
  const x = o?.[key];
  return x == null ? "" : String(x);
};
const yesNo = (v: unknown) => (v === false ? "No" : "Sí");

export async function exportFullBase(businessName?: string | null): Promise<void> {
  const [products, customers, stock, listItems, lists, stores, warranties, reasons] = await Promise.all([
    fetchAll("products", "id, name, sku, barcode, price, cost, tax_rate, unit, stock, stock_min, track_stock, deleted_at, categories(name), brands(name)", "name"),
    fetchAll("customers", "id, name, document_type, document_number, iva_condition, email, phone, address, notes, deleted_at", "name"),
    fetchAll("product_stock", "id, qty, min_qty, max_qty, location, stores(name, code, deleted_at), products(name, sku, barcode, deleted_at), product_variants(sku, barcode)"),
    fetchAll("price_list_items", "id, price, price_list_id, products(name, sku, barcode, deleted_at), product_variants(sku, barcode)"),
    fetchAll("price_lists", "id, name, deleted_at", "name"),
    fetchAll("stores", "id, name, code, short_name, address, city, province, postal_code, phone, email, afip_pos_number, notes, deleted_at", "name"),
    fetchAll("warranty_plans", "id, label, months, price, price_pct, commission_pct, description, sort, is_active", "sort"),
    fetchAll("return_reasons", "id, label, code, stock_destination, sort, is_active, deleted_at", "sort"),
  ]);

  const liveProducts = products.filter(alive);
  const listName = new Map(lists.filter(alive).map((l) => [String(l.id), String(l.name)]));
  const destLabel = new Map(STOCK_DESTINATIONS.map((d) => [d.value, d.label]));
  const subtitle = [businessName, `Exportado el ${new Date().toLocaleDateString("es-AR")}`].filter(Boolean).join(" · ");

  const sheets: XlsxSheet[] = [
    {
      name: productImportDefinition.sheetName,
      columns: exportColumns(productImportDefinition),
      rows: liveProducts.map((p) => ({
        name: p.name,
        barcode: p.barcode ?? "",
        sku: p.sku ?? "",
        price: Number(p.price),
        cost: p.cost == null ? "" : Number(p.cost),
        category: rel(p.categories, "name"),
        brand: rel(p.brands, "name"),
        tax_rate: p.tax_rate == null ? "" : Number(p.tax_rate),
        unit: p.unit ?? "",
        stock: Number(p.stock ?? 0),
        stock_min: p.stock_min == null ? "" : Number(p.stock_min),
        track_stock: yesNo(p.track_stock),
      })),
    },
    {
      name: customerImportDefinition.sheetName,
      columns: exportColumns(customerImportDefinition),
      rows: customers.filter(alive).map((c) => ({
        name: c.name,
        document_type: c.document_type ? (DOC_TYPE_LABELS[c.document_type as keyof typeof DOC_TYPE_LABELS] ?? c.document_type) : "",
        document_number: c.document_number ?? "",
        iva_condition: c.iva_condition ? (IVA_LABELS[c.iva_condition as keyof typeof IVA_LABELS] ?? c.iva_condition) : "",
        email: c.email ?? "",
        phone: c.phone ?? "",
        address: c.address ?? "",
        notes: c.notes ?? "",
      })),
    },
    {
      name: stockImportDefinition.sheetName,
      columns: exportColumns(stockImportDefinition),
      rows: stock
        .filter((s) => rel(s.stores, "deleted_at") === "" && rel(s.products, "deleted_at") === "")
        .map((s) => ({
          store: rel(s.stores, "code") || rel(s.stores, "name"),
          sku: rel(s.product_variants, "sku") || rel(s.products, "sku"),
          barcode: rel(s.product_variants, "barcode") || rel(s.products, "barcode"),
          product: rel(s.products, "name"),
          qty: Number(s.qty ?? 0),
          min_qty: s.min_qty == null ? "" : Number(s.min_qty),
          max_qty: s.max_qty == null ? "" : Number(s.max_qty),
          location: s.location ?? "",
        })),
    },
    {
      name: priceListImportDefinition.sheetName,
      columns: exportColumns(priceListImportDefinition),
      rows: [
        ...liveProducts.map((p) => ({
          list: BASE_PRICE_LABEL,
          sku: p.sku ?? "",
          barcode: p.barcode ?? "",
          product: p.name,
          price: Number(p.price),
          effective: "",
        })),
        ...listItems
          .filter((it) => listName.has(String(it.price_list_id)) && rel(it.products, "deleted_at") === "")
          .map((it) => ({
            list: listName.get(String(it.price_list_id)),
            sku: rel(it.product_variants, "sku") || rel(it.products, "sku"),
            barcode: rel(it.product_variants, "barcode") || rel(it.products, "barcode"),
            product: rel(it.products, "name"),
            price: Number(it.price),
            effective: "",
          })),
      ],
    },
    {
      name: storeImportDefinition.sheetName,
      columns: exportColumns(storeImportDefinition),
      rows: stores.filter(alive).map((s) => ({ ...s, afip_pos_number: s.afip_pos_number ?? "" })),
    },
    {
      name: warrantyImportDefinition.sheetName,
      columns: exportColumns(warrantyImportDefinition),
      rows: warranties.map((w) => ({ ...w, is_active: yesNo(w.is_active) })),
    },
    {
      name: returnReasonImportDefinition.sheetName,
      columns: exportColumns(returnReasonImportDefinition),
      rows: reasons.filter(alive).map((r) => ({
        ...r,
        stock_destination: destLabel.get(r.stock_destination as never) ?? r.stock_destination,
        is_active: yesNo(r.is_active),
      })),
    },
  ];

  // Título y bajada arriba de cada tabla: el import ubica solo la fila de
  // encabezados, así que la hoja se reimporta tal cual.
  for (const sh of sheets) {
    sh.title = `Base completa · ${sh.name}`;
    sh.subtitle = subtitle;
  }
  const day = new Date().toISOString().slice(0, 10);
  await exportXlsx(`base-completa-${day}`, sheets);
}
