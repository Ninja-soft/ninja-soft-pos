// =============================================================================
// _shared/deliveryChannels/simulator.ts (ADR-102)
//
// Adaptador SIMULADOR completo: hace de "plataforma" para probar de punta a
// punta en cualquier negocio sin credenciales de PedidosYa, Rappi ni Uber Eats.
//
//   * Webhook firmado como Rappi (`X-Ninja-Signature: t=..,sign=..`, HMAC-SHA256
//     sobre `<t>.<cuerpo>` con el secreto de la conexión).
//   * Cuerpo: { event_id, event, store_id, order_id, data } con event
//     ORDER_NEW | ORDER_STATUS | ORDER_CANCELLED | COURIER.
//   * Las llamadas salientes (aceptar, rechazar, listo, retirado) actualizan
//     el estado del pedido en la plataforma simulada (SimStore). Con
//     credentials.fail_actions = ["accept", ...] la plataforma "no responde"
//     para probar los reintentos.
//   * fetchRecentOrders lista lo que tiene la plataforma simulada: así la
//     reconciliación recupera un pedido cuyo webhook "se perdió".
// =============================================================================

import { buildSignatureHeader, verifySignatureHeader } from "./signature.ts";
import type {
  ChannelProvider,
  ConnectionContext,
  CourierInfo,
  DeliveryChannelAdapter,
  ExternalStatus,
  NormalizedEvent,
  NormalizedItem,
  NormalizedOrder,
  OutboundOrderRef,
  OutboundResult,
  ParsedWebhook,
  RecentOrder,
} from "./types.ts";

export const SIM_SIGNATURE_HEADER = "x-ninja-signature";
export const SIM_BRANDS: ChannelProvider[] = ["pedidosya", "rappi", "ubereats"];

type SimEvent = "ORDER_NEW" | "ORDER_STATUS" | "ORDER_CANCELLED" | "COURIER";

export interface SimWebhookBody {
  event_id: string;
  event: SimEvent;
  store_id: string;
  order_id: string;
  data: Record<string, unknown>;
}

const STATUSES: ExternalStatus[] = ["nuevo", "aceptado", "rechazado", "listo", "retirado", "entregado", "cancelado"];

const str = (v: unknown, max = 200): string | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Valida y normaliza un pedido del simulador (lo que viaja en data.order). */
export function parseSimOrder(payload: unknown): NormalizedOrder {
  if (!payload || typeof payload !== "object") throw new Error("invalid_order");
  const o = payload as Record<string, unknown>;
  const id = str(o.external_order_id, 120);
  if (!id) throw new Error("invalid_order: external_order_id");
  const rawItems = Array.isArray(o.items) ? o.items : [];
  const items: NormalizedItem[] = rawItems.slice(0, 100).map((it) => {
    const i = (it ?? {}) as Record<string, unknown>;
    const mods = Array.isArray(i.modifiers) ? i.modifiers : [];
    return {
      external_id: str(i.external_id, 120),
      name: str(i.name) ?? "Ítem",
      sku: str(i.sku, 80),
      quantity: Math.max(num(i.quantity) ?? 1, 0.001),
      unit_price: Math.max(num(i.unit_price) ?? 0, 0),
      notes: str(i.notes, 300),
      modifiers: mods.slice(0, 30).map((m) => {
        const x = (m ?? {}) as Record<string, unknown>;
        return {
          external_id: str(x.external_id, 120),
          name: str(x.name, 80) ?? "Extra",
          quantity: num(x.quantity) ?? 1,
          unit_price: num(x.unit_price) ?? 0,
        };
      }),
    };
  });
  if (items.length === 0) throw new Error("invalid_order: items");
  const brand = str(o.brand, 20);
  return {
    external_order_id: id,
    display_code: str(o.display_code, 40),
    brand: (SIM_BRANDS as string[]).includes(brand ?? "") ? (brand as ChannelProvider) : "simulador",
    order_type: o.order_type === "takeaway" ? "takeaway" : "delivery",
    logistics: o.logistics === "propia" ? "propia" : "plataforma",
    payment_mode: o.payment_mode === "efectivo" ? "efectivo" : "prepago",
    customer_name: str(o.customer_name, 120),
    customer_phone: str(o.customer_phone, 40),
    address: str(o.address, 300),
    address_reference: str(o.address_reference, 200),
    notes: str(o.notes, 500),
    placed_at: str(o.placed_at, 40),
    accept_deadline_at: str(o.accept_deadline_at, 40),
    promised_at: str(o.promised_at, 40),
    prep_minutes: num(o.prep_minutes),
    currency: "ARS",
    delivery_fee: Math.max(num(o.delivery_fee) ?? 0, 0),
    platform_discount: Math.max(num(o.platform_discount) ?? 0, 0),
    store_discount: Math.max(num(o.store_discount) ?? 0, 0),
    total: num(o.total) ?? undefined,
    items,
  };
}

/** Webhook del simulador -> eventos normalizados. */
export function parseSimWebhook(rawBody: string, ctx: Pick<ConnectionContext, "externalStoreId">): ParsedWebhook {
  const body = JSON.parse(rawBody) as Partial<SimWebhookBody>;
  const eventId = str(body.event_id, 200);
  const orderId = str(body.order_id, 120);
  if (!eventId || !orderId || !body.event) throw new Error("invalid_event");
  if (body.store_id !== ctx.externalStoreId) throw new Error("store_mismatch");
  const data = (body.data ?? {}) as Record<string, unknown>;
  const base = { external_event_id: eventId, external_order_id: orderId };
  let ev: NormalizedEvent;
  switch (body.event) {
    case "ORDER_NEW":
      ev = { ...base, type: "order.new", order: { ...parseSimOrder(data.order), external_order_id: orderId } };
      break;
    case "ORDER_STATUS": {
      const status = str(data.status, 20) as ExternalStatus | null;
      if (!status || !STATUSES.includes(status)) throw new Error("invalid_status");
      ev = { ...base, type: "order.status", status, prep_minutes: num(data.prep_minutes), reason: str(data.reason) };
      break;
    }
    case "ORDER_CANCELLED":
      ev = { ...base, type: "order.cancelled", reason: str(data.reason) };
      break;
    case "COURIER": {
      const c = (data.courier ?? {}) as Record<string, unknown>;
      const courier: CourierInfo = {
        name: str(c.name, 120),
        phone: str(c.phone, 40),
        status: str(c.status, 40),
        lat: num(c.lat),
        lng: num(c.lng),
        eta_minutes: num(c.eta_minutes),
        tracking_url: str(c.tracking_url, 500),
      };
      ev = { ...base, type: "courier.update", courier };
      break;
    }
    default:
      throw new Error("invalid_event");
  }
  return { events: [ev] };
}

// ── Generador de pedidos simulados ───────────────────────────────────────────

export interface SimProduct {
  product_id: string;
  name: string;
  sku: string | null;
  price: number;
  external_id: string;
}

export interface SimOrderOptions {
  brand: ChannelProvider;
  /** Suma un ítem que no está mapeado (prueba la revisión). */
  unmappedItem?: boolean;
  logistics?: "plataforma" | "propia";
  orderType?: "delivery" | "takeaway";
  /** Generador al azar inyectable (tests). */
  rng?: () => number;
  now?: number;
}

const NAMES = ["Lucía Fernández", "Martín Gómez", "Sofía Herrera", "Julián Pereyra", "Valentina Ruiz", "Tomás Acosta"];
const STREETS = ["Córdoba", "San Martín", "Pellegrini", "Oroño", "Mendoza", "Corrientes", "Rioja"];
const EXTRAS = ["Sin sal", "Extra queso", "Bien cocido", "Sin cebolla"];

const pick = <T,>(arr: T[], rng: () => number): T => arr[Math.floor(rng() * arr.length) % arr.length] as T;

export function simDisplayCode(rng: () => number = Math.random): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += chars[Math.floor(rng() * chars.length) % chars.length];
  return s;
}

/** Arma un pedido con productos reales del negocio (precio de la lista). */
export function buildSimulatedOrder(products: SimProduct[], opts: SimOrderOptions): NormalizedOrder {
  const rng = opts.rng ?? Math.random;
  const now = opts.now ?? Date.now();
  if (products.length === 0) throw new Error("sin_productos");
  const count = Math.min(products.length, 1 + Math.floor(rng() * 3));
  const pool = [...products];
  const items: NormalizedItem[] = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(rng() * pool.length) % pool.length;
    const p = pool.splice(idx, 1)[0]!;
    items.push({
      external_id: p.external_id,
      name: p.name,
      sku: p.sku,
      quantity: 1 + Math.floor(rng() * 2),
      unit_price: Math.round(Number(p.price) * 100) / 100,
      notes: null,
      modifiers: rng() < 0.4 ? [{ external_id: `SIM-MOD-${i + 1}`, name: pick(EXTRAS, rng), quantity: 1, unit_price: 0 }] : [],
    });
  }
  if (opts.unmappedItem) {
    items.push({ external_id: "SIM-NOMAP-1", name: "Promo de la app (sin mapear)", quantity: 1, unit_price: 1500, modifiers: [] });
  }
  const orderType = opts.orderType ?? "delivery";
  const logistics = opts.logistics ?? "plataforma";
  const code = simDisplayCode(rng);
  const fee = logistics === "propia" && orderType === "delivery" ? 900 : 0;
  const subtotal = items.reduce((a, it) => a + Math.round(it.quantity * it.unit_price * 100) / 100, 0);
  return {
    external_order_id: `${opts.brand.toUpperCase()}-${now.toString(36).toUpperCase()}-${code}`,
    display_code: code,
    brand: opts.brand,
    order_type: orderType,
    logistics,
    payment_mode: "prepago",
    customer_name: pick(NAMES, rng),
    customer_phone: `341${String(Math.floor(rng() * 9_000_000) + 1_000_000)}`,
    address: orderType === "delivery" ? `${pick(STREETS, rng)} ${100 + Math.floor(rng() * 3800)}` : null,
    address_reference: orderType === "delivery" && rng() < 0.5 ? `Piso ${1 + Math.floor(rng() * 9)}` : null,
    notes: rng() < 0.3 ? "Tocar timbre, no anda el portero" : null,
    placed_at: new Date(now).toISOString(),
    accept_deadline_at: new Date(now + 6 * 60_000).toISOString(),
    currency: "ARS",
    delivery_fee: fee,
    total: Math.round((subtotal + fee) * 100) / 100,
    items,
  };
}

// Centro de Rosario: el repartidor simulado se acerca en línea recta.
const ORIGIN = { lat: -32.9468, lng: -60.6393 };

/** Paso `step` (0..4) del recorrido simulado del repartidor. */
export function simulateCourier(step: number, rng: () => number = Math.random): CourierInfo {
  const s = Math.max(0, Math.min(4, Math.floor(step)));
  const left = (4 - s) / 4;
  const lat = Math.round((ORIGIN.lat + 0.02 * left) * 1e6) / 1e6;
  const lng = Math.round((ORIGIN.lng - 0.015 * left) * 1e6) / 1e6;
  return {
    name: pick(["Juan Repartidor", "Carla Moto", "Diego Bici"], rng),
    phone: "3415550000",
    status: s >= 4 ? "en_el_local" : "en_camino_al_local",
    lat,
    lng,
    eta_minutes: Math.round(12 * left),
    tracking_url: `https://www.google.com/maps?q=${lat},${lng}`,
  };
}

export function simEventId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function simWebhookBody(
  storeId: string,
  orderId: string,
  event: SimEvent,
  data: Record<string, unknown>,
  eventId: string = simEventId(event.toLowerCase()),
): SimWebhookBody {
  return { event_id: eventId, event, store_id: storeId, order_id: orderId, data };
}

export async function signSimBody(secret: string, rawBody: string, nowMs: number = Date.now()): Promise<string> {
  return buildSignatureHeader(secret, rawBody, Math.floor(nowMs / 1000));
}

// ── Adaptador ────────────────────────────────────────────────────────────────

function failing(ctx: ConnectionContext, action: string): OutboundResult | null {
  const fail = ctx.credentials?.fail_actions;
  if (Array.isArray(fail) && fail.includes(action)) {
    return { ok: false, retryable: true, error: "Simulador: la plataforma no respondió (falla simulada)" };
  }
  return null;
}

async function setPlatformStatus(
  ctx: ConnectionContext,
  action: string,
  order: OutboundOrderRef,
  status: ExternalStatus,
): Promise<OutboundResult> {
  const f = failing(ctx, action);
  if (f) return f;
  if (ctx.simStore) await ctx.simStore.put(order.external_order_id, null, status, true);
  return { ok: true, retryable: false, response: { simulated: true, status } };
}

export const simulatorAdapter: DeliveryChannelAdapter = {
  provider: "simulador",
  ready: true,
  async verifySignature(req, ctx) {
    return verifySignatureHeader(
      req.headers.get(SIM_SIGNATURE_HEADER),
      ctx.webhookSecret,
      req.rawBody,
      ctx.now ? ctx.now() : Date.now(),
    );
  },
  parseEvent(rawBody, ctx) {
    return parseSimWebhook(rawBody, ctx);
  },
  parseOrder(payload) {
    return parseSimOrder(payload);
  },
  accept(order, _prep, ctx) {
    return setPlatformStatus(ctx, "accept", order, "aceptado");
  },
  reject(order, _reason, ctx) {
    return setPlatformStatus(ctx, "reject", order, "rechazado");
  },
  markReady(order, ctx) {
    return setPlatformStatus(ctx, "mark_ready", order, "listo");
  },
  markPickedUp(order, ctx) {
    return setPlatformStatus(ctx, "mark_picked_up", order, "retirado");
  },
  async fetchRecentOrders(since, ctx): Promise<RecentOrder[]> {
    if (!ctx.simStore) return [];
    const rows = await ctx.simStore.recent(since);
    const out: RecentOrder[] = [];
    for (const r of rows) {
      try {
        const order = parseSimOrder({ ...r.payload, external_order_id: r.external_order_id });
        const status = STATUSES.includes(r.platform_status as ExternalStatus)
          ? (r.platform_status as ExternalStatus)
          : undefined;
        out.push({ order, status });
      } catch {
        // Pedido de la plataforma simulada sin datos (sólo estado): se saltea.
      }
    }
    return out;
  },
};
