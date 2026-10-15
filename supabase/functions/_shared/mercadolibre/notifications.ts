// =============================================================================
// _shared/mercadolibre/notifications.ts (H87 · ADR-104). PURO.
//
// Parseo y validación de las notificaciones de ML (doc "Notificaciones",
// 14/09/2026). ML NO firma las notificaciones: la defensa es
//   1. application_id igual al APP_ID de NinjaSoft;
//   2. user_id de una cuenta conectada (lo resuelve ml_notification_ingest);
//   3. `resource` que coincide con el patrón del tópico;
//   4. el estado real se lee SIEMPRE con un GET autenticado del recurso con el
//      token de ese vendedor: un payload falso no puede escribir nada.
// El webhook guarda la notificación cruda (idempotente por `_id`) y responde
// 200 enseguida; el worker la procesa después.
// =============================================================================
import type { MlNotification } from "./types.ts";

const ITEM = "[A-Z]{3}\\d{4,16}";

/** Patrón del `resource` por tópico. Un tópico fuera de esta lista se ignora. */
export const RESOURCE_PATTERNS: Record<string, RegExp> = {
  orders_v2: /^\/orders\/\d{5,22}$/,
  orders: /^\/orders\/\d{5,22}$/,
  orders_feedback: /^\/orders\/\d{5,22}\/feedback/,
  items: new RegExp(`^/items/${ITEM}$`),
  items_prices: new RegExp(`^/items/${ITEM}(/prices)?$`),
  questions: /^\/questions\/\d{3,22}$/,
  shipments: /^\/shipments\/\d{5,22}$/,
  messages: /^\/messages\/[A-Za-z0-9-]{4,64}$/,
  payments: /^\/collections\/\d{3,22}$/,
  user_products: /^\/user-products\/[A-Z]{3}U?\d{3,22}$/,
  user_products_families: /^\/sites\/[A-Z]{3}\/user-products-families\/\d{1,22}$/,
  "stock-location": /^\/user-products\/[A-Z]{3}U?\d{3,22}\/stock$/,
  fbm_stock_operations: /^\/stock\/fulfillment\/operations\/\d{1,22}$/,
  "flex-handshakes": /^\/flex\/sites\/[A-Z]{3}\/shipments\/\d{5,22}\/assignment\/v\d$/,
  post_purchase: /^\/post-purchase\/v\d\/claims\/\d{3,22}/,
  // Gestor (ADR-132): reclamos y sus acciones.
  claims: /^\/post-purchase\/v\d\/claims\/\d{3,22}/,
  claims_actions: /^\/post-purchase\/v\d\/claims\/\d{3,22}/,
  invoices: /^\/users\/\d{3,22}\/invoices\/[A-Za-z0-9-]{1,64}$/,
  public_offers: /^\/seller-promotions\/offers\/[A-Za-z0-9-]{1,64}$/,
  public_candidates: /^\/seller-promotions\/candidates\/[A-Za-z0-9-]{1,64}$/,
  catalog_item_competition_status: new RegExp(`^/items/${ITEM}/price_to_win`),
  price_suggestion: new RegExp(`^/suggestions/items/${ITEM}/details$`),
};

/** Tópicos que el MVP procesa; el resto se guarda como `ignored` (v2/v3). */
export const MVP_TOPICS = ["orders_v2", "orders", "items", "items_prices", "questions", "shipments"] as const;
export type MvpTopic = (typeof MVP_TOPICS)[number];

export const isMvpTopic = (t: string): t is MvpTopic => (MVP_TOPICS as readonly string[]).includes(t);

/** Tópicos del gestor (ADR-132): reclamos. Se procesan si el negocio tiene la feature. */
export const GESTOR_TOPICS = ["claims", "claims_actions", "post_purchase"] as const;
export const isGestorTopic = (t: string) => (GESTOR_TOPICS as readonly string[]).includes(t);

/** ¿El worker procesa este tópico? (el resto se guarda como `ignored`). */
export const isHandledTopic = (t: string) => isMvpTopic(t) || isGestorTopic(t);

export interface ParsedNotification {
  dedupeKey: string;
  notificationId: string | null;
  topic: string;
  resource: string;
  userId: string;
  applicationId: string;
  attempts: number;
  sent: string | null;
  received: string | null;
  actions: string[];
}

export type ParseResult =
  | { ok: true; n: ParsedNotification }
  | { ok: false; reason: "invalid_payload" | "wrong_application" | "invalid_resource" | "unknown_topic" };

const digits = (v: unknown): string | null => {
  const s = typeof v === "number" ? String(Math.trunc(v)) : typeof v === "string" ? v.trim() : "";
  return /^\d{1,22}$/.test(s) ? s : null;
};
const iso = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/**
 * Valida el payload. `appId` = APP_ID de NinjaSoft (null: app sin configurar,
 * se rechaza todo).
 */
export function parseNotification(raw: unknown, appId: string | null): ParseResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "invalid_payload" };
  const b = raw as Partial<MlNotification> & Record<string, unknown>;
  const topic = typeof b.topic === "string" ? b.topic.trim() : "";
  const resource = typeof b.resource === "string" ? b.resource.trim() : "";
  const userId = digits(b.user_id);
  const applicationId = digits(b.application_id);
  if (!topic || !resource || !userId || !applicationId || topic.length > 60 || resource.length > 300) {
    return { ok: false, reason: "invalid_payload" };
  }
  if (!appId || applicationId !== appId) return { ok: false, reason: "wrong_application" };
  const pattern = RESOURCE_PATTERNS[topic];
  if (!pattern) return { ok: false, reason: "unknown_topic" };
  if (!pattern.test(resource)) return { ok: false, reason: "invalid_resource" };
  const id = typeof b._id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(b._id) ? b._id : null;
  const sent = iso(b.sent);
  const attempts = Number.isFinite(Number(b.attempts)) ? Math.max(0, Math.min(1000, Math.trunc(Number(b.attempts)))) : 0;
  const actions = Array.isArray(b.actions) ? b.actions.filter((a): a is string => typeof a === "string").slice(0, 10) : [];
  return {
    ok: true,
    n: {
      dedupeKey: id ?? `${topic}|${resource}|${sent ?? ""}`,
      notificationId: id,
      topic,
      resource,
      userId,
      applicationId,
      attempts,
      sent,
      received: iso(b.received),
      actions,
    },
  };
}

/** Id del recurso (lo que va en el GET). */
export function resourceId(resource: string): string {
  const claim = /^\/post-purchase\/v\d\/claims\/(\d{3,22})/.exec(resource);
  if (claim) return claim[1]!;
  const parts = resource.split("/").filter(Boolean);
  if (parts[0] === "items" || parts[0] === "orders" || parts[0] === "questions" || parts[0] === "shipments") return parts[1] ?? "";
  return parts[parts.length - 1] ?? "";
}

/** Notificación sintética (reconciliación por búsqueda de órdenes). */
export function syntheticOrderNotification(orderId: string | number, userId: string | number, lastUpdated: string | null) {
  const sent = lastUpdated && Number.isFinite(Date.parse(lastUpdated)) ? new Date(Date.parse(lastUpdated)).toISOString() : null;
  return {
    dedupe_key: `poll|orders_v2|/orders/${orderId}|${sent ?? ""}`,
    notification_id: null,
    topic: "orders_v2",
    resource: `/orders/${orderId}`,
    user_id: String(userId),
    application_id: null,
    attempts: 0,
    sent,
    received: null,
    actions: [] as string[],
  };
}
