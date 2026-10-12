// =============================================================================
// Planes de cuotas por sucursal (F17 · H93 · ADR-057). Lógica pura.
//
// Un plan del negocio (store_id null) vale en todas las sucursales. Un plan de
// sucursal con el mismo medio y code (base + marca + cuotas) lo pisa en esa
// sucursal: con otro recargo, otra vigencia, o inactivo para ocultarlo. Lo que
// la sucursal no pisa lo hereda. Sin multi_sucursal en el plan, los planes de
// sucursal no se aplican (no se borran). Mismo criterio que la función SQL
// effective_payment_plans.
// =============================================================================

export interface ScopedPlanRow {
  id: string;
  provider_key: string | null;
  code: string | null;
  store_id?: string | null;
  is_active: boolean;
}

export type PlanOrigin = "tenant" | "store" | "hidden";

/** Clave de herencia: mismo medio y misma combinación. */
export function planKey(p: Pick<ScopedPlanRow, "provider_key" | "code" | "id">): string {
  return `${p.provider_key ?? ""}|${p.code ?? `#${p.id}`}`;
}

/**
 * Fila que gana por clave para una sucursal (activa o no). La de la sucursal
 * pisa a la del negocio; las de otras sucursales se ignoran.
 */
export function winningPlans<T extends ScopedPlanRow>(
  rows: T[],
  storeId: string | null,
  multiStore = true,
): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of rows) {
    const sid = r.store_id ?? null;
    if (sid !== null && (!multiStore || !storeId || sid !== storeId)) continue;
    const k = planKey(r);
    const prev = out.get(k);
    if (!prev || (sid !== null && (prev.store_id ?? null) === null)) out.set(k, r);
  }
  return out;
}

/** Planes efectivos (activos) de una sucursal, en el orden de entrada. */
export function effectivePlans<T extends ScopedPlanRow>(
  rows: T[],
  storeId: string | null,
  multiStore = true,
): T[] {
  const win = winningPlans(rows, storeId, multiStore);
  const keep = new Set<T>(win.values());
  return rows.filter((r) => keep.has(r) && r.is_active);
}

export interface PlanCellState<T extends ScopedPlanRow> {
  /** Fila efectiva (la que se ofrece o la que la oculta). */
  plan: T | undefined;
  /** Fila del negocio para esa combinación (el valor heredado). */
  inherited: T | undefined;
  origin: PlanOrigin | null;
}

/**
 * Estado de una celda del editor para un alcance: null = negocio.
 * - tenant: viene del negocio (en el alcance negocio, es la propia).
 * - store: la sucursal la pisa con una fila activa.
 * - hidden: la sucursal la oculta (fila inactiva).
 */
export function cellState<T extends ScopedPlanRow>(
  rows: T[],
  scopeStoreId: string | null,
  providerKey: string,
  code: string,
): PlanCellState<T> {
  const mine = rows.filter((r) => r.provider_key === providerKey && r.code === code);
  const inherited = mine.find((r) => (r.store_id ?? null) === null);
  if (!scopeStoreId) {
    return { plan: inherited, inherited, origin: inherited ? "tenant" : null };
  }
  const own = mine.find((r) => r.store_id === scopeStoreId);
  if (own) return { plan: own, inherited, origin: own.is_active ? "store" : "hidden" };
  return { plan: inherited, inherited, origin: inherited ? "tenant" : null };
}

/**
 * Qué hacer al vaciar una celda en una sucursal: si el negocio ofrece ese
 * plan, la sucursal lo oculta (fila inactiva); si no, se borra la fila propia.
 */
export function clearActionForBranch(state: PlanCellState<ScopedPlanRow>): "hide" | "delete" | "none" {
  if (state.origin === "store") return state.inherited ? "hide" : "delete";
  if (state.origin === "tenant") return "hide";
  return "none";
}

/** Resumen para el selector de alcance: cuántas combinaciones pisa cada sucursal. */
export function overridesByStore(rows: ScopedPlanRow[], providerKey: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.provider_key !== providerKey || !r.store_id) continue;
    out[r.store_id] = (out[r.store_id] ?? 0) + 1;
  }
  return out;
}
