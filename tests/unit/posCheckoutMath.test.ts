import { describe, expect, it } from "vitest";
import {
  applyRounding,
  checkoutTotals,
  quickCashAmounts,
  settleLine,
  splitShare,
  tipFromPercent,
  tipMethodFor,
} from "@/lib/pos/checkoutMath";

describe("redondeo y montos rápidos", () => {
  it("redondea al múltiplo configurado y deja igual sin múltiplo", () => {
    expect(applyRounding(8949, 100)).toBe(8900);
    expect(applyRounding(8950, 100)).toBe(9000);
    expect(applyRounding(8949.5, 0)).toBe(8949.5);
  });

  it("propone billetes por encima del total, sin el exacto", () => {
    expect(quickCashAmounts(8900)).toEqual([9000, 10000, 20000]);
    expect(quickCashAmounts(45300)).toEqual([45500, 46000, 50000, 60000]);
    expect(quickCashAmounts(0)).toEqual([]);
  });

  it("suma los montos fijos del negocio y respeta el máximo", () => {
    expect(quickCashAmounts(8900, { custom: [8950, 1000], max: 3 })).toEqual([8950, 9000, 10000]);
  });
});

describe("división del saldo", () => {
  it("parte el saldo en centavos exactos", () => {
    expect(splitShare(100, 3)).toBe(33.33);
    // Lo que queda después de dos tercios se cobra entero en la última parte.
    expect(splitShare(100 - 33.33, 2)).toBe(33.34);
    expect(splitShare(33.33, 1)).toBe(33.33);
  });
});

describe("totales del cobro", () => {
  it("espeja create_sale: redondeo de productos, envío y propina aparte", () => {
    const t = checkoutTotals({
      base: 8949,
      rounding: 100,
      deliveryFee: 500,
      tip: 300,
      lines: [],
    });
    expect(t.productsTotal).toBe(9400);
    expect(t.grandTotal).toBe(9700);
    expect(t.remaining).toBe(9700);
    expect(t.settled).toBe(false);
  });

  it("descuenta la promo por medio y suma garantía y recargos de las líneas", () => {
    const t = checkoutTotals({
      base: 10000,
      rounding: 0,
      promoExtra: 1000,
      warranty: 500,
      lines: [{ method: "credit", amount: 5750, surcharge: 750 }],
    });
    expect(t.productsTotal).toBe(10250);
    expect(t.paid).toBe(5750);
    expect(t.remaining).toBe(4500);
  });

  it("calcula el vuelto sólo con el efectivo recibido de más", () => {
    const t = checkoutTotals({
      base: 8900,
      rounding: 0,
      lines: [
        { method: "cash", amount: 4900, surcharge: 0, received: 10000 },
        { method: "debit", amount: 4000, surcharge: 0 },
      ],
    });
    expect(t.change).toBe(5100);
    expect(t.settled).toBe(true);
  });
});

describe("liquidación de una línea manual", () => {
  it("una línea parcial cobra la porción más su recargo", () => {
    const r = settleLine({ base: 10000, rounding: 0, lines: [] }, 4000, 10);
    expect(r).toEqual({ amount: 4400, surcharge: 400, closes: false });
  });

  it("la línea que cierra la cuenta deja el saldo en cero aunque el redondeo se mueva", () => {
    const input = {
      base: 10000,
      rounding: 100,
      lines: [{ method: "cash", amount: 6000, surcharge: 0 }],
    };
    // Resta 4000; con 15 % de recargo el total pasa a round(10600) = 10600.
    const r = settleLine(input, 4000, 15);
    expect(r.closes).toBe(true);
    expect(r.surcharge).toBe(600);
    const after = checkoutTotals({
      ...input,
      lines: [...input.lines, { method: "credit", amount: r.amount, surcharge: r.surcharge }],
    });
    expect(after.remaining).toBe(0);
  });

  it("absorbe el redondeo cuando el recargo no es múltiplo", () => {
    const input = { base: 9990, rounding: 100, lines: [] };
    const r = settleLine(input, 10000, 3.5);
    const after = checkoutTotals({
      ...input,
      lines: [{ method: "credit", amount: r.amount, surcharge: r.surcharge }],
    });
    expect(after.remaining).toBe(0);
    expect(after.productsTotal % 100).toBe(0);
  });
});

describe("propina", () => {
  it("calcula la propina por porcentaje en pesos enteros", () => {
    expect(tipFromPercent(45300, 10)).toBe(4530);
    expect(tipFromPercent(1999, 15)).toBe(300);
    expect(tipFromPercent(0, 10)).toBe(0);
  });

  it("mapea el medio de la propina a los valores de sales.tip_method", () => {
    expect(tipMethodFor("qr")).toBe("qr");
    expect(tipMethodFor("account")).toBe("cash");
    expect(tipMethodFor(undefined)).toBe("cash");
  });
});
