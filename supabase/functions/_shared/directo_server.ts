// =============================================================================
// Directo: helpers server-side (Deno) compartidos por `directo` y
// `directo_webhook` (ADR-041). Cargan la conexión del tenant (payment_secrets
// provider 'directo'), arman el cliente de la API y sincronizan un intent
// local (mp_payment_intents) contra la notificación RE-CONSULTADA a Directo,
// de forma idempotente y con auditoría. La lógica pura vive en ./directo.ts.
// =============================================================================
import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  decideIntentUpdate,
  directoClient,
  directoEnv,
  parseCreds,
  resolveBaseUrl,
  type DirectoCreds,
  type DirectoEnv,
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

// Clave/IV del MerchantHash: por defecto las del plugin oficial; se pueden
// pisar con secrets de la función si Directo las rota.
const hashConfig = () => ({
  keyB64: Deno.env.get("DIRECTO_HASH_KEY") || undefined,
  ivB64: Deno.env.get("DIRECTO_HASH_IV") || undefined,
});

export function clientFor(creds: DirectoCreds, env: DirectoEnv) {
  return directoClient({ creds, baseUrl: resolveBaseUrl(env, creds.baseUrl), hash: hashConfig() });
}

export type SyncResult =
  | { status: string; mp_payment_id: string | null; state?: string }
  | { error: string; detail?: string };

// Re-consulta la notificación y aplica el resultado.
//  * via 'status' (poll del POS): sólo resuelve intents pending.
//  * via 'webhook': un approved verificado pasa también desde
//    rejected/cancelled (el POS cerró el cobro pero el cliente pagó: queda en
//    la conciliación como cobro sin venta).
// El id de notificación queda en preference_id para que el poll del POS pueda
// re-verificar si el webhook se cortó a mitad de camino.
export async function syncIntent(
  admin: Admin,
  row: IntentRow,
  creds: DirectoCreds,
  via: "status" | "webhook",
  notificationId: string,
  actor: string | null,
): Promise<SyncResult> {
  let client;
  try {
    client = clientFor(creds, envOfIntent(row));
  } catch (e) {
    return { error: e instanceof Error ? e.message : "directo_error" };
  }
  const r = await client.getNotification(notificationId);
  if (!r.ok) return { error: "directo_error", detail: `${r.httpStatus} ${r.detail}` };

  const d = decideIntentUpdate(r.value, Number(row.amount), row.id);
  if (d.reason === "reference_mismatch") {
    return { status: row.status, mp_payment_id: row.mp_payment_id, state: "reference_mismatch" };
  }

  if (d.status === "pending") {
    if (row.preference_id !== notificationId && row.status === "pending") {
      await admin
        .from("mp_payment_intents")
        .update({ preference_id: notificationId })
        .eq("id", row.id)
        .eq("status", "pending");
    }
    return { status: row.status, mp_payment_id: row.mp_payment_id, state: d.state };
  }

  const from =
    d.status === "approved" && via === "webhook" ? ["pending", "rejected", "cancelled"] : ["pending"];
  const { data: changed } = await admin
    .from("mp_payment_intents")
    .update({
      status: d.status,
      preference_id: notificationId,
      mp_payment_id: d.status === "approved" ? notificationId : null,
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
      action: `directo_payment_${d.status}`,
      after_data: {
        notification_id: notificationId,
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
