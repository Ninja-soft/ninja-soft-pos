// =============================================================================
// dLocal Go: helpers server-side (Deno) compartidos por `dlocalgo`,
// `dlocalgo_webhook` y `pending_charges_sync` (ADR-180). Cargan la conexión del
// negocio (payment_secrets provider 'dlocalgo'), arman el cliente de la API y
// sincronizan un intent local (mp_payment_intents) contra el pago
// RE-CONSULTADO a dLocal Go, de forma idempotente y con auditoría. La lógica
// pura vive en ./dlocalgo.ts.
// =============================================================================
import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  decideIntentUpdate,
  dlocalEnv,
  dlocalgoClient,
  parseCreds,
  type DlocalCreds,
  type DlocalEnv,
} from "./dlocalgo.ts";
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

// El intent guarda el ambiente con que se creó ('test' = sandbox).
export const envOfIntent = (row: { mp_env: string | null }): DlocalEnv => (row.mp_env === "test" ? "sandbox" : "prod");
export const intentEnvValue = (env: DlocalEnv) => (env === "sandbox" ? "test" : "prod");

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
): Promise<{ creds: DlocalCreds; scopeStoreId: string | null } | null> {
  const loaded = await loadProviderSecret(admin, tenantId, "dlocalgo", opts);
  const creds = parseCreds(loaded?.secrets);
  return creds ? { creds, scopeStoreId: loaded?.scopeStoreId ?? null } : null;
}

export async function loadEnv(admin: Admin, tenantId: string): Promise<DlocalEnv> {
  const { data } = await admin
    .from("tenant_payment_methods")
    .select("sandbox")
    .eq("tenant_id", tenantId)
    .eq("provider_key", "dlocalgo")
    .maybeSingle();
  return dlocalEnv((data as { sandbox?: boolean } | null)?.sandbox);
}

export function clientFor(creds: DlocalCreds, env: DlocalEnv) {
  return dlocalgoClient({ creds, env });
}

export type SyncResult =
  | { status: string; mp_payment_id: string | null; state?: string }
  | { error: string; detail?: string };

// Re-consulta el pago y aplica el resultado.
//  * via 'status' / 'cron' (poll del POS o del cron): sólo resuelve intents pending.
//  * via 'webhook': un approved verificado pasa también desde
//    rejected/cancelled/expired (el POS cerró el cobro pero el cliente pagó:
//    queda en la conciliación como cobro sin venta).
export async function syncIntent(
  admin: Admin,
  row: IntentRow,
  creds: DlocalCreds,
  via: "status" | "webhook" | "cron",
  actor: string | null,
): Promise<SyncResult> {
  const paymentId = row.preference_id;
  if (!paymentId) return { status: row.status, mp_payment_id: row.mp_payment_id };
  const r = await clientFor(creds, envOfIntent(row)).getPayment(paymentId);
  if (!r.ok) return { error: "dlocalgo_error", detail: `${r.httpStatus} ${r.detail}` };

  const d = decideIntentUpdate(r.value, { amount: Number(row.amount), intentId: row.id, paymentId });
  if (d.reason === "reference_mismatch" || d.reason === "payment_mismatch") {
    return { status: row.status, mp_payment_id: row.mp_payment_id, state: d.reason };
  }
  if (d.status === "pending") return { status: row.status, mp_payment_id: row.mp_payment_id, state: d.state };

  const from =
    d.status === "approved" && via === "webhook" ? ["pending", "rejected", "cancelled", "expired"] : ["pending"];
  const { data: changed } = await admin
    .from("mp_payment_intents")
    .update({ status: d.status, mp_payment_id: d.status === "approved" ? paymentId : null })
    .eq("id", row.id)
    .eq("provider_key", "dlocalgo")
    .in("status", from)
    .select("id");

  if (changed && changed.length > 0) {
    await admin.from("audit_logs").insert({
      tenant_id: row.tenant_id,
      actor_user_id: actor,
      entity_type: "mp_payment_intents",
      entity_id: row.id,
      action: `dlocalgo_payment_${d.status}`,
      after_data: {
        payment_id: paymentId,
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
