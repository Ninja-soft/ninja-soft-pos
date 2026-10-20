// =============================================================================
// Viumi: helpers server-side (Deno) compartidos por `viumi`, `viumi_webhook` y
// `pending_charges_sync` (ADR-173). Cargan la conexión del negocio
// (payment_secrets provider 'viumi'), arman el cliente de la API y sincronizan
// un intent local (mp_payment_intents) contra la orden RE-CONSULTADA a Viumi,
// de forma idempotente y con auditoría. La lógica pura vive en ./viumi.ts.
// =============================================================================
import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  decideIntentUpdate,
  parseCreds,
  viumiClient,
  viumiEnv,
  type ViumiCreds,
  type ViumiEnv,
} from "./viumi.ts";
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
export const INTENT_COLS = "id, tenant_id, status, amount, preference_id, mp_payment_id, mp_env, created_at";

// El intent guarda el ambiente con que se creó ('test' = stage).
export const envOfIntent = (row: { mp_env: string | null }): ViumiEnv => (row.mp_env === "test" ? "stage" : "prod");
export const intentEnvValue = (env: ViumiEnv) => (env === "stage" ? "test" : "prod");

/** Base pública de los webhooks (dominio propio, ADR-069). */
export function hooksBase(): string {
  return (Deno.env.get("PUBLIC_HOOKS_BASE") ?? "https://hooks.soft.ninja").replace(/\/$/, "");
}

// ADR-057: `opts.storeId` usa la conexión propia de la sucursal si tiene;
// `opts.scopeStoreId` (del intent) la exacta.
export async function loadCredsScoped(
  admin: Admin,
  tenantId: string,
  opts: { storeId?: string | null; scopeStoreId?: string | null } = {},
): Promise<{ creds: ViumiCreds; scopeStoreId: string | null } | null> {
  const loaded = await loadProviderSecret(admin, tenantId, "viumi", opts);
  const creds = parseCreds(loaded?.secrets);
  return creds ? { creds, scopeStoreId: loaded?.scopeStoreId ?? null } : null;
}

export async function loadEnv(admin: Admin, tenantId: string): Promise<ViumiEnv> {
  const { data } = await admin
    .from("tenant_payment_methods")
    .select("sandbox")
    .eq("tenant_id", tenantId)
    .eq("provider_key", "viumi")
    .maybeSingle();
  return viumiEnv((data as { sandbox?: boolean } | null)?.sandbox);
}

export function clientFor(creds: ViumiCreds, env: ViumiEnv) {
  return viumiClient({ creds, env });
}

export type SyncResult =
  | { status: string; mp_payment_id: string | null; state?: string }
  | { error: string; detail?: string };

// Re-consulta la orden y aplica el resultado.
//  * via 'status' / 'cron' (poll del POS o del cron): sólo resuelve intents pending.
//  * via 'webhook': un approved verificado pasa también desde
//    rejected/cancelled (el POS cerró el cobro pero el cliente pagó: queda en
//    la conciliación como cobro sin venta).
export async function syncIntent(
  admin: Admin,
  row: IntentRow,
  creds: ViumiCreds,
  via: "status" | "webhook" | "cron",
  actor: string | null,
): Promise<SyncResult> {
  const orderUuid = row.preference_id;
  if (!orderUuid) return { status: row.status, mp_payment_id: row.mp_payment_id };
  const r = await clientFor(creds, envOfIntent(row)).getOrder(orderUuid);
  if (!r.ok) return { error: "viumi_error", detail: `${r.httpStatus} ${r.detail}` };

  const d = decideIntentUpdate(r.value, { amount: Number(row.amount), orderUuid });
  if (d.reason === "order_mismatch") {
    return { status: row.status, mp_payment_id: row.mp_payment_id, state: d.reason };
  }
  if (d.status === "pending") return { status: row.status, mp_payment_id: row.mp_payment_id, state: d.state };

  const from = d.status === "approved" && via === "webhook" ? ["pending", "rejected", "cancelled"] : ["pending"];
  const { data: changed } = await admin
    .from("mp_payment_intents")
    .update({ status: d.status, mp_payment_id: d.status === "approved" ? orderUuid : null })
    .eq("id", row.id)
    .eq("provider_key", "viumi")
    .in("status", from)
    .select("id");

  if (changed && changed.length > 0) {
    await admin.from("audit_logs").insert({
      tenant_id: row.tenant_id,
      actor_user_id: actor,
      entity_type: "mp_payment_intents",
      entity_id: row.id,
      action: `viumi_payment_${d.status}`,
      after_data: {
        order_uuid: orderUuid,
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
