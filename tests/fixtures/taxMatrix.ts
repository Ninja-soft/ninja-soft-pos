// Matriz de paridad del motor de impuestos (ADR-068). La misma matriz corre
// contra lib/tax/engine.ts (tests/unit/taxEngine.test.ts) y contra
// _sale_tax_compute vía sale_tax_preview (tests/integration/rls-impuestos.test.ts).

import type { IvaCode } from "@/lib/tax/catalog";
import type { InternalTax } from "@/lib/tax/engine";

export interface TaxMatrixProduct {
  key: string;
  id: string;
  name: string;
  price: number;
  rate_code: IvaCode;
  cost?: number;
  internal?: InternalTax;
  variants?: { key: string; id: string; rate_code: IvaCode | null }[];
}

export const TAX_PRODUCTS: TaxMatrixProduct[] = [
  { key: "p21", id: "7a000000-0000-4000-8000-000000000001", name: "Matriz 21", price: 1210, rate_code: "21" },
  { key: "p105", id: "7a000000-0000-4000-8000-000000000002", name: "Matriz 10,5", price: 1105, rate_code: "10.5" },
  { key: "pex", id: "7a000000-0000-4000-8000-000000000003", name: "Matriz exento", price: 500, rate_code: "exento" },
  { key: "png", id: "7a000000-0000-4000-8000-000000000004", name: "Matriz no gravado", price: 300, rate_code: "no_gravado" },
  { key: "p27", id: "7a000000-0000-4000-8000-000000000005", name: "Matriz 27", price: 1270, rate_code: "27" },
  { key: "p5", id: "7a000000-0000-4000-8000-000000000006", name: "Matriz 5", price: 105, rate_code: "5" },
  { key: "p25", id: "7a000000-0000-4000-8000-000000000007", name: "Matriz 2,5", price: 102.5, rate_code: "2.5" },
  { key: "p0", id: "7a000000-0000-4000-8000-000000000008", name: "Matriz 0", price: 100, rate_code: "0" },
  {
    key: "pint",
    id: "7a000000-0000-4000-8000-000000000009",
    name: "Matriz internos 20 %",
    price: 2000,
    rate_code: "21",
    internal: { mode: "pct", base: "price", rate: 20, amount: null, included: true },
  },
  {
    key: "pfix",
    id: "7a000000-0000-4000-8000-00000000000a",
    name: "Matriz internos fijo",
    price: 1500,
    rate_code: "21",
    internal: { mode: "fixed", base: "price", rate: null, amount: 100, included: true },
  },
  {
    key: "pcost",
    id: "7a000000-0000-4000-8000-00000000000b",
    name: "Matriz internos costo",
    price: 1000,
    rate_code: "21",
    cost: 400,
    internal: { mode: "pct", base: "cost", rate: 10, amount: null, included: true },
  },
  {
    key: "pvar",
    id: "7a000000-0000-4000-8000-00000000000c",
    name: "Matriz variante",
    price: 1210,
    rate_code: "21",
    variants: [
      { key: "v105", id: "7b000000-0000-4000-8000-000000000001", rate_code: "10.5" },
      { key: "vsame", id: "7b000000-0000-4000-8000-000000000002", rate_code: null },
    ],
  },
];

export interface TaxMatrixItem {
  product?: string;
  variant?: string;
  quantity: number;
  unit_price: number;
  discount?: number;
}

export interface TaxMatrixExpected {
  lines: { code: IvaCode; taxed: number; net: number; iva: number; internal: number }[];
  iva: { code: IvaCode; base: number; amount: number }[];
  netTaxed: number;
  netExempt: number;
  netUntaxed: number;
  ivaTotal: number;
  internalTotal: number;
}

export interface TaxMatrixCase {
  name: string;
  emitter: "responsable_inscripto" | "monotributo";
  items: TaxMatrixItem[];
  total: number;
  expected: TaxMatrixExpected;
}

const L = (code: IvaCode, taxed: number, net: number, iva: number, internal = 0) => ({ code, taxed, net, iva, internal });

export const TAX_CASES: TaxMatrixCase[] = [
  {
    name: "una línea al 21 %",
    emitter: "responsable_inscripto",
    items: [{ product: "p21", quantity: 1, unit_price: 1210 }],
    total: 1210,
    expected: {
      lines: [L("21", 1210, 1000, 210)],
      iva: [{ code: "21", base: 1000, amount: 210 }],
      netTaxed: 1000,
      netExempt: 0,
      netUntaxed: 0,
      ivaTotal: 210,
      internalTotal: 0,
    },
  },
  {
    name: "mixta 21, 10,5, exento y no gravado",
    emitter: "responsable_inscripto",
    items: [
      { product: "p21", quantity: 1, unit_price: 1210 },
      { product: "p105", quantity: 1, unit_price: 1105 },
      { product: "pex", quantity: 1, unit_price: 500 },
      { product: "png", quantity: 1, unit_price: 300 },
    ],
    total: 3115,
    expected: {
      lines: [L("21", 1210, 1000, 210), L("10.5", 1105, 1000, 105), L("exento", 500, 500, 0), L("no_gravado", 300, 300, 0)],
      iva: [
        { code: "21", base: 1000, amount: 210 },
        { code: "10.5", base: 1000, amount: 105 },
      ],
      netTaxed: 2000,
      netExempt: 500,
      netUntaxed: 300,
      ivaTotal: 315,
      internalTotal: 0,
    },
  },
  {
    name: "mixta con descuento general repartido",
    emitter: "responsable_inscripto",
    items: [
      { product: "p21", quantity: 1, unit_price: 1210 },
      { product: "p105", quantity: 1, unit_price: 1105 },
      { product: "pex", quantity: 1, unit_price: 500 },
      { product: "png", quantity: 1, unit_price: 300 },
    ],
    total: 3000,
    expected: {
      lines: [
        L("21", 1165.33, 963.08, 202.25),
        L("10.5", 1064.21, 963.09, 101.12),
        L("exento", 481.54, 481.54, 0),
        L("no_gravado", 288.92, 288.92, 0),
      ],
      iva: [
        { code: "21", base: 963.08, amount: 202.25 },
        { code: "10.5", base: 963.09, amount: 101.12 },
      ],
      netTaxed: 1926.17,
      netExempt: 481.54,
      netUntaxed: 288.92,
      ivaTotal: 303.37,
      internalTotal: 0,
    },
  },
  {
    name: "internos 20 % nominal sobre el precio",
    emitter: "responsable_inscripto",
    items: [{ product: "pint", quantity: 1, unit_price: 2000 }],
    total: 2000,
    expected: {
      lines: [L("21", 2000, 1369.86, 287.67, 342.47)],
      iva: [{ code: "21", base: 1369.86, amount: 287.67 }],
      netTaxed: 1369.86,
      netExempt: 0,
      netUntaxed: 0,
      ivaTotal: 287.67,
      internalTotal: 342.47,
    },
  },
  {
    name: "internos de monto fijo por unidad",
    emitter: "responsable_inscripto",
    items: [{ product: "pfix", quantity: 2, unit_price: 1500 }],
    total: 3000,
    expected: {
      lines: [L("21", 3000, 2314.05, 485.95, 200)],
      iva: [{ code: "21", base: 2314.05, amount: 485.95 }],
      netTaxed: 2314.05,
      netExempt: 0,
      netUntaxed: 0,
      ivaTotal: 485.95,
      internalTotal: 200,
    },
  },
  {
    name: "internos 10 % sobre el costo",
    emitter: "responsable_inscripto",
    items: [{ product: "pcost", quantity: 3, unit_price: 1000 }],
    total: 3000,
    expected: {
      lines: [L("21", 3000, 2380.17, 499.83, 120)],
      iva: [{ code: "21", base: 2380.17, amount: 499.83 }],
      netTaxed: 2380.17,
      netExempt: 0,
      netUntaxed: 0,
      ivaTotal: 499.83,
      internalTotal: 120,
    },
  },
  {
    name: "tres líneas iguales: el centavo que sobra va a la primera",
    emitter: "responsable_inscripto",
    items: [
      { product: "p21", quantity: 1, unit_price: 10 },
      { product: "p21", quantity: 1, unit_price: 10 },
      { product: "p21", quantity: 1, unit_price: 10 },
    ],
    total: 25,
    expected: {
      lines: [L("21", 8.34, 6.89, 1.45), L("21", 8.33, 6.89, 1.44), L("21", 8.33, 6.88, 1.45)],
      iva: [{ code: "21", base: 20.66, amount: 4.34 }],
      netTaxed: 20.66,
      netExempt: 0,
      netUntaxed: 0,
      ivaTotal: 4.34,
      internalTotal: 0,
    },
  },
  {
    name: "emisor monotributista: sin IVA discriminado",
    emitter: "monotributo",
    items: [
      { product: "p21", quantity: 1, unit_price: 1210 },
      { product: "pex", quantity: 1, unit_price: 500 },
      { product: "pint", quantity: 1, unit_price: 2000 },
    ],
    total: 3710,
    expected: {
      lines: [L("21", 1210, 1210, 0), L("exento", 500, 500, 0), L("21", 2000, 1600, 0, 400)],
      iva: [],
      netTaxed: 3310,
      netExempt: 0,
      netUntaxed: 0,
      ivaTotal: 0,
      internalTotal: 400,
    },
  },
  {
    name: "27, 5, 2,5 y 0 %",
    emitter: "responsable_inscripto",
    items: [
      { product: "p27", quantity: 1, unit_price: 1270 },
      { product: "p5", quantity: 1, unit_price: 105 },
      { product: "p25", quantity: 1, unit_price: 102.5 },
      { product: "p0", quantity: 1, unit_price: 100 },
    ],
    total: 1577.5,
    expected: {
      lines: [L("27", 1270, 1000, 270), L("5", 105, 100, 5), L("2.5", 102.5, 100, 2.5), L("0", 100, 100, 0)],
      iva: [
        { code: "27", base: 1000, amount: 270 },
        { code: "5", base: 100, amount: 5 },
        { code: "2.5", base: 100, amount: 2.5 },
        { code: "0", base: 100, amount: 0 },
      ],
      netTaxed: 1300,
      netExempt: 0,
      netUntaxed: 0,
      ivaTotal: 277.5,
      internalTotal: 0,
    },
  },
  {
    name: "variante con alícuota propia y ítem libre a la alícuota del negocio",
    emitter: "responsable_inscripto",
    items: [
      { product: "pvar", variant: "v105", quantity: 1, unit_price: 1105 },
      { product: "pvar", variant: "vsame", quantity: 1, unit_price: 1210 },
      { quantity: 1, unit_price: 121, discount: 0 },
    ],
    total: 2436,
    expected: {
      lines: [L("10.5", 1105, 1000, 105), L("21", 1210, 1000, 210), L("21", 121, 100, 21)],
      iva: [
        { code: "10.5", base: 1000, amount: 105 },
        { code: "21", base: 1100, amount: 231 },
      ],
      netTaxed: 2100,
      netExempt: 0,
      netUntaxed: 0,
      ivaTotal: 336,
      internalTotal: 0,
    },
  },
];

/** Datos fiscales de los productos tal como los usa el motor TS. */
export function matrixLineInputs(c: TaxMatrixCase) {
  return c.items.map((it) => {
    const p = it.product ? TAX_PRODUCTS.find((x) => x.key === it.product)! : null;
    const v = p && it.variant ? p.variants?.find((x) => x.key === it.variant) : null;
    return {
      gross: it.unit_price * it.quantity - (it.discount ?? 0),
      quantity: it.quantity,
      rateCode: (v?.rate_code ?? p?.rate_code ?? "21") as IvaCode,
      internal: p?.internal ?? null,
      unitCost: p?.cost ?? null,
    };
  });
}

/** Ítems con ids para sale_tax_preview. */
export function matrixPreviewItems(c: TaxMatrixCase) {
  return c.items.map((it) => {
    const p = it.product ? TAX_PRODUCTS.find((x) => x.key === it.product)! : null;
    const v = p && it.variant ? p.variants?.find((x) => x.key === it.variant) : null;
    return {
      product_id: p?.id ?? null,
      variant_id: v?.id ?? null,
      quantity: it.quantity,
      unit_price: it.unit_price,
      discount: it.discount ?? 0,
    };
  });
}
