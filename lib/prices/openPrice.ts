// Precio a definir al cobrar (ADR-151). PURO.
//
// Un producto o servicio en modo "open" no tiene precio fijo: el POS lo pide al
// agregarlo y create_sale acepta el informado dentro del mínimo y el máximo del
// producto (lo marca el producto en la base, no el POS). El precio de venta del
// producto queda como sugerido. Espejo de `_open_price_ok` (SQL).

import { round2 } from "./rounding";

export type PriceMode = "fixed" | "open";

export interface OpenPriceProduct {
  price_mode?: PriceMode | string | null;
  open_price_min?: number | string | null;
  open_price_max?: number | string | null;
  /** products.price: el sugerido. */
  price?: number | string | null;
}

export function isOpenPrice(p: OpenPriceProduct | null | undefined): boolean {
  return p?.price_mode === "open";
}

function num(v: number | string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface OpenPriceRange {
  min: number | null;
  max: number | null;
  /** Sugerido (precio de venta del producto) si es mayor a 0. */
  suggested: number | null;
}

export function openPriceRange(p: OpenPriceProduct): OpenPriceRange {
  const s = num(p.price);
  return { min: num(p.open_price_min), max: num(p.open_price_max), suggested: s != null && s > 0 ? s : null };
}

export type OpenPriceError = "required" | "below_min" | "above_max";

/** Espejo de `_open_price_ok`: > 0 y dentro del rango (tolerancia de medio centavo). */
export function openPriceError(price: number | null | undefined, min: number | null, max: number | null): OpenPriceError | null {
  if (price == null || !Number.isFinite(price) || price <= 0) return "required";
  if (min != null && price < min - 0.005) return "below_min";
  if (max != null && price > max + 0.005) return "above_max";
  return null;
}

/** Texto corto del rango para el diálogo y la ficha. */
export function openPriceRangeText(min: number | null, max: number | null, fmt: (n: number) => string): string | null {
  if (min != null && max != null) return `Entre ${fmt(min)} y ${fmt(max)}`;
  if (min != null) return `Desde ${fmt(min)}`;
  if (max != null) return `Hasta ${fmt(max)}`;
  return null;
}

export function openPriceErrorText(e: OpenPriceError, min: number | null, max: number | null, fmt: (n: number) => string): string {
  if (e === "below_min" && min != null) return `El mínimo es ${fmt(min)}`;
  if (e === "above_max" && max != null) return `El máximo es ${fmt(max)}`;
  return "Ingresá el precio";
}

/** Validación de la ficha: mínimo y máximo opcionales, mínimo <= máximo. */
export function openPriceSettingsError(min: number | null, max: number | null): string | null {
  if (min != null && min < 0) return "El mínimo no puede ser negativo";
  if (max != null && max <= 0) return "El máximo tiene que ser mayor a 0";
  if (min != null && max != null && min > max) return "El mínimo no puede ser mayor que el máximo";
  return null;
}

export interface OpenPriceServerError {
  productId: string;
  min: number | null;
  max: number | null;
  received: number | null;
}

/** Lee `open_price_out_of_range:{...}` de create_sale (o del trigger de mesas). */
export function parseOpenPriceError(err: unknown): OpenPriceServerError | null {
  const msg = err instanceof Error ? err.message : String((err as { message?: string } | null)?.message ?? err ?? "");
  const at = msg.indexOf("open_price_out_of_range:");
  if (at < 0) return null;
  try {
    const d = JSON.parse(msg.slice(at + "open_price_out_of_range:".length).trim()) as Record<string, unknown>;
    return {
      productId: String(d.product_id ?? ""),
      min: num(d.min as number | null),
      max: num(d.max as number | null),
      received: num(d.received as number | null),
    };
  } catch {
    return { productId: "", min: null, max: null, received: null };
  }
}

/** Precio tipeado ("1.234,5" o "1234.5") → número con 2 decimales, o null. */
export function parseTypedPrice(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t);
  return Number.isFinite(n) ? round2(n) : null;
}
