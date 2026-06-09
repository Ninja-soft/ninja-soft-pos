import { createClient } from "@/lib/supabase/client";

// =============================================================================
// Cliente tipado del cobro de la SUSCRIPCIÓN a NinjaSoft (preapproval de Mercado
// Pago) para el dueño del tenant. Envuelve:
//   • mp_subscription_checkout      → crea/recrea el preapproval (plan + addons)
//                                     y devuelve el init_point al que redirigir.
//   • mp_update_subscription_amount → sincroniza el monto del preapproval con el
//                                     total real tras activar/cancelar un addon.
//   • mp_subscription_manage        → estado del medio de pago + URL para cambiar
//                                     la tarjeta del preapproval.
//   • owner_billing_summary (RPC)   → si ya hay preapproval + total calculado.
// Todas las Edge Functions son verify_jwt=true y validan que el invocador sea el
// owner del tenant (o staff). El front nunca toca el access_token de plataforma.
// =============================================================================

export interface BillingBreakdown {
  billing_cycle: string;
  currency: string;
  plan_amount: number;
  addons_amount: number;
  addons_monthly: number;
  total: number;
}

export interface OwnerBillingSummary {
  has_preapproval: boolean;
  preapproval_id: string | null;
  subscription_status: string | null;
  billing: BillingBreakdown | null;
}

export interface SubscriptionPaymentMethod {
  has_preapproval: boolean;
  preapproval_id?: string;
  status?: string | null;
  payment_method_id?: string | null;
  card_id?: string | null;
  next_payment_date?: string | null;
  manage_url?: string;
  // true cuando hay preapproval pero MP no respondió (preapproval viejo/cancelado
  // o MP caído): igual viene un manage_url de fallback para no romper la UI.
  mp_unavailable?: boolean;
}

// Resumen de cobro del dueño (RPC). Devuelve null si no es owner / sin sub.
export async function fetchOwnerBillingSummary(): Promise<OwnerBillingSummary | null> {
  const supabase = createClient();
  const { data, error } = await (supabase.rpc as unknown as (
    fn: string,
  ) => Promise<{ data: unknown; error: { message?: string } | null }>)(
    "owner_billing_summary",
  );
  if (error) throw new Error(error.message ?? "error");
  return (data as OwnerBillingSummary | null) ?? null;
}

// Crea (o recrea) el preapproval del dueño y devuelve el init_point de MP al que
// hay que redirigir para autorizar el pago. back_url: a dónde vuelve MP después.
export async function startOwnerSubscriptionCheckout(
  backUrl: string,
): Promise<string> {
  const supabase = createClient();
  const { data, error } = await supabase.functions.invoke(
    "mp_subscription_checkout",
    { body: { back_url: backUrl } },
  );
  if (error) throw error;
  const res = data as { init_point?: string; error?: string };
  if (res?.error || !res?.init_point) throw new Error(res?.error ?? "no_init_point");
  return res.init_point;
}

// Sincroniza el monto del preapproval con el total real (plan + addons). No falla
// si todavía no hay preapproval (devuelve reason: "no_preapproval"). Best-effort:
// se llama tras activar/cancelar un addon.
export async function syncSubscriptionAmount(): Promise<{
  ok: boolean;
  reason?: string;
  amount?: number;
}> {
  const supabase = createClient();
  const { data, error } = await supabase.functions.invoke(
    "mp_update_subscription_amount",
    { body: {} },
  );
  if (error) throw error;
  const res = data as { ok?: boolean; reason?: string; amount?: number; error?: string };
  if (res?.error) throw new Error(res.error);
  return { ok: Boolean(res?.ok), reason: res?.reason, amount: res?.amount };
}

// Estado del medio de pago de la suscripción + URL para cambiar la tarjeta.
export async function fetchSubscriptionPaymentMethod(): Promise<SubscriptionPaymentMethod> {
  const supabase = createClient();
  const { data, error } = await supabase.functions.invoke(
    "mp_subscription_manage",
    { body: {} },
  );
  if (error) throw error;
  const res = data as SubscriptionPaymentMethod & { error?: string };
  if (res?.error) throw new Error(res.error);
  return res;
}

// PAUSA / REANUDA / CANCELA el preapproval en Mercado Pago para que el cobro
// recurrente FRENE (o retome) de verdad al cancelar/reactivar la suscripción.
// El RPC SQL (set_cancel_at_period_end / request_account_closure) ya marcó el
// estado local; esta función lo refleja en MP. Best-effort: no rompe el flujo si
// no hay preapproval (trial) o si MP no responde — la baja local ya quedó. El
// front la llama tras el RPC de cancelar/reactivar.
//   • action "pause"  → status:"paused"    (default; baja a-fin-de-período)
//   • action "resume" → status:"authorized" (deshacer la baja)
//   • action "cancel" → status:"cancelled"  (cancelación dura)
export async function setSubscriptionPreapprovalPaused(
  action: "pause" | "resume" | "cancel" = "pause",
): Promise<{ ok: boolean; reason?: string; mp_unavailable?: boolean }> {
  const supabase = createClient();
  const { data, error } = await supabase.functions.invoke(
    "mp_subscription_pause",
    { body: { action } },
  );
  if (error) throw error;
  const res = data as {
    ok?: boolean;
    reason?: string;
    mp_unavailable?: boolean;
    error?: string;
  };
  if (res?.error) throw new Error(res.error);
  return {
    ok: Boolean(res?.ok),
    reason: res?.reason,
    mp_unavailable: res?.mp_unavailable,
  };
}
