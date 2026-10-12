import { describe, expect, it } from "vitest";
import {
  accentPalette,
  availablePlans,
  brandForDetected,
  contrastRatio,
  detectCardFamily,
  formatCardNumber,
  interestLabel,
  luhnValid,
  quoteInstallments,
  validateCard,
} from "@/lib/payments/paywayCheckout";
import { finalAmountWithSurcharge } from "@/supabase/functions/_shared/payway";

const money = (n: number) => n.toLocaleString("es-AR", { style: "currency", currency: "ARS" });

describe("quoteInstallments", () => {
  it("calcula total, cuota e interés como el server", () => {
    const q = quoteInstallments(1900, { installments: 3, surcharge_pct: 9 });
    expect(q.total).toBe(2071);
    expect(q.total).toBe(finalAmountWithSurcharge(1900, 9));
    expect(q.perInstallment).toBe(690.33);
    expect(q.interest).toBe(171);
  });

  it("sin recargo no hay interés", () => {
    const q = quoteInstallments(1900, { installments: 1, surcharge_pct: 0 });
    expect(q).toMatchObject({ total: 1900, perInstallment: 1900, interest: 0 });
    expect(interestLabel(q, money)).toBe("Sin interés");
  });

  it("arma la píldora con % y monto", () => {
    const q = quoteInstallments(1900, { installments: 6, surcharge_pct: 12.5 });
    expect(q.interest).toBe(237.5);
    expect(interestLabel(q, money)).toMatch(/^\+12,5% · \$\s?237,50 de interés$/);
  });
});

describe("availablePlans", () => {
  const plans = [
    { brand: null, installments: 3, label: "3", surcharge_pct: 10 },
    { brand: "visa", installments: 3, label: "3 visa", surcharge_pct: 0 },
    { brand: "master", installments: 6, label: "6 master", surcharge_pct: 20 },
  ];
  it("el plan de la marca pisa al genérico y suma 1 pago", () => {
    const v = availablePlans(plans, "visa", false);
    expect(v.map((p) => [p.installments, p.surcharge_pct])).toEqual([
      [1, 0],
      [3, 0],
    ]);
  });
  it("débito sólo 1 pago", () => {
    expect(availablePlans(plans, "visa_debito", true).map((p) => p.installments)).toEqual([1]);
  });
});

describe("detección de marca por BIN", () => {
  it.each([
    ["4507990000004905", "visa"],
    ["5299910010000015", "master"],
    ["2221000000000009", "master"],
    ["371449635398431", "amex"],
    ["36463664750005", "diners"],
    ["5895620000000002", "naranja"],
    ["6042010000000000", "cabal"],
    ["5896570000000008", "cabal"],
    ["5018000000000000", "maestro"],
    ["9", null],
  ])("%s → %s", (n, fam) => {
    expect(detectCardFamily(n)).toBe(fam);
  });

  it("respeta Visa Débito con un BIN Visa y cambia de familia si hace falta", () => {
    const offered = ["visa", "visa_debito", "master", "amex"];
    expect(brandForDetected("visa_debito", "visa", offered)).toBe("visa_debito");
    expect(brandForDetected("visa", "master", offered)).toBe("master");
    expect(brandForDetected("visa", "cabal", offered)).toBe("visa");
    expect(brandForDetected("master", null, offered)).toBe("master");
  });

  it("formatea según la marca", () => {
    expect(formatCardNumber("4507990000004905")).toBe("4507 9900 0000 4905");
    expect(formatCardNumber("371449635398431999")).toBe("3714 496353 98431");
  });
});

describe("validateCard", () => {
  const now = new Date(2026, 9, 12);
  const ok = { number: "4507 9900 0000 4905", exp: "12/30", cvv: "123", holder: "JUAN PEREZ", dni: "25123456" };
  it("acepta datos válidos", () => {
    expect(luhnValid(ok.number)).toBe(true);
    expect(validateCard(ok, now)).toEqual({});
  });
  it("marca errores por campo", () => {
    const e = validateCard({ number: "4507 9900 0000 4906", exp: "09/26", cvv: "12", holder: "", dni: "1" }, now);
    expect(Object.keys(e).sort()).toEqual(["cvv", "dni", "exp", "holder", "number"]);
    expect(e.exp).toBe("La tarjeta está vencida.");
  });
  it("el mes actual todavía es válido; Amex pide 4 dígitos", () => {
    expect(validateCard({ ...ok, exp: "10/26" }, now).exp).toBeUndefined();
    expect(validateCard({ ...ok, number: "371449635398431", cvv: "123" }, now).cvv).toBeDefined();
  });
});

describe("accentPalette", () => {
  it.each(["#FF4B22", "#FFD400", "#22C55E", "#0F172A", null, "basura"])(
    "%s da botón y texto con contraste AA",
    (accent) => {
      const p = accentPalette(accent);
      expect(contrastRatio(p.solid, "#ffffff")).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(p.text, p.softer)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(p.text, p.soft)).toBeGreaterThanOrEqual(4.5);
    },
  );
});
