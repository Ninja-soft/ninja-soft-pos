// Matriz de paridad del motor de promociones (ADR-074).
//
// Cada caso tiene promos, líneas, contexto y el resultado esperado. La corren:
//   · tests/unit/promo-matrix.test.ts contra lib/promotions/engine.ts;
//   · tests/integration/rls-promociones.test.ts contra la base
//     (promotion_preview → _promo_eval_core), con los mismos datos.
// Si un lado cambia, el otro tiene que cambiar igual.

import type { PromoCartLine, PromoContext, Promotion } from "@/lib/promotions/engine";

export interface PromoCase {
  name: string;
  promos: Promotion[];
  lines: PromoCartLine[];
  ctx: PromoContext;
  expected: {
    discount: number;
    /** Promos aplicadas, en orden, con su descuento. */
    applied: { id: string; discount: number }[];
    /** Descuento por línea de la primera promo aplicada (opcional). */
    firstLines?: number[];
    /** Promos de regalo que se cumplen. */
    gifts?: string[];
  };
}

export function promo(p: Partial<Promotion> & { id: string }): Promotion {
  return {
    name: p.id,
    is_active: true,
    priority: 0,
    valid_from: null,
    valid_to: null,
    days_of_week: null,
    time_from: null,
    time_to: null,
    min_amount: 0,
    scope: "cart",
    scope_category_id: null,
    scope_product_id: null,
    action_type: "percent",
    action_value: 10,
    buy_qty: null,
    pay_qty: null,
    volume_tiers: null,
    payment_method: null,
    gift_product_id: null,
    gift_qty: null,
    scope_brand_id: null,
    scope_ids: null,
    bundle_items: null,
    card_brands: null,
    banks: null,
    store_ids: null,
    price_list_ids: null,
    stackable: false,
    max_discount: null,
    max_uses_total: null,
    max_uses_per_customer: null,
    ticket_label: null,
    ...p,
  };
}

/** Línea: producto, categoría, marca, precio unitario, cantidad y descuento de línea. */
export function line(
  productId: string | null,
  categoryId: string | null,
  brandId: string | null,
  unitPrice: number,
  quantity: number,
  discount = 0,
  excluded = false,
): PromoCartLine {
  return {
    productId,
    categoryId,
    brandId,
    unitPrice,
    quantity,
    lineTotal: Math.round((unitPrice * quantity - discount) * 100) / 100,
    excluded,
  };
}

const CTX: PromoContext = { weekday: 3, minutes: 13 * 60, date: "2026-11-04" };
const TWO = [line("prodA", "catX", "brA", 1000, 1), line("prodB", "catY", "brB", 500, 1)];

export const PROMO_CASES: PromoCase[] = [
  {
    name: "10% sobre todo el carrito",
    promos: [promo({ id: "p1" })],
    lines: TWO,
    ctx: CTX,
    expected: { discount: 150, applied: [{ id: "p1", discount: 150 }], firstLines: [100, 50] },
  },
  {
    name: "monto fijo en una categoría",
    promos: [promo({ id: "p1", action_type: "amount", action_value: 300, scope: "category", scope_category_id: "catX" })],
    lines: TWO,
    ctx: CTX,
    expected: { discount: 300, applied: [{ id: "p1", discount: 300 }], firstLines: [300, 0] },
  },
  {
    name: "monto fijo acotado a la base del alcance",
    promos: [promo({ id: "p1", action_type: "amount", action_value: 2000, scope: "category", scope_category_id: "catY" })],
    lines: TWO,
    ctx: CTX,
    expected: { discount: 500, applied: [{ id: "p1", discount: 500 }], firstLines: [0, 500] },
  },
  {
    name: "monto fijo repartido en proporción",
    promos: [promo({ id: "p1", action_type: "amount", action_value: 100 })],
    lines: TWO,
    ctx: CTX,
    expected: { discount: 100, applied: [{ id: "p1", discount: 100 }], firstLines: [66.67, 33.33] },
  },
  {
    name: "precio fijo de un producto",
    promos: [promo({ id: "p1", action_type: "fixed_price", action_value: 800, scope: "product", scope_product_id: "prodA" })],
    lines: TWO,
    ctx: CTX,
    expected: { discount: 200, applied: [{ id: "p1", discount: 200 }] },
  },
  {
    name: "precio fijo mayor que la base no descuenta",
    promos: [promo({ id: "p1", action_type: "fixed_price", action_value: 5000 })],
    lines: TWO,
    ctx: CTX,
    expected: { discount: 0, applied: [] },
  },
  {
    name: "2x1 sobre 4 unidades",
    promos: [promo({ id: "p1", action_type: "nxm", buy_qty: 2, pay_qty: 1 })],
    lines: [line("prodA", "catX", null, 100, 4)],
    ctx: CTX,
    expected: { discount: 200, applied: [{ id: "p1", discount: 200 }] },
  },
  {
    name: "3x2 libera la unidad más barata",
    promos: [promo({ id: "p1", action_type: "nxm", buy_qty: 3, pay_qty: 2 })],
    lines: [line("prodA", "catX", null, 300, 3), line("prodB", "catX", null, 100, 2)],
    ctx: CTX,
    expected: { discount: 100, applied: [{ id: "p1", discount: 100 }], firstLines: [0, 100] },
  },
  {
    name: "NxM con kilos usa sólo unidades enteras",
    promos: [promo({ id: "p1", action_type: "nxm", buy_qty: 2, pay_qty: 1 })],
    lines: [line("prodA", "catX", null, 1000, 2.5)],
    ctx: CTX,
    expected: { discount: 1000, applied: [{ id: "p1", discount: 1000 }] },
  },
  {
    name: "segunda unidad al 50%",
    promos: [promo({ id: "p1", action_type: "second_item", action_value: 50 })],
    lines: [line("prodA", "catX", null, 1000, 2), line("prodB", "catX", null, 600, 1)],
    ctx: CTX,
    expected: { discount: 300, applied: [{ id: "p1", discount: 300 }], firstLines: [0, 300] },
  },
  {
    name: "segunda unidad sobre una línea con descuento",
    promos: [promo({ id: "p1", action_type: "second_item", action_value: 50 })],
    lines: [line("prodA", "catX", null, 1000, 2, 200)],
    ctx: CTX,
    expected: { discount: 450, applied: [{ id: "p1", discount: 450 }] },
  },
  {
    name: "escalas por cantidad: tramo de 6",
    promos: [
      promo({
        id: "p1",
        action_type: "volume_tier",
        volume_tiers: [
          { min_qty: 3, pct: 10 },
          { min_qty: 6, pct: 15 },
          { min_qty: 12, pct: 20 },
        ],
      }),
    ],
    lines: [line("prodA", "catX", null, 100, 6)],
    ctx: CTX,
    expected: { discount: 90, applied: [{ id: "p1", discount: 90 }] },
  },
  {
    name: "escalas por cantidad: debajo del primer tramo",
    promos: [promo({ id: "p1", action_type: "volume_tier", volume_tiers: [{ min_qty: 3, pct: 10 }] })],
    lines: [line("prodA", "catX", null, 100, 2)],
    ctx: CTX,
    expected: { discount: 0, applied: [] },
  },
  {
    name: "combo café + 2 medialunas a precio fijo",
    promos: [
      promo({
        id: "p1",
        action_type: "bundle",
        action_value: 2500,
        bundle_items: [
          { product_id: "cafe", qty: 1 },
          { product_id: "medialuna", qty: 2 },
        ],
      }),
    ],
    lines: [line("cafe", "catC", null, 1500, 2), line("medialuna", "catC", null, 700, 3)],
    ctx: CTX,
    expected: { discount: 400, applied: [{ id: "p1", discount: 400 }], firstLines: [206.9, 193.1] },
  },
  {
    name: "combo con dos juegos completos",
    promos: [
      promo({
        id: "p1",
        action_type: "bundle",
        action_value: 2500,
        bundle_items: [
          { product_id: "cafe", qty: 1 },
          { product_id: "medialuna", qty: 2 },
        ],
      }),
    ],
    lines: [line("cafe", "catC", null, 1500, 2), line("medialuna", "catC", null, 700, 4)],
    ctx: CTX,
    expected: { discount: 800, applied: [{ id: "p1", discount: 800 }] },
  },
  {
    name: "combo incompleto no descuenta",
    promos: [
      promo({
        id: "p1",
        action_type: "bundle",
        action_value: 2500,
        bundle_items: [
          { product_id: "cafe", qty: 1 },
          { product_id: "medialuna", qty: 2 },
        ],
      }),
    ],
    lines: [line("cafe", "catC", null, 1500, 1), line("medialuna", "catC", null, 700, 1)],
    ctx: CTX,
    expected: { discount: 0, applied: [] },
  },
  {
    name: "por marca",
    promos: [promo({ id: "p1", action_value: 20, scope: "brand", scope_brand_id: "brB" })],
    lines: TWO,
    ctx: CTX,
    expected: { discount: 100, applied: [{ id: "p1", discount: 100 }], firstLines: [0, 100] },
  },
  {
    name: "varias categorías",
    promos: [promo({ id: "p1", action_value: 10, scope: "category", scope_ids: ["catX", "catY"] })],
    lines: [...TWO, line("prodC", "catZ", null, 2000, 1)],
    ctx: CTX,
    expected: { discount: 150, applied: [{ id: "p1", discount: 150 }], firstLines: [100, 50, 0] },
  },
  {
    name: "varios productos",
    promos: [promo({ id: "p1", action_value: 10, scope: "product", scope_ids: ["prodB", "prodC"] })],
    lines: [...TWO, line("prodC", "catZ", null, 2000, 1)],
    ctx: CTX,
    expected: { discount: 250, applied: [{ id: "p1", discount: 250 }] },
  },
  {
    name: "efectivo: paga en efectivo",
    promos: [promo({ id: "p1", payment_method: "cash" })],
    lines: TWO,
    ctx: { ...CTX, payments: [{ method: "cash" }] },
    expected: { discount: 150, applied: [{ id: "p1", discount: 150 }] },
  },
  {
    name: "efectivo: sin medio elegido no aplica",
    promos: [promo({ id: "p1", payment_method: "cash" })],
    lines: TWO,
    ctx: CTX,
    expected: { discount: 0, applied: [] },
  },
  {
    name: "efectivo: pago dividido con tarjeta no aplica",
    promos: [promo({ id: "p1", payment_method: "cash" })],
    lines: TWO,
    ctx: { ...CTX, payments: [{ method: "cash" }, { method: "credit", cardBrand: "visa" }] },
    expected: { discount: 0, applied: [] },
  },
  {
    name: "pago que el POS no pudo evaluar (Point) no cumple la condición",
    promos: [promo({ id: "p1", payment_method: "credit" }), promo({ id: "p2", action_value: 5 })],
    lines: TWO,
    ctx: { ...CTX, payments: [{ method: "credit", ineligible: true }] },
    expected: { discount: 75, applied: [{ id: "p2", discount: 75 }] },
  },
  {
    name: "Visa con etiqueta de la marca",
    promos: [promo({ id: "p1", action_value: 15, card_brands: ["visa"] })],
    lines: TWO,
    ctx: { ...CTX, payments: [{ method: "credit", cardBrand: "Visa" }] },
    expected: { discount: 225, applied: [{ id: "p1", discount: 225 }] },
  },
  {
    name: "Mastercard por etiqueta larga",
    promos: [promo({ id: "p1", action_value: 15, card_brands: ["master"] })],
    lines: TWO,
    ctx: { ...CTX, payments: [{ method: "debit", cardBrand: "Mastercard" }] },
    expected: { discount: 225, applied: [{ id: "p1", discount: 225 }] },
  },
  {
    name: "Visa: otra marca no aplica",
    promos: [promo({ id: "p1", action_value: 15, card_brands: ["visa"] })],
    lines: TWO,
    ctx: { ...CTX, payments: [{ method: "credit", cardBrand: "American Express" }] },
    expected: { discount: 0, applied: [] },
  },
  {
    name: "banco: crédito del banco elegido",
    promos: [promo({ id: "p1", action_value: 20, payment_method: "credit", banks: ["galicia"] })],
    lines: TWO,
    ctx: { ...CTX, payments: [{ method: "credit", cardBrand: "visa", bank: "galicia" }] },
    expected: { discount: 300, applied: [{ id: "p1", discount: 300 }] },
  },
  {
    name: "banco: otro banco no aplica",
    promos: [promo({ id: "p1", action_value: 20, banks: ["galicia"] })],
    lines: TWO,
    ctx: { ...CTX, payments: [{ method: "credit", cardBrand: "visa", bank: "santander" }] },
    expected: { discount: 0, applied: [] },
  },
  {
    name: "miércoles de 18 a 21 dentro de la franja",
    promos: [promo({ id: "p1", action_value: 30, days_of_week: [3], time_from: 18 * 60, time_to: 21 * 60 })],
    lines: TWO,
    ctx: { ...CTX, minutes: 19 * 60 },
    expected: { discount: 450, applied: [{ id: "p1", discount: 450 }] },
  },
  {
    name: "miércoles de 18 a 21: a las 21 ya no",
    promos: [promo({ id: "p1", action_value: 30, days_of_week: [3], time_from: 18 * 60, time_to: 21 * 60 })],
    lines: TWO,
    ctx: { ...CTX, minutes: 21 * 60 },
    expected: { discount: 0, applied: [] },
  },
  {
    name: "otro día de la semana no aplica",
    promos: [promo({ id: "p1", days_of_week: [1, 2] })],
    lines: TWO,
    ctx: CTX,
    expected: { discount: 0, applied: [] },
  },
  {
    name: "vigencia: el último día vale",
    promos: [promo({ id: "p1", valid_from: "2026-11-01", valid_to: "2026-11-04" })],
    lines: TWO,
    ctx: CTX,
    expected: { discount: 150, applied: [{ id: "p1", discount: 150 }] },
  },
  {
    name: "vigencia: todavía no empezó",
    promos: [promo({ id: "p1", valid_from: "2026-11-05" })],
    lines: TWO,
    ctx: CTX,
    expected: { discount: 0, applied: [] },
  },
  {
    name: "sucursal: vale en la sucursal elegida",
    promos: [promo({ id: "p1", store_ids: ["s1"] })],
    lines: TWO,
    ctx: { ...CTX, storeId: "s1" },
    expected: { discount: 150, applied: [{ id: "p1", discount: 150 }] },
  },
  {
    name: "sucursal: otra sucursal no",
    promos: [promo({ id: "p1", store_ids: ["s1"] })],
    lines: TWO,
    ctx: { ...CTX, storeId: "s2" },
    expected: { discount: 0, applied: [] },
  },
  {
    name: "lista de precios mayorista",
    promos: [promo({ id: "p1", price_list_ids: ["mayorista"] })],
    lines: TWO,
    ctx: { ...CTX, priceListId: "mayorista" },
    expected: { discount: 150, applied: [{ id: "p1", discount: 150 }] },
  },
  {
    name: "lista de precios: con otra lista no",
    promos: [promo({ id: "p1", price_list_ids: ["mayorista"] })],
    lines: TWO,
    ctx: { ...CTX, priceListId: "mostrador" },
    expected: { discount: 0, applied: [] },
  },
  {
    name: "tope de usos totales alcanzado",
    promos: [promo({ id: "p1", max_uses_total: 5 })],
    lines: TWO,
    ctx: { ...CTX, usage: { p1: { total: 5, customer: 0 } } },
    expected: { discount: 0, applied: [] },
  },
  {
    name: "tope de usos totales con lugar",
    promos: [promo({ id: "p1", max_uses_total: 5 })],
    lines: TWO,
    ctx: { ...CTX, usage: { p1: { total: 4, customer: 0 } } },
    expected: { discount: 150, applied: [{ id: "p1", discount: 150 }] },
  },
  {
    name: "tope por cliente: sin cliente no aplica",
    promos: [promo({ id: "p1", max_uses_per_customer: 1 })],
    lines: TWO,
    ctx: CTX,
    expected: { discount: 0, applied: [] },
  },
  {
    name: "tope por cliente: ya la usó",
    promos: [promo({ id: "p1", max_uses_per_customer: 1 })],
    lines: TWO,
    ctx: { ...CTX, customerId: "c1", usage: { p1: { total: 3, customer: 1 } } },
    expected: { discount: 0, applied: [] },
  },
  {
    name: "tope por cliente: primera vez",
    promos: [promo({ id: "p1", max_uses_per_customer: 1 })],
    lines: TWO,
    ctx: { ...CTX, customerId: "c1" },
    expected: { discount: 150, applied: [{ id: "p1", discount: 150 }] },
  },
  {
    name: "monto mínimo justo",
    promos: [promo({ id: "p1", min_amount: 1500 })],
    lines: TWO,
    ctx: CTX,
    expected: { discount: 150, applied: [{ id: "p1", discount: 150 }] },
  },
  {
    name: "monto mínimo por un centavo no",
    promos: [promo({ id: "p1", min_amount: 1500.01 })],
    lines: TWO,
    ctx: CTX,
    expected: { discount: 0, applied: [] },
  },
  {
    name: "tope de descuento por ticket",
    promos: [promo({ id: "p1", action_value: 50, max_discount: 400 })],
    lines: TWO,
    ctx: CTX,
    expected: { discount: 400, applied: [{ id: "p1", discount: 400 }], firstLines: [266.67, 133.33] },
  },
  {
    name: "dos acumulables: la segunda sobre lo que queda",
    promos: [
      promo({ id: "p1", action_value: 10, stackable: true, priority: 5 }),
      promo({ id: "p2", action_value: 5, stackable: true }),
    ],
    lines: TWO,
    ctx: CTX,
    expected: {
      discount: 217.5,
      applied: [
        { id: "p1", discount: 150 },
        { id: "p2", discount: 67.5 },
      ],
    },
  },
  {
    name: "excluyente mejor que las acumulables",
    promos: [
      promo({ id: "p1", action_value: 10, stackable: true }),
      promo({ id: "p2", action_value: 5, stackable: true }),
      promo({ id: "p3", action_value: 20 }),
    ],
    lines: TWO,
    ctx: CTX,
    expected: { discount: 300, applied: [{ id: "p3", discount: 300 }] },
  },
  {
    name: "acumulables mejores que la excluyente",
    promos: [
      promo({ id: "p1", action_value: 10, stackable: true }),
      promo({ id: "p2", action_value: 5, stackable: true }),
      promo({ id: "p3", action_value: 12 }),
    ],
    lines: TWO,
    ctx: CTX,
    expected: {
      discount: 217.5,
      applied: [
        { id: "p1", discount: 150 },
        { id: "p2", discount: 67.5 },
      ],
    },
  },
  {
    name: "empate entre excluyentes: gana la de mayor prioridad",
    promos: [promo({ id: "pa", action_value: 10 }), promo({ id: "pb", action_value: 10, priority: 3 })],
    lines: TWO,
    ctx: CTX,
    expected: { discount: 150, applied: [{ id: "pb", discount: 150 }] },
  },
  {
    name: "empate con la misma prioridad: gana el id menor",
    promos: [promo({ id: "pb", action_value: 10 }), promo({ id: "pa", action_value: 10 })],
    lines: TWO,
    ctx: CTX,
    expected: { discount: 150, applied: [{ id: "pa", discount: 150 }] },
  },
  {
    name: "2x1 acumulable antes que un 10% acumulable",
    promos: [
      promo({ id: "p1", action_type: "nxm", buy_qty: 2, pay_qty: 1, stackable: true, priority: 10 }),
      promo({ id: "p2", action_value: 10, stackable: true }),
    ],
    lines: [line("prodA", "catX", null, 100, 4)],
    ctx: CTX,
    expected: {
      discount: 220,
      applied: [
        { id: "p1", discount: 200 },
        { id: "p2", discount: 20 },
      ],
    },
  },
  {
    name: "regalos, recargos y venta libre no participan",
    promos: [promo({ id: "p1", action_value: 10 })],
    lines: [
      ...TWO,
      line("prodG", "catX", null, 0, 1, 0, true),
      line(null, null, null, 300, 1),
      line("prodH", "catX", null, 800, 1, 0, true),
    ],
    ctx: CTX,
    expected: { discount: 150, applied: [{ id: "p1", discount: 150 }], firstLines: [100, 50, 0, 0, 0] },
  },
  {
    name: "inactiva no aplica",
    promos: [promo({ id: "p1", is_active: false })],
    lines: TWO,
    ctx: CTX,
    expected: { discount: 0, applied: [] },
  },
  {
    name: "regalo por compra desde $1.000",
    promos: [
      promo({ id: "g1", action_type: "gift", action_value: 0, gift_product_id: "prodG", gift_qty: 1, min_amount: 1000 }),
      promo({ id: "p1", action_value: 10 }),
    ],
    lines: TWO,
    ctx: CTX,
    expected: { discount: 150, applied: [{ id: "p1", discount: 150 }], gifts: ["g1"] },
  },
  {
    name: "redondeo a centavos por línea",
    promos: [promo({ id: "p1", action_value: 15 })],
    lines: [line("a", null, null, 33.33, 1), line("b", null, null, 33.33, 1), line("c", null, null, 33.33, 1)],
    ctx: CTX,
    expected: { discount: 15, applied: [{ id: "p1", discount: 15 }], firstLines: [5, 5, 5] },
  },
  {
    name: "porcentaje con decimales",
    promos: [promo({ id: "p1", action_value: 12.5 })],
    lines: [line("a", null, null, 99.99, 3)],
    ctx: CTX,
    expected: { discount: 37.5, applied: [{ id: "p1", discount: 37.5 }] },
  },
];

/** Argumentos de promotion_preview / _promo_eval_core para un caso. */
export function promoSqlArgs(c: PromoCase) {
  return {
    p_promos: c.promos,
    p_lines: c.lines.map((l) => ({
      product_id: l.productId,
      category_id: l.categoryId,
      brand_id: l.brandId ?? null,
      quantity: l.quantity,
      line_total: l.lineTotal,
      excluded: Boolean(l.excluded),
    })),
    p_ctx: {
      weekday: c.ctx.weekday,
      minutes: c.ctx.minutes,
      date: c.ctx.date,
      payments: (c.ctx.payments ?? (c.ctx.paymentMethod ? [{ method: c.ctx.paymentMethod }] : [])).map((p) => ({
        method: p.method,
        card_brand: p.cardBrand ?? null,
        bank: p.bank ?? null,
        ineligible: Boolean(p.ineligible),
      })),
      store_id: c.ctx.storeId ?? null,
      price_list_id: c.ctx.priceListId ?? null,
      customer_id: c.ctx.customerId ?? null,
      usage: c.ctx.usage ?? {},
    },
  };
}
