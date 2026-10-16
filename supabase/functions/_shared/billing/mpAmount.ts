// =============================================================================
// Monto del débito automático de Mercado Pago y reglas de addons (ADR-156).
// Lógica pura, sin red ni base. La usan mp_update_subscription_amount,
// mp_billing_webhook y mp_subscription_checkout (Deno) y, por
// lib/billing/mpAmount.ts, las pantallas y los tests (Node).
//
// Espejos en SQL (migración 20261224100000_addon_email_cobro):
//   · addonBillable   ↔ platform_addon_billable
//   · addonUsable     ↔ platform_addon_usable
//   · addonPriceOn    ↔ platform_addon_price_on
//   · expectedAmount  ↔ platform_mp_expected_amount (amount)
// =============================================================================

/** ¿Se factura el addon en un cobro con fecha `at` (YYYY-MM-DD)? */
export function addonBillable(
  status: string,
  cancelAtPeriodEnd: boolean | null | undefined,
  periodEnd: string | null | undefined,
  at: string,
): boolean {
  if (status !== "active") return false;
  if (!cancelAtPeriodEnd || !periodEnd) return true;
  return String(periodEnd).slice(0, 10) > at;
}

/** ¿Se puede usar el addon el día `today`? (hasta el fin de su período inclusive). */
export function addonUsable(
  status: string,
  cancelAtPeriodEnd: boolean | null | undefined,
  periodEnd: string | null | undefined,
  today: string,
): boolean {
  if (status !== "active") return false;
  if (!cancelAtPeriodEnd || !periodEnd) return true;
  return String(periodEnd).slice(0, 10) >= today;
}

export interface AddonPriceInput {
  source: string;
  monthly_price_ars: number | null;
  catalog_price_ars?: number | null;
  trial_ends_at?: string | null;
  pending_price_ars?: number | null;
  pending_from?: string | null;
}

/** Precio mensual del addon en un cobro con fecha `at`. */
export function addonPriceOn(a: AddonPriceInput, at: string): number {
  if (a.source === "granted") return 0;
  if (a.trial_ends_at && String(a.trial_ends_at).slice(0, 10) > at) return 0;
  if (a.pending_from && a.pending_price_ars != null && String(a.pending_from).slice(0, 10) <= at) {
    return Number(a.pending_price_ars);
  }
  return Number(a.monthly_price_ars ?? a.catalog_price_ars ?? 0) || 0;
}

/** Próximo débito: total del período + ajustes abiertos (centavos), en pesos. */
export function expectedAmount(periodTotal: number, adjustmentsCents: number): number {
  const total = Math.round((Number(periodTotal) || 0) * 100) + Math.max(0, Math.round(adjustmentsCents || 0));
  return total / 100;
}

/** ¿Hay que actualizar el monto del preapproval? (al centavo). */
export function needsAmountSync(expected: number, synced: number | null | undefined): boolean {
  if (!(expected > 0)) return false;
  if (synced == null || !Number.isFinite(Number(synced))) return true;
  return Math.round(expected * 100) !== Math.round(Number(synced) * 100);
}

/**
 * Fecha de inicio del débito para el checkout: si el negocio está en prueba y
 * le queda más de una hora, el primer cobro se difiere al fin de la prueba
 * (MP no cobra nada hasta esa fecha). Si no, null (cobro inmediato).
 */
export function debitStartDate(input: {
  status: string | null | undefined;
  trialEndsAt: string | null | undefined;
  now?: Date;
}): string | null {
  if (input.status !== "trial" || !input.trialEndsAt) return null;
  const end = new Date(input.trialEndsAt);
  const now = input.now ?? new Date();
  if (!Number.isFinite(end.getTime()) || end.getTime() - now.getTime() <= 3600_000) return null;
  return end.toISOString();
}

/**
 * Clave idempotente de un cobro recurrente. La autorización del preapproval y
 * la búsqueda de cobros usan la MISMA clave que la notificación del cobro, así
 * un pago nunca se acredita dos veces.
 */
export function authorizedPaymentKey(ap: { id?: string | number | null; payment?: { id?: string | number | null } | null }): string | null {
  const id = ap.payment?.id ?? ap.id;
  return id == null || id === "" ? null : `authpay:${String(id)}`;
}
