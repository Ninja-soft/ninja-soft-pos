// lib/commercial/governance.ts
//
// Maker-checker de cambios comerciales (F14 · H63, ADR-092). PURO.
//
// Espejo de _promo_impact_pct / _promo_high_impact y de la regla del trigger
// trg_commercial_maker_checker (migración 20261109200100). El servidor es la
// fuente de verdad; esto alimenta la UI (aviso "queda pendiente") y los tests.

export type PromoMode = "off" | "high_impact" | "all";
export type SurchargeMode = "off" | "all";
export type RequestStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled";
export type RequestEntity = "promotions" | "payment_plans";

export interface Governance {
  enabled: boolean;
  promo_mode: PromoMode;
  promo_pct: number;
  promo_amount: number | null;
  surcharge_mode: SurchargeMode;
  request_ttl_days: number;
  has_feature?: boolean;
}

export const DEFAULT_GOVERNANCE: Governance = {
  enabled: false,
  promo_mode: "high_impact",
  promo_pct: 20,
  promo_amount: null,
  surcharge_mode: "all",
  request_ttl_days: 7,
};

/** Forma mínima de una promoción para estimar su impacto. */
export interface PromoImpactInput {
  action_type: string;
  action_value?: number | null;
  buy_qty?: number | null;
  pay_qty?: number | null;
  volume_tiers?: { min_qty?: number; pct?: number }[] | null;
  max_discount?: number | null;
}

const clampPct = (n: number) => Math.min(Math.max(n, 0), 100);
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * % máximo estimado sobre las unidades alcanzadas. null si no se puede
 * estimar (monto fijo, precio fijo, combo, regalo).
 */
export function promoImpactPct(p: PromoImpactInput): number | null {
  const v = Number(p.action_value ?? 0) || 0;
  switch (p.action_type) {
    case "percent":
      return clampPct(v);
    case "second_item":
      return r2(clampPct(v) / 2);
    case "nxm": {
      const buy = Math.trunc(Number(p.buy_qty ?? 0));
      const pay = Math.trunc(Number(p.pay_qty ?? 0));
      return buy >= 2 && pay >= 1 && pay < buy ? r2(((buy - pay) * 100) / buy) : 0;
    }
    case "volume_tier": {
      let max = 0;
      for (const t of p.volume_tiers ?? []) max = Math.max(max, Math.min(Number(t?.pct ?? 0) || 0, 100));
      return max;
    }
    default:
      return null;
  }
}

/** ¿La promo necesita aprobación con esta política? */
export function isHighImpactPromo(
  p: PromoImpactInput,
  g: Pick<Governance, "promo_mode" | "promo_pct" | "promo_amount">,
): boolean {
  if (g.promo_mode === "all") return true;
  if (g.promo_mode === "off") return false;
  const cap = p.max_discount;
  if (cap != null && g.promo_amount != null && cap <= g.promo_amount) return false;
  const pct = promoImpactPct(p);
  if (pct != null) return pct >= g.promo_pct;
  if (p.action_type === "amount" && g.promo_amount != null) return (Number(p.action_value ?? 0) || 0) > g.promo_amount;
  return true;
}

export type MakerRole = "owner" | "manager" | "cashier" | "viewer" | null | undefined;

/**
 * ¿El guardado de este rol queda pendiente? Espejo del trigger: sólo el
 * encargado, con el circuito prendido y la feature, y sólo si lo que queda
 * es activo.
 */
export function needsApproval(args: {
  role: MakerRole;
  governance: Governance | null | undefined;
  entity: RequestEntity;
  willBeActive: boolean;
  promo?: PromoImpactInput | null;
}): boolean {
  const g = args.governance;
  if (args.role !== "manager" || !g || !g.enabled || g.has_feature === false) return false;
  if (!args.willBeActive) return false;
  if (args.entity === "payment_plans") return g.surcharge_mode !== "off";
  return args.promo ? isHighImpactPromo(args.promo, g) : g.promo_mode !== "off";
}

const COSMETIC: Record<RequestEntity, string[]> = {
  promotions: ["name", "ticket_label", "priority"],
  payment_plans: ["label", "sort"],
};
const IGNORED = new Set(["id", "tenant_id", "created_at", "updated_at"]);

/** Columnas que cambian entre dos versiones de la fila (lo que se propone). */
export function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of Object.keys(after)) {
    if (IGNORED.has(k)) continue;
    if (JSON.stringify(after[k] ?? null) !== JSON.stringify(before[k] ?? null)) out.push(k);
  }
  return out;
}

/** Ya activa y sólo cambia lo cosmético: pasa sin aprobación. */
export function isCosmeticOnly(entity: RequestEntity, wasActive: boolean, fields: string[]): boolean {
  return wasActive && fields.length > 0 && fields.every((f) => COSMETIC[entity].includes(f));
}

/** Estado visible: una pendiente vencida se muestra como vencida. */
export function effectiveStatus(status: RequestStatus, expiresAt: string, now: Date = new Date()): RequestStatus {
  return status === "pending" && new Date(expiresAt).getTime() <= now.getTime() ? "expired" : status;
}

export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  pending: "Pendiente",
  approved: "Aprobada",
  rejected: "Rechazada",
  expired: "Vencida",
  cancelled: "Cancelada",
};

export const ENTITY_LABEL: Record<RequestEntity, string> = {
  promotions: "Promoción",
  payment_plans: "Plan de cuotas",
};

const FIELD_LABEL: Record<string, string> = {
  is_active: "Activa",
  name: "Nombre",
  label: "Nombre",
  action_type: "Tipo de beneficio",
  action_value: "Valor",
  max_discount: "Tope por ticket",
  surcharge_pct: "Recargo %",
  installments: "Cuotas",
  brand: "Marca",
  base: "Tarjeta",
  provider_key: "Medio",
  store_id: "Sucursal",
  valid_from: "Desde",
  valid_to: "Hasta",
  valid_until: "Hasta",
  buy_qty: "Lleva",
  pay_qty: "Paga",
  volume_tiers: "Escalas",
  min_amount: "Compra mínima",
  scope: "Alcance",
};

export function fieldLabel(key: string): string {
  return FIELD_LABEL[key] ?? key.replace(/_/g, " ");
}

/** Valor legible para la bandeja (antes y propuesto). */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "Sin valor";
  if (typeof v === "boolean") return v ? "Sí" : "No";
  if (typeof v === "number") return String(v).replace(".", ",");
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/** Mensaje de error del servidor para el circuito. */
export function governanceErrorMessage(e: unknown): string {
  const msg = String((e as { message?: string } | null)?.message ?? e ?? "");
  if (/feature_not_in_plan: aprobaciones_comerciales/.test(msg)) return "Tu plan no incluye la aprobación de cambios comerciales.";
  if (/reason_required/.test(msg)) return "Contá por qué lo rechazás.";
  if (/request_not_pending/.test(msg)) return "La solicitud ya no está pendiente.";
  if (/entity_not_found/.test(msg)) return "La promoción o el plan ya no existe.";
  if (/forbidden/.test(msg)) return "Sólo el dueño puede hacer esto.";
  return "No se pudo completar la acción.";
}
