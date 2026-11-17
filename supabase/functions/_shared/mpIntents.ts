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

/** Auditoría que no se pudo grabar: no se lanza (ver applyOrderToIntent). */
function auditFailed(error: unknown, intent: string, action: string): void {
  if (!error) return;
  console.error("[mp_orders] audit_logs no se pudo grabar", {
    intent,
    action,
    error: String((error as { message?: string }).message ?? error).slice(0, 200),
  });
}

/**
 * Aplica el estado de la order al intent local. Devuelve el resultado resuelto.
 * `strict` (PAY-27): si falla el update del estado lanza IntentWriteError. Un
 * error de la auditoría (después del update) sólo se loguea: el intent ya
 * cambió y un reintento sale por idempotencia sin volver a auditar.
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
    const { data: upd, error: updErr } = await admin
      .from("mp_payment_intents")
      .update({ status: "approved", mp_payment_id: res.paymentId })
      .eq("id", row.id)
      .neq("status", "approved")
      .select("id");
    if (updErr && opts.strict) throw new IntentWriteError(updErr);
    if ((upd ?? []).length > 0) {
      const { error: auditErr } = await admin.from("audit_logs").insert({
        tenant_id: row.tenant_id,
        actor_user_id: actor.userId,
        entity_type: "mp_payment_intents",
        entity_id: row.id,
        action: "mp_order_approved",
        after_data: {
          provider_key: row.provider_key,
          mp_order_id: row.mp_order_id,
          mp_payment_id: res.paymentId,
          amount: Number(row.amount),
          env: row.mp_env,
          source: actor.source,
          previous_status: row.status,
        },
      });
      if (opts.strict) auditFailed(auditErr, row.id, "mp_order_approved");
    }
    return res;
  }

  if (res.status !== "pending") {
    const { data: upd, error: updErr } = await admin
      .from("mp_payment_intents")
      .update({ status: res.status, mp_payment_id: res.paymentId ?? row.mp_payment_id })
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id");
    if (updErr && opts.strict) throw new IntentWriteError(updErr);
    if ((upd ?? []).length > 0 && res.reason === "amount_mismatch") {
      console.error("[mp_orders] amount_mismatch, NO se acredita", {
        intent: row.id,
        order: order.id,
      });
      const { error: auditErr } = await admin.from("audit_logs").insert({
        tenant_id: row.tenant_id,
        actor_user_id: actor.userId,
        entity_type: "mp_payment_intents",
        entity_id: row.id,
        action: "mp_order_amount_mismatch",
        after_data: {
          provider_key: row.provider_key,
          mp_order_id: row.mp_order_id,
          mp_payment_id: res.paymentId,
          expected: Number(row.amount),
          order_total: order.total_amount ?? null,
          source: actor.source,
        },
      });
      if (opts.strict) auditFailed(auditErr, row.id, "mp_order_amount_mismatch");
    }
  }
  return res;
}
