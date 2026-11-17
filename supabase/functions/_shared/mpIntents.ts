// =============================================================================
// _shared/mpIntents.ts — sincroniza un intent local (mp_payment_intents) con su
// order de la Orders API. Lo usan el polling del POS (mp_qr / mp_point status)
// y el webhook topic `order` (mp_orders_webhook): misma regla en los dos.
//
// * La order SIEMPRE se re-lee de la API con el token del tenant (en el
//   ambiente del intent). Nunca se confía en el payload de un webhook.
// * Sólo se acredita `approved` con resolveOrder (processed + monto exacto +
//   external_reference = intent). Idempotente: transiciones sólo desde
//   pending, salvo approved, que se registra aunque el intent se haya cerrado
//   localmente (un cobro real nunca debe quedar invisible a la conciliación).
// * Acreditaciones y montos que no cierran dejan rastro en audit_logs.
// * PAY-27: applyOrderToIntent con `{ strict: true }` (sólo mp_orders_webhook)
//   lanza si falla la escritura del estado, para responder 503 y que MP
//   reintente. Sin la opción ignora el error como siempre (el polling vuelve).
// * PAY-28 (ADR-191): el cambio de estado y su auditoría van en UNA
//   transacción (RPC _mp_intent_transition, sólo service_role): o quedan los
//   dos o ninguno. Lo usan todos los llamadores (webhook, mp_qr, mp_point,
//   mp_cupon, pending_charges_sync) con la misma condición de siempre
//   (approved: `status <> 'approved'`; el resto: `status = 'pending'`). Si la
//   base todavía no tiene la función (Edge desplegada antes que la
//   migración) cae al camino de dos pasos de antes.
// =============================================================================
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { MP_API, mpHeaders } from "./mpAuth.ts";
import { type MpEnv, type MpOrder, type ResolvedOrder, resolveOrder } from "./mpOrders.ts";

export interface OrderIntentRow {
  id: string;
  tenant_id: string;
  status: string;
  amount: number | string;
  mp_order_id: string | null;
  mp_payment_id: string | null;
  mp_env: MpEnv | null;
  provider_key: string;
}

export const ORDER_INTENT_COLUMNS =
  "id, tenant_id, status, amount, mp_order_id, mp_payment_id, mp_env, provider_key, point_device_id, preference_id";

export async function fetchOrder(
  token: string,
  orderId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<{ ok: true; order: MpOrder } | { ok: false; status: number; detail: string }> {
  // PAY-27: `signal` opcional para que el webhook corte la lectura (timeout).
  const r = await fetch(`${MP_API}/v1/orders/${encodeURIComponent(orderId)}`, {
    headers: mpHeaders(token),
    signal: opts.signal,
  });
  if (!r.ok) return { ok: false, status: r.status, detail: (await r.text()).slice(0, 300) };
  return { ok: true, order: (await r.json()) as MpOrder };
}

/** Falla de la escritura del estado en modo estricto (PAY-27). */
export class IntentWriteError extends Error {
  constructor(cause: unknown) {
    super(`mp_payment_intents update: ${(cause as { message?: string } | null)?.message ?? String(cause)}`);
    this.name = "IntentWriteError";
  }
}

/** Auditoría que no se pudo grabar (sólo el camino viejo, sin la RPC). */
function auditFailed(error: unknown, intent: string, action: string): void {
  if (!error) return;
  console.error("[mp_orders] audit_logs no se pudo grabar", {
    intent,
    action,
    error: String((error as { message?: string }).message ?? error).slice(0, 200),
  });
}

/** La RPC no existe (base sin la migración PAY-28): PostgREST PGRST202 / Postgres 42883. */
export function isMissingRpc(err: unknown): boolean {
  const e = (err ?? {}) as { code?: string; message?: string };
  return e.code === "PGRST202" || e.code === "42883" ||
    /_mp_intent_transition/.test(String(e.message ?? "")) && /could not find|does not exist/i.test(String(e.message ?? ""));
}

type Transition = {
  status: string;
  mpPaymentId: string | null;
  /** true: sólo desde `pending`; false: cualquier estado salvo `approved`. */
  onlyPending: boolean;
  audit: { action: string; actor: string | null; after: Record<string, unknown> } | null;
};

/**
 * PAY-28: transición del intent + auditoría atómicas. Devuelve si cambió una
 * fila; con `error` si la base falló (nada quedó escrito: la transacción se
 * revierte entera). Sin la RPC en la base, el camino viejo de dos pasos.
 */
async function transitionIntent(
  admin: SupabaseClient,
  row: OrderIntentRow,
  t: Transition,
): Promise<{ changed: boolean; error: unknown }> {
  const { data, error } = await admin.rpc("_mp_intent_transition", {
    p_intent: row.id,
    p_status: t.status,
    p_mp_payment_id: t.mpPaymentId,
    p_only_pending: t.onlyPending,
    p_audit_action: t.audit?.action ?? null,
    p_actor: t.audit?.actor ?? null,
    p_audit_after: t.audit?.after ?? null,
  });
  if (!error) return { changed: data === true, error: null };
  if (!isMissingRpc(error)) return { changed: false, error };

  // Base sin la migración: update y después auditoría (pre PAY-28).
  const values: Record<string, unknown> = { status: t.status };
  if (t.mpPaymentId != null) values.mp_payment_id = t.mpPaymentId;
  let q = admin.from("mp_payment_intents").update(values).eq("id", row.id);
  q = t.onlyPending ? q.eq("status", "pending") : q.neq("status", "approved");
  const { data: upd, error: updErr } = await q.select("id");
  if (updErr) return { changed: false, error: updErr };
  const changed = (upd ?? []).length > 0;
  if (changed && t.audit) {
    const { error: auditErr } = await admin.from("audit_logs").insert({
      tenant_id: row.tenant_id,
      actor_user_id: t.audit.actor,
      entity_type: "mp_payment_intents",
      entity_id: row.id,
      action: t.audit.action,
      after_data: t.audit.after,
    });
    auditFailed(auditErr, row.id, t.audit.action);
  }
  return { changed, error: null };
}

/** Error de la transición: estricto lanza (503); si no, se loguea y sigue (el polling vuelve). */
function onTransitionError(error: unknown, row: OrderIntentRow, strict: boolean | undefined): void {
  if (!error) return;
  if (strict) throw new IntentWriteError(error);
  console.error("[mp_orders] no se pudo actualizar el intent", {
    intent: row.id,
    error: String((error as { message?: string }).message ?? error).slice(0, 200),
  });
}

/**
 * Aplica el estado de la order al intent local. Devuelve el resultado resuelto.
 * `strict` (PAY-27): si falla la escritura lanza IntentWriteError. PAY-28: la
 * escritura es estado + auditoría en una transacción, así que un error no
 * deja el intent cambiado sin su auditoría (ni al revés) y el reintento
 * vuelve a intentar las dos.
 */
export async function applyOrderToIntent(
  admin: SupabaseClient,
  row: OrderIntentRow,
  order: MpOrder,
  actor: { userId: string | null; source: "poll" | "webhook" },
  opts: { strict?: boolean } = {},
): Promise<ResolvedOrder> {
  const res = resolveOrder(order, { intentId: row.id, expectedAmount: Number(row.amount) });

  if (res.reason === "reference_mismatch") {
    console.error("[mp_orders] external_reference ajeno, se ignora", {
      intent: row.id,
      order: order.id,
    });
    return res;
  }

  if (res.status === "approved") {
    const { error } = await transitionIntent(admin, row, {
      status: "approved",
      mpPaymentId: res.paymentId ?? null,
      onlyPending: false,
      audit: {
        action: "mp_order_approved",
        actor: actor.userId,
        after: {
          provider_key: row.provider_key,
          mp_order_id: row.mp_order_id,
          mp_payment_id: res.paymentId,
          amount: Number(row.amount),
          env: row.mp_env,
          source: actor.source,
          previous_status: row.status,
        },
      },
    });
    onTransitionError(error, row, opts.strict);
    return res;
  }

  if (res.status !== "pending") {
    const mismatch = res.reason === "amount_mismatch";
    const { changed, error } = await transitionIntent(admin, row, {
      status: res.status,
      mpPaymentId: res.paymentId ?? row.mp_payment_id ?? null,
      onlyPending: true,
      audit: mismatch
        ? {
            action: "mp_order_amount_mismatch",
            actor: actor.userId,
            after: {
              provider_key: row.provider_key,
              mp_order_id: row.mp_order_id,
              mp_payment_id: res.paymentId,
              expected: Number(row.amount),
              order_total: order.total_amount ?? null,
              source: actor.source,
            },
          }
        : null,
    });
    onTransitionError(error, row, opts.strict);
    if (changed && mismatch) {
      console.error("[mp_orders] amount_mismatch, NO se acredita", {
        intent: row.id,
        order: order.id,
      });
    }
  }
  return res;
}
