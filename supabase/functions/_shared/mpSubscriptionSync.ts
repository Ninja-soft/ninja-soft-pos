// =============================================================================
// Sincronización del monto del débito automático de Mercado Pago (ADR-156).
//
// El monto del próximo débito lo decide la base (platform_mp_expected_amount:
// total del período que arranca en la fecha del cobro + ajustes abiertos que
// vencen hasta esa fecha). Acá sólo se refleja en el preapproval con
// PUT /preapproval/{id} (auto_recurring.transaction_amount, sin recrearlo) y
// se guarda lo sincronizado en subscriptions.mp_amount_synced.
//
// La usan mp_update_subscription_amount (dueño, staff y cron diario) y
// mp_billing_webhook (después de acreditar un cobro, para volver al monto
// normal cuando se cobró un ajuste). Nunca hace cobros: sólo cambia el monto
// de los débitos futuros.
// =============================================================================
import { needsAmountSync } from "./billing/mpAmount.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;

export interface SyncResult {
  ok: boolean;
  reason?: string;
  amount?: number;
  preapproval_id?: string;
  detail?: string;
}

interface Expected {
  applies?: boolean;
  reason?: string | null;
  amount?: number | string;
  synced_amount?: number | string | null;
  preapproval_id?: string | null;
  period_total?: number | string;
  adjustments_cents?: number | string;
  next_charge_date?: string | null;
}

export async function platformMpToken(admin: Admin): Promise<string | null> {
  const { data } = await admin.from("platform_secrets").select("secrets").eq("key", "mercadopago").maybeSingle();
  return ((data?.secrets ?? {}) as { access_token?: string }).access_token ?? null;
}

/**
 * Lleva el monto del preapproval del negocio al esperado. `force` hace el PUT
 * aunque lo guardado ya coincida (el dueño acaba de cambiar algo).
 */
export async function syncPreapprovalAmount(
  admin: Admin,
  tenantId: string,
  opts: { actorId: string | null; via: string; force?: boolean; accessToken?: string | null },
): Promise<SyncResult> {
  const { data, error } = await admin.rpc("platform_mp_expected_amount", { p_tenant: tenantId });
  let e: Expected | null = (data ?? null) as Expected | null;
  if (error) {
    // Sin la migración de ADR-156: comportamiento anterior (total de hoy).
    const { data: sub } = await admin
      .from("subscriptions")
      .select("mp_preapproval_id")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    const { data: billing } = await admin.rpc("subscription_billing_total", { p_tenant: tenantId });
    const pre = String(sub?.mp_preapproval_id ?? "").trim();
    e = {
      applies: Boolean(pre),
      reason: pre ? null : "no_preapproval",
      amount: Number((billing as { total?: number } | null)?.total ?? 0),
      synced_amount: null,
      preapproval_id: pre || null,
    };
  }
  if (!e) return { ok: false, reason: "no_subscription" };
  const amount = Math.round(Number(e.amount ?? 0) * 100) / 100;
  if (!e.applies) return { ok: false, reason: e.reason ?? "not_applicable", amount };
  const preId = String(e.preapproval_id ?? "").trim();
  if (!preId) return { ok: false, reason: "no_preapproval", amount };
  if (!(amount > 0)) {
    // MP no acepta un débito de $ 0 (descuento del 100 %): queda auditado para
    // que el staff pase el negocio a exento o pause el débito.
    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: opts.actorId,
      entity_type: "subscriptions",
      entity_id: null,
      action: "subscription_amount_zero",
      after_data: { preapproval_id: preId, via: opts.via },
    });
    return { ok: false, reason: "zero_amount", amount, preapproval_id: preId };
  }
  const synced = e.synced_amount == null || e.synced_amount === "" ? null : Number(e.synced_amount);
  if (!opts.force && !needsAmountSync(amount, synced)) {
    return { ok: true, reason: "in_sync", amount, preapproval_id: preId };
  }

  const token = opts.accessToken ?? (await platformMpToken(admin));
  if (!token) return { ok: false, reason: "platform_not_configured", amount, preapproval_id: preId };

  let res: Response;
  try {
    res = await fetch(`https://api.mercadopago.com/preapproval/${preId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ auto_recurring: { transaction_amount: amount, currency_id: "ARS" } }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    return { ok: false, reason: "mp_unreachable", amount, preapproval_id: preId, detail: String(err).slice(0, 200) };
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: opts.actorId,
      entity_type: "subscriptions",
      entity_id: null,
      action: "subscription_amount_sync_failed",
      after_data: { preapproval_id: preId, amount, detail, via: opts.via },
    });
    return { ok: false, reason: "mp_error", amount, preapproval_id: preId, detail };
  }

  await admin
    .from("subscriptions")
    .update({ mp_amount_synced: amount, mp_amount_synced_at: new Date().toISOString() })
    .eq("tenant_id", tenantId);
  await admin.from("audit_logs").insert({
    tenant_id: tenantId,
    actor_user_id: opts.actorId,
    entity_type: "subscriptions",
    entity_id: null,
    action: "subscription_amount_synced",
    after_data: {
      preapproval_id: preId,
      amount,
      previous: synced,
      period_total: e.period_total ?? null,
      adjustments_cents: e.adjustments_cents ?? null,
      next_charge_date: e.next_charge_date ?? null,
      via: opts.via,
    },
  });
  return { ok: true, amount, preapproval_id: preId };
}
