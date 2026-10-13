import { describe, expect, it } from "vitest";
import { tenderGlyph } from "@/components/pos/ui/TenderLogo";
import { TENDER_BY_ID, integratedCardTender } from "@/lib/pos/tenders";

describe("tenderGlyph", () => {
  it("usa el set propio para los medios genéricos", () => {
    expect(tenderGlyph(TENDER_BY_ID.cash!)).toBe("efectivo");
    expect(tenderGlyph(TENDER_BY_ID.transfer!)).toBe("transferencia");
    expect(tenderGlyph(TENDER_BY_ID.card!)).toBe("tarjeta");
    expect(tenderGlyph(TENDER_BY_ID.account!)).toBe("cuenta-corriente");
    expect(tenderGlyph(TENDER_BY_ID.store_credit!)).toBe("vale");
  });

  it("conserva el logo oficial de las marcas", () => {
    expect(tenderGlyph(TENDER_BY_ID["mercadopago:qr"]!)).toBeNull();
    expect(tenderGlyph(TENDER_BY_ID["modo:qr"]!)).toBeNull();
  });

  it("la tarjeta en terminal integrada conserva el logo del adquirente", () => {
    const t = integratedCardTender(TENDER_BY_ID.card!, {
      terminalId: "x",
      label: "Pinpad",
      providerKey: "payway",
      requiresBrand: false,
      simulated: false,
    });
    expect(tenderGlyph(t)).toBeNull();
  });

  it("resuelve las líneas de pago por tenderId o método (seña)", () => {
    expect(tenderGlyph({ tenderId: "sena", method: "sena", logo: null })).toBe("sena");
    expect(tenderGlyph({ tenderId: "cash", logo: "/images/payments/efectivo-icon.webp" })).toBe("efectivo");
    expect(tenderGlyph({ method: "other", logo: null })).toBe("otro");
  });
});
