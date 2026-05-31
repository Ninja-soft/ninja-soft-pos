import { z } from "zod";

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : null));

export const ProductSchema = z.object({
  name: z.string().min(1, "Requerido").max(120),
  sku: optionalText(60),
  barcode: optionalText(60),
  category_id: z.string().uuid().nullable().optional(),
  brand_id: z.string().uuid().nullable().optional(),
  price: z.coerce.number().nonnegative("Debe ser ≥ 0"),
  cost: z.coerce.number().nonnegative("Debe ser ≥ 0").optional(),
  stock: z.coerce.number().default(0),
  stock_min: z.coerce.number().nonnegative().default(0),
  unit: z.string().min(1).max(10).default("un"),
  tax_rate: z.coerce.number().min(0).max(100).default(21),
  season: optionalText(60),
  tags: optionalText(300), // coma-separado en el form; el api lo pasa a array
  image_url: optionalText(600),
  description: optionalText(500),
  is_active: z.boolean().default(true),
  is_kit: z.boolean().default(false),
  is_serialized: z.boolean().default(false),
  track_stock: z.boolean().default(true),
  // Override de venta en negativo: "inherit" usa el ajuste global del tenant.
  allow_negative: z.enum(["inherit", "yes", "no"]).default("inherit"),
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
