// Lectura del nombre del negocio (ADR-124): nombre de la cuenta (tenants.name)
// y nombre de fantasía (tenant_branding.trade_name). La regla de cuál se
// muestra vive en lib/branding/businessName.ts (businessDisplayName).
//
// trade_name se pide en una consulta APARTE y un error se toma como "sin
// fantasía": si la migración 20261121200000_nombre_fantasia todavía no se
// aplicó, la columna no existe y el resto de la pantalla no se rompe.
import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import { fetchTradeName } from "@/lib/branding/tradeName";

export { fetchTradeName, fetchTradeNames } from "@/lib/branding/tradeName";

/** Claves de react-query que muestran el nombre del negocio (para invalidar al guardar la marca). */
export const BUSINESS_NAME_QUERY_KEYS = [["my-tenant"], ["ticket-branding"], ["remember-business"], ["my-branding-ctx"], ["business-names"]] as const;

export interface BusinessNameRow {
  tenantId: string;
  tenantName: string | null;
  tradeName: string | null;
}

/** Nombre de la cuenta y de fantasía del negocio activo (o del indicado). */
export async function fetchBusinessName(tenantId?: string | null): Promise<BusinessNameRow | null> {
  const supabase = createClient();
  const id = tenantId ?? (await getCurrentTenantId());
  if (!id) return null;
  const [{ data: t }, tradeName] = await Promise.all([
    supabase.from("tenants").select("name").eq("id", id).maybeSingle(),
    fetchTradeName(supabase, id),
  ]);
  return { tenantId: id, tenantName: (t as { name: string | null } | null)?.name ?? null, tradeName };
}
