// Venta offline (ADR-077): política del dueño y reglas de qué se puede vender
// sin conexión. Espejo del servidor (_offline_sale_checks en
// 20261103200000_venta_offline): el POS no deja guardar lo que el servidor
// mandaría a revisión, y el servidor igual lo revalida todo al sincronizar.

export interface OfflinePolicy {
  /** El dueño permite vender sin conexión. */
  enabled: boolean;
  /** Monto máximo por venta offline (ARS). */
  maxAmount: number;
  /** Ventas offline máximas por turno y usuario. */
  maxSales: number;
  /** Antigüedad máxima (horas) para sincronizar sin revisión. */
  maxHours: number;
}

/** Mismos valores que offline_policy_defaults() en la base. */
export const OFFLINE_POLICY_DEFAULTS: OfflinePolicy = {
  enabled: true,
  maxAmount: 50000,
  maxSales: 20,
  maxHours: 48,
};

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** pos_settings.offline_policy (jsonb, claves snake_case) con defaults. */
export function parseOfflinePolicy(raw: unknown): OfflinePolicy {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const d = OFFLINE_POLICY_DEFAULTS;
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : d.enabled,
    maxAmount: num(o.max_amount) ?? d.maxAmount,
    maxSales: num(o.max_sales) ?? d.maxSales,
    maxHours: num(o.max_hours) ?? d.maxHours,
  };
}

/** Política → jsonb de pos_settings. */
export function offlinePolicyToRaw(p: OfflinePolicy): Record<string, unknown> {
  return { enabled: p.enabled, max_amount: p.maxAmount, max_sales: p.maxSales, max_hours: p.maxHours };
}

/** Mismo criterio que offline_policy_error() en la base. null = válida. */
export function offlinePolicyError(p: OfflinePolicy): string | null {
  if (!Number.isFinite(p.maxAmount) || p.maxAmount < 0 || p.maxAmount > 100_000_000)
    return "El monto máximo tiene que estar entre 0 y 100.000.000";
  if (!Number.isInteger(p.maxSales) || p.maxSales < 1 || p.maxSales > 500)
    return "Las ventas por turno tienen que estar entre 1 y 500";
  if (!Number.isInteger(p.maxHours) || p.maxHours < 1 || p.maxHours > 168)
    return "Las horas máximas tienen que estar entre 1 y 168";
  return null;
}

/** Métodos de venta que se aceptan offline (p_payments.method). */
export const OFFLINE_METHODS = ["cash", "transfer", "debit", "credit"] as const;

/** Lo mínimo de un tender (lib/pos/tenders) para decidir si va offline. */
export interface TenderLike {
  id: string;
  flow: string;
  method: string | null;
  integrated?: unknown;
}

/**
 * Medios manuales sin integración: efectivo, transferencia (con o sin número
 * de operación) y tarjeta en posnet con cupón. Nunca QR, link, Point,
 * terminal (integrada o de la marca), vale, cuenta corriente ni Directo.
 */
export function isTenderAllowedOffline(t: TenderLike): boolean {
  if (t.integrated) return false;
  if (t.flow === "cash") return true;
  if (t.flow === "direct") return t.method === "transfer";
  if (t.flow === "card") return t.id === "card";
  return false;
}

export interface OfflinePaymentLike {
  method: string;
  amount: number;
  card_voucher?: { origen?: string; terminal_tx?: string } | null;
}

export function isPaymentAllowedOffline(p: OfflinePaymentLike): boolean {
  if (!(p.amount > 0)) return true;
  if (!(OFFLINE_METHODS as readonly string[]).includes(p.method)) return false;
  if (p.card_voucher?.origen === "terminal" || p.card_voucher?.terminal_tx) return false;
  return true;
}

export type OfflineBlockReason =
  | "disabled"
  | "no_shift"
  | "no_session"
  | "over_amount"
  | "over_count"
  | "method"
  | "extra"
  | "price_override"
  | "origin";

export interface OfflineSaleCheckInput {
  policy: OfflinePolicy;
  /** Total a cobrar (después de descuentos y promo). */
  total: number;
  /** Ventas offline de este usuario en este turno (en cola o ya enviadas). */
  countInShift: number;
  shiftId: string | null;
  hasSession: boolean;
  payments: OfflinePaymentLike[];
  extraKinds: string[];
  anyPriceOverride: boolean;
  /** Mesa, delivery, cupón, turno de agenda o pack: necesitan al servidor. */
  hasServerOrigin: boolean;
}

export type OfflineSaleCheck = { ok: true } | { ok: false; reason: OfflineBlockReason; message: string };

/** ¿Se puede guardar esta venta offline? Mismo orden que el servidor. */
export function checkOfflineSale(i: OfflineSaleCheckInput): OfflineSaleCheck {
  const fail = (reason: OfflineBlockReason, message: string): OfflineSaleCheck => ({ ok: false, reason, message });
  if (!i.policy.enabled) return fail("disabled", "La venta sin conexión está apagada en este negocio");
  if (!i.hasSession) return fail("no_session", "Iniciá sesión con conexión antes de vender offline");
  if (!i.shiftId) return fail("no_shift", "Sin conexión sólo se vende con la caja ya abierta");
  if (i.total > i.policy.maxAmount + 0.01)
    return fail("over_amount", "La venta supera el monto máximo permitido sin conexión");
  if (i.countInShift >= i.policy.maxSales)
    return fail("over_count", "Llegaste al máximo de ventas sin conexión de este turno");
  if (i.payments.some((p) => !isPaymentAllowedOffline(p)))
    return fail("method", "Sin conexión sólo se cobra en efectivo, transferencia o tarjeta en posnet");
  if (i.extraKinds.some((k) => k === "pack" || k === "pack_session"))
    return fail("extra", "Los packs y sesiones necesitan conexión");
  if (i.anyPriceOverride) return fail("price_override", "El cambio manual de precio necesita conexión");
  if (i.hasServerOrigin) return fail("origin", "Mesas, delivery, cupones y turnos necesitan conexión");
  return { ok: true };
}
