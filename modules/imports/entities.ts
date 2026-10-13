// Importaciones nuevas de TX-4 (ADR-078) para el motor único (lib/import):
// stock por sucursal, listas de precios, sucursales, planes de garantía y
// motivos de devolución. Cada una valida por fila con Zod en el navegador y
// manda las filas a su RPC import_* (dry-run + aplicación en el servidor).
import { z } from "zod";
import type { ImportDefinition, ImportField } from "@/lib/import/types";
import { normalizeHeader } from "@/lib/utils/xlsxImport";
import { formatCurrency } from "@/lib/utils/format";
import { STOCK_DESTINATIONS } from "@/modules/sales/api";

/** Nombre del precio base en la columna "Lista" (igual que el export de listas). */
export const BASE_PRICE_LABEL = "Precio de venta";

const qty = (v: number | null) => (v == null || v >= 0 ? { value: v } : { error: "No puede ser negativo." });
const pct = (label: string) => (v: number | null) =>
  v == null || (v >= 0 && v <= 100) ? { value: v } : { error: `${label} tiene que estar entre 0 y 100.` };
const intOrNull = (label: string) => (v: number | null) =>
  v == null || Number.isInteger(v) ? { value: v } : { error: `${label} tiene que ser un número entero.` };

const codeRefine = <T extends { sku: string | null; barcode: string | null }>(row: T, ctx: z.RefinementCtx) => {
  if (!row.sku && !row.barcode) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sku"], message: "Poné el SKU o el código de barras del producto." });
  }
};

// ── Stock por sucursal ──────────────────────────────────────────────────────

export interface StockImportRow {
  store: string | null;
  sku: string | null;
  barcode: string | null;
  product: string | null;
  qty: number | null;
  min_qty: number | null;
  max_qty: number | null;
  location: string | null;
}

export const stockImportDefinition: ImportDefinition<StockImportRow> = {
  entity: "stock",
  rpc: "import_stock",
  title: "Stock por sucursal",
  singular: "fila de stock",
  plural: "filas de stock",
  sheetName: "Stock",
  fileSlug: "stock",
  intro: "Cargá el conteo de stock de cada producto en cada sucursal (stock inicial o inventario), y si querés el mínimo, el máximo y la ubicación.",
  matchRule: "La cantidad reemplaza el stock de ese producto en esa sucursal (queda registrado como conteo). Sucursal vacía = la principal.",
  feature: "stock",
  fields: (ctx) => [
    { header: "Sucursal", key: "store", type: "text", aliases: ["store", "deposito", "local"], options: ctx.stores, help: "Nombre o código de la sucursal. Vacío = la sucursal principal.", width: 20 },
    { header: "SKU", key: "sku", type: "text", aliases: ["sku", "codigo"], help: "SKU del producto o de la variante. Poné el SKU o el código de barras.", width: 14 },
    { header: "Código de barras", key: "barcode", type: "text", aliases: ["barcode", "ean", "codigo de barras"], help: "Código de barras del producto o de la variante.", width: 18 },
    { header: "Producto", key: "product", type: "text", aliases: ["name", "nombre", "descripcion"], help: "Sólo de referencia (no se usa para buscar).", width: 30 },
    { header: "Cantidad", key: "qty", type: "number", aliases: ["qty", "stock", "conteo", "existencia"], cellType: "number", help: "Stock contado en esa sucursal. Vacío = no cambia el stock.", transform: qty },
    { header: "Mínimo", key: "min_qty", type: "number", aliases: ["min", "stock minimo", "minimo"], cellType: "number", help: "Punto de reposición de la sucursal (requiere stock por sucursal en el plan).", transform: qty },
    { header: "Máximo", key: "max_qty", type: "number", aliases: ["max", "stock maximo", "maximo"], cellType: "number", help: "Stock objetivo al reponer (requiere stock por sucursal en el plan).", transform: qty },
    { header: "Ubicación", key: "location", type: "text", aliases: ["location", "gondola", "estante"], help: "Góndola, estante o depósito dentro de la sucursal (máx. 60).", width: 16 },
  ],
  example: (ctx) => [
    { store: ctx.stores?.[0] ?? "Central", sku: "COCA500", barcode: "7790895000990", product: "Coca Cola 500ml", qty: 24, min_qty: 6, max_qty: 48, location: "Heladera 1" },
  ],
  schema: () =>
    z
      .object({
        sku: z.string().nullable(),
        barcode: z.string().nullable(),
        qty: z.number().nullable(),
        min_qty: z.number().nullable(),
        max_qty: z.number().nullable(),
        location: z.string().max(60, "La ubicación es demasiado larga (máx. 60).").nullable(),
      })
      .passthrough()
      .superRefine((row, ctx) => {
        codeRefine(row, ctx);
        if (row.qty == null && row.min_qty == null && row.max_qty == null && row.location == null) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["qty"], message: "Poné la cantidad (o el mínimo, el máximo o la ubicación)." });
        }
        if (row.min_qty != null && row.max_qty != null && row.min_qty > row.max_qty) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["min_qty"], message: "El mínimo no puede ser mayor que el máximo." });
        }
      }),
  dedupeKey: ["store", "sku", "barcode"],
  preview: [
    { header: "Sucursal", cell: (r) => r.store ?? "Principal" },
    { header: "Código", cell: (r) => r.sku ?? r.barcode ?? "" },
    { header: "Producto", cell: (r) => r.product ?? "" },
    { header: "Cantidad", align: "right", cell: (r) => (r.qty == null ? "" : String(r.qty)) },
    { header: "Mín. / Máx.", align: "right", cell: (r) => (r.min_qty == null && r.max_qty == null ? "" : `${r.min_qty ?? "-"} / ${r.max_qty ?? "-"}`) },
  ],
  toPayload: ({ product: _product, ...rest }) => rest,
  invalidate: [["products"], ["stock-stores"]],
};

// ── Listas de precios ───────────────────────────────────────────────────────

export interface PriceListImportRow {
  list: string;
  sku: string | null;
  barcode: string | null;
  product: string | null;
  price: number;
  effective: string | null;
}

export const priceListImportDefinition: ImportDefinition<PriceListImportRow> = {
  entity: "price_lists",
  rpc: "import_price_lists",
  title: "Listas de precios",
  singular: "precio",
  plural: "precios",
  sheetName: "Precios",
  fileSlug: "listas-de-precios",
  intro: `Actualizá el precio de venta o el precio fijo de cada producto en tus listas. Usá "${BASE_PRICE_LABEL}" para el precio base.`,
  matchRule: "El producto se busca por SKU o código de barras y la lista por su nombre. Con una fecha futura, el precio queda programado.",
  fields: (ctx) => [
    { header: "Lista", key: "list", type: "text", required: true, aliases: ["list", "lista de precios"], options: [BASE_PRICE_LABEL, ...(ctx.priceLists ?? [])], help: `"${BASE_PRICE_LABEL}" o el nombre exacto de una lista de precios (las listas requieren el plan con listas de precios).`, width: 24 },
    { header: "SKU", key: "sku", type: "text", aliases: ["sku", "codigo"], help: "SKU del producto o de la variante. Poné el SKU o el código de barras.", width: 16 },
    { header: "Código de barras", key: "barcode", type: "text", aliases: ["barcode", "ean", "codigo de barras"], help: "Código de barras del producto o de la variante.", width: 18 },
    { header: "Producto", key: "product", type: "text", aliases: ["name", "nombre"], help: "Sólo de referencia (no se usa para buscar).", width: 32 },
    {
      header: "Precio",
      key: "price",
      type: "number",
      required: true,
      aliases: ["price"],
      cellType: "money",
      help: "Precio final.",
      transform: (v: number | null) => (v != null && v >= 0 ? { value: v } : { error: "El precio tiene que ser 0 o más." }),
    },
    { header: "Vigente desde", key: "effective", type: "date", aliases: ["effective_at", "desde", "vigencia", "fecha"], help: "Opcional, dd/mm/aaaa. Vacío o una fecha pasada = se aplica ya; una fecha futura = queda programado.", width: 16 },
  ],
  example: (ctx) => [
    { list: BASE_PRICE_LABEL, sku: "COCA500", barcode: "7790895000990", product: "Coca Cola 500ml", price: 850, effective: "" },
    ...(ctx.priceLists?.[0]
      ? [{ list: ctx.priceLists[0], sku: "COCA500", barcode: "7790895000990", product: "Coca Cola 500ml", price: 780, effective: "" }]
      : []),
  ],
  schema: () =>
    z
      .object({ sku: z.string().nullable(), barcode: z.string().nullable() })
      .passthrough()
      .superRefine((row, ctx) => codeRefine(row, ctx)),
  dedupeKey: ["list", "sku", "barcode"],
  preview: [
    { header: "Lista", cell: (r) => r.list },
    { header: "Código", cell: (r) => r.sku ?? r.barcode ?? "" },
    { header: "Producto", cell: (r) => r.product ?? "" },
    { header: "Precio", align: "right", cell: (r) => formatCurrency(r.price) },
    { header: "Desde", cell: (r) => (r.effective ? r.effective.split("-").reverse().join("/") : "Ya") },
  ],
  // La fecha va como medianoche de Argentina.
  toPayload: ({ product: _product, effective, ...rest }) => ({
    ...rest,
    effective_at: effective ? `${effective}T00:00:00-03:00` : null,
  }),
  invalidate: [["products"], ["price-lists"], ["price-list-items"], ["price-pro"]],
};

// ── Sucursales ──────────────────────────────────────────────────────────────

export interface StoreImportRow {
  name: string;
  code: string | null;
  short_name: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  phone: string | null;
  email: string | null;
  afip_pos_number: number | null;
  notes: string | null;
}

const STORE_FIELDS: ImportField[] = [
  { header: "Nombre", key: "name", type: "text", required: true, aliases: ["name", "sucursal"], help: "Nombre de la sucursal. Si ya existe una con ese nombre (o con el mismo código), se actualiza.", width: 22 },
  { header: "Código", key: "code", type: "text", aliases: ["code", "codigo"], help: "Código corto único (p. ej. CEN). Opcional.", width: 10 },
  { header: "Nombre corto", key: "short_name", type: "text", aliases: ["short_name", "abreviatura"], help: "Para tickets y pantallas chicas.", width: 14 },
  { header: "Dirección", key: "address", type: "text", aliases: ["address", "domicilio"], help: "Calle y número.", width: 26 },
  { header: "Localidad", key: "city", type: "text", aliases: ["city", "ciudad"], help: "Ciudad o localidad.", width: 16 },
  { header: "Provincia", key: "province", type: "text", aliases: ["province"], help: "Provincia.", width: 16 },
  { header: "Código postal", key: "postal_code", type: "text", aliases: ["postal_code", "cp"], help: "Código postal.", width: 12 },
  { header: "Teléfono", key: "phone", type: "text", aliases: ["phone", "tel"], help: "Teléfono de la sucursal.", width: 16 },
  { header: "Email", key: "email", type: "text", aliases: ["email", "correo", "mail"], help: "Email de la sucursal.", width: 24 },
  {
    header: "Punto de venta fiscal",
    key: "afip_pos_number",
    type: "number",
    aliases: ["afip_pos_number", "punto de venta", "pv"],
    help: "Número de punto de venta de ARCA (1 a 99998). Opcional.",
    transform: (v: number | null) =>
      v == null || (Number.isInteger(v) && v >= 1 && v <= 99998) ? { value: v } : { error: "El punto de venta fiscal tiene que ser un entero entre 1 y 99998." },
  },
  { header: "Notas", key: "notes", type: "text", aliases: ["notes", "observaciones"], help: "Notas internas.", width: 24 },
];

export const storeImportDefinition: ImportDefinition<StoreImportRow> = {
  entity: "stores",
  rpc: "import_stores",
  title: "Sucursales",
  singular: "sucursal",
  plural: "sucursales",
  sheetName: "Sucursales",
  fileSlug: "sucursales",
  intro: "Cargá o actualizá tus sucursales (locales o depósitos) con su dirección y datos de contacto.",
  matchRule: "Si el código (o el nombre) ya existe, se actualiza esa sucursal; si no, se crea. Crear más de una sucursal requiere el plan con varias sucursales y respeta el máximo del plan.",
  fields: () => STORE_FIELDS,
  example: () => [
    { name: "Sucursal Centro", code: "CEN", short_name: "Centro", address: "San Martín 123", city: "Rosario", province: "Santa Fe", postal_code: "2000", phone: "3415550000", email: "centro@minegocio.com", afip_pos_number: 2, notes: "" },
  ],
  schema: () =>
    z
      .object({
        name: z.string().max(80, "El nombre es demasiado largo (máx. 80)."),
        code: z.string().max(20, "El código es demasiado largo (máx. 20).").nullable(),
        email: z
          .string()
          .nullable()
          .refine((v) => v == null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Email inválido."),
      })
      .passthrough(),
  dedupeKey: "name",
  preview: [
    { header: "Nombre", cell: (r) => r.name },
    { header: "Código", cell: (r) => r.code ?? "" },
    { header: "Dirección", cell: (r) => [r.address, r.city].filter(Boolean).join(", ") },
    { header: "Teléfono", cell: (r) => r.phone ?? "" },
  ],
  invalidate: [["branches"], ["stock-stores"]],
};

// ── Planes de garantía extendida ────────────────────────────────────────────

export interface WarrantyImportRow {
  label: string;
  months: number | null;
  price: number | null;
  price_pct: number | null;
  commission_pct: number | null;
  description: string | null;
  sort: number | null;
  is_active: boolean | null;
}

export const warrantyImportDefinition: ImportDefinition<WarrantyImportRow> = {
  entity: "warranty_plans",
  rpc: "import_warranty_plans",
  title: "Garantías extendidas",
  singular: "plan de garantía",
  plural: "planes de garantía",
  sheetName: "Garantías",
  fileSlug: "garantias",
  intro: "Cargá los planes de garantía extendida que se ofrecen al vender: meses de cobertura, precio fijo o porcentaje y comisión del vendedor.",
  matchRule: "Si ya hay un plan con ese nombre, se actualiza; si no, se crea.",
  feature: "garantias",
  fields: () => [
    { header: "Nombre", key: "label", type: "text", required: true, aliases: ["label", "plan"], help: "Nombre del plan (p. ej. Garantía 12 meses).", width: 24 },
    { header: "Meses", key: "months", type: "number", aliases: ["months", "duracion"], cellType: "number", help: "Meses de cobertura extra.", transform: (v: number | null) => (v == null || (Number.isInteger(v) && v >= 0) ? { value: v } : { error: "Los meses tienen que ser un entero de 0 o más." }) },
    { header: "Precio fijo", key: "price", type: "number", aliases: ["price", "prima", "precio"], cellType: "money", help: "Precio fijo de la garantía. Usá esto o el porcentaje.", transform: qty },
    { header: "Porcentaje del precio", key: "price_pct", type: "number", aliases: ["price_pct", "porcentaje", "%"], help: "Porcentaje sobre el precio del producto (0 a 100).", transform: pct("El porcentaje") },
    { header: "Comisión %", key: "commission_pct", type: "number", aliases: ["commission_pct", "comision"], help: "Comisión del vendedor (0 a 100).", transform: pct("La comisión") },
    { header: "Descripción", key: "description", type: "text", aliases: ["description", "detalle"], help: "Qué cubre.", width: 32 },
    { header: "Orden", key: "sort", type: "number", aliases: ["sort"], help: "Orden en la lista (número entero).", transform: intOrNull("El orden") },
    { header: "Activo", key: "is_active", type: "boolean", aliases: ["is_active", "activa"], options: ["Sí", "No"], help: "Sí o No. Vacío al crear = Sí." },
  ],
  example: () => [
    { label: "Garantía extendida 12 meses", months: 12, price: "", price_pct: 10, commission_pct: 5, description: "Cubre fallas de fábrica", sort: 1, is_active: "Sí" },
  ],
  schema: () => z.object({ label: z.string().max(80, "El nombre es demasiado largo (máx. 80).") }).passthrough(),
  dedupeKey: "label",
  preview: [
    { header: "Nombre", cell: (r) => r.label },
    { header: "Meses", align: "right", cell: (r) => (r.months == null ? "" : String(r.months)) },
    { header: "Precio", align: "right", cell: (r) => (r.price != null ? formatCurrency(r.price) : r.price_pct != null ? `${r.price_pct}%` : "") },
    { header: "Activo", cell: (r) => (r.is_active === false ? "No" : "Sí") },
  ],
  invalidate: [["warranty-plans"]],
};

// ── Motivos de devolución ───────────────────────────────────────────────────

export interface ReturnReasonImportRow {
  label: string;
  code: string | null;
  stock_destination: string | null;
  sort: number | null;
  is_active: boolean | null;
}

const DEST_BY_LABEL = new Map<string, string>();
for (const d of STOCK_DESTINATIONS) {
  DEST_BY_LABEL.set(normalizeHeader(d.label), d.value);
  DEST_BY_LABEL.set(d.value, d.value);
}

export const returnReasonImportDefinition: ImportDefinition<ReturnReasonImportRow> = {
  entity: "return_reasons",
  rpc: "import_return_reasons",
  title: "Motivos de devolución",
  singular: "motivo",
  plural: "motivos",
  sheetName: "Motivos",
  fileSlug: "motivos-devolucion",
  intro: "Cargá los motivos que el cajero elige al hacer una devolución y qué pasa con el stock en cada caso.",
  matchRule: "Si el código (o el nombre) ya existe, se actualiza ese motivo; si no, se crea.",
  feature: "devoluciones",
  fields: () => [
    { header: "Nombre", key: "label", type: "text", required: true, aliases: ["label", "motivo"], help: "Lo que ve el cajero (p. ej. Producto fallado).", width: 26 },
    { header: "Código", key: "code", type: "text", aliases: ["code", "codigo"], help: "Código corto único (minúsculas, sin espacios). Opcional.", width: 16, transform: (v: string | null) => ({ value: v ? v.trim().toLowerCase().replace(/\s+/g, "_") : null }) },
    {
      header: "Destino del stock",
      key: "stock_destination",
      type: "text",
      aliases: ["stock_destination", "destino"],
      options: STOCK_DESTINATIONS.map((d) => d.label),
      help: STOCK_DESTINATIONS.map((d) => `${d.label}: ${d.hint.toLowerCase()}`).join(". ") + ". Vacío al crear = Vuelve a la venta.",
      width: 20,
      transform: (v: string | null) => {
        if (v == null || v === "") return { value: null };
        const code = DEST_BY_LABEL.get(normalizeHeader(v));
        return code ? { value: code } : { error: `Destino no reconocido ("${v}"). Usá: ${STOCK_DESTINATIONS.map((d) => d.label).join(", ")}.` };
      },
    },
    { header: "Orden", key: "sort", type: "number", aliases: ["sort"], help: "Orden en la lista (número entero).", transform: intOrNull("El orden") },
    { header: "Activo", key: "is_active", type: "boolean", aliases: ["is_active", "activa"], options: ["Sí", "No"], help: "Sí o No. Vacío al crear = Sí." },
  ],
  example: () => [{ label: "Producto fallado", code: "fallado", stock_destination: "Pérdida / merma", sort: 30, is_active: "Sí" }],
  schema: () => z.object({ label: z.string().max(80, "El nombre es demasiado largo (máx. 80).") }).passthrough(),
  dedupeKey: "label",
  preview: [
    { header: "Nombre", cell: (r) => r.label },
    { header: "Código", cell: (r) => r.code ?? "" },
    { header: "Destino", cell: (r) => STOCK_DESTINATIONS.find((d) => d.value === r.stock_destination)?.label ?? "" },
    { header: "Activo", cell: (r) => (r.is_active === false ? "No" : "Sí") },
  ],
  invalidate: [["return-reasons"]],
};
