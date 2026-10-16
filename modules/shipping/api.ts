"use client";

// Envíos y logística (ADR-103). Lectura por REST con RLS (negocio y
// sucursal); escritura por RPC (shipment_create, _submit, _cancel, _retry,
// _request_track) y por la Edge `shipping` (conexiones, cotizar, sucursales,
// procesar y etiquetas). Tablas y RPC fuera de los tipos generados: se castean.

import { createClient } from "@/lib/supabase/client";
import type { QuoteChoice } from "@/lib/shipping/form";
import type { DispatchShipmentSource } from "@/lib/shipping/fromDispatch";

export interface ShippingProvider {
  key: string;
  name: string;
  kind: "carrier" | "aggregator" | "points" | "simulator";
  status: "active" | "skeleton" | "planned";
  capabilities: Partial<Record<"quote" | "label" | "points" | "track" | "cancel" | "webhooks" | "pickup", boolean>>;
  label_formats: string[];
  sort: number;
}

export interface ShippingConnection {
  id: string;
  tenant_id: string;
  store_id: string | null;
  provider_key: string;
  enabled: boolean;
  sandbox: boolean;
  config: Record<string, string | number | boolean>;
  secret_keys: string[];
  last_test_at: string | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  updated_at: string;
}

export interface EffectiveConnection {
  provider_key: string;
  name: string;
  kind: string;
  status: string;
  capabilities: ShippingProvider["capabilities"];
  label_formats: string[];
  connection_id: string | null;
  scope: "tenant" | "store";
  sandbox: boolean;
  connected: boolean;
  in_plan: boolean;
}

export interface Shipment {
  id: string;
  tenant_id: string;
  store_id: string;
  provider_key: string | null;
  source: "pos_sale" | "order" | "manual" | "mercadolibre";
  sale_id: string | null;
  order_ref: string | null;
  service_type: "door" | "branch";
  service_code: string | null;
  pickup_point: { id: string; name?: string } | null;
  recipient: { name: string; document?: string; email?: string; phone?: string };
  destination: {
    street?: string;
    number?: string;
    floor?: string;
    apartment?: string;
    city?: string;
    province?: string;
    postal_code: string;
    reference?: string;
  };
  packages: { weight_kg: number; length_cm: number; width_cm: number; height_cm: number }[];
  package_count: number;
  total_weight_kg: number;
  declared_value: number;
  quote: (QuoteChoice & Record<string, unknown>) | null;
  quoted_cost: number | null;
  status: string;
  status_detail: string | null;
  carrier_status: string | null;
  tracking_number: string | null;
  external_id: string | null;
  label_path: string | null;
  label_format: "pdf" | "zpl" | null;
  label_ready_at: string | null;
  create_uncertain: boolean;
  cancel_requested_at: string | null;
  cancel_reason: string | null;
  delivered_at: string | null;
  last_tracked_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShipmentEvent {
  id: string;
  status: string | null;
  carrier_status: string | null;
  description: string | null;
  location: string | null;
  occurred_at: string;
  source: "system" | "poll" | "webhook" | "manual";
}

export interface ShipmentFilters {
  statuses?: string[];
  provider?: string | null;
  storeId?: string | null;
  search?: string;
  from?: string | null;
  limit?: number;
}

export interface PickupPointView {
  id: string;
  name: string;
  address: string;
  city?: string;
  postal_code?: string;
  hours?: string;
  kind: string;
}

type Res = { data: unknown; error: { message: string } | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => createClient() as any;

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = (await db().rpc(fn, args)) as Res;
  if (error) throw new Error(error.message);
  return data as T;
}

/** Llama a la Edge y devuelve el cuerpo aunque la respuesta sea un error HTTP. */
async function edge<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().functions.invoke("shipping", { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    let detail: { error?: string; detail?: string } | null = null;
    try {
      detail = ctx ? await ctx.json() : null;
    } catch {
      detail = null;
    }
    throw new Error(detail?.detail && detail.error === "carrier_error" ? detail.detail : (detail?.error ?? error.message));
  }
  return data as T;
}

export const shippingApi = {
  async providers(): Promise<ShippingProvider[]> {
    const { data, error } = (await db().from("shipping_providers").select("*").eq("is_active", true).order("sort")) as Res;
    if (error) throw new Error(error.message);
    return (data ?? []) as ShippingProvider[];
  },

  async connections(): Promise<ShippingConnection[]> {
    const { data, error } = (await db()
      .from("shipping_connections")
      .select("id, tenant_id, store_id, provider_key, enabled, sandbox, config, secret_keys, last_test_at, last_test_ok, last_test_error, updated_at")
      .is("deleted_at", null)) as Res;
    if (error) throw new Error(error.message);
    return (data ?? []) as ShippingConnection[];
  },

  effective: (storeId: string) => rpc<EffectiveConnection[]>("shipping_effective_connections", { p_store: storeId }),

  async list(f: ShipmentFilters): Promise<Shipment[]> {
    let q = db()
      .from("shipments")
      .select("*")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(Math.min(f.limit ?? 200, 500));
    if (f.statuses?.length) q = q.in("status", f.statuses);
    if (f.provider) q = q.eq("provider_key", f.provider);
    if (f.storeId) q = q.eq("store_id", f.storeId);
    if (f.from) q = q.gte("created_at", f.from);
    const s = (f.search ?? "").trim();
    if (s) {
      const safe = s.replace(/[%,()]/g, " ").slice(0, 60);
      q = q.or(`tracking_number.ilike.%${safe}%,order_ref.ilike.%${safe}%,recipient->>name.ilike.%${safe}%`);
    }
    const { data, error } = (await q) as Res;
    if (error) throw new Error(error.message);
    return (data ?? []) as Shipment[];
  },

  async get(id: string): Promise<Shipment | null> {
    const { data, error } = (await db().from("shipments").select("*").eq("id", id).maybeSingle()) as Res;
    if (error) throw new Error(error.message);
    return (data as Shipment | null) ?? null;
  },

  async events(id: string): Promise<ShipmentEvent[]> {
    const { data, error } = (await db()
      .from("shipment_events")
      .select("id, status, carrier_status, description, location, occurred_at, source")
      .eq("shipment_id", id)
      .order("occurred_at", { ascending: true })) as Res;
    if (error) throw new Error(error.message);
    return (data ?? []) as ShipmentEvent[];
  },

  /**
   * ADR-149 (A11): lo que necesita "Crear envío con logística" desde una
   * entrega: dirección de entrega, cliente, productos de esa entrega y su
   * precio neto en la venta.
   */
  async dispatchSource(dispatchId: string): Promise<DispatchShipmentSource> {
    const { data, error } = (await db()
      .from("dispatches")
      .select(
        "id, number, sale_id, store_id, ship_address, customer_name, " +
          "items:dispatch_items(product_id, variant_id, product_name, variant_label, qty), " +
          "sale:sales(number, customer:customers(name, email, phone, document_number, address), " +
          "lines:sale_items(product_id, variant_id, quantity, subtotal, product_name))",
      )
      .eq("id", dispatchId)
      .maybeSingle()) as Res;
    if (error) throw new Error(error.message);
    if (!data) throw new Error("dispatch_not_found");
    type Line = { product_id: string | null; variant_id: string | null; quantity: number; subtotal: number; product_name: string };
    const d = data as {
      id: string;
      number: number;
      sale_id: string;
      store_id: string;
      ship_address: string | null;
      customer_name: string | null;
      items: { product_id: string; variant_id: string | null; product_name: string; variant_label: string | null; qty: number }[] | null;
      sale: { number: number; customer: DispatchShipmentSource["customer"]; lines: Line[] | null } | null;
    };
    const lines = d.sale?.lines ?? [];
    const unitPrice = (pid: string | null, vid: string | null) => {
      const same = lines.filter((l) => l.product_id === pid && (l.variant_id ?? null) === (vid ?? null));
      const q = same.reduce((t, l) => t + Number(l.quantity || 0), 0);
      return q > 0 ? same.reduce((t, l) => t + Number(l.subtotal || 0), 0) / q : null;
    };
    const parts = d.items ?? [];
    const items =
      parts.length > 0
        ? parts.map((i) => ({
            name: i.variant_label ? `${i.product_name} (${i.variant_label})` : i.product_name,
            qty: Number(i.qty),
            unitPrice: unitPrice(i.product_id, i.variant_id),
          }))
        : lines.map((l) => ({ name: l.product_name, qty: Number(l.quantity), unitPrice: unitPrice(l.product_id, l.variant_id) }));
    return {
      dispatchId: d.id,
      dispatchNumber: d.number,
      saleId: d.sale_id,
      saleNumber: d.sale?.number ?? null,
      storeId: d.store_id,
      shipAddress: d.ship_address,
      customerName: d.customer_name,
      customer: d.sale?.customer ?? null,
      items,
    };
  },

  /** ADR-149 (A12): dirección de ENTREGA cargada al cobrar (la del envío abierto de la venta). */
  async saleShipAddress(saleId: string): Promise<string | null> {
    const { data, error } = (await db()
      .from("dispatches")
      .select("ship_address, status")
      .eq("sale_id", saleId)
      .eq("delivery_type", "envio")
      .neq("status", "cancelado")
      .not("ship_address", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)) as Res;
    if (error) return null;
    const row = ((data ?? []) as { ship_address: string | null }[])[0];
    return row?.ship_address ?? null;
  },

  async saleByNumber(storeId: string | null, number: number) {
    let q = db()
      .from("sales")
      .select("id, number, store_id, total, status, created_at, customer:customers(name, email, phone, document_number, address)")
      .eq("number", number)
      .eq("status", "completed")
      .order("created_at", { ascending: false })
      .limit(1);
    if (storeId) q = q.eq("store_id", storeId);
    const { data, error } = (await q.maybeSingle()) as Res;
    if (error) throw new Error(error.message);
    return data as {
      id: string;
      number: number;
      store_id: string;
      total: number;
      customer: { name: string; email: string | null; phone: string | null; document_number: string | null; address: string | null } | null;
    } | null;
  },

  create: (payload: Record<string, unknown>) => rpc<Shipment & { replayed: boolean }>("shipment_create", { p: payload }),
  submit: (id: string, provider: string | null, quote: QuoteChoice | null) =>
    rpc<Shipment>("shipment_submit", { p_id: id, p_provider: provider, p_quote: quote }),
  cancel: (id: string, reason: string, local: boolean) =>
    rpc<Shipment & { cancel_mode: string }>("shipment_cancel", { p_id: id, p_reason: reason, p_local: local }),
  retry: (id: string, force: boolean) => rpc<Shipment>("shipment_retry", { p_id: id, p_force: force }),

  // Edge
  quote: (body: { store_id: string; destination: Record<string, unknown>; packages: unknown[]; declared_value: number; service_type?: string }) =>
    edge<{ quotes: QuoteChoice[]; errors: { provider_key: string; error: string }[] }>({ action: "quote", ...body }),
  points: (storeId: string, provider: string, postalCode: string) =>
    edge<{ points: PickupPointView[] }>({ action: "points", store_id: storeId, provider_key: provider, postal_code: postalCode }),
  process: (id: string) => edge<{ shipment: Shipment | null }>({ action: "process", shipment_id: id }),
  track: (id: string) => edge<{ shipment: Shipment | null }>({ action: "track", shipment_id: id }),
  label: (id: string, format?: "pdf" | "zpl") =>
    edge<{ format: "pdf" | "zpl"; url?: string; zpl?: string; tracking_number: string | null }>({ action: "label", shipment_id: id, format }),
  labelsBatch: (ids: string[], format: "pdf" | "zpl") =>
    edge<{ format: "pdf" | "zpl"; url?: string | null; zpl?: string; included: string[]; skipped: string[] }>({
      action: "labels_batch",
      shipment_ids: ids,
      format,
    }),
  testConnection: (body: { provider_key: string; store_id: string | null; sandbox: boolean; config: Record<string, string>; secrets: Record<string, string> }) =>
    edge<{ ok: boolean; detail?: string; error?: string }>({ action: "test_connection", ...body }),
  saveConnection: (body: {
    provider_key: string;
    store_id: string | null;
    enabled: boolean;
    sandbox: boolean;
    config: Record<string, string>;
    secrets: Record<string, string>;
  }) => edge<{ ok: boolean; connection: ShippingConnection }>({ action: "save_connection", ...body }),
  deleteConnection: (id: string) => edge<{ ok: boolean }>({ action: "delete_connection", connection_id: id }),
};
