// =============================================================================
// Talo: helpers server-side (Deno) compartidos por `talo`, `talo_webhook` y
// `pending_charges_sync` (ADR-175). Cargan la conexión del negocio
// (payment_secrets provider 'talo'), arman el cliente de la API y sincronizan
// un intent local (mp_payment_intents) contra el pago RE-CONSULTADO a Talo, de
// forma idempotente y con auditoría. La lógica pura vive en ./talo.ts.
// =============================================================================
import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  decideIntentUpdate,
  lastRefund,
  parseCreds,
  refundStatusByRef,
  taloClient,
  taloEnv,
  toCents,
  transferInfo,
  type Decision,
  type TaloCreds,
  type TaloEnv,
} from "./talo.ts";
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
  paid_amount: number | string | null;
  created_at: string;
};
export const INTENT_COLS = "id, tenant_id, status, amount, preference_id, mp_payment_id, mp_env, paid_amount, created_at";

// El intent guarda el ambiente con que se creó ('test' = sandbox).
export const envOfIntent = (row: { mp_env: string | null }): TaloEnv => (row.mp_env === "test" ? "sandbox" : "prod");
export const intentEnvValue = (env: TaloEnv) => (env === "sandbox" ? "test" : "prod");

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
): Promise<{ creds: TaloCreds; scopeStoreId: string | null } | null> {
  const loaded = await loadProviderSecret(admin, tenantId, "talo", opts);
  const creds = parseCreds(loaded?.secrets);
  return creds ? { creds, scopeStoreId: loaded?.scopeStoreId ?? null } : null;
}

export async function loadEnv(admin: Admin, tenantId: string): Promise<TaloEnv> {
  const { data } = await admin
    .from("tenant_payment_methods")
    .select("sandbox")
    .eq("tenant_id", tenantId)
    .eq("provider_key", "talo")
    .maybeSingle();
  return taloEnv((data as { sandbox?: boolean } | null)?.sandbox);
}

export function clientFor(creds: TaloCreds, env: TaloEnv) {
  return taloClient({ creds, env });
}

export type SyncOk = {
  status: string;
  mp_payment_id: string | null;
  state?: string;
  paid?: number | null;
  missing?: number;
  overpaid?: number;
  cvu?: string | null;
  alias?: string | null;
};
export type SyncResult = SyncOk | { error: string; detail?: string };

// Re-consulta el pago y aplica el resultado.
//  * via 'status' / 'cron' (poll del POS o del cron): sólo resuelve intents pending.
//  * via 'webhook': un approved verificado pasa también desde
//    rejected/cancelled (el POS cerró el cobro pero el cliente transfirió:
//    queda en la conciliación como cobro sin venta, para devolver o registrar).
// Además guarda paid_amount (lo recibido según Talo) para mostrar el faltante
// de un UNDERPAID y la diferencia de un OVERPAID, y actualiza las devoluciones
// en curso del intent con el mismo pago re-consultado.
export async function syncIntent(
  admin: Admin,
  row: IntentRow,
  creds: TaloCreds,
  via: "status" | "webhook" | "cron",
  actor: string | null,
): Promise<SyncResult> {
  const paymentId = row.preference_id;
  if (!paymentId) return { status: row.status, mp_payment_id: row.mp_payment_id };
  const r = await clientFor(creds, envOfIntent(row)).getPayment(paymentId);
  if (!r.ok) return { error: "talo_error", detail: `${r.httpStatus} ${r.detail}` };

  const d: Decision = decideIntentUpdate(r.value, { amount: Number(row.amount), intentId: row.id, paymentId });
  const t = transferInfo(r.value);
  const extra = {
    state: d.state,
    paid: d.paid,
    ...(d.missing !== undefined ? { missing: d.missing } : {}),
    ...(d.overpaid !== undefined ? { overpaid: d.overpaid } : {}),
    cvu: t.cvu,
    alias: t.alias,
  };
  if (d.reason === "reference_mismatch" || d.reason === "payment_mismatch") {
    return { status: row.status, mp_payment_id: row.mp_payment_id, state: d.reason };
  }

  // Lo recibido (sin tocar el estado): sólo si cambió.
  const prevPaid = row.paid_amount === null ? null : Number(row.paid_amount);
  if (d.paid !== null && (prevPaid === null || toCents(prevPaid) !== toCents(d.paid))) {
    await admin.from("mp_payment_intents").update({ paid_amount: d.paid }).eq("id", row.id).eq("provider_key", "talo");
  }

  await reconcileRefunds(admin, row, r.value);

  if (d.status === "pending") return { status: row.status, mp_payment_id: row.mp_payment_id, ...extra };

  const from = d.status === "approved" && via === "webhook" ? ["pending", "rejected", "cancelled"] : ["pending"];
  const { data: changed } = await admin
    .from("mp_payment_intents")
    .update({ status: d.status, mp_payment_id: d.status === "approved" ? paymentId : null })
    .eq("id", row.id)
    .eq("provider_key", "talo")
    .in("status", from)
    .select("id");

  if (changed && changed.length > 0) {
    await admin.from("audit_logs").insert({
      tenant_id: row.tenant_id,
      actor_user_id: actor,
      entity_type: "mp_payment_intents",
      entity_id: row.id,
      action: `talo_payment_${d.status}`,
      after_data: {
        payment_id: paymentId,
        state: d.state,
        reason: d.reason ?? null,
        amount: Number(row.amount),
        paid: d.paid,
        overpaid: d.overpaid ?? null,
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
  return { status: f?.status ?? d.status, mp_payment_id: f?.mp_payment_id ?? null, ...extra };
}

/** Devoluciones en curso del intent: estado según el pago re-consultado. */
export async function reconcileRefunds(admin: Admin, row: IntentRow, payment: unknown): Promise<void> {
  if (!lastRefund(payment)) return;
  const { data } = await admin
    .from("talo_refunds")
    .select("id, refund_ref, status")
    .eq("intent_id", row.id)
    .eq("status", "initiated");
  for (const rf of (data ?? []) as { id: string; refund_ref: string | null; status: string }[]) {
    if (!rf.refund_ref) continue;
    const next = refundStatusByRef(payment, rf.refund_ref);
    if (!next || next === "initiated") continue;
    const { data: changed } = await admin
      .from("talo_refunds")
      .update({ status: next, error_code: next === "failed" ? "talo_refund_failed" : null })
      .eq("id", rf.id)
      .eq("status", "initiated")
      .select("id");
    if (changed && changed.length > 0) {
      await admin.from("audit_logs").insert({
        tenant_id: row.tenant_id,
        actor_user_id: null,
        entity_type: "talo_refunds",
        entity_id: rf.id,
        action: `talo_refund_${next}`,
        after_data: { intent_id: row.id, payment_id: row.preference_id, via: "sync" },
      });
    }
  }
}
