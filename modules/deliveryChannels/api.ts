"use client";

// Canales de delivery externos (F13 · H49 integraciones, ADR-102): conexiones
// a PedidosYa, Rappi, Uber Eats, Mercado Pago Delivery y el simulador, mapeo
// de productos, pedidos de las apps en el tablero y simulador. Escritura sólo
// por RPC (SECURITY DEFINER + feature canales_delivery en el servidor); los
// secretos nunca vuelven al navegador. Tablas sin tipos generados: cast.

import { createClient } from "@/lib/supabase/client";
import type { ChannelProvider, ExternalStatus } from "@/supabase/functions/_shared/deliveryChannels/types";

export type { ChannelProvider, ExternalStatus };

export const CHANNEL_LABELS: Record<ChannelProvider, string> = {
  pedidosya: "PedidosYa",
  rappi: "Rappi",
  ubereats: "Uber Eats",
  mp_delivery: "Mercado Pago Delivery",
  simulador: "Simulador",
};

export const EXTERNAL_STATUS_LABELS: Record<ExternalStatus, string> = {
  nuevo: "Nuevo, sin aceptar",
  aceptado: "Aceptado",
  rechazado: "Rechazado",
  listo: "Listo para retirar",
  retirado: "Retirado",
  entregado: "Entregado",
  cancelado: "Cancelado por la app",
};

export type BillingStatus = "pendiente" | "facturado" | "no_facturar" | "anulado" | "error";

export const BILLING_LABELS: Record<BillingStatus, string> = {
  pendiente: "A facturar",
  facturado: "Facturado",
  no_facturar: "Sin factura",
  anulado: "Venta anulada",
  error: "No se pudo facturar",
};

export interface ChannelProviderInfo {
  key: ChannelProvider;
  name: string;
  default_flow: "directo" | "indirecto";
  supports_tracking: boolean;
  supports_settlements: boolean;
  supports_menu_sync: boolean;
  supports_reconcile: boolean;
  is_available: boolean;
  sort: number;
}

export interface ChannelConnection {
  id: string;
  store_id: string;
  provider: ChannelProvider;
  label: string;
  external_store_id: string;
  status: "pendiente" | "activa" | "pausada" | "error";
  flow: "directo" | "indirecto";
  auto_accept: boolean;
  default_prep_minutes: number;
  billing_mode: "auto" | "manual";
  commission_pct: number;
  last_event_at: string | null;
  last_reconciled_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  created_at: string;
}

export interface ChannelOrder {
  id: string;
  delivery_order_id: string;
  connection_id: string;
  store_id: string;
  provider: ChannelProvider;
  brand: ChannelProvider;
  external_order_id: string;
  external_display_code: string | null;
  external_status: ExternalStatus;
  logistics: "plataforma" | "propia";
  payment_mode: "prepago" | "efectivo";
  total: number;
  placed_at: string;
  accept_deadline_at: string | null;
  accepted_at: string | null;
  prep_minutes: number | null;
  ready_at: string | null;
  picked_up_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  courier_name: string | null;
  courier_phone: string | null;
  courier_status: string | null;
  courier_lat: number | null;
  courier_lng: number | null;
  courier_eta_at: string | null;
  tracking_url: string | null;
  courier_updated_at: string | null;
  needs_review: boolean;
  billing_status: BillingStatus;
  billing_error: string | null;
  sale_id: string | null;
  sync_error: string | null;
  created_at: string;
}

export interface ChannelMapRow {
  id: string;
  connection_id: string;
  kind: "product" | "modifier";
  external_id: string;
  external_name: string | null;
  product_id: string | null;
  modifier_option_id: string | null;
}

export interface ChannelExternalItem {
  id: string;
  connection_id: string;
  kind: "product" | "modifier";
  external_id: string;
  name: string;
  sku: string | null;
  last_price: number | null;
  seen_count: number;
  last_seen_at: string;
}

export interface MapProduct {
  id: string;
  name: string;
  sku: string | null;
  price: number;
  has_variants: boolean;
}

export interface ConnectSettings {
  flow?: "directo" | "indirecto";
  auto_accept?: boolean;
  default_prep_minutes?: number;
  billing_mode?: "auto" | "manual";
  commission_pct?: number;
}

export interface MapInput {
  kind: "product" | "modifier";
  external_id: string;
  external_name?: string | null;
  product_id: string | null;
  modifier_option_id?: string | null;
}

const CONN_COLS =
  "id, store_id, provider, label, external_store_id, status, flow, auto_accept, default_prep_minutes, billing_mode, commission_pct, last_event_at, last_reconciled_at, last_error, last_error_at, created_at";
const ORDER_COLS =
  "id, delivery_order_id, connection_id, store_id, provider, brand, external_order_id, external_display_code, external_status, logistics, payment_mode, total, placed_at, accept_deadline_at, accepted_at, prep_minutes, ready_at, picked_up_at, delivered_at, cancelled_at, cancel_reason, courier_name, courier_phone, courier_status, courier_lat, courier_lng, courier_eta_at, tracking_url, courier_updated_at, needs_review, billing_status, billing_error, sale_id, sync_error, created_at";

const ERRORS: Record<string, string> = {
  "feature_not_in_plan: canales_delivery": "Tu plan no incluye los canales de delivery.",
  feature_not_in_plan: "Tu plan no incluye los canales de delivery.",
  forbidden_role: "Sólo el dueño o un encargado pueden hacer esto.",
  forbidden_read_only: "Tu usuario es de solo lectura.",
  forbidden: "No tenés permiso para esto.",
  external_store_required: "Falta el id del local en la plataforma.",
  external_store_taken: "Ese local de la plataforma ya está conectado.",
  store_not_found: "La sucursal no existe.",
  store_not_allowed: "No tenés acceso a esa sucursal.",
  no_open_shift: "Abrí tu caja para facturar.",
  channel_wrong_store: "Tu caja es de otra sucursal: facturalo desde una caja de la sucursal del canal.",
  channel_order_already_billed: "El pedido ya está facturado.",
  channel_order_not_billable: "El pedido no se puede facturar en este estado.",
  channel_order_not_finished: "El pedido todavía no se retiró ni se entregó.",
  reject_reason_required: "Escribí el motivo del rechazo.",
  reason_required: "Escribí el motivo.",
  variant_product_not_supported: "Los productos con variantes todavía no se pueden mapear.",
  only_simulator: "El simulador sólo funciona con una conexión de tipo Simulador.",
  connection_paused: "La conexión está pausada: activala para simular.",
  no_products: "Cargá productos con precio para simular un pedido.",
  insufficient_stock: "No hay stock suficiente para facturar.",
  webhook_secret_too_short: "El secreto del webhook tiene que tener al menos 16 caracteres.",
};

export function channelErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  for (const [k, v] of Object.entries(ERRORS)) if (raw.includes(k)) return v;
  if (raw.startsWith("invalid_transition")) return "El pedido ya cambió de estado. Actualizá la pantalla.";
  return raw || "No se pudo completar la acción.";
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().rpc(fn as never, args as never);
  if (error) throw new Error(error.message);
  return data as T;
}

/** Llama a la Edge del worker y devuelve el cuerpo aunque sea un error HTTP. */
async function worker<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().functions.invoke("delivery_channel_worker", { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    let detail: { error?: string; message?: string } | null = null;
    try {
      detail = ctx ? await ctx.json() : null;
    } catch {
      detail = null;
    }
    throw new Error(detail?.message ?? detail?.error ?? error.message);
  }
  return data as T;
}

/** URL del webhook que se le pasa a la plataforma. */
export function webhookUrl(connectionId: string): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  return `${base}/functions/v1/delivery_channel_webhook?c=${connectionId}`;
}

export const channelsApi = {
  providers: async (): Promise<ChannelProviderInfo[]> => {
    const { data, error } = await createClient()
      .from("delivery_channel_providers" as never)
      .select("key, name, default_flow, supports_tracking, supports_settlements, supports_menu_sync, supports_reconcile, is_available, sort")
      .order("sort");
    if (error) throw error;
    return (data ?? []) as unknown as ChannelProviderInfo[];
  },

  connections: async (): Promise<ChannelConnection[]> => {
    const { data, error } = await createClient()
      .from("delivery_channel_connections" as never)
      .select(CONN_COLS)
      .is("deleted_at", null)
      .order("created_at");
    if (error) throw error;
    return (data ?? []) as unknown as ChannelConnection[];
  },

  /** Pedidos de apps abiertos o de las últimas 24 h (tablero de delivery). */
  orders: async (): Promise<ChannelOrder[]> => {
    const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const { data, error } = await createClient()
      .from("delivery_channel_orders" as never)
      .select(ORDER_COLS)
      .or(`created_at.gte.${since},external_status.in.(nuevo,aceptado,listo,retirado),billing_status.in.(pendiente,error)`)
      .order("created_at", { ascending: false })
      .limit(300);
    if (error) throw error;
    return (data ?? []) as unknown as ChannelOrder[];
  },

  outbox: async (connectionId: string) => {
    const { data, error } = await createClient()
      .from("delivery_channel_outbox" as never)
      .select("id, action, status, attempts, max_attempts, next_attempt_at, last_error, created_at, done_at, channel_order_id")
      .eq("connection_id", connectionId)
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) throw error;
    return (data ?? []) as unknown as {
      id: string;
      action: string;
      status: string;
      attempts: number;
      max_attempts: number;
      next_attempt_at: string;
      last_error: string | null;
      created_at: string;
      done_at: string | null;
      channel_order_id: string | null;
    }[];
  },

  events: async (connectionId: string) => {
    const { data, error } = await createClient()
      .from("delivery_channel_events" as never)
      .select("id, external_event_id, event_type, external_order_id, source, status, attempts, error, received_at")
      .eq("connection_id", connectionId)
      .order("received_at", { ascending: false })
      .limit(30);
    if (error) throw error;
    return (data ?? []) as unknown as {
      id: string;
      external_event_id: string;
      event_type: string;
      external_order_id: string | null;
      source: string;
      status: string;
      attempts: number;
      error: string | null;
      received_at: string;
    }[];
  },

  mapRows: async (connectionId: string): Promise<ChannelMapRow[]> => {
    const { data, error } = await createClient()
      .from("delivery_channel_product_map" as never)
      .select("id, connection_id, kind, external_id, external_name, product_id, modifier_option_id")
      .eq("connection_id", connectionId)
      .is("deleted_at", null);
    if (error) throw error;
    return (data ?? []) as unknown as ChannelMapRow[];
  },

  externalItems: async (connectionId: string): Promise<ChannelExternalItem[]> => {
    const { data, error } = await createClient()
      .from("delivery_channel_external_items" as never)
      .select("id, connection_id, kind, external_id, name, sku, last_price, seen_count, last_seen_at")
      .eq("connection_id", connectionId)
      .order("last_seen_at", { ascending: false })
      .limit(500);
    if (error) throw error;
    return (data ?? []) as unknown as ChannelExternalItem[];
  },

  products: async (): Promise<MapProduct[]> => {
    const { data, error } = await createClient()
      .from("products")
      .select("id, name, sku, price, has_variants")
      .is("deleted_at", null)
      .eq("is_active", true)
      .order("name")
      .limit(2000);
    if (error) throw error;
    return (data ?? []) as unknown as MapProduct[];
  },

  credentialKeys: (connectionId: string) =>
    rpc<{ keys: string[]; has_webhook_secret: boolean; updated_at: string }>("delivery_channel_credential_keys", {
      p_id: connectionId,
    }),

  connect: (provider: ChannelProvider, storeId: string, label: string | null, externalStoreId: string | null, settings: ConnectSettings) =>
    rpc<string>("delivery_channel_connect", {
      p_provider: provider,
      p_store_id: storeId,
      p_label: label,
      p_external_store_id: externalStoreId,
      p_settings: settings,
    }),
  update: (id: string, patch: Record<string, unknown>) => rpc<unknown>("delivery_channel_update", { p_id: id, p: patch }),
  disconnect: (id: string, reason: string | null) => rpc<void>("delivery_channel_disconnect", { p_id: id, p_reason: reason }),
  setCredentials: (id: string, credentials: Record<string, unknown>) =>
    rpc<unknown>("delivery_channel_set_credentials", { p_id: id, p_credentials: credentials }),
  mapSet: (connectionId: string, rows: MapInput[]) =>
    rpc<{ mapped: number; unmapped: number }>("delivery_channel_map_set", { p_connection: connectionId, p_rows: rows }),
  retryOutbox: (id: string) => rpc<void>("delivery_channel_outbox_retry", { p_id: id }),

  accept: (id: string, prepMinutes: number) =>
    rpc<unknown>("delivery_channel_order_accept", { p_id: id, p_prep_minutes: prepMinutes }),
  reject: (id: string, reason: string) => rpc<unknown>("delivery_channel_order_reject", { p_id: id, p_reason: reason }),
  ready: (id: string) => rpc<unknown>("delivery_channel_order_ready", { p_id: id }),
  pickedUp: (id: string) =>
    rpc<{ billing_error?: string | null }>("delivery_channel_order_picked_up", { p_id: id, p_cash_shift_id: null }),
  delivered: (id: string) =>
    rpc<{ billing_error?: string | null }>("delivery_channel_order_delivered", { p_id: id, p_cash_shift_id: null }),
  bill: (id: string) => rpc<{ sale_id: string; number: number }>("delivery_channel_order_bill", { p_id: id, p_cash_shift_id: null }),
  billPending: () => rpc<{ billed: number; failed: number; reason?: string }>("delivery_channel_bill_pending", { p_cash_shift_id: null }),
  closeUnbilled: (id: string, reason: string) =>
    rpc<unknown>("delivery_channel_order_close_unbilled", { p_id: id, p_reason: reason }),

  // Edge del worker.
  flush: () => worker<{ ok: boolean }>({ action: "flush" }),
  test: (connectionId: string) =>
    worker<{ ok: boolean; message: string; adapter_ready: boolean; credential_keys: string[] }>({
      action: "test",
      connection_id: connectionId,
    }),
  simulate: (connectionId: string, body: Record<string, unknown>) =>
    worker<{ ok: boolean; external_order_id?: string; webhook?: { status: number; body: unknown } | null }>({
      action: "simulate",
      connection_id: connectionId,
      ...body,
    }),
};
