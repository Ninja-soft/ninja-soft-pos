import { isIvaCode, ivaCodeFromRate, type IvaCode } from "@/lib/tax/catalog";

// Campos fiscales del producto (ADR-068) para el formulario. types/database.ts
// no los tiene todavía: se leen sueltos y, sin la migración, salen del
// tax_rate numérico.
type Loose = Record<string, unknown> | null | undefined;

export function productTaxDefaults(product: unknown) {
  const p = (product ?? null) as Loose;
  const code: IvaCode = isIvaCode(p?.tax_rate_code) ? p!.tax_rate_code : (ivaCodeFromRate(p?.tax_rate as number) ?? "21");
  const mode = p?.internal_tax_mode === "pct" || p?.internal_tax_mode === "fixed" ? p.internal_tax_mode : "none";
  return {
    tax_rate_code: code,
    is_service: Boolean(p?.is_service),
    internal_tax_mode: mode as "none" | "pct" | "fixed",
    internal_tax_base: (p?.internal_tax_base === "cost" ? "cost" : "price") as "price" | "cost",
    internal_tax_rate: p?.internal_tax_rate == null ? "" : Number(p.internal_tax_rate),
    internal_tax_amount: p?.internal_tax_amount == null ? "" : Number(p.internal_tax_amount),
    internal_tax_included: p?.internal_tax_included !== false,
  } as const;
}
