// Garantías extendidas por tipo (ADR-139). Lógica PURA, espejo exacto de la
// migración 20261205100000_garantias_extendidas_tipos:
//   warrantyUnitPrice  ⇔ warranty_unit_price(...)
//   resolvePlanScope   ⇔ _warranty_plan_resolve(tipo, producto)
// El POS y la vista previa calculan con esto; create_sale (vía el trigger de
// sale_items) vuelve a calcular y rechaza cualquier diferencia. Sin imports con
// alias: la prueba en PGlite lo importa directo.

export interface WarrantyPricing {
  /** % sobre el precio unitario del producto (0 = usa la prima fija). */
  price_pct: number | string | null;
  /** Prima fija por unidad. */
  price: number | string | null;
  min_price?: number | string | null;
  max_price?: number | string | null;
  /** Múltiplo al que se redondea (0 = centavos). */
  rounding_step?: number | string | null;
}

export interface WarrantyTypeLike extends WarrantyPricing {
  id: string;
  label: string;
  months: number;
  applies_to_all?: boolean | null;
  is_active?: boolean | null;
  deleted_at?: string | null;
  sort?: number | null;
  description?: string | null;
  terms?: string | null;
}

export type ScopeEffect = "include" | "exclude";

export interface WarrantyScopeLike {
  plan_id: string;
  category_id: string | null;
  product_id: string | null;
  effect: ScopeEffect;
  deleted_at?: string | null;
}

export interface CategoryNodeLike {
  id: string;
  parent_id: string | null;
  name?: string;
  deleted_at?: string | null;
}

export interface ProductRef {
  id: string;
  categoryId: string | null;
}

export type ScopeReason =
  | "product_include"
  | "product_exclude"
  | "category_include"
  | "category_exclude"
  | "all"
  | "not_assigned";

export interface ScopeResolution {
  applies: boolean;
  reason: ScopeReason;
  /** Categoría que decidió (reason category_*). */
  categoryId?: string;
}

/** Mismo tope de profundidad que el CTE recursivo de SQL (depth < 12). */
const MAX_DEPTH = 12;

const num = (v: number | string | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const optNum = (v: number | string | null | undefined): number | null =>
  v === null || v === undefined || v === "" ? null : num(v);

/** Redondeo a centavos "half away from zero" como numeric de Postgres. */
export function round2(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n) * 100 + 1e-7) / 100;
}

/**
 * Prima por UNIDAD: % del precio (o la fija si el % es 0), redondeada al
 * múltiplo más cercano del paso (0 = centavos) y acotada por mínimo y máximo.
 * Producto a $0 o menos (regalo, pack) = 0, sin garantía.
 */
export function warrantyUnitPrice(plan: WarrantyPricing, unitPrice: number): number {
  if (!(unitPrice > 0)) return 0;
  const pct = num(plan.price_pct);
  const raw = pct > 0 ? (unitPrice * pct) / 100 : num(plan.price);
  const step = num(plan.rounding_step);
  const stepped = step > 0 ? Math.round(raw / step + 1e-9) * step : round2(raw);
  const min = optNum(plan.min_price);
  const max = optNum(plan.max_price);
  let v = Math.max(stepped, min ?? 0);
  if (max !== null) v = Math.min(v, max);
  return round2(v);
}

/** Prima total de la línea cubierta (unidad x cantidad), como valida el servidor. */
export function warrantyLinePrice(plan: WarrantyPricing, unitPrice: number, quantity: number): number {
  return round2(warrantyUnitPrice(plan, unitPrice) * quantity);
}

/** Cadena de categorías vivas desde la del producto hacia la raíz. */
export function categoryChain(categoryId: string | null, categories: CategoryNodeLike[]): string[] {
  if (!categoryId) return [];
  const byId = new Map(categories.filter((c) => !c.deleted_at).map((c) => [c.id, c]));
  const out: string[] = [];
  let cur = byId.get(categoryId);
  while (cur && out.length < MAX_DEPTH + 1) {
    out.push(cur.id);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return out;
}

/**
 * ¿El tipo alcanza al producto? Precedencia: producto > categoría más
 * específica (subiendo por el árbol) > "todos los productos".
 */
export function resolvePlanScope(
  plan: Pick<WarrantyTypeLike, "id" | "applies_to_all">,
  scopes: WarrantyScopeLike[],
  product: ProductRef,
  categories: CategoryNodeLike[],
): ScopeResolution {
  const live = scopes.filter((s) => s.plan_id === plan.id && !s.deleted_at);
  const own = live.find((s) => s.product_id === product.id);
  if (own) return { applies: own.effect === "include", reason: own.effect === "include" ? "product_include" : "product_exclude" };
  for (const catId of categoryChain(product.categoryId, categories)) {
    const s = live.find((x) => x.category_id === catId);
    if (s) {
      return {
        applies: s.effect === "include",
        reason: s.effect === "include" ? "category_include" : "category_exclude",
        categoryId: catId,
      };
    }
  }
  const all = plan.applies_to_all ?? true;
  return { applies: all, reason: all ? "all" : "not_assigned" };
}

export interface WarrantyOffer {
  plan: WarrantyTypeLike;
  /** Prima por unidad. */
  unitPrice: number;
  /** Prima de la línea (unidad x cantidad). */
  total: number;
  resolution: ScopeResolution;
}

/** Tipos vivos y activos que se ofrecen para un producto, con su precio, en orden. */
export function offersForProduct(
  plans: WarrantyTypeLike[],
  scopes: WarrantyScopeLike[],
  categories: CategoryNodeLike[],
  product: ProductRef,
  unitPrice: number,
  quantity = 1,
): WarrantyOffer[] {
  return sortPlans(plans.filter((p) => !p.deleted_at && (p.is_active ?? true)))
    .map((plan) => {
      const resolution = resolvePlanScope(plan, scopes, product, categories);
      const unit = warrantyUnitPrice(plan, unitPrice);
      return { plan, unitPrice: unit, total: round2(unit * quantity), resolution };
    })
    .filter((o) => o.resolution.applies && o.unitPrice > 0);
}

export function sortPlans<T extends Pick<WarrantyTypeLike, "sort" | "label">>(plans: T[]): T[] {
  return [...plans].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.label.localeCompare(b.label, "es"));
}

/**
 * Vencimiento (YYYY-MM-DD): fecha de la venta en hora de Argentina + meses de
 * fábrica + meses del tipo. Igual que Postgres (date + interval 'n months'):
 * si el día no existe en el mes de llegada, queda el último día del mes.
 */
export function warrantyExpiry(soldAt: Date | string, factoryMonths: number, planMonths: number): string {
  const d = typeof soldAt === "string" ? new Date(soldAt) : soldAt;
  const ar = arDateParts(d);
  const total = Math.max(0, Math.trunc(factoryMonths || 0)) + Math.max(0, Math.trunc(planMonths || 0));
  const m0 = ar.month - 1 + total;
  const y = ar.year + Math.floor(m0 / 12);
  const m = ((m0 % 12) + 12) % 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(ar.day, last);
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function arDateParts(d: Date): { year: number; month: number; day: number } {
  // Argentina no tiene horario de verano: UTC-3 fijo.
  const t = new Date(d.getTime() - 3 * 3600 * 1000);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** "15/10/2028" a partir de "2028-10-15". */
export function formatDateAr(iso: string | null | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return y && m && d ? `${d}/${m}/${y}` : "";
}

/** Texto corto del precio de un tipo: "12% del precio", "$ 15.000 fijo". */
export function pricingSummary(plan: WarrantyPricing, money: (n: number) => string): string {
  const pct = num(plan.price_pct);
  const base = pct > 0 ? `${trimNum(pct)}% del precio` : `${money(num(plan.price))} por unidad`;
  const parts = [base];
  const min = optNum(plan.min_price);
  const max = optNum(plan.max_price);
  if (min !== null && min > 0) parts.push(`mín. ${money(min)}`);
  if (max !== null) parts.push(`máx. ${money(max)}`);
  const step = num(plan.rounding_step);
  if (step > 0) parts.push(`redondeo a ${money(step)}`);
  return parts.join(" · ");
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "").replace(".", ",");
}

export function monthsLabel(n: number): string {
  return `${n} ${n === 1 ? "mes" : "meses"}`;
}
