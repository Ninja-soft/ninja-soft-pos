// Lectura del nombre de fantasía (ADR-124), isomórfica: recibe el cliente de
// Supabase (navegador o servidor). Se pide en una consulta APARTE y un error
// se toma como "sin fantasía": si la migración 20261121200000_nombre_fantasia
// todavía no se aplicó, la columna no existe y la pantalla no se rompe.
import { cleanTradeName } from "./businessName";

type Loose = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (c: string, v: string) => { maybeSingle: () => PromiseLike<{ data: unknown; error: unknown }> };
      in: (c: string, v: string[]) => PromiseLike<{ data: unknown; error: unknown }>;
    };
  };
};

/** Nombre de fantasía del negocio (null si no tiene o la columna aún no existe). */
export async function fetchTradeName(sb: unknown, tenantId: string): Promise<string | null> {
  try {
    const { data, error } = await (sb as Loose)
      .from("tenant_branding")
      .select("trade_name")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error) return null;
    return cleanTradeName((data as { trade_name?: unknown } | null)?.trade_name);
  } catch {
    return null;
  }
}

/** Nombres de fantasía de varios negocios (selector de negocio). Error → mapa vacío. */
export async function fetchTradeNames(sb: unknown, tenantIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!tenantIds.length) return out;
  try {
    const { data, error } = await (sb as Loose).from("tenant_branding").select("tenant_id, trade_name").in("tenant_id", tenantIds);
    if (error) return out;
    for (const r of (data ?? []) as { tenant_id: string; trade_name?: unknown }[]) {
      const t = cleanTradeName(r.trade_name);
      if (t) out.set(r.tenant_id, t);
    }
  } catch {
    /* sin columna: nombres de cuenta */
  }
  return out;
}
