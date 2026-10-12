import { describe, expect, it } from "vitest";
import {
  brandLabel,
  mpSettlementLine,
  normalizeCloverPayment,
  normalizeGoCuotasOrder,
  normalizeMpPayment,
  normalizeNavePayment,
  normalizePaywayPayment,
  normalizeProcessorPayment,
} from "@/supabase/functions/_shared/processorData";
import {
  cloverPayment,
  goCuotasOrder,
  mpAccountMoneyPayment,
  mpCreditPayment,
  mpMoneyTransfer,
  mpRejectedPayment,
  navePayment,
  paywayPayment,
} from "../fixtures/processorPayments";

const NOW = new Date("2026-10-12T12:00:00Z");

describe("normalizeMpPayment", () => {
  it("toma comisiones e impuestos del vendedor desde charges_details", () => {
    const d = normalizeMpPayment(mpCreditPayment, NOW);
    expect(d.external_id).toBe("91234567890");
    expect(d.status).toBe("approved");
    expect(d.status_label).toBe("Aprobado");
    expect(d.gross).toBe(12000);
    expect(d.fee_total).toBe(732);
    expect(d.taxes_total).toBe(323.4);
    expect(d.net).toBe(10944.6);
    // El cupón lo paga Mercado Pago, no el vendedor.
    expect(d.fees.map((f) => f.label)).toEqual([
      "Comisión de Mercado Pago",
      "IVA sobre la comisión",
      "Retención de Ingresos Brutos",
    ]);
    expect(d.installments).toBe(3);
    expect(d.installment_amount).toBe(4000);
    expect(d.card).toEqual({ brand: "Visa", last4: "3704", first6: "450995", holder: "APRO" });
    expect(d.authorization).toBe("301234");
    expect(d.order_id).toBe("1234567");
    expect(d.payer?.doc).toBe("DNI 30111222");
    expect(d.released).toBe(false);
    expect(d.release_date).toBe("2026-10-24T18:03:12.000Z");
  });

  it("usa fee_details y taxes_amount en el formato viejo y marca acreditado", () => {
    const d = normalizeMpPayment(mpAccountMoneyPayment, NOW);
    expect(d.fee_total).toBe(40);
    expect(d.taxes_total).toBe(10);
    expect(d.net).toBe(4950);
    expect(d.released).toBe(true);
    expect(d.card).toBeNull();
    expect(d.timeline.at(-1)?.label).toBe("Dinero acreditado");
  });

  it("sin money_release_status decide por la fecha", () => {
    const { money_release_status: _omit, ...p } = mpCreditPayment;
    expect(normalizeMpPayment(p, NOW).released).toBe(false);
    expect(normalizeMpPayment(p, new Date("2026-11-01T00:00:00Z")).released).toBe(true);
  });

  it("tolera basura", () => {
    expect(normalizeMpPayment(null).status).toBe("unknown");
    expect(normalizeMpPayment("x").fees).toEqual([]);
  });
});

describe("mpSettlementLine", () => {
  it("arma la línea con clave estable, neto y acreditación", () => {
    const l = mpSettlementLine(mpCreditPayment, NOW)!;
    expect(l.line_key).toBe("mp:91234567890");
    expect(l.gross).toBe(12000);
    expect(l.fee).toBe(732);
    expect(l.taxes).toBe(323.4);
    expect(l.net).toBe(10944.6);
    expect(l.released).toBe(false);
    expect(l.external_reference).toBe(mpCreditPayment.external_reference);
    expect(l.card_brand).toBe("Visa");
    expect(l.operation_at).toBe("2026-10-10T18:03:12.000Z");
  });

  it("descarta pagos rechazados y transferencias salientes", () => {
    expect(mpSettlementLine(mpRejectedPayment, NOW)).toBeNull();
    expect(mpSettlementLine(mpMoneyTransfer, NOW)).toBeNull();
  });

  it("dinero en cuenta sin tarjeta usa la marca del medio", () => {
    expect(mpSettlementLine(mpAccountMoneyPayment, NOW)!.card_brand).toBe("Dinero en cuenta");
  });
});

describe("otros procesadores", () => {
  it("Payway: centavos, cupón y autorización", () => {
    const d = normalizePaywayPayment(paywayPayment);
    expect(d.gross).toBe(15500.5);
    expect(d.installments).toBe(6);
    expect(d.cupon).toBe("0042");
    expect(d.authorization).toBe("abc123");
    expect(d.comercio).toBe("12345678");
    expect(d.card?.first6).toBe("450799");
    expect(d.currency).toBe("ARS");
    expect(d.fees).toEqual([]);
    expect(d.net).toBe(15500.5);
  });

  it("Nave: débito con marca y últimos 4", () => {
    const d = normalizeNavePayment(navePayment);
    expect(d.status).toBe("approved");
    expect(d.gross).toBe(2500);
    expect(d.payment_type).toBe("debit");
    expect(d.card?.brand).toBe("Maestro");
    expect(d.card?.last4).toBe("1111");
    expect(d.authorization).toBe("998877");
  });

  it("Clover: suma la propina y lee el cupón del lote", () => {
    const d = normalizeCloverPayment(cloverPayment);
    expect(d.status).toBe("approved");
    expect(d.gross).toBe(1600);
    expect(d.card?.brand).toBe("Mastercard");
    expect(d.lote).toBe("15");
    expect(d.authorization).toBe("OK1234");
  });

  it("GO Cuotas: orden entregada = aprobada", () => {
    const d = normalizeGoCuotasOrder(goCuotasOrder);
    expect(d.status).toBe("approved");
    expect(d.gross).toBe(30000);
    expect(d.installments).toBe(4);
    expect(d.payer?.email).toBe("c@x.com");
  });

  it("despacha por provider_key y conserva el canal", () => {
    expect(normalizeProcessorPayment("mercadopago_point", mpCreditPayment, NOW).provider).toBe("mercadopago_point");
    expect(normalizeProcessorPayment("modo", {}).status).toBe("unknown");
  });

  it("nombres de marca", () => {
    expect(brandLabel("master")).toBe("Mastercard");
    expect(brandLabel("debcabal")).toBe("Cabal");
    expect(brandLabel(null)).toBeNull();
  });
});
