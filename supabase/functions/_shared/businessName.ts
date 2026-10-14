// Nombre del negocio para mostrar al cliente (ADR-123). Espejo de
// lib/branding/businessName.ts para las Edge Functions (Deno no importa lib/).
//
// Orden: nombre de fantasía (tenant_branding.trade_name) → nombre de la cuenta
// (tenants.name) → razón social. trade_name se lee APARTE y un error se toma
// como "sin fantasía": si la migración 20261121100000_nombre_fantasia todavía
// no se aplicó, la columna no existe y el envío sigue como antes.

// deno-lint-ignore no-explicit-any
type Admin = any;

const clean = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

export async function fetchTradeName(admin: Admin, tenantId: string): Promise<string | null> {
  try {
    const { data, error } = await admin.from("tenant_branding").select("trade_name").eq("tenant_id", tenantId).maybeSingle();
    if (error) return null;
    return clean((data as { trade_name?: unknown } | null)?.trade_name).slice(0, 120) || null;
  } catch {
    return null;
  }
}

export function businessDisplayName(
  parts: { tradeName?: string | null; tenantName?: string | null; legalName?: string | null },
  fallback = "",
): string {
  return clean(parts.tradeName) || clean(parts.tenantName) || clean(parts.legalName) || fallback;
}
