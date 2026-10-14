// Nombre del negocio que ve la gente (ADR-123). PURO.
//
// El negocio tiene tres nombres:
//   · Nombre de fantasía (tenant_branding.trade_name): el comercial, el que
//     está en la vidriera. Se edita en Configuración > Marca. Opcional.
//   · Nombre de la cuenta (tenants.name): el que se cargó al registrarse.
//   · Razón social (tenant_branding.legal_name): dato fiscal. NO es un nombre
//     para mostrar: sale sólo en los datos fiscales del comprobante.
//
// Todo lugar que muestra "el nombre del negocio" (barra lateral, panel, ticket,
// factura, presupuesto, emails, catálogo público, login, pestaña) usa
// businessDisplayName: fantasía, si no la cuenta y, como último recurso (datos
// viejos sin nombre de cuenta), la razón social.
//
// Comprobantes: invoiceTradeName resuelve el encabezado comercial con el
// override propio del comprobante (invoice_style.trade_name, Configuración >
// Comprobantes) por encima de la marca. Ver ADR-123.

export const TRADE_NAME_MAX = 120;

const clean = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/** Normaliza el nombre de fantasía para guardar: espacios colapsados, tope de largo, vacío = null. */
export function cleanTradeName(v: unknown): string | null {
  const s = clean(v);
  if (!s) return null;
  return s.length > TRADE_NAME_MAX ? s.slice(0, TRADE_NAME_MAX).trim() : s;
}

export interface BusinessNameParts {
  /** tenant_branding.trade_name (o el pisado por la sucursal). */
  tradeName?: string | null;
  /** tenants.name. */
  tenantName?: string | null;
  /** tenant_branding.legal_name: sólo como último recurso. */
  legalName?: string | null;
}

/** Nombre del negocio para mostrar: fantasía → cuenta → razón social → fallback. */
export function businessDisplayName(parts: BusinessNameParts | null | undefined, fallback = "Mi negocio"): string {
  return clean(parts?.tradeName) || clean(parts?.tenantName) || clean(parts?.legalName) || fallback;
}

/** Atajo para filas de marca (SampleBrand y similares): fantasía → cuenta → razón social. */
export function brandDisplayName(
  brand: { trade_name?: string | null; tenant_name?: string | null; legal_name?: string | null } | null | undefined,
  fallback = "Mi negocio",
): string {
  return businessDisplayName(
    { tradeName: brand?.trade_name, tenantName: brand?.tenant_name, legalName: brand?.legal_name },
    fallback,
  );
}

/** Igual que businessDisplayName pero null si no hay ningún nombre. */
export function businessDisplayNameOrNull(parts: BusinessNameParts | null | undefined): string | null {
  return businessDisplayName(parts, "") || null;
}

const same = (a: string, b: string) => a.localeCompare(b, "es", { sensitivity: "base" }) === 0;

/**
 * Encabezado comercial del comprobante (va arriba, grande; la razón social
 * queda debajo con los datos fiscales). Prioridad:
 *   1. override del comprobante (invoice_style.trade_name),
 *   2. nombre de fantasía de la marca (con lo que pise la sucursal),
 *   3. nombre de la cuenta (tenants.name).
 * Si coincide con la razón social no se repite (null).
 */
export function invoiceTradeName(args: {
  override?: string | null;
  tradeName?: string | null;
  tenantName?: string | null;
  legalName?: string | null;
}): string | null {
  const name = clean(args.override) || clean(args.tradeName) || clean(args.tenantName);
  if (!name) return null;
  const legal = clean(args.legalName);
  if (legal && same(name, legal)) return null;
  return name;
}
