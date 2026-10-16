import { describe, expect, it } from "vitest";
import { validReason, zNeedsReview, zReviewLabel, zeroCloseNeedsConfirm } from "@/lib/cash/closeControls";

describe("zeroCloseNeedsConfirm (H156)", () => {
  it("pide confirmar con $0 contados y esperado positivo", () => {
    expect(zeroCloseNeedsConfirm(0, 50000)).toBe(true);
    expect(zeroCloseNeedsConfirm(0.001, 10)).toBe(true);
  });
  it("no pide nada si se contó algo o si no se esperaba efectivo", () => {
    expect(zeroCloseNeedsConfirm(100, 50000)).toBe(false);
    expect(zeroCloseNeedsConfirm(0, 0)).toBe(false);
    expect(zeroCloseNeedsConfirm(0, -20)).toBe(false);
    expect(zeroCloseNeedsConfirm(0, null)).toBe(false);
  });
});

describe("conciliación del Z (H156)", () => {
  it("un Z con diferencia sin revisar pide revisión", () => {
    expect(zNeedsReview({ difference: -25900 })).toBe(true);
    expect(zNeedsReview({ difference: 10, reviewed_at: "2026-10-15T12:00:00Z" })).toBe(false);
    expect(zNeedsReview({ difference: 0 })).toBe(false);
    expect(zNeedsReview({ difference: 0.004 })).toBe(false);
  });
  it("etiquetas y motivo mínimo", () => {
    expect(zReviewLabel("conteo")).toBe("Error de conteo");
    expect(zReviewLabel("raro")).toBe("Revisado");
    expect(validReason("ok")).toBe(false);
    expect(validReason("  mal contado ")).toBe(true);
  });
});
