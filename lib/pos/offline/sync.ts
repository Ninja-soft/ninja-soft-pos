// Sincronización de la cola offline (ADR-077). Recorre las ventas pendientes
// en orden y llama a la RPC sync_offline_sale (idempotente por
// client_sale_id). Una venta sale de la cola SÓLO cuando el servidor la
// tiene: registrada o en "requiere revisión". Sin red se corta y se reintenta
// después; con un rechazo duro queda retenida en el dispositivo.

import { OfflineQueue, verifyEntry, type OfflineQueueEntry, type OfflineScope } from "./queue";

export type OfflineServerStatus = "processing" | "synced" | "needs_review" | "resolved" | "discarded";

export interface OfflineConflict {
  kind: "price_changed" | "negative_stock" | "negative_stock_branch" | "promo_changed" | string;
  product_id?: string | null;
  variant_id?: string | null;
  expected?: number;
  received?: number;
  quantity?: number;
  /** promo_changed: promo que mandó el POS y descuento que se cobró. */
  promo_id?: string | null;
  promo_name?: string | null;
  charged?: number;
  /** promo_changed de un regalo que el motor ya no da. */
  gift?: boolean;
}

export interface SyncServerResult {
  id: string;
  client_sale_id: string;
  status: OfflineServerStatus;
  sale_id: string | null;
  sale_number: number | null;
  sale_total: number | null;
  conflicts: OfflineConflict[];
  reasons: string[];
  error: string | null;
  duplicate: boolean;
}

export interface SyncMeta {
  sold_at: string;
  user_id: string;
  device_id: string | null;
  total: number;
  payload_hash: string;
  integrity: "ok" | "failed";
  snapshot_at: string | null;
}

export type SyncRpc = (entry: OfflineQueueEntry, meta: SyncMeta) => Promise<SyncServerResult>;

/** retry: sin red, se reintenta · auth: falta sesión · hold: rechazo duro. */
export type SyncDisposition = "retry" | "auth" | "hold";

const NETWORK = /failed to fetch|networkerror|network request failed|load failed|fetch failed|\btimeout\b|timed out|err_internet_disconnected|econnrefused|enotfound/i;
const AUTH = /jwt|no_tenant|not authenticated|invalid claim|refresh token|pgrst30[0-3]/i;

export function classifySyncError(err: unknown): SyncDisposition {
  const e = (err ?? {}) as { message?: unknown; code?: unknown; status?: unknown; name?: unknown };
  const msg = `${typeof e.message === "string" ? e.message : ""} ${typeof e.code === "string" ? e.code : ""}`;
  const status = typeof e.status === "number" ? e.status : null;
  if (e.name === "TypeError" && !msg.trim()) return "retry";
  if (NETWORK.test(msg) || status === 0 || (status !== null && status >= 500)) return "retry";
  if (status === 401 || AUTH.test(msg)) return "auth";
  return "hold";
}

export interface SyncSummary {
  synced: number;
  review: number;
  conflicts: number;
  held: number;
  /** Se cortó por red o por sesión: quedan pendientes. */
  stopped: "network" | "auth" | null;
  results: SyncServerResult[];
}

export async function syncQueue(queue: OfflineQueue, scope: OfflineScope, rpc: SyncRpc): Promise<SyncSummary> {
  const out: SyncSummary = { synced: 0, review: 0, conflicts: 0, held: 0, stopped: null, results: [] };
  const pending = await queue.list(scope, "pending");
  for (const entry of pending) {
    const intact = await verifyEntry(entry);
    const meta: SyncMeta = {
      sold_at: entry.sold_at,
      user_id: entry.user_id,
      device_id: entry.device_id,
      total: entry.total,
      payload_hash: entry.hash,
      integrity: intact ? "ok" : "failed",
      snapshot_at: entry.snapshot_at,
    };
    let res: SyncServerResult;
    try {
      res = await rpc(entry, meta);
    } catch (err) {
      const d = classifySyncError(err);
      const msg = err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err);
      if (d === "retry") {
        await queue.bumpAttempt(entry.client_sale_id, msg);
        out.stopped = "network";
        break;
      }
      if (d === "auth") {
        out.stopped = "auth";
        break;
      }
      await queue.hold(entry.client_sale_id, msg);
      out.held++;
      continue;
    }
    // El servidor ya la tiene: sale de la cola.
    await queue.remove(entry.client_sale_id);
    out.results.push(res);
    if (res.status === "needs_review") out.review++;
    else if (res.status === "synced") {
      out.synced++;
      if ((res.conflicts ?? []).length > 0) out.conflicts++;
    }
  }
  return out;
}

const fmt = (n: number | undefined) =>
  typeof n === "number" ? `$${n.toLocaleString("es-AR", { maximumFractionDigits: 2 })}` : "";

/** Texto de una diferencia con la que se registró la venta. */
export function conflictLabel(c: OfflineConflict, productName?: string | null): string {
  const what = productName ? `${productName}: ` : "";
  switch (c.kind) {
    case "price_changed":
      return `${what}precio cambiado. Se cobró ${fmt(c.received)} y la lista dice ${fmt(c.expected)}`;
    case "negative_stock":
      return `${what}stock negativo después de la venta`;
    case "negative_stock_branch":
      return `${what}stock negativo en la sucursal`;
    case "promo_changed": {
      const promo = c.promo_name ? `"${c.promo_name}"` : "la promoción";
      if (c.gift) return `${what}regalo de ${promo} que ya no corresponde. Se entregó igual`;
      return `${what}${promo} cambió. Se descontó ${fmt(c.charged)} y hoy corresponde ${fmt(c.expected)}`;
    }
    default:
      return `${what}${c.kind}`;
  }
}

const REASONS: Record<string, string> = {
  offline_disabled: "La venta sin conexión estaba apagada",
  over_amount_limit: "Supera el monto máximo sin conexión",
  over_count_limit: "Supera la cantidad de ventas sin conexión del turno",
  sold_at_in_future: "La fecha de la venta está en el futuro",
  too_old: "Se sincronizó después del plazo máximo",
  invalid_sold_at: "La fecha de la venta es inválida",
  method_not_allowed_offline: "Usa un medio de pago que no se permite sin conexión",
  extra_not_allowed_offline: "Incluye packs o sesiones",
  price_override_offline: "Tiene un cambio manual de precio",
  not_allowed_offline: "Incluye mesa, delivery o cupón",
  integrity_failed: "Los datos guardados en el dispositivo no coinciden con su firma",
  invalid_payload: "Los datos de la venta están incompletos",
  sale_rejected: "El servidor no pudo registrarla",
};

export function reasonLabel(r: string): string {
  return REASONS[r] ?? r;
}

/** Error de create_sale guardado en la bandeja, en castellano. */
export function offlineErrorLabel(err: string | null): string | null {
  if (!err) return null;
  if (err.includes("shift_not_open")) return "El turno ya estaba cerrado";
  if (err.includes("shift_not_owned")) return "El turno es de otra persona";
  if (err.includes("store_not_allowed")) return "Sin acceso a la sucursal del turno";
  if (err.includes("supervisor_required")) return "Hacía falta autorización de un supervisor";
  if (err.includes("product_not_found")) return "Un producto ya no existe";
  if (err.includes("variant")) return "Una variante ya no existe o falta";
  if (err.includes("insufficient_payment")) return "El pago no cubre el total";
  if (err.includes("discount_exceeds_user_limit")) return "El descuento supera el tope personal del usuario";
  if (err.includes("discount_exceeds_limit")) return "El descuento supera el tope del rol";
  if (err.includes("discount_not_discountable") || err.includes("product_not_discountable")) {
    return "Hay productos que no aceptan descuento";
  }
  if (err.includes("free_sale")) return "La venta libre no está permitida o supera el tope";
  if (err.includes("feature_not_in_plan")) return "Usa algo que el plan no incluye";
  if (err.includes("account_inactive")) return "La suscripción estaba vencida";
  if (err.includes("staff_")) return "El usuario no estaba habilitado para vender";
  return err;
}
