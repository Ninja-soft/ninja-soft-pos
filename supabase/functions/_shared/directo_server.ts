// =============================================================================
// Directo: helpers server-side (Deno) compartidos por `directo`,
// `directo_webhook` y `pending_charges_sync` (ADR-181, API Ecommerce 2.0).
// Cargan la conexión del tenant (payment_secrets provider 'directo'), arman el
// cliente y sincronizan un intent local (mp_payment_intents) contra el estado
// RE-CONSULTADO a Directo, de forma idempotente y con auditoría. La lógica
// pura vive en ./directo.ts.
//
// Intent de Directo:
//   * preference_id = merchantOrderId (lo genera Directo al crear la orden).
//   * mp_payment_id = creditNumber del crédito aprobado (o el merchantOrderId
//     si Directo no lo informa).
//   * mp_env = 'test' (QA) o 'prod'.
// Los datos del crédito (cuotas, valor de cuota, capital, número) quedan en
// audit_logs.after_data de `directo_payment_approved` (mp_payment_intents no
// tiene columna de metadata; ADR-181).
// =============================================================================
import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  decideIntentUpdate,
  directoClient,
  directoEnv,
  parseCreds,
  type ApiResult,
  type DirectoCreds,
  type DirectoEnv,
  type DirectoOrderStatus,
} from "./directo.ts";
import { loadProviderSecret } from "./paymentSecrets.ts";

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

// El intent guarda el ambiente con que se creó ('test' = QA).
export const envOfIntent = (row: { mp_env: string | null }): DirectoEnv =>
  row.mp_env === "test" ? "qa" : "prod";
export const intentEnvValue = (env: DirectoEnv) => (env === "qa" ? "test" : "prod");

// Dominio propio de webhooks (ADR-069): hooks.soft.ninja/directo → directo_webhook.
export function hooksBase(): string {
  return (Deno.env.get("PUBLIC_HOOKS_BASE") ?? "https://hooks.soft.ninja").replace(/\/$/, "");
}

// ADR-057: `opts.storeId` usa la conexión propia de la sucursal si tiene;
// `opts.scopeStoreId` (del intent) la exacta.
export async function loadCredsScoped(
  admin: Admin,
  tenantId: string,
  opts: { storeId?: string | null; scopeStoreId?: string | null } = {},
): Promise<{ creds: DirectoCreds; scopeStoreId: string | null } | null> {
  const loaded = await loadProviderSecret(admin, tenantId, "directo", opts);
  const creds = parseCreds(loaded?.secrets);
  return creds ? { creds, scopeStoreId: loaded?.scopeStoreId ?? null } : null;
}

export async function loadCreds(
  admin: Admin,
  tenantId: string,
  opts: { storeId?: string | null; scopeStoreId?: string | null } = {},
): Promise<DirectoCreds | null> {
  return (await loadCredsScoped(admin, tenantId, opts))?.creds ?? null;
}

export async function loadEnv(admin: Admin, tenantId: string): Promise<DirectoEnv> {
  const { data } = await admin
    .from("tenant_payment_methods")
    .select("sandbox")
    .eq("tenant_id", tenantId)
    .eq("provider_key", "directo")
    .maybeSingle();
  return directoEnv((data as { sandbox?: boolean } | null)?.sandbox);
}

export function clientFor(creds: DirectoCreds, env: DirectoEnv) {
  return directoClient({ creds, env });
}

export type SyncResult =
  | { status: string; mp_payment_id: string | null; state?: string }
  | { error: string; detail?: string };

// Re-consulta la orden y aplica el resultado.
//  * via 'status' / 'cron' (poll del POS o del cron): get_order_status; sólo
//    resuelve intents pending.
//  * via 'webhook': get_by_notification(notification_id); un approved
//    verificado pasa también desde rejected/cancelled (el POS cerró el cobro
//    pero el cliente sacó el crédito: queda en la conciliación como cobro sin
//    venta).
// En los dos casos el merchantOrderId de la respuesta tiene que ser el de la
// orden que creamos (preference_id del intent).
export async function syncIntent(
  admin: Admin,
  row: IntentRow,
  creds: DirectoCreds,
  via: "status" | "webhook" | "cron",
  actor: string | null,
  notificationId: string | null = null,
): Promise<SyncResult> {
  const orderId = row.preference_id;
  if (!orderId) return { status: row.status, mp_payment_id: row.mp_payment_id };
  const client = clientFor(creds, envOfIntent(row));
  const r: ApiResult<DirectoOrderStatus> =
    via === "webhook" && notificationId
      ? await client.getByNotification(notificationId)
      : await client.getOrderStatus(orderId);
  if (!r.ok) return { error: "directo_error", detail: `${r.httpStatus} ${r.detail}` };

  const d = decideIntentUpdate(r.value, { merchantOrderId: orderId, amount: Number(row.amount) });
  if (d.reason === "order_mismatch") {
    return { status: row.status, mp_payment_id: row.mp_payment_id, state: d.reason };
  }
  if (d.status === "pending") return { status: row.status, mp_payment_id: row.mp_payment_id, state: d.state };

  const from = d.status === "approved" && via === "webhook" ? ["pending", "rejected", "cancelled"] : ["pending"];
  const paymentId = d.status === "approved" ? (d.credit?.credit_number ?? orderId) : null;
  const { data: changed } = await admin
    .from("mp_payment_intents")
    .update({ status: d.status, mp_payment_id: paymentId })
    .eq("id", row.id)
    .eq("provider_key", "directo")
    .in("status", from)
    .select("id");

  if (changed && changed.length > 0) {
    await admin.from("audit_logs").insert({
      tenant_id: row.tenant_id,
      actor_user_id: actor,
      entity_type: "mp_payment_intents",
      entity_id: row.id,
      action: `directo_payment_${d.status}`,
      after_data: {
        merchant_order_id: orderId,
        notification_id: notificationId,
        state: d.state,
        amount: Number(row.amount),
        ...(d.credit ? { credit: d.credit } : {}),
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
