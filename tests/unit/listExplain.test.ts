// ADR-151: cómo se calcula cada lista, en palabras (ficha del producto).
import { describe, expect, it } from "vitest";
import { describeAdjustment, describeListRule } from "@/lib/prices/listExplain";

const MAY = { id: "m", name: "Mayorista", kind: "fixed", adjustment_pct: -10 };

describe("describeListRule", () => {
  it("fija: % y monto sobre el precio de venta", () => {
    expect(describeListRule(MAY)).toBe("Precio de venta −10 %");
    expect(describeListRule({ id: "a", name: "A", kind: "fixed", adjustment_pct: 5, adjustment_amount: -50 })).toBe(
      "Precio de venta +5 % − $50",
    );
    expect(describeListRule({ id: "a", name: "A", kind: "fixed" })).toBe("Igual al precio de venta");
  });

  it("fija con precio del producto: el ítem pisa la regla y no se redondea", () => {
    const l = { ...MAY, rounding: { mode: "multiple" as const, step: 100, direction: "up" as const } };
    expect(describeListRule(l, [], { hasItem: true })).toBe("Precio fijo para este producto");
  });

  it("derivada: sale de la madre", () => {
    const d = { id: "d", name: "Web", kind: "derived", base_list_id: "m", adjustment_pct: 5 };
    expect(describeListRule(d, [MAY, d])).toBe("Sale de Mayorista +5 %");
    expect(describeListRule({ ...d, base_list_id: "x" }, [MAY])).toBe("Sale de otra lista +5 %");
  });

  it("sobre costo: base y markup o margen", () => {
    expect(
      describeListRule({ id: "c", name: "C", kind: "cost", cost_basis: "replacement", markup_mode: "markup", markup_value: 60 }),
    ).toBe("Costo de reposición + 60 % de markup");
    expect(describeListRule({ id: "c", name: "C", kind: "cost", cost_basis: "final", markup_mode: "margin", markup_value: 35 })).toBe(
      "Costo final + 35 % de margen",
    );
  });

  it("en moneda extranjera", () => {
    expect(describeListRule({ id: "u", name: "U", kind: "currency", currency: "usd", fx_source: "oficial" })).toBe(
      "En USD con dólar oficial",
    );
  });

  it("redondeo y lista neta", () => {
    const l = {
      ...MAY,
      rounding: { mode: "ending" as const, ending: 99, direction: "nearest" as const },
      prices_include_tax: false,
    };
    expect(describeListRule(l)).toBe("Precio de venta −10 % · terminado en 99, al más cercano · sin IVA (al vender se suma)");
  });

  it("sin PRO toda lista se calcula como fija y sin redondeo", () => {
    const d = { id: "d", name: "Web", kind: "derived", base_list_id: "m", adjustment_pct: 5, rounding: { mode: "multiple" as const, step: 10 } };
    expect(describeListRule(d, [MAY], { pro: false })).toBe("Precio de venta +5 %");
  });

  it("describeAdjustment vacío sin ajuste", () => {
    expect(describeAdjustment(null, 0)).toBe("");
    expect(describeAdjustment("12.5", "200")).toBe("+12,5 % + $200");
  });
});
