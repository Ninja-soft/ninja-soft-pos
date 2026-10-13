// =============================================================================
// _shared/deliveryChannels/worker.ts (ADR-102)
//
// Piezas puras del worker de canales: ejecutar una llamada saliente con el
// adaptador (clasificando el error como reintentable o no) y convertir los
// pedidos recientes de la plataforma en eventos idempotentes para la ingesta.
// =============================================================================

import { NotImplementedError } from "./types.ts";
import type {
  ChannelProvider,
  ConnectionContext,
  DeliveryChannelAdapter,
  NormalizedEvent,
  OutboundResult,
  RecentOrder,
} from "./types.ts";

export interface OutboxRow {
  id: string;
  tenant_id: string;
  connection_id: string;
  provider: ChannelProvider;
  external_store_id: string;
  action: "accept" | "reject" | "mark_ready" | "mark_picked_up" | "sync_menu" | "toggle_store";
  payload: Record<string, unknown> | null;
  attempts: number;
  channel_order_id: string | null;
  external_order_id: string | null;
  brand: string | null;
}

export interface WebhookContextRow {
  connection_id: string;
  tenant_id: string;
  store_id: string;
  provider: ChannelProvider;
  status: string;
  flow: string;
  external_store_id: string;
  has_feature: boolean;
  webhook_secret: string | null;
  credentials: Record<string, unknown> | null;
}

export function contextFromRow(row: WebhookContextRow, extra: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: row.connection_id,
    tenantId: row.tenant_id,
    provider: row.provider,
    externalStoreId: row.external_store_id,
    webhookSecret: row.webhook_secret ?? "",
    credentials: row.credentials ?? {},
    ...extra,
  };
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 400);

/** Ejecuta la acción de la cola. Nunca lanza: el resultado dice si reintentar. */
export async function runOutboxAction(
  adapter: DeliveryChannelAdapter,
  row: OutboxRow,
  ctx: ConnectionContext,
): Promise<OutboundResult> {
  const ref = { external_order_id: row.external_order_id ?? "", brand: row.brand };
  const payload = row.payload ?? {};
  try {
    switch (row.action) {
      case "accept": {
        const prep = Math.min(Math.max(Math.round(Number(payload.prep_minutes) || 20), 1), 180);
        return await adapter.accept(ref, prep, ctx);
      }
      case "reject":
        return await adapter.reject(ref, String(payload.reason ?? "Rechazado por el local"), ctx);
      case "mark_ready":
        return await adapter.markReady(ref, ctx);
      case "mark_picked_up":
        return await adapter.markPickedUp(ref, ctx);
      case "sync_menu":
        return adapter.syncMenu
          ? await adapter.syncMenu([], ctx)
          : { ok: false, retryable: false, error: "El canal no sincroniza el menú" };
      case "toggle_store":
        return adapter.toggleStore
          ? await adapter.toggleStore(Boolean(payload.open), Number(payload.minutes) || null, ctx)
          : { ok: false, retryable: false, error: "El canal no permite pausar el local" };
      default:
        return { ok: false, retryable: false, error: "Acción desconocida" };
    }
  } catch (e) {
    if (e instanceof NotImplementedError) return { ok: false, retryable: false, error: e.message };
    // Red caída, timeout o 5xx: se reintenta con backoff.
    return { ok: false, retryable: true, error: errMsg(e) };
  }
}

/**
 * Pedidos recientes de la plataforma -> eventos para la ingesta. Los ids son
 * estables (recon:<pedido>), así que correr la reconciliación dos veces no
 * duplica nada; y si el webhook ya había llegado, el pedido existe y la
 * ingesta lo reconoce por (conexión, id externo del pedido).
 */
export function reconcileEvents(recent: RecentOrder[]): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (const r of recent) {
    const id = r.order.external_order_id;
    out.push({ type: "order.new", external_event_id: `recon:${id}`, external_order_id: id, order: r.order });
    if (r.status === "cancelado") {
      out.push({
        type: "order.cancelled",
        external_event_id: `recon-cancel:${id}`,
        external_order_id: id,
        reason: "Cancelado en la plataforma",
      });
    } else if (r.status === "listo" || r.status === "retirado" || r.status === "entregado") {
      out.push({ type: "order.status", external_event_id: `recon-${r.status}:${id}`, external_order_id: id, status: r.status });
    }
  }
  return out;
}
