// =============================================================================
// _shared/deliveryChannels/types.ts (F13 · H49 integraciones, ADR-102)
//
// Contrato común de los canales de delivery externos. Cada plataforma
// (PedidosYa, Rappi, Uber Eats, Mercado Pago Delivery) y el simulador
// implementan DeliveryChannelAdapter; el resto del sistema sólo conoce los
// tipos normalizados de acá:
//
//   webhook -> verifySignature -> parseEvent -> NormalizedEvent[]
//           -> RPC delivery_channel_ingest_event (idempotente)
//   cola saliente -> accept / reject / markReady / markPickedUp
//   reconciliación -> fetchRecentOrders -> order.new idempotente
//
// Puro (sin Deno.*): lo usan las Edge y los tests de Vitest.
// =============================================================================

export type ChannelProvider = "pedidosya" | "rappi" | "ubereats" | "mp_delivery" | "simulador";

export const CHANNEL_PROVIDERS: ChannelProvider[] = ["pedidosya", "rappi", "ubereats", "mp_delivery", "simulador"];

/** Estado del pedido del lado de la plataforma, normalizado. */
export type ExternalStatus = "nuevo" | "aceptado" | "rechazado" | "listo" | "retirado" | "entregado" | "cancelado";

export interface NormalizedModifier {
  external_id?: string | null;
  name: string;
  quantity?: number;
  unit_price?: number;
}

export interface NormalizedItem {
  external_id: string | null;
  name: string;
  sku?: string | null;
  quantity: number;
  /** Precio unitario que cobró la plataforma (con sus modificadores). */
  unit_price: number;
  notes?: string | null;
  modifiers?: NormalizedModifier[];
}

export interface NormalizedOrder {
  external_order_id: string;
  /** Código corto que ve el repartidor ("A1B2"). */
  display_code?: string | null;
  /** Marca que ve el local (el simulador imita a las otras). */
  brand?: ChannelProvider;
  order_type: "delivery" | "takeaway";
  /** plataforma: reparte la app; propia: reparte el local. */
  logistics: "plataforma" | "propia";
  /** prepago: lo cobró la app; efectivo: lo cobra el repartidor del local. */
  payment_mode: "prepago" | "efectivo";
  customer_name?: string | null;
  customer_phone?: string | null;
  address?: string | null;
  address_reference?: string | null;
  notes?: string | null;
  placed_at?: string | null;
  accept_deadline_at?: string | null;
  promised_at?: string | null;
  prep_minutes?: number | null;
  currency?: string;
  delivery_fee?: number;
  platform_discount?: number;
  store_discount?: number;
  total?: number;
  items: NormalizedItem[];
}

export interface CourierInfo {
  name?: string | null;
  phone?: string | null;
  status?: string | null;
  lat?: number | null;
  lng?: number | null;
  eta_minutes?: number | null;
  eta_at?: string | null;
  tracking_url?: string | null;
}

interface EventBase {
  /** Id único del evento en la plataforma: clave de idempotencia. */
  external_event_id: string;
  external_order_id: string;
}

export type NormalizedEvent =
  | (EventBase & { type: "order.new"; order: NormalizedOrder })
  | (EventBase & { type: "order.status"; status: ExternalStatus; prep_minutes?: number | null; reason?: string | null })
  | (EventBase & { type: "order.cancelled"; reason?: string | null })
  | (EventBase & { type: "courier.update"; courier: CourierInfo });

export interface ParsedWebhook {
  events: NormalizedEvent[];
  /** Respuesta propia del protocolo (p. ej. el PING de Rappi) en vez de "ok". */
  reply?: { status: number; body: unknown };
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Pedidos de la "plataforma" del simulador (en producción, la tabla delivery_channel_sim_orders). */
export interface SimStore {
  put(externalOrderId: string, payload: NormalizedOrder | null, status: ExternalStatus, webhookSent: boolean): Promise<void>;
  recent(since: Date): Promise<{ external_order_id: string; payload: NormalizedOrder; platform_status: string; webhook_sent: boolean }[]>;
}

export interface ConnectionContext {
  connectionId: string;
  tenantId: string;
  provider: ChannelProvider;
  externalStoreId: string;
  webhookSecret: string;
  credentials: Record<string, unknown>;
  fetch?: FetchLike;
  simStore?: SimStore;
  /** Reloj inyectable (ms) para tests. */
  now?: () => number;
}

export interface OutboundOrderRef {
  external_order_id: string;
  brand?: string | null;
}

export interface OutboundResult {
  ok: boolean;
  /** false = error del negocio (no tiene sentido reintentar). */
  retryable: boolean;
  error?: string;
  response?: unknown;
}

export interface WebhookRequest {
  headers: Headers;
  rawBody: string;
  ip?: string;
}

export interface DeliveryChannelAdapter {
  provider: ChannelProvider;
  /** true si el adaptador está homologado para producción. */
  ready: boolean;
  verifySignature(req: WebhookRequest, ctx: ConnectionContext): Promise<boolean>;
  parseEvent(rawBody: string, ctx: ConnectionContext): ParsedWebhook;
  parseOrder(payload: unknown, ctx: ConnectionContext): NormalizedOrder;
  accept(order: OutboundOrderRef, prepMinutes: number, ctx: ConnectionContext): Promise<OutboundResult>;
  reject(order: OutboundOrderRef, reason: string, ctx: ConnectionContext): Promise<OutboundResult>;
  markReady(order: OutboundOrderRef, ctx: ConnectionContext): Promise<OutboundResult>;
  markPickedUp(order: OutboundOrderRef, ctx: ConnectionContext): Promise<OutboundResult>;
  fetchRecentOrders(since: Date, ctx: ConnectionContext): Promise<RecentOrder[]>;
  syncMenu?(items: MenuItem[], ctx: ConnectionContext): Promise<OutboundResult>;
  toggleStore?(open: boolean, minutes: number | null, ctx: ConnectionContext): Promise<OutboundResult>;
}

/** Pedido que devuelve la consulta de pedidos recientes (reconciliación). */
export interface RecentOrder {
  order: NormalizedOrder;
  /** Estado actual en la plataforma (si lo informa). */
  status?: ExternalStatus;
}

export interface MenuItem {
  external_id: string;
  name: string;
  price: number;
  available: boolean;
}

/** Error de un adaptador que todavía no está implementado (A CONFIRMAR con la plataforma). */
export class NotImplementedError extends Error {
  constructor(readonly provider: ChannelProvider, readonly operation: string) {
    super(`${provider}: ${operation} sin implementar (A CONFIRMAR con la plataforma)`);
    this.name = "NotImplementedError";
  }
}

export function notImplemented(provider: ChannelProvider, operation: string): OutboundResult {
  return { ok: false, retryable: false, error: new NotImplementedError(provider, operation).message };
}
