import { z } from "zod";
import { IVA_CODES } from "@/lib/tax/catalog";

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : null));

// PLU: código corto opcional de exactamente 6 dígitos (o vacío → null).
// Si se deja vacío y el tenant tiene el PLU habilitado, la DB lo genera sola.
const pluField = z
  .string()
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? v.trim() : null))
  .refine((v) => v === null || /^[0-9]{6}$/.test(v), "Debe ser de 6 dígitos");

export const ProductSchema = z.object({
  name: z.string().min(1, "Requerido").max(120),
  sku: optionalText(60),
  barcode: optionalText(60),
  plu: pluField,
  category_id: z.string().uuid().nullable().optional(),
  brand_id: z.string().uuid().nullable().optional(),
  price: z.coerce.number().nonnegative("Debe ser ≥ 0"),
  cost: z.coerce.number().nonnegative("Debe ser ≥ 0").optional(),
  // Costo de reposición (F18 · H101): vacío = sin cargar (null), no cero.
  replacement_cost: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? undefined : v),
    z.coerce.number().nonnegative("Debe ser ≥ 0").optional(),
  ),
  stock: z.coerce.number().default(0),
  stock_min: z.coerce.number().nonnegative().default(0),
  unit: z.string().min(1).max(10).default("un"),
  tax_rate: z.coerce.number().min(0).max(100).default(21),
  // F18 · H103 (ADR-068): alícuota del catálogo (manda sobre tax_rate, que
  // queda como espejo numérico), servicio (concepto de WSFE) e internos.
  tax_rate_code: z.enum(IVA_CODES).default("21"),
  is_service: z.boolean().default(false),
  internal_tax_mode: z.enum(["none", "pct", "fixed"]).default("none"),
  internal_tax_base: z.enum(["price", "cost"]).default("price"),
  internal_tax_rate: z
    .union([z.coerce.number().min(0).lt(100), z.literal(""), z.null()])
    .transform((v) => (v === "" || v == null ? null : v))
    .optional(),
  internal_tax_amount: z
    .union([z.coerce.number().min(0), z.literal(""), z.null()])
    .transform((v) => (v === "" || v == null ? null : v))
    .optional(),
  internal_tax_included: z.boolean().default(true),
  season: optionalText(60),
  tags: optionalText(300), // coma-separado en el form; el api lo pasa a array
  image_url: optionalText(600),
  description: optionalText(4000),
  model: optionalText(80),
  // Atributos libres ordenados (Color, Talle, Contenido...). Se normalizan en el api.
  attributes: z
    .array(z.object({ key: z.string().max(60), value: z.string().max(200) }))
    .default([]),
  is_active: z.boolean().default(true),
  is_kit: z.boolean().default(false),
  is_serialized: z.boolean().default(false),
  has_variants: z.boolean().default(false),
  track_stock: z.boolean().default(true),
  // Override de venta en negativo: "inherit" usa el ajuste global del tenant.
  allow_negative: z.enum(["inherit", "yes", "no"]).default("inherit"),
  warranty_months: z.coerce.number().int().min(0).max(600).default(0),
  // Botón rápido del POS (H36): favorito + orden de aparición en la grilla.
  is_favorite: z.boolean().default(false),
  // F24 · H158: no acepta descuento manual (promos y cupones sí).
  no_discount: z.boolean().default(false),
  // F24 · H163: compra, venta o ambos. undefined = no se tocó (queda 'both').
  usage: z.enum(["both", "sale", "purchase"]).optional(),
  favorite_order: z.coerce.number().int().min(0).max(9999).default(0),
  // Servicio (F12 · H38): duración por defecto del turno (min) y % de comisión
  // del profesional. Vacío → null (producto normal, sin agenda).
  service_duration_min: z
    .union([z.coerce.number().int().positive().max(1440), z.literal(""), z.null()])
    .transform((v) => (v === "" || v == null ? null : v))
    .optional(),
  commission_pct: z
    .union([z.coerce.number().min(0).max(100), z.literal(""), z.null()])
    .transform((v) => (v === "" || v == null ? null : v))
    .optional(),
  // Estación de preparación (F13 · H45 ruteo): a qué pantalla del KDS va el
  // producto (cocina/barra/cafeteria/parrilla/postres/despacho). "" → null = sin
  // estación. El POS/Salón snapshotea esto en la línea del pedido al cargarla.
  station: optionalText(20),
  // Servicios profesionales (ADR-116): descripción ampliada que viaja a la
  // factura y aclaraciones predefinidas que se suman solas al venderlo.
  invoice_detail: optionalText(2000),
  service_clarification_ids: z.array(z.string().uuid()).max(20).default([]),
  // ADR-122: tipo del servicio (service_types). "" → null = sin tipo.
  service_type_id: z
    .union([z.string().uuid(), z.literal(""), z.null()])
    .transform((v) => (v ? v : null))
    .optional(),
  // ADR-151: precio a definir al cobrar. undefined = no se tocó (producto fijo).
  price_mode: z.enum(["fixed", "open"]).optional(),
  // Vacío = sin límite (null). Se limpia antes de convertir: "" no es 0.
  open_price_min: z.preprocess(
    (v) => (v === "" || v === undefined ? null : v),
    z.coerce.number().min(0, "Debe ser ≥ 0").lt(1_000_000_000).nullable().optional(),
  ),
  open_price_max: z.preprocess(
    (v) => (v === "" || v === undefined ? null : v),
    z.coerce.number().positive("Debe ser mayor a 0").lt(1_000_000_000).nullable().optional(),
  ),
}).superRefine((v, ctx) => {
  if (v.price_mode === "open" && v.open_price_min != null && v.open_price_max != null && v.open_price_min > v.open_price_max) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["open_price_max"], message: "Tiene que ser mayor o igual al mínimo" });
  }
});
export type ProductInput = z.input<typeof ProductSchema>;
export type ProductOutput = z.output<typeof ProductSchema>;

export const CategorySchema = z.object({
  name: z.string().min(1, "Requerido").max(80),
  parent_id: z.string().uuid().nullable().optional(),
});
export type CategoryInput = z.infer<typeof CategorySchema>;

// Motivos de ajuste manual (sale / sale_void los genera el POS).
export const ADJUST_REASONS = [
  "purchase",
  "adjustment",
  "loss",
  "return",
  "transfer",
] as const;
export const ADJUST_REASON_LABELS: Record<
  (typeof ADJUST_REASONS)[number],
  string
> = {
  purchase: "Compra",
  adjustment: "Ajuste manual",
  loss: "Merma",
  return: "Devolución",
  transfer: "Transferencia",
};

export const StockAdjustSchema = z.object({
  delta: z.coerce.number().refine((v) => v !== 0, "No puede ser 0"),
  reason: z.enum(ADJUST_REASONS),
  notes: optionalText(200),
});
export type StockAdjustInput = z.input<typeof StockAdjustSchema>;

// ── Merma tipada (F13 · H50) ─────────────────────────────────────────────────
// Sub-motivos de pérdida de stock. Se registran con register_stock_waste, que
// descuenta el stock e inserta el movimiento con reason='loss' + loss_reason.
export const WASTE_REASONS = [
  "vencido",
  "roto",
  "preparacion_fallida",
  "devolucion",
  "otro",
] as const;
export const WASTE_REASON_LABELS: Record<
  (typeof WASTE_REASONS)[number],
  string
> = {
  vencido: "Vencido",
  roto: "Roto / dañado",
  preparacion_fallida: "Preparación fallida",
  devolucion: "Devolución (descarte)",
  otro: "Otro",
};

export const MermaSchema = z.object({
  qty: z.coerce.number().positive("La cantidad debe ser mayor a 0"),
  reason: z.enum(WASTE_REASONS),
  notes: optionalText(200),
});
export type MermaInput = z.input<typeof MermaSchema>;

// ── Producción / batch (F13 · H50) ───────────────────────────────────────────
// Registrar una preparación previa: suma `qty` al stock del producto preparado
// (reason='production'). No tiene sub-motivos (a diferencia de la merma).
export const ProductionSchema = z.object({
  qty: z.coerce.number().positive("La cantidad debe ser mayor a 0"),
  notes: optionalText(200),
});
export type ProductionInput = z.input<typeof ProductionSchema>;
