// Matriz de paridad del resolver de precios (F18 · H100, ADR-058).
//
// Un mismo "mundo" (productos, listas, ítems, escalas, plazos, cotizaciones,
// programados y asignaciones) y una lista de casos con el precio esperado. Lo
// usan:
//   · tests/unit/price-resolver-parity.test.ts → resolveUnitPrice (TS);
//   · tests/integration/rls-listas-precios-pro.test.ts → _resolve_unit_price
//     (SQL) sobre un Supabase local, sembrando exactamente este mundo.
// Si los dos lados dan `expected` en todos los casos, el POS y el servidor
// cobran lo mismo.

import type {
  FxRateLike,
  PaymentTermLike,
  PriceScheduleLike,
  PricingWorld,
  ProPriceItem,
  ProPriceList,
  ProductCostsLike,
  QtyBreak,
} from "@/lib/prices/resolve";

export const MATRIX_NOW = "2026-11-10T15:00:00.000Z";

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const IDS = {
  P1: u(101),
  P2: u(102),
  P3: u(103),
  V1: u(201),
  V2: u(202),
  L_MOST: u(301),
  L_MAY: u(302),
  L_DER: u(303),
  L_COST: u(304),
  L_MARG: u(305),
  L_USD: u(306),
  L_EXP: u(307),
  L_FUT: u(308),
  L_GRP: u(309),
  T30: u(401),
  T60: u(402),
  T90: u(403),
  G1: u(501),
  C1: u(601),
  C2: u(602),
  C3: u(603),
} as const;

export interface MatrixProduct {
  id: string;
  name: string;
  price: number;
  costs: ProductCostsLike;
  variants?: { id: string; option1: string; price_override: number | null }[];
}

export const PRODUCTS: MatrixProduct[] = [
  {
    id: IDS.P1,
    name: "Matriz P1",
    price: 1000,
    costs: { cost: 500, last_cost: 520, avg_cost: 480, replacement_cost: 600, min_price: null },
  },
  {
    id: IDS.P2,
    name: "Matriz P2",
    price: 1234.56,
    costs: { cost: 700, last_cost: null, avg_cost: null, replacement_cost: null, min_price: null },
    variants: [
      { id: IDS.V1, option1: "Grande", price_override: 1500 },
      { id: IDS.V2, option1: "Chica", price_override: null },
    ],
  },
  {
    id: IDS.P3,
    name: "Matriz P3",
    price: 99.99,
    costs: { cost: null, last_cost: null, avg_cost: null, replacement_cost: null, min_price: 120 },
  },
];

const L = (l: Partial<ProPriceList> & { id: string; name: string; created_at: string }): ProPriceList => ({
  channel: "custom",
  adjustment_pct: null,
  adjustment_amount: null,
  kind: "fixed",
  base_list_id: null,
  cost_basis: null,
  markup_mode: null,
  markup_value: null,
  currency: null,
  fx_source: null,
  rounding: null,
  min_margin_pct: null,
  valid_from: null,
  valid_to: null,
  is_active: true,
  pos_selectable: false,
  ...l,
});

export const LISTS: ProPriceList[] = [
  L({ id: IDS.L_MOST, name: "Matriz mostrador", channel: "mostrador", adjustment_pct: 10,
      rounding: { mode: "multiple", step: 10, direction: "nearest" }, created_at: "2026-01-01T00:00:00Z" }),
  L({ id: IDS.L_MAY, name: "Matriz mayorista", adjustment_pct: -15, pos_selectable: true,
      created_at: "2026-01-02T00:00:00Z" }),
  L({ id: IDS.L_DER, name: "Matriz derivada", kind: "derived", base_list_id: IDS.L_MOST, adjustment_pct: -5,
      adjustment_amount: 3, rounding: { mode: "ending", ending: 0.99, direction: "up" },
      created_at: "2026-01-03T00:00:00Z" }),
  L({ id: IDS.L_COST, name: "Matriz costo", kind: "cost", cost_basis: "replacement", markup_mode: "markup",
      markup_value: 60, rounding: { mode: "ending", ending: 9, direction: "nearest" }, min_margin_pct: 30,
      created_at: "2026-01-04T00:00:00Z" }),
  L({ id: IDS.L_MARG, name: "Matriz margen", kind: "cost", cost_basis: "average", markup_mode: "margin",
      markup_value: 40, min_margin_pct: 45, created_at: "2026-01-05T00:00:00Z" }),
  L({ id: IDS.L_USD, name: "Matriz USD", kind: "currency", currency: "USD", fx_source: "oficial",
      adjustment_pct: 5, rounding: { mode: "multiple", step: 50, direction: "up" },
      created_at: "2026-01-06T00:00:00Z" }),
  L({ id: IDS.L_EXP, name: "Matriz vencida", adjustment_pct: 50, valid_to: "2026-11-01T03:00:00Z",
      created_at: "2026-01-07T00:00:00Z" }),
  L({ id: IDS.L_FUT, name: "Matriz futura", adjustment_pct: 30, valid_from: "2026-12-01T03:00:00Z",
      pos_selectable: true, created_at: "2026-01-08T00:00:00Z" }),
  L({ id: IDS.L_GRP, name: "Matriz grupo", adjustment_pct: -20, created_at: "2026-01-09T00:00:00Z" }),
];

export const ITEMS: ProPriceItem[] = [
  { price_list_id: IDS.L_MAY, product_id: IDS.P2, variant_id: null, price: 1100 },
  { price_list_id: IDS.L_MAY, product_id: IDS.P2, variant_id: IDS.V1, price: 1400 },
  { price_list_id: IDS.L_USD, product_id: IDS.P1, variant_id: null, price: 2.5 },
  { price_list_id: IDS.L_MOST, product_id: IDS.P3, variant_id: null, price: 105.5 },
];

export const BREAKS: QtyBreak[] = [
  { price_list_id: IDS.L_MAY, product_id: IDS.P1, variant_id: null, min_qty: 10, kind: "pct", value: -10 },
  { price_list_id: IDS.L_MAY, product_id: null, variant_id: null, min_qty: 50, kind: "pct", value: -20 },
  { price_list_id: IDS.L_MAY, product_id: IDS.P2, variant_id: IDS.V1, min_qty: 5, kind: "price", value: 1300 },
  { price_list_id: IDS.L_MOST, product_id: IDS.P1, variant_id: null, min_qty: 6, kind: "pct", value: -3.5 },
];

export const TERMS: (PaymentTermLike & { sort: number })[] = [
  { id: IDS.T30, name: "Matriz 30 días", days: 30, surcharge_pct: 5, is_active: true, sort: 1 },
  { id: IDS.T60, name: "Matriz 60 días", days: 60, surcharge_pct: 10, is_active: false, sort: 2 },
  { id: IDS.T90, name: "Matriz 90 días", days: 90, surcharge_pct: 12.5, is_active: true, sort: 3 },
];

export const FX: FxRateLike[] = [
  { currency: "USD", source: "oficial", rate_date: "2026-11-01", rate: 1000 },
  { currency: "USD", source: "oficial", rate_date: "2026-11-09", rate: 1050.5 },
  { currency: "USD", source: "oficial", rate_date: "2026-11-12", rate: 1100 },
  { currency: "USD", source: "mep", rate_date: "2026-11-09", rate: 1200 },
];

export const SCHEDULES: PriceScheduleLike[] = [
  { id: u(701), list_id: null, product_id: IDS.P1, variant_id: null, price: 1100,
    effective_at: "2026-11-05T03:00:00Z", status: "scheduled", created_at: "2026-11-01T00:00:00Z" },
  { id: u(702), list_id: null, product_id: IDS.P1, variant_id: null, price: 1500,
    effective_at: "2026-11-20T03:00:00Z", status: "scheduled", created_at: "2026-11-01T00:00:01Z" },
  { id: u(703), list_id: IDS.L_MAY, product_id: IDS.P1, variant_id: null, price: 900,
    effective_at: "2026-11-01T03:00:00Z", status: "scheduled", created_at: "2026-10-30T00:00:00Z" },
  { id: u(704), list_id: null, product_id: IDS.P2, variant_id: null, price: 1, effective_at: "2026-11-01T03:00:00Z",
    status: "cancelled", created_at: "2026-10-30T00:00:00Z" },
  { id: u(705), list_id: null, product_id: IDS.P2, variant_id: IDS.V2, price: 1250,
    effective_at: "2026-11-02T03:00:00Z", status: "scheduled", created_at: "2026-10-30T00:00:00Z" },
];

/** Clientes: C1 en el grupo G1 con condición 30 días; C2 con lista vencida; C3 sin nada. */
export const CUSTOMERS = [
  { id: IDS.C1, name: "Matriz C1", group_id: IDS.G1, payment_term_id: IDS.T30 },
  { id: IDS.C2, name: "Matriz C2", group_id: null, payment_term_id: null },
  { id: IDS.C3, name: "Matriz C3", group_id: null, payment_term_id: null },
] as const;
export const GROUPS = [{ id: IDS.G1, name: "Matriz G1" }] as const;
export const ASSIGNMENTS = [
  { price_list_id: IDS.L_GRP, scope: "customer_group" as const, scope_id: IDS.G1 },
  { price_list_id: IDS.L_EXP, scope: "customer" as const, scope_id: IDS.C2 },
];

/** Espejo de `_price_assigned_lists` sin sucursal (la matriz no usa sucursales). */
export function assignedFor(customerId: string | null): (string | null)[] {
  if (!customerId) return [null, null, null, null];
  const c = CUSTOMERS.find((x) => x.id === customerId);
  const own = ASSIGNMENTS.find((a) => a.scope === "customer" && a.scope_id === customerId)?.price_list_id ?? null;
  const grp = c?.group_id
    ? (ASSIGNMENTS.find((a) => a.scope === "customer_group" && a.scope_id === c.group_id)?.price_list_id ?? null)
    : null;
  return [own, grp, null, null];
}

export function worldFor(pro: boolean, customerId: string | null): PricingWorld {
  const costs: Record<string, ProductCostsLike> = {};
  for (const p of PRODUCTS) costs[p.id] = p.costs;
  return {
    pro,
    lists: LISTS,
    items: ITEMS,
    schedules: SCHEDULES,
    breaks: BREAKS,
    terms: TERMS,
    fx: FX,
    costs,
    assigned: assignedFor(customerId),
    customerTermId: CUSTOMERS.find((c) => c.id === customerId)?.payment_term_id ?? null,
  };
}

export interface MatrixCase {
  name: string;
  pro: boolean;
  product: string;
  variant?: string | null;
  qty?: number;
  customer?: string | null;
  list?: string | null;
  posList?: string | null;
  term?: string | null;
  at?: string;
  expected: number;
}

const P = IDS;

export const CASES: MatrixCase[] = [
  // Sin PRO: toda lista es fija (% + ítems), sin escalas, plazos, redondeo ni piso.
  { name: "base programado vigente + mostrador 10 %", pro: false, product: P.P1, expected: 1210 },
  { name: "antes del programado: precio del producto", pro: false, product: P.P1, at: "2026-11-04T12:00:00Z", expected: 1100 },
  { name: "ítem fijo en mostrador", pro: false, product: P.P3, expected: 105.5 },
  { name: "variante con override + mostrador", pro: false, product: P.P2, variant: P.V1, expected: 1650 },
  { name: "variante sin override: programado de la variante", pro: false, product: P.P2, variant: P.V2, expected: 1375 },
  { name: "lista explícita mayorista: ítem de variante", pro: false, product: P.P2, variant: P.V1, list: P.L_MAY, expected: 1400 },
  { name: "lista explícita mayorista: programado del ítem", pro: false, product: P.P1, list: P.L_MAY, expected: 900 },
  { name: "derivada sin PRO se comporta como fija", pro: false, product: P.P1, list: P.L_DER, expected: 1048 },
  { name: "lista del grupo del cliente", pro: false, product: P.P1, customer: P.C1, expected: 880 },
  { name: "lista vencida del cliente → mostrador", pro: false, product: P.P1, customer: P.C2, expected: 1210 },
  { name: "lista elegida en el POS (elegible)", pro: false, product: P.P1, posList: P.L_MAY, expected: 900 },
  { name: "lista elegida futura → sigue con mostrador", pro: false, product: P.P1, posList: P.L_FUT, expected: 1210 },
  { name: "lista elegida no elegible → ignorada", pro: false, product: P.P1, posList: P.L_GRP, expected: 1210 },
  { name: "plazo ignorado sin PRO", pro: false, product: P.P1, customer: P.C3, term: P.T30, expected: 1210 },
  { name: "lista USD sin PRO: % sobre la base", pro: false, product: P.P1, list: P.L_USD, expected: 1155 },
  // PRO.
  { name: "mostrador con redondeo a $10", pro: true, product: P.P2, expected: 1360 },
  { name: "escala del mostrador desde 6 unidades", pro: true, product: P.P1, qty: 6, expected: 1170 },
  { name: "derivada: madre redondeada, -5 % + $3, termina en ,99", pro: true, product: P.P1, list: P.L_DER, expected: 1152.99 },
  { name: "derivada con ítem fijo en la madre (103,99) y piso del producto", pro: true, product: P.P3, list: P.L_DER, expected: 120 },
  { name: "derivada sobre variante", pro: true, product: P.P2, variant: P.V1, list: P.L_DER, expected: 1570.99 },
  { name: "derivada sin PRO: % y monto sobre la base", pro: false, product: P.P3, list: P.L_DER, expected: 97.99 },
  { name: "costo de reposición + 60 %, terminado en 9", pro: true, product: P.P1, list: P.L_COST, expected: 959 },
  { name: "costo sin costo → % de la lista sobre la base (sin %: base) y piso", pro: true, product: P.P3, list: P.L_COST, expected: 120 },
  { name: "margen 40 % sobre promedio con piso de margen 45 %", pro: true, product: P.P1, list: P.L_MARG, expected: 872.73 },
  { name: "margen: sin promedio usa el costo", pro: true, product: P.P2, list: P.L_MARG, expected: 1272.73 },
  { name: "USD: ítem × cotización vigente, redondeo a $50 arriba", pro: true, product: P.P1, list: P.L_USD, expected: 2650 },
  { name: "USD: cotización del día anterior", pro: true, product: P.P1, list: P.L_USD, at: "2026-11-05T15:00:00Z", expected: 2500 },
  { name: "USD sin ítem: % sobre la base, redondeo", pro: true, product: P.P2, list: P.L_USD, expected: 1300 },
  { name: "mayorista: escala de producto 10+", pro: true, product: P.P1, list: P.L_MAY, qty: 12, expected: 810 },
  { name: "mayorista: la escala del producto gana a la general", pro: true, product: P.P1, list: P.L_MAY, qty: 60, expected: 810 },
  { name: "mayorista: escala general 50+ sobre ítem fijo", pro: true, product: P.P2, list: P.L_MAY, qty: 60, expected: 880 },
  { name: "mayorista: escala de variante con precio fijo", pro: true, product: P.P2, variant: P.V1, list: P.L_MAY, qty: 5, expected: 1300 },
  { name: "mayorista: escala de variante debajo del mínimo", pro: true, product: P.P2, variant: P.V1, list: P.L_MAY, qty: 4, expected: 1400 },
  { name: "plazo de la ficha del cliente (30 días, 5 %)", pro: true, product: P.P1, customer: P.C1, expected: 924 },
  { name: "plazo elegido 90 días sobre mostrador, re-redondeo", pro: true, product: P.P1, term: P.T90, expected: 1360 },
  { name: "contado explícito pisa la ficha", pro: true, product: P.P1, customer: P.C1, term: "none", expected: 880 },
  { name: "plazo inactivo → sin recargo", pro: true, product: P.P1, term: P.T60, expected: 1210 },
  { name: "precio mínimo del producto (piso)", pro: true, product: P.P3, list: P.L_MAY, expected: 120 },
  { name: "lista explícita vencida → base", pro: true, product: P.P1, list: P.L_EXP, expected: 1100 },
  { name: "plazo sin lista (base) sin redondeo", pro: true, product: P.P2, list: P.L_EXP, term: P.T30, expected: 1296.29 },
];
