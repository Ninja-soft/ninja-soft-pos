// Importaciones de depósitos internos (F11 · H33 + H34, ADR-085) para el
// motor único (lib/import, ADR-078): depósitos por sucursal y conteo por
// depósito. El servidor (import_warehouses / import_warehouse_stock) resuelve
// la coincidencia y llama a las RPC warehouse_*, que validan rol, plan,
// sucursal y disponible.
import { z } from "zod";
import type { ImportDefinition } from "@/lib/import/types";
import { CREATABLE_KINDS, WAREHOUSE_KIND_LABEL, parseWarehouseKind } from "@/lib/stock/warehouses";

const KIND_OPTIONS = CREATABLE_KINDS.map((k) => WAREHOUSE_KIND_LABEL[k]);

// ── Depósitos ───────────────────────────────────────────────────────────────

export interface WarehouseImportRow {
  store: string | null;
  name: string | null;
  code: string | null;
  kind: string | null;
}

export const warehouseImportDefinition: ImportDefinition<WarehouseImportRow> = {
  entity: "warehouses",
  rpc: "import_warehouses",
  title: "Depósitos",
  singular: "depósito",
  plural: "depósitos",
  sheetName: "Depositos",
  fileSlug: "depositos",
  intro: "Creá los depósitos de cada sucursal (reserva, devoluciones, merma). El salón de ventas se crea solo.",
  matchRule: "Si el código ya existe, o la sucursal ya tiene un depósito con ese nombre, se actualiza; si no, se crea. Sucursal vacía = la principal.",
  feature: "depositos",
  fields: (ctx) => [
    { header: "Sucursal", key: "store", type: "text", aliases: ["store", "local"], options: ctx.stores, help: "Nombre o código de la sucursal. Vacío = la sucursal principal.", width: 20 },
    { header: "Nombre", key: "name", type: "text", aliases: ["name", "nombre", "deposito"], help: "Nombre del depósito (máx. 60). Obligatorio para crear.", width: 24 },
    { header: "Código", key: "code", type: "text", aliases: ["code", "codigo"], help: "Código único del depósito (máx. 20). Sirve para la importación de stock por depósito.", width: 12 },
    { header: "Tipo", key: "kind", type: "text", aliases: ["kind", "tipo"], options: KIND_OPTIONS, help: "Reserva, Devoluciones, Merma u Otro. Vacío = Reserva.", width: 16 },
  ],
  example: (ctx) => [
    { store: ctx.stores?.[0] ?? "Central", name: "Depósito del fondo", code: "FONDO", kind: "Reserva" },
    { store: ctx.stores?.[0] ?? "Central", name: "Rotos y vencidos", code: "MERMA", kind: "Merma" },
  ],
  schema: () =>
    z
      .object({
        name: z.string().max(60, "El nombre es demasiado largo (máx. 60).").nullable(),
        code: z.string().max(20, "El código es demasiado largo (máx. 20).").nullable(),
        kind: z.string().nullable(),
      })
      .passthrough()
      .superRefine((row, ctx) => {
        if (!row.name && !row.code) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["name"], message: "Poné el nombre (o el código de uno existente)." });
        }
        if (row.kind && !parseWarehouseKind(row.kind)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["kind"], message: "El tipo tiene que ser Reserva, Devoluciones, Merma u Otro." });
        }
      }),
  dedupeKey: ["store", "name"],
  preview: [
    { header: "Sucursal", cell: (r) => r.store ?? "Principal" },
    { header: "Nombre", cell: (r) => r.name ?? "" },
    { header: "Código", cell: (r) => r.code ?? "" },
    { header: "Tipo", cell: (r) => r.kind ?? "Reserva" },
  ],
  toPayload: (r) => ({ ...r, kind: parseWarehouseKind(r.kind) }),
  invalidate: [["warehouses"], ["warehouse-overview"]],
};

// ── Stock por depósito ──────────────────────────────────────────────────────

export interface WarehouseStockImportRow {
  store: string | null;
  warehouse: string | null;
  warehouse_code: string | null;
  sku: string | null;
  barcode: string | null;
  product: string | null;
  qty: number | null;
}

export const warehouseStockImportDefinition: ImportDefinition<WarehouseStockImportRow> = {
  entity: "warehouse_stock",
  rpc: "import_warehouse_stock",
  title: "Stock por depósito",
  singular: "fila de stock",
  plural: "filas de stock",
  sheetName: "StockDepositos",
  fileSlug: "stock-depositos",
  intro: "Cargá el conteo de cada producto en cada depósito. La diferencia se mueve desde o hacia el salón: el stock de la sucursal no cambia.",
  matchRule: "Depósito por código, o por sucursal y nombre. La cantidad reemplaza lo que hay en ese depósito (queda auditado como conteo).",
  feature: "depositos",
  fields: (ctx) => [
    { header: "Sucursal", key: "store", type: "text", aliases: ["store", "local"], options: ctx.stores, help: "Nombre o código de la sucursal (si el depósito va por nombre). Vacío = la principal.", width: 20 },
    { header: "Depósito", key: "warehouse", type: "text", aliases: ["warehouse", "deposito"], help: "Nombre del depósito en esa sucursal.", width: 22 },
    { header: "Código de depósito", key: "warehouse_code", type: "text", aliases: ["warehouse code", "codigo deposito"], help: "Código del depósito (en lugar de sucursal y nombre).", width: 14 },
    { header: "SKU", key: "sku", type: "text", aliases: ["sku", "codigo"], help: "SKU del producto o de la variante. Poné el SKU o el código de barras.", width: 14 },
    { header: "Código de barras", key: "barcode", type: "text", aliases: ["barcode", "ean", "codigo de barras"], help: "Código de barras del producto o de la variante.", width: 18 },
    { header: "Producto", key: "product", type: "text", aliases: ["name", "nombre", "descripcion"], help: "Sólo de referencia (no se usa para buscar).", width: 30 },
    { header: "Cantidad", key: "qty", type: "number", aliases: ["qty", "stock", "conteo"], cellType: "number", help: "Cantidad contada en ese depósito.", transform: (v: number | null) => (v == null || v >= 0 ? { value: v } : { error: "No puede ser negativo." }) },
  ],
  example: () => [
    { store: "", warehouse: "", warehouse_code: "FONDO", sku: "REM-M-NEG", barcode: "", product: "Remera M negra", qty: 12 },
  ],
  schema: () =>
    z
      .object({
        warehouse: z.string().nullable(),
        warehouse_code: z.string().nullable(),
        sku: z.string().nullable(),
        barcode: z.string().nullable(),
        qty: z.number().nullable(),
      })
      .passthrough()
      .superRefine((row, ctx) => {
        if (!row.warehouse && !row.warehouse_code) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["warehouse"], message: "Poné el depósito (nombre o código)." });
        }
        if (!row.sku && !row.barcode) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sku"], message: "Poné el SKU o el código de barras del producto." });
        }
        if (row.qty == null) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["qty"], message: "Poné la cantidad." });
        }
      }),
  dedupeKey: ["store", "warehouse", "warehouse_code", "sku", "barcode"],
  preview: [
    { header: "Depósito", cell: (r) => r.warehouse_code ?? `${r.warehouse ?? ""}${r.store ? ` (${r.store})` : ""}` },
    { header: "Código", cell: (r) => r.sku ?? r.barcode ?? "" },
    { header: "Producto", cell: (r) => r.product ?? "" },
    { header: "Cantidad", align: "right", cell: (r) => (r.qty == null ? "" : String(r.qty)) },
  ],
  toPayload: ({ product: _product, ...rest }) => rest,
  invalidate: [["warehouse-overview"], ["products"]],
};
