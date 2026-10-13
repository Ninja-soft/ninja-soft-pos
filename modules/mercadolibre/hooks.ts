"use client";

// Mercado Libre (H87 · ADR-104). Lectura por tabla con RLS (el negocio sale
// del JWT); toda escritura por RPC SECURITY DEFINER o por las Edge ml_api y
// ml_oauth_start (el servidor valida plan, rol y cuenta). Las tablas y RPC
// nuevas no están en los tipos generados: se castean.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { AttrField, PublishInput } from "@/supabase/functions/_shared/mercadolibre/items";

export type { AttrField, PublishInput };

// ---------------------------------------------------------------------------
// Tipos de las filas
// ---------------------------------------------------------------------------
export interface MlLocationMap {
  id: string;
  account_id: string;
  location_type: string;
  store_id: string | null;
  warehouse_id: string | null;
  reserve_qty: number;
  push_enabled: boolean;
}

export interface MlAccount {
  id: string;
  ml_user_id: number;
  nickname: string;
  site_id: string;
  user_product_seller: boolean;
  status: "active" | "reauth_required" | "disconnected";
  status_reason: string | null;
  price_list_id: string | null;
  price_markup_pct: number;
  price_rounding: number;
  price_sync: boolean;
  stock_sync: boolean;
  invoice_mode: "on_paid" | "on_shipped" | "manual" | "ml_billing" | "none";
  upload_invoice: boolean;
  default_listing_type: string;
  label_format: "pdf" | "zpl2";
  connected_at: string;
  last_sync_at: string | null;
  last_error: string | null;
  location: MlLocationMap | null;
}

export interface MlItemLink {
  id: string;
  product_id: string;
  variant_id: string | null;
  ml_variation_id: number | null;
  linked_by: string;
  products: { name: string } | null;
}

export interface MlItem {
  id: string;
  account_id: string;
  ml_item_id: string;
  user_product_id: string | null;
  title: string;
  category_id: string | null;
  listing_type_id: string | null;
  status: string;
  sub_status: string[];
  logistic_type: string | null;
  shipping_mode: string | null;
  free_shipping: boolean;
  catalog_listing: boolean;
  permalink: string | null;
  thumbnail: string | null;
  price: number | null;
  available_quantity: number | null;
  sold_quantity: number | null;
  has_variations: boolean;
  health: number | null;
  price_source: "pos" | "manual" | "automation";
  last_pushed_at: string | null;
  last_error: string | null;
  synced_at: string | null;
  links: MlItemLink[];
}

export interface MlOrder {
  id: string;
  account_id: string;
  ml_order_id: number;
  pack_key: string;
  pack_id: number | null;
  status: string;
  tags: string[];
  date_created: string | null;
  total_amount: number;
  paid_amount: number;
  sale_fee_total: number;
  shipping_cost: number | null;
  buyer_nickname: string | null;
  shipment_id: number | null;
  fraud_risk: boolean;
  sale_id: string | null;
  unlinked_lines: number;
  needs_review: string | null;
  invoice_status: string;
  stock_reverted_at: string | null;
  lines: Array<{ title?: string; quantity?: number; unit_price?: number; ml_item_id?: string }>;
  sales: { number: number } | null;
}

export interface MlShipment {
  id: string;
  account_id: string;
  shipment_id: number;
  pack_key: string | null;
  mode: string | null;
  logistic_type: string | null;
  status: string;
  substatus: string | null;
  tracking_number: string | null;
  cost: number | null;
  city: string | null;
  state: string | null;
  label_printed_at: string | null;
  label_print_count: number;
  created_at: string;
}

export interface MlQuestion {
  id: string;
  account_id: string;
  question_id: number;
  ml_item_id: string;
  text: string;
  status: string;
  date_created: string | null;
  answer_text: string | null;
  answer_state: "none" | "sending" | "sent" | "error";
  last_error: string | null;
  ml_items: { title: string; permalink: string | null } | null;
}

export interface MlChannelPreview {
  product_id: string;
  name: string;
  description: string | null;
  sku: string | null;
  barcode: string | null;
  is_kit: boolean;
  has_variants: boolean;
  price: number | null;
  qty: number | null;
  listing_type: string;
  user_product_seller: boolean;
  pictures: string[];
  variants: Array<{
    variant_id: string;
    option1: string;
    option2: string | null;
    sku: string | null;
    barcode: string | null;
    price: number | null;
    qty: number | null;
  }>;
  links: Array<{
    link_id: string;
    item_id: string;
    ml_item_id: string;
    variant_id: string | null;
    title: string;
    status: string;
    permalink: string | null;
  }>;
}

export interface MlDomainSuggestion {
  domain_id: string;
  domain_name: string;
  category_id: string;
  category_name: string;
  attributes?: Array<{ id: string; name?: string; value_id?: string | null; value_name?: string | null }>;
}

export interface MlCategoryInfo {
  category: { id: string; name: string; max_title_length: number | null; max_pictures: number | null; listing_allowed: boolean };
  attributes: AttrField[];
  listing_types: Array<{ id: string; name: string }>;
}

export interface MlLinkSuggestion {
  item_row_id: string;
  ml_item_id: string;
  title: string;
  variation_id: string | null;
  label: string;
  product_id: string;
  variant_id: string | null;
  by: "sku" | "gtin";
}

export type MlItemAction = "pause" | "activate" | "push_stock" | "push_price" | "refresh" | "price_manual" | "price_pos";

// ---------------------------------------------------------------------------
// Acceso
// ---------------------------------------------------------------------------
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().rpc(fn as never, args as never);
  if (error) throw error;
  return data as T;
}

/** Llama a una Edge y devuelve el cuerpo; un error HTTP se lanza con su código. */
export async function mlEdge<T>(name: "ml_api" | "ml_oauth_start", body: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().functions.invoke(name, { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    let detail: { error?: string; message?: string } | null = null;
    try {
      detail = ctx && typeof ctx.json === "function" ? await ctx.json() : null;
    } catch {
      detail = null;
    }
    throw new Error([detail?.error, detail?.message].filter(Boolean).join(": ") || error.message);
  }
  const res = data as (T & { error?: string; message?: string }) | null;
  if (res && typeof res === "object" && "error" in res && res.error) {
    throw new Error([res.error, res.message].filter(Boolean).join(": "));
  }
  return data as T;
}

const from = (t: string) => createClient().from(t as never);

export const mlApi = {
  accounts: async (): Promise<MlAccount[]> => {
    const { data, error } = await from("ml_accounts")
      .select(
        "id, ml_user_id, nickname, site_id, user_product_seller, status, status_reason, price_list_id, price_markup_pct, " +
          "price_rounding, price_sync, stock_sync, invoice_mode, upload_invoice, default_listing_type, label_format, " +
          "connected_at, last_sync_at, last_error, ml_location_map(id, account_id, location_type, store_id, warehouse_id, reserve_qty, push_enabled)",
      )
      .is("deleted_at", null)
      .order("connected_at");
    if (error) throw error;
    return ((data ?? []) as unknown as Array<MlAccount & { ml_location_map: MlLocationMap[] }>).map((a) => ({
      ...a,
      location: (a.ml_location_map ?? []).find((m) => m.location_type === "item_stock") ?? null,
    }));
  },

  items: async (accountId: string): Promise<MlItem[]> => {
    const { data, error } = await from("ml_items")
      .select(
        "id, account_id, ml_item_id, user_product_id, title, category_id, listing_type_id, status, sub_status, logistic_type, " +
          "shipping_mode, free_shipping, catalog_listing, permalink, thumbnail, price, available_quantity, sold_quantity, " +
          "has_variations, health, price_source, last_pushed_at, last_error, synced_at, " +
          "links:ml_item_links(id, product_id, variant_id, ml_variation_id, linked_by, products(name))",
      )
      .eq("account_id", accountId)
      .is("deleted_at", null)
      .order("title")
      .limit(1000);
    if (error) throw error;
    return (data ?? []) as unknown as MlItem[];
  },

  orders: async (accountId: string): Promise<MlOrder[]> => {
    const { data, error } = await from("ml_orders")
      .select(
        "id, account_id, ml_order_id, pack_key, pack_id, status, tags, date_created, total_amount, paid_amount, sale_fee_total, " +
          "shipping_cost, buyer_nickname, shipment_id, fraud_risk, sale_id, unlinked_lines, needs_review, invoice_status, " +
          "stock_reverted_at, lines, sales(number)",
      )
      .eq("account_id", accountId)
      .order("date_created", { ascending: false })
      .limit(300);
    if (error) throw error;
    return (data ?? []) as unknown as MlOrder[];
  },

  shipments: async (accountId: string): Promise<MlShipment[]> => {
    const { data, error } = await from("ml_shipments")
      .select(
        "id, account_id, shipment_id, pack_key, mode, logistic_type, status, substatus, tracking_number, cost, city, state, " +
          "label_printed_at, label_print_count, created_at",
      )
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(300);
    if (error) throw error;
    return (data ?? []) as unknown as MlShipment[];
  },

  questions: async (accountId: string): Promise<MlQuestion[]> => {
    const { data, error } = await from("ml_questions")
      .select(
        "id, account_id, question_id, ml_item_id, text, status, date_created, answer_text, answer_state, last_error, " +
          "ml_items:item_row_id(title, permalink)",
      )
      .eq("account_id", accountId)
      .order("date_created", { ascending: false })
      .limit(300);
    if (error) throw error;
    return (data ?? []) as unknown as MlQuestion[];
  },

  preview: (accountId: string, productId: string) =>
    rpc<MlChannelPreview>("ml_product_channel_preview", { p_account: accountId, p_product: productId }),
};

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------
export function useMlAccounts(enabled = true) {
  return useQuery({ queryKey: ["ml", "accounts"], queryFn: mlApi.accounts, enabled });
}

export function useMlItems(accountId: string | null) {
  return useQuery({
    queryKey: ["ml", "items", accountId],
    queryFn: () => mlApi.items(accountId!),
    enabled: Boolean(accountId),
  });
}

export function useMlOrders(accountId: string | null) {
  return useQuery({
    queryKey: ["ml", "orders", accountId],
    queryFn: () => mlApi.orders(accountId!),
    enabled: Boolean(accountId),
  });
}

export function useMlShipments(accountId: string | null) {
  return useQuery({
    queryKey: ["ml", "shipments", accountId],
    queryFn: () => mlApi.shipments(accountId!),
    enabled: Boolean(accountId),
  });
}

export function useMlQuestions(accountId: string | null) {
  return useQuery({
    queryKey: ["ml", "questions", accountId],
    queryFn: () => mlApi.questions(accountId!),
    enabled: Boolean(accountId),
  });
}

export function useMlChannelPreview(accountId: string | null, productId: string | null) {
  return useQuery({
    queryKey: ["ml", "preview", accountId, productId],
    queryFn: () => mlApi.preview(accountId!, productId!),
    enabled: Boolean(accountId && productId),
  });
}

// ---------------------------------------------------------------------------
// Mutaciones
// ---------------------------------------------------------------------------
export interface MlSettingsInput {
  store_id?: string | null;
  warehouse_id?: string | null;
  reserve_qty?: number;
  stock_sync?: boolean;
  price_sync?: boolean;
  price_list_id?: string | null;
  price_markup_pct?: number;
  price_rounding?: number;
  invoice_mode?: string;
  upload_invoice?: boolean;
  default_listing_type?: string;
  label_format?: string;
}

export function useMlMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["ml"] });
  return {
    connect: useMutation({
      mutationFn: (reconnectId: string | null) =>
        mlEdge<{ url: string }>("ml_oauth_start", reconnectId ? { reconnect_id: reconnectId } : {}),
    }),
    saveSettings: useMutation({
      mutationFn: (v: { accountId: string; p: MlSettingsInput }) =>
        rpc("ml_account_settings_save", { p_account: v.accountId, p: v.p }),
      onSuccess: inv,
    }),
    disconnect: useMutation({
      mutationFn: (v: { accountId: string; reason: string }) =>
        rpc("ml_account_disconnect", { p_account: v.accountId, p_reason: v.reason }),
      onSuccess: inv,
    }),
    link: useMutation({
      mutationFn: (v: { itemId: string; variationId: string | number | null; productId: string; variantId: string | null; by?: string }) =>
        rpc<string>("ml_item_link", {
          p_item: v.itemId,
          p_variation: v.variationId === null || v.variationId === "" ? null : Number(v.variationId),
          p_product: v.productId,
          p_variant: v.variantId,
          p_by: v.by ?? "manual",
        }),
      onSuccess: inv,
    }),
    unlink: useMutation({
      mutationFn: (linkId: string) => rpc("ml_item_unlink", { p_link: linkId }),
      onSuccess: inv,
    }),
    itemsAction: useMutation({
      mutationFn: (v: { ids: string[]; action: MlItemAction }) =>
        rpc<{ ok: boolean; count: number }>("ml_items_action", { p_items: v.ids, p_action: v.action }),
      onSuccess: inv,
    }),
    answer: useMutation({
      mutationFn: (v: { questionId: string; text: string }) =>
        rpc("ml_question_answer", { p_question: v.questionId, p_text: v.text }),
      onSuccess: inv,
    }),
    invoice: useMutation({
      mutationFn: (orderId: string) => rpc("ml_order_invoice", { p_order: orderId }),
      onSuccess: inv,
    }),
    retryUpload: useMutation({
      mutationFn: (orderId: string) => rpc("ml_order_invoice_upload_retry", { p_order: orderId }),
      onSuccess: inv,
    }),
    importItems: useMutation({
      mutationFn: (accountId: string) =>
        mlEdge<{ imported: number; suggestions: MlLinkSuggestion[] }>("ml_api", { action: "import_items", account_id: accountId }),
      onSuccess: inv,
    }),
    syncAccount: useMutation({
      mutationFn: (accountId: string) => mlEdge<{ ok: boolean; orders: number }>("ml_api", { action: "sync_account", account_id: accountId }),
      onSuccess: inv,
    }),
    labels: useMutation({
      mutationFn: (v: { accountId: string; shipmentIds: string[]; format: "pdf" | "zpl2" }) =>
        mlEdge<{ format: "pdf" | "zpl2"; pdf_base64?: string; zpl?: string; blocked: Array<{ shipment_id: string; reason: string }> }>(
          "ml_api",
          { action: "labels", account_id: v.accountId, shipment_ids: v.shipmentIds, format: v.format },
        ),
      onSuccess: inv,
    }),
  };
}

// Publicar (llamadas directas desde el modal).
export const mlPublishApi = {
  predict: (title: string) => mlEdge<{ suggestions: MlDomainSuggestion[] }>("ml_api", { action: "predict_category", title }),
  category: (categoryId: string) => mlEdge<MlCategoryInfo>("ml_api", { action: "category", category_id: categoryId }),
  validate: (accountId: string, input: PublishInput) =>
    mlEdge<{ ok: boolean; errors?: string[] }>("ml_api", { action: "validate", account_id: accountId, input }),
  publish: (accountId: string, productId: string, input: PublishInput) =>
    mlEdge<{ ok: boolean; errors?: string[]; items?: Array<{ ml_item_id: string; permalink: string | null }> }>("ml_api", {
      action: "publish",
      account_id: accountId,
      product_id: productId,
      input,
    }),
};
