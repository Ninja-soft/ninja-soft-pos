// =============================================================================
// _shared/pagos360_server.ts: conexión y sincronización de Pagos360 del lado
// del servidor. La usan la Edge pagos360 (status del POS) y pending_charges_sync
// (cron de cobros en espera, ADR-048): Pagos360 no tiene webhook obligatorio,
// así que un cobro en espera se sincroniza aunque el POS esté cerrado.
//
// Regla conservadora (ADR-028): sólo acredita con state=paid y monto exacto.
// =============================================================================
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { loadProviderSecret } from "./paymentSecrets.ts";

// deno-lint-ignore no-explicit-any
type Admin = SupabaseClient<any, "public", any>;

export interface Pagos360Conn {
  base: string;
  headers: Record<string, string>;
  /** Sucursal de la credencial usada (null = la del negocio, ADR-057). */
  scopeStoreId: string | null;
}

/**
 * API key del tenant + base sandbox/prod. null = sin conectar.
 * ADR-057: `opts.storeId` usa la de la sucursal si tiene; `opts.scopeStoreId`
 * (del intent) la exacta.
 */
export async function loadPagos360(
  admin: Admin,
  tenantId: string,
  opts: { storeId?: string | null; scopeStoreId?: string | null } = {},
): Promise<Pagos360Conn | null> {
  const [loaded, { data: methodRow }] = await Promise.all([
    loadProviderSecret(admin, tenantId, "pagos360", opts),
    admin
      .from("tenant_payment_methods")
      .select("sandbox")
      .eq("tenant_id", tenantId)
      .eq("provider_key", "pagos360")
      .maybeSingle(),
  ]);
  const apiKey = ((loaded?.secrets ?? {}) as { api_key?: string }).api_key;
  if (!apiKey) return null;
  return {
    base: methodRow?.sandbox ? "https://api.sandbox.pagos360.com": "https://api.pagos360.com",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    scopeStoreId: loaded?.scopeStoreId ?? null,
  };
}

export type Pagos360Sync =
  | { ok: true; status: string; mp_payment_id: string | null; state?: string }
  | { ok: false; error: string; detail?: string };

/**
 * Re-consulta la solicitud de pago y sincroniza el intent. Un intent que ya no
 * está pending se devuelve tal cual (idempotente).
 */
export async function syncPagos360Intent(
  admin: Admin,
  conn: Pagos360Conn,
  tenantId: string,
  intentId: string,
): Promise<Pagos360Sync> {
  const { data: row } = await admin
    .from("mp_payment_intents")
    .select("id, status, amount, preference_id, mp_payment_id")
    .eq("id", intentId)
    .eq("tenant_id", tenantId)
    .eq("provider_key", "pagos360")
    .maybeSingle();
  if (!row) return { ok: false, error: "intent_not_found" };
  if (row.status !== "pending") {
    return { ok: true, status: row.status, mp_payment_id: row.mp_payment_id };
  }
  if (!row.preference_id) return { ok: true, status: "pending", mp_payment_id: null };

  const r = await fetch(`${conn.base}/payment-request/${row.preference_id}`, { headers: conn.headers });
  if (!r.ok) return { ok: false, error: "pagos360_error", detail: (await r.text()).slice(0, 300) };
  const pr = (await r.json()) as { state?: string; first_total?: number };
  const state = String(pr.state ?? "").toLowerCase();

  if (state === "paid") {
    const amountOk = Math.abs(Number(pr.first_total ?? 0) - Number(row.amount)) < 0.01;
    if (amountOk) {
      await admin
        .from("mp_payment_intents")
        .update({ status: "approved", mp_payment_id: String(row.preference_id) })
        .eq("id", row.id)
        .eq("status", "pending");
      return { ok: true, status: "approved", mp_payment_id: String(row.preference_id) };
    }
    await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", row.id).eq("status", "pending");
    return { ok: true, status: "rejected", mp_payment_id: null };
  }
  if (["expired", "canceled", "cancelled", "reverted"].includes(state)) {
    await admin.from("mp_payment_intents").update({ status: "cancelled" }).eq("id", row.id).eq("status", "pending");
    return { ok: true, status: "cancelled", mp_payment_id: null };
  }
  return { ok: true, status: "pending", mp_payment_id: null, state };
}
