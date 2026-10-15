// Garantías extendidas por tipo (ADR-139). Lectura directa (RLS del negocio);
// las escrituras van por RPC (dueño o encargado, feature garantias, auditadas).
// Las columnas nuevas todavía no están en types/database.ts: cliente sin tipar.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import type { ScopeEffect, WarrantyScopeLike, WarrantyTypeLike } from "@/lib/warranty/pricing";
import type { ScopeRowInput } from "@/lib/warranty/scopes";

const db = (): SupabaseClient => createClient() as unknown as SupabaseClient;

export interface WarrantyType extends WarrantyTypeLike {
  tenant_id: string;
  months: number;
  price: number;
  price_pct: number;
  min_price: number | null;
  max_price: number | null;
  rounding_step: number;
  commission_pct: number;
  description: string | null;
  terms: string | null;
  applies_to_all: boolean;
  is_active: boolean;
  sort: number;
  created_at: string;
  updated_at: string | null;
  deleted_at: string | null;
}

export interface WarrantyScope extends WarrantyScopeLike {
  id: string;
  effect: ScopeEffect;
}

export interface WarrantyCatalog {
  plans: WarrantyType[];
  scopes: WarrantyScope[];
}

export interface WarrantyTypeInput {
  id?: string;
  label: string;
  months: number;
  price_pct: number;
  price: number;
  min_price: number | null;
  max_price: number | null;
  rounding_step: number;
  commission_pct: number;
  description: string | null;
  terms: string | null;
  applies_to_all: boolean;
  is_active: boolean;
}

/** Garantía vendida (línea de garantía enlazada), para la ficha del cliente. */
export interface SoldWarranty {
  id: string;
  product_name: string | null;
  warranty_months: number | null;
  warranty_expires_on: string | null;
  warranty_terms: string | null;
  subtotal: number;
  returned_qty: number | null;
  covered: { product_name: string | null; serial: string | null } | null;
  sale: { id: string; number: number | null; created_at: string; status: string };
}

export const warrantyApi = {
  catalog: async (): Promise<WarrantyCatalog> => {
    const c = db();
    const [plans, scopes] = await Promise.all([
      c.from("warranty_plans").select("*").is("deleted_at", null).order("sort").order("label"),
      c
        .from("warranty_plan_scopes")
        .select("id, plan_id, category_id, product_id, effect")
        .is("deleted_at", null),
    ]);
    if (plans.error) throw plans.error;
    if (scopes.error) throw scopes.error;
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return {
      plans: ((plans.data ?? []) as WarrantyType[]).map((p) => ({
        ...p,
        price: Number(p.price) || 0,
        price_pct: Number(p.price_pct) || 0,
        min_price: num(p.min_price),
        max_price: num(p.max_price),
        rounding_step: Number(p.rounding_step) || 0,
        commission_pct: Number(p.commission_pct) || 0,
        applies_to_all: p.applies_to_all ?? true,
      })),
      scopes: (scopes.data ?? []) as WarrantyScope[],
    };
  },

  save: async (plan: WarrantyTypeInput, scopes: ScopeRowInput[] | null): Promise<string> => {
    const { data, error } = await db().rpc("warranty_plan_save", { p_plan: plan, p_scopes: scopes });
    if (error) throw error;
    return data as string;
  },

  setActive: async (id: string, active: boolean): Promise<void> => {
    const { error } = await db().rpc("warranty_plan_set_active", { p_id: id, p_active: active });
    if (error) throw error;
  },

  archive: async (id: string): Promise<void> => {
    const { error } = await db().rpc("warranty_plan_archive", { p_id: id });
    if (error) throw error;
  },

  reorder: async (ids: string[]): Promise<void> => {
    const { error } = await db().rpc("warranty_plan_reorder", { p_ids: ids });
    if (error) throw error;
  },

  /** Garantías extendidas vendidas a un cliente (más nuevas primero). */
  soldToCustomer: async (customerId: string): Promise<SoldWarranty[]> => {
    const { data, error } = await db()
      .from("sale_items")
      .select(
        "id, product_name, warranty_months, warranty_expires_on, warranty_terms, subtotal, returned_qty, covered:warranty_for_item_id(product_name, serial), sale:sales!inner(id, number, created_at, status, customer_id)",
      )
      .not("warranty_plan_id", "is", null)
      .eq("sale.customer_id", customerId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    return (data ?? []) as unknown as SoldWarranty[];
  },
};

/** Mensaje claro para los errores de las RPC de garantías. */
export function warrantyErrorMessage(e: unknown): string {
  const msg = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e ?? "");
  if (msg.includes("warranty_label_taken")) return "Ya tenés un tipo de garantía con ese nombre";
  if (msg.includes("warranty_label_invalid")) return "Poné un nombre de hasta 60 caracteres";
  if (msg.includes("warranty_months_invalid")) return "La duración va de 1 a 120 meses";
  if (msg.includes("warranty_price_required")) return "Cargá un % del precio o un monto fijo";
  if (msg.includes("warranty_price_invalid")) return "El % y la comisión van de 0 a 100";
  if (msg.includes("warranty_limits_invalid")) return "Revisá el mínimo, el máximo y el redondeo";
  if (msg.includes("warranty_text_too_long")) return "La descripción o las condiciones son muy largas";
  if (msg.includes("warranty_scope")) return "Alguna categoría o producto elegido ya no existe: volvé a elegir";
  if (msg.includes("feature_not_in_plan")) return "Tu plan no incluye garantías extendidas";
  if (msg.includes("forbidden")) return "Sólo el dueño o el encargado pueden configurar garantías";
  if (msg.includes("warranty_plan_not_found")) return "Ese tipo de garantía ya no existe";
  return "No se pudo guardar. Probá de nuevo.";
}
