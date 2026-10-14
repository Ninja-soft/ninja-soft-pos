// Servicios profesionales (ADR-116): modo del catálogo, aclaraciones
// predefinidas y datos de servicio de los ítems del catálogo.
//
// pos_settings.catalog_mode, service_clarifications y las columnas nuevas de
// products / sale_items todavía no están en types/database.ts (no se
// regeneran): se leen con select + cast. La base valida (RLS, checks).
import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import { isCatalogMode, type CatalogMode } from "@/lib/catalog/mode";

export interface ServiceClarification {
  id: string;
  title: string;
  body: string;
  sort: number;
  is_active: boolean;
}

export interface ServiceClarificationInput {
  title: string;
  body: string;
  sort?: number;
  is_active?: boolean;
}

/** Datos de servicio de un ítem del catálogo (para el POS). */
export interface ServiceProductInfo {
  id: string;
  unit: string;
  invoice_detail: string | null;
  service_clarification_ids: string[];
}

interface Loose {
  from: (t: string) => {
    select: (c: string) => LooseQuery;
    insert: (v: unknown) => Promise<{ error: unknown }>;
    update: (v: unknown) => { eq: (c: string, v: unknown) => Promise<{ error: unknown }> };
  };
}
interface LooseQuery extends PromiseLike<{ data: unknown; error: unknown }> {
  is: (c: string, v: null) => LooseQuery;
  eq: (c: string, v: unknown) => LooseQuery;
  order: (c: string, o?: { ascending?: boolean }) => LooseQuery;
  limit: (n: number) => LooseQuery;
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
}
const loose = () => createClient() as unknown as Loose;

function clean(input: Partial<ServiceClarificationInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.title !== undefined) out.title = input.title.trim().slice(0, 80);
  if (input.body !== undefined) out.body = input.body.trim().slice(0, 1000);
  if (input.sort !== undefined) out.sort = Math.max(0, Math.min(9999, Math.trunc(input.sort)));
  if (input.is_active !== undefined) out.is_active = input.is_active;
  return out;
}

export const servicesApi = {
  /** Modo elegido en Configuración (null = según el rubro). */
  catalogModeSetting: async (): Promise<CatalogMode | null> => {
    const { data } = await loose().from("pos_settings").select("catalog_mode").maybeSingle();
    const v = (data as { catalog_mode?: string | null } | null)?.catalog_mode ?? null;
    return isCatalogMode(v) ? v : null;
  },

  /**
   * Guarda qué vende el negocio (dueño; RLS de pos_settings). Lo usa el
   * asistente de rubro ("vendo productos / servicios / ambos").
   */
  setCatalogMode: async (mode: CatalogMode): Promise<void> => {
    const tenantId = await getCurrentTenantId();
    if (!tenantId) return;
    const { error } = await loose().from("pos_settings").update({ catalog_mode: mode }).eq("tenant_id", tenantId);
    if (error) throw error;
  },

  clarifications: async (activeOnly = false): Promise<ServiceClarification[]> => {
    let q = loose()
      .from("service_clarifications")
      .select("id, title, body, sort, is_active")
      .is("deleted_at", null);
    if (activeOnly) q = q.eq("is_active", true);
    const { data, error } = await q.order("sort").order("created_at");
    if (error) throw error;
    return (data ?? []) as ServiceClarification[];
  },

  createClarification: async (input: ServiceClarificationInput): Promise<void> => {
    const { error } = await loose().from("service_clarifications").insert(clean(input));
    if (error) throw error;
  },

  updateClarification: async (id: string, input: Partial<ServiceClarificationInput>): Promise<void> => {
    const { error } = await loose().from("service_clarifications").update(clean(input)).eq("id", id);
    if (error) throw error;
  },

  // Baja lógica: los renglones ya vendidos guardan su propio texto.
  removeClarification: async (id: string): Promise<void> => {
    const { error } = await loose()
      .from("service_clarifications")
      .update({ deleted_at: new Date().toISOString(), is_active: false })
      .eq("id", id);
    if (error) throw error;
  },

  /** Servicios del catálogo (los que el POS deja aclarar por renglón). */
  serviceProducts: async (): Promise<ServiceProductInfo[]> => {
    const { data, error } = await loose()
      .from("products")
      .select("id, unit, invoice_detail, service_clarification_ids")
      .eq("is_service", true)
      .is("deleted_at", null)
      .limit(2000);
    if (error) throw error;
    return ((data ?? []) as ServiceProductInfo[]).map((p) => ({
      ...p,
      service_clarification_ids: p.service_clarification_ids ?? [],
    }));
  },
};
