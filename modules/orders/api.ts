"use client";

// Pedidos de salón y expedición (F11 · H32, ADR-129). Lectura por tabla con
// RLS (columnas explícitas: el hash del código de retiro no se lee); toda
// escritura por RPC SECURITY DEFINER (plan, rol, sucursal, reserva y
// auditoría en el servidor). Las tablas y RPC nuevas no están en los tipos
// generados: se castean.

import { createClient } from "@/lib/supabase/client";
import type { CheckoutSnapshot } from "@/components/pos/checkout/types";
import type { PausedCart } from "@/modules/paused-sales/logic";
import type {
  DeliveryType,
  DispatchStatus,
  OrderItemInput,
  OrderStatus,
} from "@/lib/orders/logic";

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().rpc(fn as never, args as never);
  if (error) throw error;
  return data as T;
}

export interface SaleOrder {
  id: string;
  number: number;
  store_id: string;
  fulfillment_store_id: string;
  delivery_type: DeliveryType;
  status: OrderStatus;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  pickup_name: string | null;
  ship_address: string | null;
  notes: string | null;
  seller_user_id: string | null;
  seller_professional_id: string | null;
  seller_name: string | null;
  cart: PausedCart;
  checkout: CheckoutSnapshot | null;
  total: number;
  item_count: number;
  reservation_id: string | null;
  reserved_until: string | null;
  reservation_released_at: string | null;
  taken_by: string | null;
  taken_at: string | null;
  sale_id: string | null;
  paid_at: string | null;
  cashier_user_id: string | null;
  cancel_reason: string | null;
  created_at: string;
  /** ADR-130: origen (sin la migración no viene: se toma 'pos'). */
  source?: "pos" | "catalogo_publico";
  customer_email?: string | null;
  payment_preference?: "al_retirar" | "link" | null;
  /** Sólo en la respuesta de sale_order_take. */
  reservation_active?: boolean;
  has_pickup_code?: boolean;
}

const ORDER_COLS =
  "id, number, store_id, fulfillment_store_id, delivery_type, status, customer_id, customer_name, customer_phone, " +
  "pickup_name, ship_address, notes, seller_user_id, seller_professional_id, seller_name, cart, checkout, total, " +
  "item_count, reservation_id, reserved_until, reservation_released_at, taken_by, taken_at, sale_id, paid_at, " +
  "cashier_user_id, cancel_reason, created_at";
// ADR-130: columnas del pedido del catálogo. Sin la migración aplicada la
// lectura reintenta sin ellas (ver selectOrders).
const ORDER_COLS_CATALOG = `${ORDER_COLS}, source, customer_email, payment_preference`;
const MISSING_CATALOG_COLS = /source|customer_email|payment_preference/;

export interface DispatchItem {
  product_name: string;
  quantity: number;
  returned_qty: number | null;
  unit_label: string | null;
}

export interface Dispatch {
  id: string;
  number: number;
  sale_id: string;
  sale_order_id: string | null;
  store_id: string;
  fulfillment_store_id: string;
  delivery_type: DeliveryType;
  status: DispatchStatus;
  customer_name: string | null;
  pickup_name: string | null;
  has_pickup_code: boolean;
  failed_attempts: number;
  ship_address: string | null;
  shipment_id: string | null;
  tracking: string | null;
  notes: string | null;
  prepared_at: string | null;
  ready_at: string | null;
  sent_at: string | null;
  arrived_at: string | null;
  delivered_at: string | null;
  delivered_to: string | null;
  cancel_reason: string | null;
  created_at: string;
  sale: { number: number; total: number; items: DispatchItem[] } | null;
  /** ADR-136: entrega N de M de la venta y sucursal que vendió. */
  part?: number;
  parts_total?: number;
  sale_store_id?: string | null;
  /** ADR-136: renglones de esta entrega (venta partida); sin ellos, toda la venta. */
  items?: DispatchPartItem[];
  /** ADR-149 (A6): cuándo se despachó y el último estado del envío con logística. */
  shipped_at?: string | null;
  shipment_status?: string | null;
}

export interface DispatchPartItem {
  product_id?: string;
  variant_id?: string | null;
  product_name: string;
  variant_label: string | null;
  qty: number;
  unit: string;
  source_store_id: string;
  source_warehouse_id: string | null;
}

const DISPATCH_COLS =
  "id, number, sale_id, sale_order_id, store_id, fulfillment_store_id, delivery_type, status, customer_name, " +
  "pickup_name, has_pickup_code, failed_attempts, ship_address, shipment_id, tracking, notes, prepared_at, ready_at, sent_at, " +
  "arrived_at, delivered_at, delivered_to, cancel_reason, created_at, " +
  "sale:sales(number, total, items:sale_items(product_name, quantity, returned_qty, unit_label))";
// ADR-136: partes y renglones por entrega. Sin la migración, se reintenta sin ellos.
const DISPATCH_COLS_PARTS = `${DISPATCH_COLS}, part, parts_total, sale_store_id, items:dispatch_items(product_id, variant_id, product_name, variant_label, qty, unit, source_store_id, source_warehouse_id)`;
const MISSING_PART_COLS = /part|sale_store_id|dispatch_items|relationship/;
// ADR-149 (L0): despacho y estado del envío. Sin la migración, se reintenta sin ellos.
const DISPATCH_COLS_L0 = `${DISPATCH_COLS_PARTS}, shipped_at, shipment_status`;
const MISSING_L0_COLS = /shipped_at|shipment_status/;

/** Lo que falta entregar de una venta (dispatch_sale_pending, ADR-149). */
export interface SalePending {
  sale_id: string;
  number: number;
  status: string;
  store_id: string;
  items: { product_id: string; variant_id: string | null; name: string; sold: number; in_dispatches: number; returned: number; pending: number }[];
}

/** Entrega de una venta, para el detalle de la venta (ADR-149, R18). */
export interface SaleDelivery {
  id: string;
  number: number;
  part: number;
  parts_total: number;
  delivery_type: DeliveryType;
  status: DispatchStatus;
  ship_address: string | null;
  pickup_name: string | null;
  tracking: string | null;
  delivered_at: string | null;
  created_at: string;
  remito: { id: string; label: string } | null;
}

export interface CreateOrderInput {
  id: string;
  storeId: string;
  cart: PausedCart;
  checkout: CheckoutSnapshot | null;
  items: OrderItemInput[];
  total: number;
  itemCount: number;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  deliveryType: DeliveryType;
  fulfillmentStoreId: string | null;
  pickupName: string | null;
  shipAddress: string | null;
  notes: string | null;
  sellerProfessionalId: string | null;
}

export interface CreateOrderResult {
  id: string;
  number: number;
  reservation_id: string | null;
  reserved_until: string | null;
  pickup_code: string | null;
}

export interface DeliverResult {
  ok: boolean;
  error?: string;
  attempts_left?: number;
}

export const ordersApi = {
  list: async (opts: { storeId: string | null; open: boolean }): Promise<SaleOrder[]> => {
    const run = (cols: string) => {
      let q = createClient()
        .from("sale_orders" as never)
        .select(cols)
        .is("deleted_at", null)
        .order("created_at", { ascending: opts.open })
        .limit(opts.open ? 200 : 100);
      if (opts.storeId) q = q.eq("store_id", opts.storeId);
      return opts.open ? q.in("status", ["abierto", "tomado"]) : q.in("status", ["cobrado", "anulado", "vencido"]);
    };
    let { data, error } = await run(ORDER_COLS_CATALOG);
    if (error && MISSING_CATALOG_COLS.test(error.message)) ({ data, error } = await run(ORDER_COLS));
    if (error) throw error;
    return (data ?? []) as unknown as SaleOrder[];
  },

  get: async (id: string): Promise<SaleOrder | null> => {
    const run = (cols: string) => createClient().from("sale_orders" as never).select(cols).eq("id", id).maybeSingle();
    let { data, error } = await run(ORDER_COLS_CATALOG);
    if (error && MISSING_CATALOG_COLS.test(error.message)) ({ data, error } = await run(ORDER_COLS));
    if (error) throw error;
    return (data as unknown as SaleOrder) ?? null;
  },

  create: (i: CreateOrderInput) =>
    rpc<CreateOrderResult>("sale_order_create", {
      p_id: i.id,
      p_store_id: i.storeId,
      p_order: {
        cart: i.cart,
        checkout: i.checkout,
        items: i.items,
        total: Math.round(i.total * 100) / 100,
        item_count: i.itemCount,
        customer_id: i.customerId,
        customer_name: i.customerName,
        customer_phone: i.customerPhone,
        delivery_type: i.deliveryType,
        fulfillment_store_id: i.fulfillmentStoreId,
        pickup_name: i.pickupName,
        ship_address: i.shipAddress,
        notes: i.notes,
        seller_professional_id: i.sellerProfessionalId,
      },
    }),

  take: (id: string) => rpc<SaleOrder>("sale_order_take", { p_id: id }),
  leave: (id: string) => rpc<void>("sale_order_leave", { p_id: id }),
  cancel: (id: string, reason: string) => rpc<void>("sale_order_cancel", { p_id: id, p_reason: reason }),
  complete: (id: string, saleId: string) =>
    rpc<{ ok: boolean; already?: boolean }>("sale_order_complete", { p_id: id, p_sale_id: saleId }),

  dispatches: async (opts: { storeId: string | null; open: boolean }): Promise<Dispatch[]> => {
    const run = (cols: string, parts: boolean) => {
      let q = createClient()
        .from("dispatches" as never)
        .select(cols)
        .is("deleted_at", null)
        .order("created_at", { ascending: opts.open })
        .limit(opts.open ? 200 : 100);
      if (opts.storeId) {
        q = q.or(
          parts
            ? `store_id.eq.${opts.storeId},fulfillment_store_id.eq.${opts.storeId},sale_store_id.eq.${opts.storeId}`
            : `store_id.eq.${opts.storeId},fulfillment_store_id.eq.${opts.storeId}`,
        );
      }
      // ADR-149 (A6): lo despachado sigue abierto (En camino) hasta que se entrega.
      return opts.open
        ? q.in("status", ["pendiente", "armando", "listo", "en_transito", "despachado"])
        : q.in("status", ["entregado", "cancelado"]);
    };
    let { data, error } = await run(DISPATCH_COLS_L0, true);
    if (error && MISSING_L0_COLS.test(error.message)) ({ data, error } = await run(DISPATCH_COLS_PARTS, true));
    if (error && MISSING_PART_COLS.test(error.message)) ({ data, error } = await run(DISPATCH_COLS, false));
    if (error) throw error;
    return ((data ?? []) as unknown as Dispatch[]).map((d) => ({
      ...d,
      items: (d.items ?? []).map((i) => ({ ...i, qty: Number(i.qty) })),
    }));
  },

  dispatchAdvance: (id: string, to: "pendiente" | "armando" | "listo" | "en_transito") =>
    rpc<void>("dispatch_advance", { p_id: id, p_to: to }),
  dispatchDeliver: (id: string, code: string | null, deliveredTo: string | null, overrideReason: string | null) =>
    rpc<DeliverResult>("dispatch_deliver", {
      p_id: id,
      p_code: code,
      p_delivered_to: deliveredTo,
      p_override_reason: overrideReason,
    }),
  // ADR-149 (A5): con el envío de ESTA entrega; sin él, el servidor no adivina.
  dispatchShip: (id: string, tracking: string | null, shipmentId: string | null = null) =>
    rpc<void>("dispatch_ship", { p_id: id, p_tracking: tracking, p_shipment_id: shipmentId }),
  dispatchCancel: (id: string, reason: string) => rpc<void>("dispatch_cancel", { p_id: id, p_reason: reason }),
  saleIdByNumber: async (saleNumber: number): Promise<string> => {
    const { data, error } = await createClient()
      .from("sales")
      .select("id")
      .eq("number", saleNumber)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("sale_not_found");
    return (data as { id: string }).id;
  },
  /** ADR-149 (A1): lo que falta entregar de la venta. */
  salePending: (saleId: string) => rpc<SalePending>("dispatch_sale_pending", { p_sale_id: saleId }),
  dispatchForSale: async (
    saleNumber: number,
    delivery: {
      delivery_type: DeliveryType;
      fulfillment_store_id: string | null;
      pickup_name: string | null;
      ship_address: string | null;
      /** ADR-149 (A1): qué productos y cuántos; sin esto, todo lo pendiente. */
      items?: { product_id: string; variant_id: string | null; qty: number }[];
    },
  ) => {
    const saleId = await ordersApi.saleIdByNumber(saleNumber);
    return rpc<{ id: string; number: number; part?: number; pickup_code: string | null }>("dispatch_create_for_sale", {
      p_sale_id: saleId,
      p_delivery: delivery,
    });
  },

  /** ADR-149 (R18): entregas de una venta y sus remitos, para el detalle de la venta. */
  saleDeliveries: async (saleId: string): Promise<SaleDelivery[]> => {
    const db = createClient();
    const [d, r] = await Promise.all([
      db
        .from("dispatches" as never)
        .select("id, number, part, parts_total, delivery_type, status, ship_address, pickup_name, tracking, delivered_at, created_at")
        .eq("sale_id", saleId)
        .is("deleted_at", null)
        .order("part"),
      db
        .from("remitos" as never)
        .select("id, dispatch_id, pto_vta, number, status")
        .eq("sale_id", saleId)
        .is("deleted_at", null),
    ]);
    if (d.error) {
      if (/dispatches|does not exist|schema cache|part/i.test(d.error.message)) return [];
      throw d.error;
    }
    const remitos = r.error ? [] : ((r.data ?? []) as unknown as { id: string; dispatch_id: string | null; pto_vta: number; number: number; status: string }[]);
    return ((d.data ?? []) as unknown as Omit<SaleDelivery, "remito">[]).map((x) => {
      const rm = remitos.find((m) => m.dispatch_id === x.id && m.status === "emitido");
      return { ...x, remito: rm ? { id: rm.id, label: `${String(rm.pto_vta).padStart(4, "0")}-${String(rm.number).padStart(8, "0")}` } : null };
    });
  },

  /** Reservado vigente por sucursal (para el disponible del POS). */
  reservedByStore: (storeId: string | null) =>
    rpc<{ store_id: string; product_id: string; variant_id: string | null; reserved: number }[]>(
      "stock_reserved_by_store",
      { p_store_id: storeId },
    ),

  /** Config cruda (pos_settings.order_config); se normaliza con orderConfig(). */
  rawConfig: async (): Promise<unknown> => {
    const { data, error } = await createClient()
      .from("pos_settings")
      .select("order_config" as never)
      .maybeSingle();
    if (error) {
      // Sin la migración aplicada la columna no existe: defaults.
      if (/order_config/.test(error.message)) return null;
      throw error;
    }
    return (data as { order_config?: unknown } | null)?.order_config ?? null;
  },
};
