"use client";

// Promociones (F9 · H53). CRUD por tabla directa con RLS (escritura sólo owner/
// manager, enforced server-side). El tipo `Promotion` (registro completo) lo
// define el motor puro en lib/promotions/engine.ts; acá se agregan el input de
// alta/edición y el acceso a datos. La tabla `promotions` no está en los tipos
// generados (no se regeneran): cast del nombre de tabla / payload. La DB valida.

import { createClient } from "@/lib/supabase/client";
import type {
  Promotion,
  PromoScope,
  PromoActionType,
  PromoVolumeTier,
  SimSale,
} from "@/lib/promotions/engine";

export type { Promotion, PromoScope, PromoActionType, PromoVolumeTier, SimSale };

export interface PromotionInput {
  name: string;
  is_active?: boolean;
  priority?: number;
  valid_from?: string | null;
  valid_to?: string | null;
  days_of_week?: number[] | null;
  time_from?: number | null;
  time_to?: number | null;
  min_amount?: number;
  scope: PromoScope;
  scope_category_id?: string | null;
  scope_product_id?: string | null;
  action_type: PromoActionType;
  action_value: number;
  // Sólo para NxM (H54): N (lleva) y M (paga).
  buy_qty?: number | null;
  pay_qty?: number | null;
  // Sólo para % por volumen escalonado (H54): tramos cantidad → %.
  volume_tiers?: PromoVolumeTier[] | null;
}

const COLS =
  "id, name, is_active, priority, valid_from, valid_to, days_of_week, time_from, time_to, min_amount, scope, scope_category_id, scope_product_id, action_type, action_value, buy_qty, pay_qty, volume_tiers";

// Normaliza el input al payload de la tabla (limpia el alcance no usado).
function toRow(input: PromotionInput): Record<string, unknown> {
  const scope = input.scope;
  return {
    name: input.name.trim() || "Promoción",
    is_active: input.is_active ?? true,
    priority: input.priority ?? 0,
    valid_from: input.valid_from || null,
    valid_to: input.valid_to || null,
    days_of_week:
      input.days_of_week && input.days_of_week.length > 0 ? input.days_of_week : null,
    time_from: input.time_from ?? null,
    time_to: input.time_to ?? null,
    min_amount: Math.max(0, Number(input.min_amount) || 0),
    scope,
    scope_category_id: scope === "category" ? input.scope_category_id ?? null : null,
    scope_product_id: scope === "product" ? input.scope_product_id ?? null : null,
    action_type: input.action_type,
    action_value: Math.max(0, Number(input.action_value) || 0),
    // NxM: sólo si el tipo es 'nxm'; si no, null (coherencia con el CHECK).
    buy_qty: input.action_type === "nxm" ? input.buy_qty ?? null : null,
    pay_qty: input.action_type === "nxm" ? input.pay_qty ?? null : null,
    // Volumen escalonado: sólo si el tipo es 'volume_tier'. Sanitiza cada tramo
    // (min_qty entero ≥ 1, pct en (0, 100]) y los ordena por min_qty asc; si no
    // queda ninguno válido, null (la DB rechaza el array vacío para este tipo).
    volume_tiers:
      input.action_type === "volume_tier"
        ? sanitizeTiers(input.volume_tiers)
        : null,
  };
}

function sanitizeTiers(
  tiers: PromoVolumeTier[] | null | undefined,
): PromoVolumeTier[] | null {
  const clean = (tiers ?? [])
    .map((t) => ({
      min_qty: Math.trunc(Number(t?.min_qty) || 0),
      pct: Number(t?.pct) || 0,
    }))
    .filter((t) => t.min_qty >= 1 && t.pct > 0 && t.pct <= 100)
    .sort((a, b) => a.min_qty - b.min_qty);
  return clean.length > 0 ? clean : null;
}

export const promotionsApi = {
  // Todas las promos del tenant (no borradas), por prioridad desc y nombre.
  list: async (): Promise<Promotion[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("promotions" as never)
      .select(COLS)
      .is("deleted_at", null)
      .order("priority", { ascending: false })
      .order("name");
    if (error) throw error;
    return (data ?? []) as unknown as Promotion[];
  },

  // Sólo las ACTIVAS (lo que el POS evaluaría). La vigencia por fecha/día/hora la
  // resuelve el motor con el contexto; acá filtramos el flag para no traer de más.
  listActive: async (): Promise<Promotion[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("promotions" as never)
      .select(COLS)
      .is("deleted_at", null)
      .eq("is_active", true)
      .order("priority", { ascending: false });
    if (error) throw error;
    return (data ?? []) as unknown as Promotion[];
  },

  create: async (input: PromotionInput): Promise<string> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("promotions" as never)
      .insert(toRow(input) as never)
      .select("id")
      .single();
    if (error) throw error;
    return (data as unknown as { id: string }).id;
  },

  update: async (id: string, input: PromotionInput): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("promotions" as never)
      .update(toRow(input) as never)
      .eq("id", id);
    if (error) throw error;
  },

  // Baja lógica (deleted_at).
  remove: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("promotions" as never)
      .update({ deleted_at: new Date().toISOString() } as never)
      .eq("id", id);
    if (error) throw error;
  },

  // Datos históricos para el simulador (F9 · H56): ventas del período (las más
  // recientes, hasta `limit`) con su contexto AR + líneas, listas para el motor.
  simData: async (fromISO: string, toISO: string, limit = 1000): Promise<SimSale[]> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("promotion_sim_data" as never, {
      p_from: fromISO,
      p_to: toISO,
      p_limit: limit,
    } as never);
    if (error) throw error;
    return (data ?? []) as unknown as SimSale[];
  },
};
