// =============================================================================
// GO Cuotas: helpers server-side (Deno) compartidos por `gocuotas` y
// `gocuotas_webhook`. Cargan la conexión del tenant (payment_secrets provider
// 'gocuotas': { api_key } de la sucursal) y sincronizan un intent local
// (mp_payment_intents) contra la orden RE-CONSULTADA a GO Cuotas, de forma
// idempotente y con auditoría. La lógica pura vive en ./gocuotas.ts.
// =============================================================================
import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  decideIntentUpdate,
  gocuotasEnv,
  resolveOrder,
  type GoCuotasEnv,
} from "./gocuotas.ts";

// deno-lint-ignore no-explicit-any
export type Admin = SupabaseClient<any, "public", any>;

export type IntentRow = {
  id: string;
  tenant_id: string;
  status: string;
  amount: number | string;
  preference_id: string | null;
  mp_payment_id: string | null;
  mp_env: string | null;
  created_at: string;
};
export const INTENT_COLS =
  "id, tenant_id, status, amount, preference_id, mp_payment_id, mp_env, created_at";

// El intent guarda el ambiente con que se creó ('test' = sandbox): status y
// webhook consultan ESE host aunque el dueño cambie el switch después.
export const envOfIntent = (row: { mp_env: string | null }): GoCuotasEnv =>
  row.mp_env === "test" ? "sandbox" : "prod";
export const intentEnvValue = (env: GoCuotasEnv) => (env === "sandbox" ? "test" : "prod");

export async function loadApiKey(admin: Admin, tenantId: string): Promise<string | null> {
  const { data } = await admin
    .from("payment_secrets")
    .select("secrets")
    .eq("tenant_id", tenantId)
    .eq("provider_key", "gocuotas")
    .maybeSingle();
  const key = ((data as { secrets?: { api_key?: string } } | null)?.secrets?.api_key ?? "").trim();
  return key || null;
}

export async function loadEnv(admin: Admin, tenantId: string): Promise<GoCuotasEnv> {
  const { data } = await admin
    .from("tenant_payment_methods")
    .select("sandbox")
    .eq("tenant_id", tenantId)
    .eq("provider_key", "gocuotas")
    .maybeSingle();
  return gocuotasEnv((data as { sandbox?: boolean } | null)?.sandbox);
}

export type SyncResult =
  | { status: string; mp_payment_id: string | null; state?: string }
  | { error: string; detail?: string };

// Re-consulta la orden del intent y aplica el resultado.
//  * via 'status' (poll del POS): sólo resuelve intents pending.
//  * via 'webhook': además, un approved verificado pasa también desde
//    rejected/cancelled (el POS cerró el cobro pero el cliente pagó: queda en
//    la conciliación como cobro sin venta).
export async function syncIntent(
  admin: Admin,
  row: IntentRow,
  apiKey: string,
  via: "status" | "webhook",
  hintedOrderId: string | null,
  actor: string | null,
): Promise<SyncResult> {
  const look = await resolveOrder({
    env: envOfIntent(row),
    apiKey,
    intentId: row.id,
    createdAt: row.created_at,
    hintedOrderId: hintedOrderId ?? row.preference_id,
  });
  if (!look.ok) return { error: "gocuotas_error", detail: look.detail };

  const d = decideIntentUpdate(look.order, Number(row.amount), row.id);
  if (d.status === "pending") return { status: row.status, mp_payment_id: row.mp_payment_id, state: d.state };

  // Una orden de GO Cuotas acredita a un único intent.
  if (d.status === "approved" && d.orderId) {
    const { data: dup } = await admin
      .from("mp_payment_intents")
      .select("id")
      .eq("provider_key", "gocuotas")
      .eq("mp_payment_id", d.orderId)
      .neq("id", row.id)
      .limit(1);
    if (dup && dup.length > 0) {
      return { status: row.status, mp_payment_id: row.mp_payment_id, state: "order_already_used" };
    }
  }

  const from =
    d.status === "approved" && via === "webhook" ? ["pending", "rejected", "cancelled"] : ["pending"];
  const { data: changed } = await admin
    .from("mp_payment_intents")
    .update({
      status: d.status,
      preference_id: d.orderId ?? row.preference_id,
      mp_payment_id: d.status === "approved" ? d.orderId : null,
    })
    .eq("id", row.id)
    .in("status", from)
    .select("id");

  if (changed && changed.length > 0) {
    await admin.from("audit_logs").insert({
      tenant_id: row.tenant_id,
      actor_user_id: actor,
      entity_type: "mp_payment_intents",
      entity_id: row.id,
      action: `gocuotas_payment_${d.status}`,
      after_data: {
        order_id: d.orderId ?? null,
        state: d.state,
        reason: d.reason ?? null,
        amount: Number(row.amount),
        previous_status: row.status,
        env: envOfIntent(row),
        via,
      },
    });
  }

  const { data: fresh } = await admin
    .from("mp_payment_intents")
    .select("status, mp_payment_id")
    .eq("id", row.id)
    .maybeSingle();
  const f = fresh as { status?: string; mp_payment_id?: string | null } | null;
  return { status: f?.status ?? d.status, mp_payment_id: f?.mp_payment_id ?? null };
}
