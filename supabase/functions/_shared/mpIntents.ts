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
): Promise<{ ok: true; order: MpOrder } | { ok: false; status: number; detail: string }> {
  const r = await fetch(`${MP_API}/v1/orders/${encodeURIComponent(orderId)}`, {
    headers: mpHeaders(token),
  });
  if (!r.ok) return { ok: false, status: r.status, detail: (await r.text()).slice(0, 300) };
  return { ok: true, order: (await r.json()) as MpOrder };
}

/** Aplica el estado de la order al intent local. Devuelve el resultado resuelto. */
export async function applyOrderToIntent(
  admin: SupabaseClient,
  row: OrderIntentRow,
  order: MpOrder,
  actor: { userId: string | null; source: "poll" | "webhook" },
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
    const { data: upd } = await admin
      .from("mp_payment_intents")
      .update({ status: "approved", mp_payment_id: res.paymentId })
      .eq("id", row.id)
      .neq("status", "approved")
      .select("id");
    if ((upd ?? []).length > 0) {
      await admin.from("audit_logs").insert({
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
    }
    return res;
  }

  if (res.status !== "pending") {
    const { data: upd } = await admin
      .from("mp_payment_intents")
      .update({ status: res.status, mp_payment_id: res.paymentId ?? row.mp_payment_id })
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id");
    if ((upd ?? []).length > 0 && res.reason === "amount_mismatch") {
      console.error("[mp_orders] amount_mismatch, NO se acredita", {
        intent: row.id,
        order: order.id,
      });
      await admin.from("audit_logs").insert({
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
    }
  }
  return res;
}
