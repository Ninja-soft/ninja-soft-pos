// Resolución de precio por lista (H10 → F18 · H100, ADR-056 y ADR-058).
// Función pura, espejo EXACTO de `_resolve_unit_price` (SQL, migración
// 20261021100200_resolver_listas_pro). La paridad se prueba con la matriz de
// tests/fixtures/priceMatrix.ts contra los dos lados.
//
// `resolvePrice` (legacy) queda para quien sólo tiene una lista con % e ítems.
//
// Orden de `resolveUnitPrice`:
//   1. Lista: la pedida (explícita) o, si no, la elegida en el POS (sólo listas
//      "elegibles en el POS") → cliente → grupo de clientes → sucursal → grupo
//      de sucursales → canal mostrador. Se salta la que está inactiva, borrada o
//      fuera de vigencia (desde <= ahora < hasta).
//   2. Precio base: precio programado vigente del producto o la variante, si
//      no `price_override` de la variante o precio del producto.
//   3. Precio de la lista: programado vigente o ítem puntual (variante →
//      producto); si no hay, según el tipo (PRO): fija (% y monto sobre base),
//      derivada de otra lista (% y monto sobre el precio de la madre), sobre
//      costo (markup o margen) o en moneda extranjera (ítem × cotización).
//      Sin PRO, toda lista se comporta como fija.
//   4. PRO: escala por cantidad (precio fijo o %), recargo de la condición de
//      pago (contado, 30, 60, 90 días), redondeo de la lista sobre lo
//      calculado y piso (precio mínimo del producto y margen mínimo de la lista).
//   5. Siempre a centavos con mitad hacia arriba (igual que Postgres).

import {
  applyRounding,
  fromCents,
  toCents,
  toCentsCeil,
  type RoundingRule,
} from "./rounding";

// ── Legacy ──────────────────────────────────────────────────────────────────

export interface PriceListLike {
  adjustment_pct: number | null;
}

export interface PriceItemLike {
  product_id: string;
  variant_id: string | null;
  price: number;
}

function legacyRound2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function resolvePrice(
  basePrice: number,
  productId: string,
  variantId: string | null,
  list: PriceListLike | null,
  items: PriceItemLike[],
): number {
  if (!list) return basePrice;
  if (variantId) {
    const byVariant = items.find((i) => i.product_id === productId && i.variant_id === variantId);
    if (byVariant) return byVariant.price;
  }
  const byProduct = items.find((i) => i.product_id === productId && i.variant_id === null);
  if (byProduct) return byProduct.price;
  if (list.adjustment_pct != null) return legacyRound2(basePrice * (1 + list.adjustment_pct / 100));
  return basePrice;
}

// ── Modelo PRO ──────────────────────────────────────────────────────────────

export type ListKind = "fixed" | "derived" | "cost" | "currency";
export type ListCostBasis = "cost" | "last" | "average" | "replacement";
export type MarkupMode = "markup" | "margin";

export interface ProPriceList {
  id: string;
  name?: string;
  channel?: string;
  adjustment_pct: number | null;
  adjustment_amount?: number | null;
  kind?: ListKind | null;
  base_list_id?: string | null;
  cost_basis?: ListCostBasis | null;
  markup_mode?: MarkupMode | null;
  markup_value?: number | null;
  currency?: string | null;
  fx_source?: string | null;
  rounding?: RoundingRule | null;
  min_margin_pct?: number | null;
  valid_from?: string | null;
  valid_to?: string | null;
  is_active?: boolean;
  deleted_at?: string | null;
  pos_selectable?: boolean;
  created_at?: string;
}

export interface ProPriceItem {
  price_list_id: string;
  product_id: string;
  variant_id: string | null;
  price: number;
}

export interface PriceScheduleLike {
  id?: string;
  list_id: string | null;
  product_id: string;
  variant_id: string | null;
  price: number;
  effective_at: string;
  status: string;
  created_at?: string;
}

export interface QtyBreak {
  price_list_id: string;
  product_id: string | null;
  variant_id?: string | null;
  min_qty: number;
  kind: "price" | "pct";
  value: number;
}

export interface PaymentTermLike {
  id: string;
  name: string;
  days: number;
  surcharge_pct: number;
  is_active: boolean;
}

export interface FxRateLike {
  currency: string;
  source: string;
  rate: number;
  /** YYYY-MM-DD (fecha de la cotización, vale desde ese día). */
  rate_date: string;
}

export interface ProductCostsLike {
  cost?: number | null;
  last_cost?: number | null;
  avg_cost?: number | null;
  replacement_cost?: number | null;
  min_price?: number | null;
}

export interface PricingWorld {
  /** El negocio tiene `listas_precios_pro`. */
  pro: boolean;
  lists: ProPriceList[];
  items: ProPriceItem[];
  schedules: PriceScheduleLike[];
  breaks: QtyBreak[];
  terms: PaymentTermLike[];
  fx: FxRateLike[];
  costs: Record<string, ProductCostsLike>;
  /** Listas asignadas en orden: cliente, grupo de clientes, sucursal, grupo de sucursales. */
  assigned: (string | null)[];
  /** Condición de pago de la ficha del cliente. */
  customerTermId: string | null;
}

export interface PriceQuery {
  productId: string;
  variantId?: string | null;
  /** products.price */
  basePrice: number;
  /** product_variants.price_override */
  variantPrice?: number | null;
  qty?: number;
  at?: Date | string;
  /** Lista explícita (p_list_id). */
  listId?: string | null;
  /** Lista elegida en el POS (header x-ninja-price-list). */
  selectedListId?: string | null;
  /** 'none' = contado explícito; uuid = condición; null = la del cliente. */
  termId?: string | null;
}

export interface PriceResolution {
  price: number;
  listId: string | null;
  termId: string | null;
}

export const EMPTY_WORLD: PricingWorld = {
  pro: false,
  lists: [],
  items: [],
  schedules: [],
  breaks: [],
  terms: [],
  fx: [],
  costs: {},
  assigned: [],
  customerTermId: null,
};

const MAX_DEPTH = 4;

function ts(v: Date | string | undefined): number {
  if (v == null) return Date.now();
  return typeof v === "string" ? new Date(v).getTime() : v.getTime();
}

/** Fecha calendario en Argentina (YYYY-MM-DD) de un instante. */
export function arDate(ms: number): string {
  const d = new Date(ms - 3 * 3600 * 1000); // UTC-3 sin horario de verano
  return d.toISOString().slice(0, 10);
}

export function listIsValid(l: ProPriceList | undefined | null, at: number): l is ProPriceList {
  if (!l) return false;
  if (l.is_active === false || l.deleted_at) return false;
  if (l.valid_from && new Date(l.valid_from).getTime() > at) return false;
  if (l.valid_to && new Date(l.valid_to).getTime() <= at) return false;
  return true;
}

function pickSchedule(
  w: PricingWorld,
  listId: string | null,
  productId: string,
  variantId: string | null,
  at: number,
): number | null {
  let best: PriceScheduleLike | null = null;
  for (const s of w.schedules) {
    if (s.status !== "scheduled") continue;
    if (s.list_id !== listId || s.product_id !== productId || s.variant_id !== variantId) continue;
    const e = new Date(s.effective_at).getTime();
    if (e > at) continue;
    if (!best) {
      best = s;
      continue;
    }
    const be = new Date(best.effective_at).getTime();
    if (e > be || (e === be && (s.created_at ?? "") > (best.created_at ?? ""))) best = s;
  }
  return best ? Number(best.price) : null;
}

function pickItem(w: PricingWorld, listId: string, productId: string, variantId: string | null): number | null {
  const it = w.items.find(
    (i) => i.price_list_id === listId && i.product_id === productId && i.variant_id === variantId,
  );
  return it ? Number(it.price) : null;
}

function fxRate(w: PricingWorld, currency: string | null | undefined, source: string | null | undefined, at: number) {
  if (!currency) return null;
  const day = arDate(at);
  const src = source || "manual";
  let best: FxRateLike | null = null;
  for (const r of w.fx) {
    if (r.currency !== currency || r.source !== src || r.rate_date > day) continue;
    if (!best || r.rate_date > best.rate_date) best = r;
  }
  return best && Number(best.rate) > 0 ? Number(best.rate) : null;
}

export function costFor(c: ProductCostsLike | undefined, basis: ListCostBasis | null | undefined): number | null {
  if (!c) return null;
  const pick =
    basis === "last" ? c.last_cost : basis === "average" ? c.avg_cost : basis === "replacement" ? c.replacement_cost : c.cost;
  const v = pick ?? c.cost;
  return v == null ? null : Number(v);
}

interface Step {
  cents: number;
  computed: boolean;
}

function adjust(l: ProPriceList, s: Step): Step {
  const pct = l.adjustment_pct;
  const amt = l.adjustment_amount;
  if (pct == null && amt == null) return s;
  let c = s.cents;
  if (pct != null) c = toCents((c * (100 + Number(pct))) / 10000);
  if (amt != null) c += toCents(Number(amt));
  return { cents: Math.max(0, c), computed: true };
}

/**
 * Lista que aplica: la explícita (si es válida) o la elegida en el POS (si es
 * elegible), las asignadas y el canal mostrador, la primera vigente.
 */
export function selectList(
  w: PricingWorld,
  at: number,
  explicitId: string | null,
  selectedId: string | null,
): ProPriceList | null {
  const byId = new Map(w.lists.map((l) => [l.id, l]));
  if (explicitId) {
    const l = byId.get(explicitId);
    return listIsValid(l, at) ? l : null;
  }
  const cands: (string | null | undefined)[] = [];
  const sel = selectedId ? byId.get(selectedId) : undefined;
  if (sel?.pos_selectable) cands.push(sel.id);
  cands.push(...w.assigned);
  for (const id of cands) {
    const l = id ? byId.get(id) : undefined;
    if (listIsValid(l, at)) return l;
  }
  const m = w.lists
    .filter((l) => l.channel === "mostrador" && l.is_active !== false && !l.deleted_at)
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))[0];
  return listIsValid(m, at) ? m : null;
}

export function resolveUnitPrice(w: PricingWorld, q: PriceQuery): PriceResolution {
  const at = ts(q.at);
  const pid = q.productId;
  const vid = q.variantId ?? null;
  const qty = q.qty ?? 1;
  const byId = new Map(w.lists.map((l) => [l.id, l]));

  // Base.
  const prodBase = pickSchedule(w, null, pid, null, at) ?? Number(q.basePrice ?? 0);
  let base = prodBase;
  if (vid) {
    const v = pickSchedule(w, null, pid, vid, at) ?? (q.variantPrice != null ? Number(q.variantPrice) : null);
    base = v ?? prodBase;
  }
  const baseCents = toCents(base);

  const list = selectList(w, at, q.listId ?? null, q.selectedListId ?? null);

  const costs = w.costs[pid];

  function listPrice(l: ProPriceList, depth: number): Step {
    const kind: ListKind = w.pro ? (l.kind ?? "fixed") : "fixed";
    // Sin PRO, los ítems de una lista en moneda extranjera no son pesos: se ignoran.
    const useItems = w.pro || l.kind !== "currency";
    let item: number | null = null;
    if (useItems && vid) item = pickSchedule(w, l.id, pid, vid, at) ?? pickItem(w, l.id, pid, vid);
    if (useItems && item == null) item = pickSchedule(w, l.id, pid, null, at) ?? pickItem(w, l.id, pid, null);

    let s: Step | null = null;
    if (item != null) {
      if (kind === "currency") {
        const rate = fxRate(w, l.currency, l.fx_source, at);
        if (rate != null) s = { cents: toCents(item * rate), computed: true };
      } else {
        s = { cents: toCents(item), computed: false };
      }
    }
    if (!s) {
      if (kind === "derived") {
        const parent = l.base_list_id ? byId.get(l.base_list_id) : undefined;
        const pp =
          depth < MAX_DEPTH && parent && parent.id !== l.id && listIsValid(parent, at)
            ? listPrice(parent, depth + 1)
            : { cents: baseCents, computed: false };
        s = adjust(l, pp);
      } else if (kind === "cost") {
        const c = costFor(costs, l.cost_basis);
        const v = l.markup_value;
        if (c != null && c > 0 && v != null && (l.markup_mode !== "margin" || Number(v) < 100)) {
          const p = l.markup_mode === "margin" ? c / (1 - Number(v) / 100) : c * (1 + Number(v) / 100);
          s = { cents: toCents(p), computed: true };
        } else {
          s = adjust(l, { cents: baseCents, computed: false });
        }
      } else {
        s = adjust(l, { cents: baseCents, computed: false });
      }
    }
    if (w.pro && s.computed && l.rounding) {
      s = { cents: toCents(applyRounding(fromCents(s.cents), l.rounding)), computed: true };
    }
    return s;
  }

  let step: Step = list ? listPrice(list, 0) : { cents: baseCents, computed: false };
  let reround = false;

  // Escala por cantidad (PRO).
  if (w.pro && list) {
    const own = w.breaks.filter(
      (b) =>
        b.price_list_id === list!.id &&
        b.product_id === pid &&
        (b.variant_id ?? null) === null &&
        Number(b.min_qty) <= qty,
    );
    const ownVar = vid
      ? w.breaks.filter(
          (b) => b.price_list_id === list!.id && b.product_id === pid && b.variant_id === vid && Number(b.min_qty) <= qty,
        )
      : [];
    const wide = w.breaks.filter(
      (b) => b.price_list_id === list!.id && b.product_id == null && Number(b.min_qty) <= qty,
    );
    const pool = ownVar.length ? ownVar : own.length ? own : wide;
    const br = pool.sort((a, b) => Number(b.min_qty) - Number(a.min_qty))[0];
    if (br) {
      if (br.kind === "price") step = { cents: toCents(Number(br.value)), computed: false };
      else {
        step = { cents: toCents((step.cents * (100 + Number(br.value))) / 10000), computed: true };
        reround = true;
      }
    }
  }

  // Condición de pago (PRO).
  let termId: string | null = null;
  if (w.pro) {
    const want = q.termId === "none" ? null : (q.termId ?? w.customerTermId);
    const term = want ? w.terms.find((t) => t.id === want && t.is_active) : undefined;
    if (term) {
      termId = term.id;
      if (Number(term.surcharge_pct) !== 0) {
        step = { cents: toCents((step.cents * (100 + Number(term.surcharge_pct))) / 10000), computed: true };
        reround = true;
      }
    }
  }

  if (w.pro && list && reround && list.rounding) {
    step = { cents: toCents(applyRounding(fromCents(step.cents), list.rounding)), computed: true };
  }

  // Piso (PRO): precio mínimo del producto y margen mínimo de la lista.
  if (w.pro) {
    let floor = 0;
    if (costs?.min_price != null && Number(costs.min_price) > 0) floor = toCents(Number(costs.min_price));
    if (list && list.min_margin_pct != null && Number(list.min_margin_pct) < 100) {
      const c = costFor(costs, list.cost_basis);
      if (c != null && c > 0) floor = Math.max(floor, toCentsCeil(c / (1 - Number(list.min_margin_pct) / 100)));
    }
    if (step.cents < floor) step = { cents: floor, computed: true };
  }

  return { price: fromCents(Math.max(0, step.cents)), listId: list?.id ?? null, termId };
}

/** Recargo de una condición sobre un monto (para mostrar "precio por plazo"). */
export function termTotal(amount: number, term: PaymentTermLike | null | undefined): number {
  if (!term) return amount;
  return fromCents(toCents((toCents(amount) * (100 + Number(term.surcharge_pct))) / 10000));
}

/** Markup ↔ margen (la UI muestra los dos: markup 50 % = margen 33,33 %). */
export function markupToMargin(markup: number): number {
  return Math.round((markup / (100 + markup)) * 10000) / 100;
}
export function marginToMarkup(margin: number): number {
  if (margin >= 100) return Infinity;
  return Math.round((margin / (100 - margin)) * 10000) / 100;
}
