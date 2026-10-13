"use client";

// Promociones (F9, ADR-074). CRUD por tabla con RLS (dueño o encargado, con la
// feature `promociones` y alcance de sucursal; lo valida la base). El tipo
// `Promotion` lo define el motor puro (lib/promotions/engine.ts). La tabla no
// está en los tipos generados: cast del nombre de tabla y del payload.

import { createClient } from "@/lib/supabase/client";
import type {
  Promotion,
  PromoScope,
  PromoActionType,
  PromoVolumeTier,
  PromoBundleItem,
  PromoUsage,
  SimSale,
} from "@/lib/promotions/engine";

export type { Promotion, PromoScope, PromoActionType, PromoVolumeTier, PromoBundleItem, PromoUsage, SimSale };

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
  scope_brand_id?: string | null;
  scope_ids?: string[] | null;
  action_type: PromoActionType;
  action_value: number;
  buy_qty?: number | null;
  pay_qty?: number | null;
  volume_tiers?: PromoVolumeTier[] | null;
  bundle_items?: PromoBundleItem[] | null;
  payment_method?: string | null;
  card_brands?: string[] | null;
  banks?: string[] | null;
  store_ids?: string[] | null;
  price_list_ids?: string[] | null;
  stackable?: boolean;
  max_discount?: number | null;
  max_uses_total?: number | null;
  max_uses_per_customer?: number | null;
  ticket_label?: string | null;
  gift_product_id?: string | null;
  gift_qty?: number | null;
}

const COLS =
  "id, name, is_active, priority, valid_from, valid_to, days_of_week, time_from, time_to, min_amount, scope, scope_category_id, scope_product_id, scope_brand_id, scope_ids, action_type, action_value, buy_qty, pay_qty, volume_tiers, bundle_items, payment_method, card_brands, banks, store_ids, price_list_ids, stackable, max_discount, max_uses_total, max_uses_per_customer, ticket_label, gift_product_id, gift_qty";

const list = <T>(v: T[] | null | undefined): T[] | null => (v && v.length > 0 ? v : null);
const posInt = (v: unknown): number | null => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 1 ? n : null;
};

/** Normaliza el input al payload de la tabla (limpia lo que el tipo no usa). */
export function promotionRow(input: PromotionInput): Record<string, unknown> {
  const t = input.action_type;
  const scope: PromoScope = t === "bundle" ? "cart" : input.scope;
  const ids = list((input.scope_ids ?? []).filter(Boolean));
  const maxDiscount = Number(input.max_discount);
  return {
    name: input.name.trim() || "Promoción",
    is_active: input.is_active ?? true,
    priority: Math.trunc(Number(input.priority) || 0),
    valid_from: input.valid_from || null,
    valid_to: input.valid_to || null,
    days_of_week: list(input.days_of_week),
    time_from: input.time_from ?? null,
    time_to: input.time_to ?? null,
    min_amount: Math.max(0, Number(input.min_amount) || 0),
    scope,
    scope_ids: scope === "cart" ? null : ids,
    scope_category_id: scope === "category" && !ids ? (input.scope_category_id ?? null) : null,
    scope_product_id: scope === "product" && !ids ? (input.scope_product_id ?? null) : null,
    scope_brand_id: scope === "brand" && !ids ? (input.scope_brand_id ?? null) : null,
    action_type: t,
    action_value: Math.max(0, Number(input.action_value) || 0),
    buy_qty: t === "nxm" ? (input.buy_qty ?? null) : null,
    pay_qty: t === "nxm" ? (input.pay_qty ?? null) : null,
    volume_tiers: t === "volume_tier" ? sanitizeTiers(input.volume_tiers) : null,
    bundle_items: t === "bundle" ? sanitizeBundle(input.bundle_items) : null,
    payment_method: input.payment_method ? input.payment_method : null,
    card_brands: list(input.card_brands),
    banks: list(input.banks),
    store_ids: list(input.store_ids),
    price_list_ids: list(input.price_list_ids),
    stackable: Boolean(input.stackable),
    max_discount: Number.isFinite(maxDiscount) && maxDiscount > 0 ? maxDiscount : null,
    max_uses_total: posInt(input.max_uses_total),
    max_uses_per_customer: posInt(input.max_uses_per_customer),
    ticket_label: input.ticket_label?.trim() ? input.ticket_label.trim().slice(0, 40) : null,
    gift_product_id: t === "gift" ? (input.gift_product_id ?? null) : null,
    gift_qty: t === "gift" ? Math.max(1, Math.trunc(Number(input.gift_qty) || 1)) : null,
  };
}

export function sanitizeTiers(tiers: PromoVolumeTier[] | null | undefined): PromoVolumeTier[] | null {
  const clean = (tiers ?? [])
    .map((t) => ({ min_qty: Math.trunc(Number(t?.min_qty) || 0), pct: Number(t?.pct) || 0 }))
    .filter((t) => t.min_qty >= 1 && t.pct > 0 && t.pct <= 100)
    .sort((a, b) => a.min_qty - b.min_qty);
  return clean.length > 0 ? clean : null;
}

export function sanitizeBundle(items: PromoBundleItem[] | null | undefined): PromoBundleItem[] | null {
  const seen = new Set<string>();
  const clean: PromoBundleItem[] = [];
  for (const b of items ?? []) {
    const qty = Math.trunc(Number(b?.qty) || 0);
    if (!b?.product_id || qty < 1 || seen.has(b.product_id)) continue;
    seen.add(b.product_id);
    clean.push({ product_id: b.product_id, qty });
  }
  return clean.length > 0 ? clean.slice(0, 10) : null;
}

/** Promo aplicada en una venta (ticket y detalle). */
export interface SalePromotion {
  id: string;
  promotion_id: string | null;
  label: string;
  kind: "discount" | "gift";
  discount: number;
}

export const promotionsApi = {
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
      .insert(promotionRow(input) as never)
      .select("id")
      .single();
    if (error) throw error;
    return (data as unknown as { id: string }).id;
  },

  update: async (id: string, input: PromotionInput): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("promotions" as never)
      .update(promotionRow(input) as never)
      .eq("id", id);
    if (error) throw error;
  },

  setActive: async (id: string, active: boolean): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("promotions" as never)
      .update({ is_active: active } as never)
      .eq("id", id);
    if (error) throw error;
  },

  remove: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("promotions" as never)
      .update({ deleted_at: new Date().toISOString() } as never)
      .eq("id", id);
    if (error) throw error;
  },

  /** Usos por promo con tope (total y del cliente), para la vista previa del POS. */
  usage: async (customerId: string | null): Promise<Record<string, PromoUsage>> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("promotion_usage" as never, { p_customer: customerId } as never);
    if (error) throw error;
    const raw = (data ?? {}) as Record<string, { total: number | string; customer: number | string }>;
    const out: Record<string, PromoUsage> = {};
    for (const [k, v] of Object.entries(raw)) out[k] = { total: Number(v.total) || 0, customer: Number(v.customer) || 0 };
    return out;
  },

  /** Promos aplicadas en una venta (descuentos y regalos). */
  forSale: async (saleId: string): Promise<SalePromotion[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("sale_promotions" as never)
      .select("id, promotion_id, label, kind, discount")
      .eq("sale_id", saleId)
      .order("created_at");
    if (error) throw error;
    return ((data ?? []) as unknown as SalePromotion[]).map((r) => ({ ...r, discount: Number(r.discount) || 0 }));
  },

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

  performance: async (fromISO: string, toISO: string): Promise<PromotionPerfReport> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("promotion_performance" as never, {
      p_from: fromISO,
      p_to: toISO,
    } as never);
    if (error) throw error;
    return (data ?? { rows: [], count: 0, total_discount: 0, total_sold: 0 }) as unknown as PromotionPerfReport;
  },
};

export interface PromotionPerfRow {
  promo_id: string;
  promo_name: string;
  kind?: "discount" | "gift";
  count: number;
  total_discount: number;
  total_sold: number;
}
export interface PromotionPerfReport {
  rows: PromotionPerfRow[];
  count: number;
  total_discount: number;
  total_sold: number;
}
