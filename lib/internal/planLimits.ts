// =============================================================================
// Límites del plan en la ficha del negocio (ADR-120): límite del plan,
// override del negocio, efectivo y uso. Lógica pura para TenantLimitsCard,
// espejo de internal_tenant_limits / internal_set_limit_overrides. Un límite
// null (o ausente) en el plan es ilimitado, igual que tenant_limit_for.
// Se testea en tests/unit/planLimits.test.ts.
// =============================================================================

export type LimitKey = "max_stores" | "max_registers_per_store" | "max_users" | "max_products" | "max_sales_per_month";

export const LIMIT_META: Record<LimitKey, { label: string; hint: string; unit: string }> = {
  max_stores: { label: "Sucursales", hint: "Sucursales activas", unit: "sucursales" },
  max_registers_per_store: { label: "Cajas por sucursal", hint: "En la sucursal con más cajas", unit: "cajas" },
  max_users: { label: "Usuarios", hint: "Miembros activos del equipo", unit: "usuarios" },
  max_products: { label: "Productos", hint: "Productos del catálogo", unit: "productos" },
  max_sales_per_month: { label: "Ventas por mes", hint: "Ventas de este mes sin anular", unit: "ventas" },
};

export interface LimitRowInput {
  key: LimitKey;
  plan_value: number | null;
  override: number | null;
  usage: number;
}

/** Límite que rige: el override si hay; si no, el del plan (null = ilimitado). */
export function effectiveLimit(row: Pick<LimitRowInput, "plan_value" | "override">): number | null {
  return row.override ?? row.plan_value;
}

export type UsageTone = "ok" | "near" | "over" | "unlimited";

/** Semáforo del uso contra el límite efectivo: 80 % o más avisa, 100 % o más excede. */
export function usageTone(usage: number, limit: number | null): UsageTone {
  if (limit === null) return "unlimited";
  if (limit <= 0) return usage > 0 ? "over" : "near";
  const ratio = usage / limit;
  if (ratio >= 1) return "over";
  if (ratio >= 0.8) return "near";
  return "ok";
}

/** Porcentaje de uso para la barra (0 a 100). */
export function usagePercent(usage: number, limit: number | null): number {
  if (limit === null || limit <= 0) return limit === 0 && usage > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round((usage / limit) * 100)));
}

/**
 * Texto del input a override: "" = sin override (null), entero desde 0 = el
 * número; cualquier otra cosa es inválida (undefined).
 */
export function parseOverride(text: string): number | null | undefined {
  const t = text.trim();
  if (t === "") return null;
  if (!/^\d{1,9}$/.test(t)) return undefined;
  return Number(t);
}

export interface LimitChange {
  key: LimitKey;
  from: number | null;
  to: number | null;
}

/**
 * Cambios entre los overrides guardados y lo escrito en la grilla. Devuelve el
 * payload para internal_set_limit_overrides ({clave: número | null}), la lista
 * de cambios para la confirmación y las claves con texto inválido.
 */
export function diffOverrides(
  rows: LimitRowInput[],
  drafts: Partial<Record<LimitKey, string>>,
): { payload: Partial<Record<LimitKey, number | null>>; changes: LimitChange[]; invalid: LimitKey[] } {
  const payload: Partial<Record<LimitKey, number | null>> = {};
  const changes: LimitChange[] = [];
  const invalid: LimitKey[] = [];
  for (const r of rows) {
    const text = drafts[r.key];
    if (text === undefined) continue;
    const next = parseOverride(text);
    if (next === undefined) {
      invalid.push(r.key);
      continue;
    }
    if (next === r.override) continue;
    payload[r.key] = next;
    changes.push({ key: r.key, from: r.override, to: next });
  }
  return { payload, changes, invalid };
}

/** "10", "Sin límite" o "Plan (5)" para la confirmación. */
export function describeLimit(value: number | null, planValue: number | null): string {
  if (value === null) return planValue === null ? "Lo del plan (sin límite)" : `Lo del plan (${planValue.toLocaleString("es-AR")})`;
  return value.toLocaleString("es-AR");
}
