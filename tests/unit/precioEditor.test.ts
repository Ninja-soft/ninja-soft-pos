import { describe, expect, it } from "vitest";
import {
  HISTORY_LIMIT,
  applyBulk,
  buildChanges,
  buildPreview,
  estimateListPrice,
  listField,
  normalizeEditorPage,
  previewFlags,
  previewSummary,
  pushHistory,
  resetRow,
  rowMargin,
  setCell,
  type Drafts,
  type EditorList,
  type EditorRow,
} from "@/lib/prices/editor";
import { EMPTY_WORLD, type PricingWorld } from "@/lib/prices/resolve";

// ADR-151: editor rápido de precios (lógica pura).

function row(p: Partial<EditorRow> = {}): EditorRow {
  return {
    id: "p1",
    name: "Alfajor",
    sku: "ALF",
    barcode: null,
    image_url: null,
    category_id: null,
    brand_id: null,
    is_service: false,
    is_active: true,
    has_variants: false,
    price_mode: "fixed",
    open_price_min: null,
    open_price_max: null,
    price: 121,
    min_price: null,
    cost: 50,
    final_cost: 50,
    cost_currency: "ARS",
    cost_usd: null,
    cost_extras: [],
    iva_pct: 21,
    items: {},
    list_prices: { L: 108.9 },
    ...p,
  };
}

const L: EditorList = {
  id: "L", name: "Mayorista", channel: "mayorista", kind: "fixed", currency: null,
  adjustment_pct: -10, prices_include_tax: true, editable: true,
};
const USD: EditorList = { ...L, id: "U", name: "Dólar", kind: "currency", currency: "USD", editable: false };

describe("setCell", () => {
  it("precio, costo y margen (sobre el precio sin IVA)", () => {
    const r = row();
    expect(rowMargin(r)).toBe(50);
    let d = setCell({}, r, "price", 130).drafts;
    expect(d.p1).toEqual({ price: 130 });
    d = setCell(d, r, "cost", 60).drafts;
    expect(d.p1).toEqual({ price: 130, cost: 60 });
    // Margen 60 % con costo final 50: neto 125, con IVA 21 % = 151,25.
    const m = setCell({}, r, "margin", 60).drafts;
    expect(m.p1?.price).toBe(151.25);
  });

  it("volver al valor original limpia el borrador", () => {
    const r = row();
    const d = setCell({}, r, "price", 130).drafts;
    expect(setCell(d, r, "price", 121).drafts).toEqual({});
    expect(resetRow(setCell({}, r, "cost", 70).drafts, "p1")).toEqual({});
  });

  it("errores: costo en dólares, lista bloqueada, sin costo, margen 100, negativo", () => {
    expect(setCell({}, row({ cost_currency: "USD" }), "cost", 10).error).toBe("cost_usd");
    expect(setCell({}, row(), listField("U"), 10, [L, USD]).error).toBe("list_locked");
    expect(setCell({}, row({ cost: null, final_cost: null }), "margin", 30).error).toBe("no_cost");
    expect(setCell({}, row(), "margin", 100).error).toBe("margin_100");
    expect(setCell({}, row(), "price", -1).error).toBe("negative");
    expect(setCell({}, row(), "price", null).error).toBe("invalid");
  });

  it("lista: crea precio fijo y vuelve si coincide con el que había", () => {
    const r = row({ items: { L: 100 } });
    expect(setCell({}, r, listField("L"), 95, [L]).drafts.p1).toEqual({ lists: { L: 95 } });
    expect(setCell({}, r, listField("L"), 100, [L]).drafts).toEqual({});
  });
});

describe("applyBulk", () => {
  const rows = [row(), row({ id: "p2", name: "Turrón", price: 200, cost: null, final_cost: null })];

  it("% con redondeo a $10", () => {
    const r = applyBulk({}, rows, { target: "price", kind: "pct", value: 10, rounding: { mode: "multiple", step: 10, direction: "nearest" } });
    expect(r.drafts.p1?.price).toBe(130); // 133,10 → 130
    expect(r.drafts.p2?.price).toBe(220);
    expect(r.changed).toBe(2);
  });

  it("monto, fijar y margen (saltea sin costo)", () => {
    expect(applyBulk({}, rows, { target: "price", kind: "amount", value: 5 }).drafts.p1?.price).toBe(126);
    expect(applyBulk({}, rows, { target: "price", kind: "set", value: 300 }).drafts.p2?.price).toBe(300);
    const m = applyBulk({}, rows, { target: "price", kind: "margin", value: 50 });
    expect(m.drafts.p1).toBeUndefined(); // ya tiene 50 % de margen: sin cambio
    expect(m.skipped).toBe(1);
    const mk = applyBulk({}, rows, { target: "price", kind: "markup", value: 50 });
    expect(mk.drafts.p1?.price).toBe(90.75); // 50 × 1,5 × 1,21
  });

  it("costo en dólares y lista bloqueada se saltean", () => {
    const r = applyBulk({}, [row({ cost_currency: "USD" })], { target: "cost", kind: "pct", value: 10 });
    expect(r.skipped).toBe(1);
    const l = applyBulk({}, [row()], { target: listField("U") as never, kind: "pct", value: 10 }, [L, USD]);
    expect(l.skipped).toBe(1);
  });

  it("lista sin precio fijo parte del calculado", () => {
    const r = applyBulk({}, [row()], { target: listField("L") as never, kind: "pct", value: 10 }, [L]);
    expect(r.drafts.p1?.lists).toEqual({ L: 119.79 });
  });
});

describe("guardado y vista previa", () => {
  it("buildChanges arma lo que espera price_editor_save", () => {
    const d: Drafts = { p1: { price: 130, cost: 60 }, p2: { lists: { L: 99 } } };
    expect(buildChanges(d)).toEqual([
      { product_id: "p1", price: 130, cost: 60 },
      { product_id: "p2", lists: { L: 99 } },
    ]);
  });

  it("alertas iguales a las del servidor", () => {
    expect(previewFlags(55, 50, 21, 20, 60)).toEqual(["below_cost", "below_floor", "low_margin"]);
    expect(previewFlags(121, 50, 21, 20, null)).toEqual([]);
    expect(previewFlags(70, 50, 21, 20, null)).toEqual(["low_margin"]); // margen 13,57 %
    expect(previewFlags(100, null, 21, 20, null)).toEqual([]);
  });

  it("buildPreview y resumen", () => {
    const r = row({ min_price: 60, items: { L: 100 } });
    const d: Drafts = { p1: { price: 55, lists: { L: 130 } } };
    const lines = buildPreview([r], d, [L], 20);
    expect(lines).toHaveLength(2);
    expect(lines[0]!).toMatchObject({ kind: "price", before: 121, after: 55, flags: ["below_cost", "below_floor", "low_margin"] });
    expect(lines[0]!.diffPct).toBe(-54.55);
    expect(lines[1]!).toMatchObject({ kind: "list", what: "Mayorista", before: 100, after: 130, diffPct: 30, flags: [] });
    expect(previewSummary(lines)).toEqual({ lines: 2, products: 1, belowCost: 1, lowMargin: 1, belowFloor: 1 });
  });

  it("deshacer guarda hasta el límite", () => {
    let s: Drafts[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) s = pushHistory(s, { [`p${i}`]: { price: i } });
    expect(s).toHaveLength(HISTORY_LIMIT);
    expect(s[s.length - 1]).toEqual({ [`p${HISTORY_LIMIT + 9}`]: { price: HISTORY_LIMIT + 9 } });
  });
});

describe("normalizeEditorPage y estimación por lista", () => {
  it("numeric como string", () => {
    const p = normalizeEditorPage({
      total: "3",
      min_margin_pct: "25",
      lists_enabled: true,
      lists: [{ id: "L", name: "M", channel: "custom", kind: "fixed", adjustment_pct: "-10", editable: true }],
      rows: [{ id: "p1", name: "A", price: "121.00", cost: "50", final_cost: "50", iva_pct: "21", items: { L: "100" }, list_prices: { L: "100.00" } }],
    });
    expect(p.total).toBe(3);
    expect(p.min_margin_pct).toBe(25);
    expect(p.lists[0]!.adjustment_pct).toBe(-10);
    expect(p.rows[0]!).toMatchObject({ price: 121, cost: 50, iva_pct: 21, items: { L: 100 }, list_prices: { L: 100 }, cost_currency: "ARS" });
  });

  it("sin cambios devuelve el del servidor; con precio nuevo recalcula con la regla", () => {
    const world: PricingWorld = {
      ...EMPTY_WORLD,
      lists: [{ id: "L", name: "M", channel: "custom", kind: "fixed", adjustment_pct: -10, is_active: true }],
    };
    const r = row();
    expect(estimateListPrice(world, r, "L")).toBe(108.9);
    expect(estimateListPrice(world, r, "L", { price: 200 })).toBe(180);
    expect(estimateListPrice(null, r, "L", { price: 200 })).toBe(108.9);
    // Precio fijo cargado en el borrador: manda ese.
    expect(estimateListPrice(world, r, "L", { lists: { L: 150 } })).toBe(150);
  });
});
