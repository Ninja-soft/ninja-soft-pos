import { z } from "zod";

// Validación de la API pública v1 (ADR-094). Primera barrera en la ruta de
// Next; la base vuelve a validar (las RPC son la barrera real). Los objetos
// son estrictos: un campo desconocido (p. ej. tenant_id) es un 422, nunca se
// ignora en silencio.

export const MAX_BATCH = 500;
/** Tamaño máximo del cuerpo de un pedido (500 ítems con holgura). */
export const MAX_BODY_BYTES = 1_048_576;

const money = z.number().finite().min(0).lt(10_000_000_000);
const sku = z.string().trim().min(1).max(64);
const uuid = z.string().uuid();
const isoDate = z.string().datetime({ offset: true });

export const productItemSchema = z
  .object({
    sku,
    name: z.string().trim().min(1).max(200).optional(),
    barcode: z.string().trim().max(64).nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
    price: money.optional(),
    cost: money.nullable().optional(),
    unit: z.string().trim().min(1).max(10).optional(),
    is_active: z.boolean().optional(),
    track_stock: z.boolean().optional(),
    stock_min: z.number().finite().min(0).nullable().optional(),
  })
  .strict();

function uniqueBy<T>(items: T[], key: (t: T) => string | null | undefined): boolean {
  const seen = new Set<string>();
  for (const it of items) {
    const k = key(it);
    if (k == null || k === "") continue;
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}

const batch = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item).min(1).max(MAX_BATCH) }).strict();

export const productsUpsertSchema = batch(productItemSchema)
  .refine((b) => uniqueBy(b.items, (i) => i.sku), { message: "Hay SKU repetidos en el lote.", path: ["items"] })
  .refine((b) => uniqueBy(b.items, (i) => i.barcode ?? null), {
    message: "Hay códigos de barras repetidos en el lote.",
    path: ["items"],
  });

export const priceItemSchema = z.object({ sku, price: money, cost: money.nullable().optional() }).strict();
export const pricesUpdateSchema = batch(priceItemSchema).refine((b) => uniqueBy(b.items, (i) => i.sku), {
  message: "Hay SKU repetidos en el lote.",
  path: ["items"],
});

export const STOCK_REASONS = ["purchase", "adjustment", "loss", "return", "count", "production"] as const;

export const stockItemSchema = z
  .object({
    sku,
    store_id: uuid.nullable().optional(),
    mode: z.enum(["delta", "set"]).default("delta"),
    qty: z.number().finite().gt(-1_000_000_000).lt(1_000_000_000),
    reason: z.enum(STOCK_REASONS),
    notes: z.string().max(300).nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.mode === "delta" && v.qty === 0) ctx.addIssue({ code: "custom", path: ["qty"], message: "qty: distinto de 0" });
    if (v.mode === "set" && v.qty < 0) ctx.addIssue({ code: "custom", path: ["qty"], message: "qty: mayor o igual a 0" });
  });
export const stockAdjustSchema = batch(stockItemSchema);

export const DOCUMENT_TYPES = ["cuit", "dni", "cuil", "passport", "other"] as const;
export const IVA_CONDITIONS = [
  "consumidor_final",
  "responsable_inscripto",
  "monotributo",
  "monotributo_social",
  "exento",
  "no_responsable",
  "no_categorizado",
  "no_alcanzado",
  "iva_liberado",
  "exterior",
] as const;

export const customerItemSchema = z
  .object({
    id: uuid.optional(),
    external_id: z.string().trim().min(1).max(100).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().max(200).nullable().optional(),
    phone: z.string().trim().max(50).nullable().optional(),
    document_type: z.enum(DOCUMENT_TYPES).nullable().optional(),
    document_number: z.string().trim().max(20).nullable().optional(),
    address: z.string().trim().max(300).nullable().optional(),
    iva_condition: z.enum(IVA_CONDITIONS).nullable().optional(),
    notes: z.string().max(1000).nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  .refine((c) => Boolean(c.id || c.external_id), { message: "id o external_id: obligatorio", path: ["external_id"] });

export const customersUpsertSchema = batch(customerItemSchema)
  .refine((b) => uniqueBy(b.items, (i) => i.external_id ?? null), {
    message: "Hay clientes repetidos en el lote.",
    path: ["items"],
  })
  .refine((b) => uniqueBy(b.items, (i) => i.id?.toLowerCase() ?? null), {
    message: "Hay clientes repetidos en el lote.",
    path: ["items"],
  });

// ── Consultas ───────────────────────────────────────────────────────────────
const limit = (max: number) => z.coerce.number().int().min(1).max(max).optional();
const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1")
  .optional();

/** Datos extra del producto que se piden con include (ADR-168). */
export const PRODUCT_INCLUDES = ["attributes", "images", "price_lists", "variants", "stock"] as const;
export type ProductInclude = (typeof PRODUCT_INCLUDES)[number];
/** Con algún include, la página máxima baja a este tamaño. */
export const MAX_LIMIT_WITH_INCLUDE = 100;
export const MAX_PRODUCT_IDS = 100;

/** Lista separada por comas: sin vacíos ni repetidos. */
const csv = (s: string) => [...new Set(s.split(",").map((x) => x.trim()).filter(Boolean))];

const productIncludes = z
  .string()
  .max(200)
  .transform(csv)
  .refine((v) => v.every((x) => (PRODUCT_INCLUDES as readonly string[]).includes(x)), {
    message: `include acepta ${PRODUCT_INCLUDES.join(", ")}.`,
  })
  .transform((v) => v as ProductInclude[]);

const productIds = z
  .string()
  .max(4000)
  .transform(csv)
  .refine((v) => v.length >= 1 && v.length <= MAX_PRODUCT_IDS, { message: `ids acepta entre 1 y ${MAX_PRODUCT_IDS} ids.` })
  .refine((v) => v.every((x) => uuid.safeParse(x).success), { message: "ids tiene que ser una lista de ids (uuid)." })
  .transform((v) => v.map((x) => x.toLowerCase()));

export const productsQuerySchema = z
  .object({
    limit: limit(500),
    cursor: z.string().max(512).optional(),
    updated_since: isoDate.optional(),
    sku: sku.optional(),
    ids: productIds.optional(),
    include: productIncludes.optional(),
    include_deleted: bool,
  })
  .strict()
  .refine((q) => !(q.include?.length && (q.limit ?? 0) > MAX_LIMIT_WITH_INCLUDE), {
    message: `Con include, limit va hasta ${MAX_LIMIT_WITH_INCLUDE}.`,
    path: ["limit"],
  });

export const customersQuerySchema = z
  .object({
    limit: limit(500),
    cursor: z.string().max(512).optional(),
    updated_since: isoDate.optional(),
    external_id: z.string().trim().min(1).max(100).optional(),
    include_deleted: bool,
  })
  .strict();

export const stockQuerySchema = z
  .object({
    store_id: uuid.optional(),
    sku: z
      .string()
      .max(64 * 500)
      .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
      .pipe(z.array(sku).min(1).max(MAX_BATCH))
      .optional(),
    limit: limit(500),
    cursor: z.string().max(512).optional(),
  })
  .strict();

export const MAX_SALES_RANGE_DAYS = 93;

export const salesQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
    store_id: uuid.optional(),
    limit: limit(200),
    cursor: z.string().max(512).optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    const from = Date.parse(q.from);
    const to = Date.parse(q.to);
    if (!(to > from)) ctx.addIssue({ code: "custom", path: ["to"], message: "to tiene que ser posterior a from" });
    else if (to - from > MAX_SALES_RANGE_DAYS * 86_400_000) {
      ctx.addIssue({ code: "custom", path: ["to"], message: `El rango no puede superar ${MAX_SALES_RANGE_DAYS} días` });
    }
  });

export const tokenRequestSchema = z.object({
  grant_type: z.literal("client_credentials"),
  client_id: z.string().max(64).optional(),
  client_secret: z.string().max(128).optional(),
  scope: z.string().max(400).optional(),
});

/** Issues de Zod a detalles de error de la API (path legible). */
export function zodDetails(err: z.ZodError): { path: string; message: string }[] {
  return err.issues.slice(0, 50).map((i) => ({ path: i.path.join("."), message: i.message }));
}
