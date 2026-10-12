import { describe, expect, it } from "vitest";
import {
  isIncomingTransfer,
  pairTransfer,
  transferInfo,
  type TransferInfo,
  type WatchLite,
} from "@/supabase/functions/_shared/mpTransfers";
import { autoSettingsOf, isMpCvuAccount, type TransferAccount } from "@/lib/payments/transfer";

const OWN = "123456";

// Forma de un pago de /v1/payments/search para una transferencia entrante a
// un CVU (campos asumidos: ver ADR-061; "Probar detección" lo verifica).
const incoming = {
  id: 555001,
  status: "approved",
  payment_type_id: "bank_transfer",
  payment_method_id: "cvu",
  operation_type: "money_transfer",
  collector_id: 123456,
  transaction_amount: 15000,
  date_created: "2026-10-12T15:00:00.000-03:00",
  date_approved: "2026-10-12T15:00:05.000-03:00",
  payer: { id: "999", first_name: "Juan", last_name: "Pérez", identification: { type: "CUIT", number: "20111222333" } },
};

describe("isIncomingTransfer", () => {
  it("acepta transferencias entrantes aprobadas", () => {
    expect(isIncomingTransfer(incoming, OWN)).toBe(true);
    expect(isIncomingTransfer({ ...incoming, payment_type_id: "account_money", payment_method_id: "account_money", operation_type: "account_fund" }, OWN)).toBe(true);
  });
  it("descarta salientes, otras cuentas, no aprobadas y cobros comunes", () => {
    expect(isIncomingTransfer({ ...incoming, payer: { id: OWN } }, OWN)).toBe(false);
    expect(isIncomingTransfer({ ...incoming, collector_id: 1 }, OWN)).toBe(false);
    expect(isIncomingTransfer({ ...incoming, status: "pending" }, OWN)).toBe(false);
    expect(
      isIncomingTransfer({ ...incoming, payment_type_id: "credit_card", payment_method_id: "visa", operation_type: "regular_payment" }, OWN),
    ).toBe(false);
    expect(isIncomingTransfer(null, OWN)).toBe(false);
  });
});

describe("transferInfo", () => {
  it("toma monto, fecha aprobada, nombre y documento", () => {
    expect(transferInfo(incoming)).toEqual({
      id: "555001",
      amount: 15000,
      at: "2026-10-12T18:00:05.000Z",
      payer_name: "Juan Pérez",
      payer_doc: "CUIT 20111222333",
      bank: null,
    });
  });
  it("usa los datos del banco si no hay pagador", () => {
    const t = transferInfo({
      id: "x",
      transaction_amount: "10",
      date_created: "2026-10-12T15:00:00Z",
      point_of_interaction: { transaction_data: { bank_info: { payer: { long_name: "ANA GOMEZ", identification: { type: "CUIL", number: "27" } } } } },
    });
    expect(t?.payer_name).toBe("ANA GOMEZ");
    expect(t?.payer_doc).toBe("CUIL 27");
    expect(transferInfo({ id: "y" })).toBeNull();
  });
});

const watch = (over: Partial<WatchLite> = {}): WatchLite => ({
  id: "w1",
  amount: 15000,
  tolerance: 0,
  created_at: "2026-10-12T17:59:00Z",
  expires_at: "2026-10-12T18:29:00Z",
  ...over,
});
const tr = (id: string, amount: number, at = "2026-10-12T18:00:05Z"): TransferInfo => ({
  id,
  amount,
  at,
  payer_name: null,
  payer_doc: null,
  bank: null,
});

describe("pairTransfer", () => {
  it("un solo candidato en monto y ventana = matched", () => {
    const r = pairTransfer(watch(), [tr("a", 15000), tr("b", 14000)]);
    expect(r.status).toBe("matched");
    expect(r.match?.id).toBe("a");
  });
  it("tolerancia por arriba y por abajo", () => {
    expect(pairTransfer(watch({ tolerance: 50 }), [tr("a", 15050)]).status).toBe("matched");
    expect(pairTransfer(watch({ tolerance: 50 }), [tr("a", 14949)]).status).toBe("waiting");
  });
  it("fuera de la ventana no cuenta (2 min antes sí)", () => {
    expect(pairTransfer(watch(), [tr("a", 15000, "2026-10-12T17:57:30Z")]).status).toBe("matched");
    expect(pairTransfer(watch(), [tr("a", 15000, "2026-10-12T17:56:00Z")]).status).toBe("waiting");
    expect(pairTransfer(watch(), [tr("a", 15000, "2026-10-12T18:30:00Z")]).status).toBe("waiting");
  });
  it("nunca reusa un movimiento usado o rechazado", () => {
    expect(pairTransfer(watch(), [tr("a", 15000)], { usedIds: ["a"] }).status).toBe("waiting");
    expect(pairTransfer(watch({ rejected_ids: ["a"] }), [tr("a", 15000)]).status).toBe("waiting");
  });
  it("dos candidatos u otra espera que también encaja = ambiguous", () => {
    expect(pairTransfer(watch(), [tr("a", 15000), tr("b", 15000)]).status).toBe("ambiguous");
    const other = watch({ id: "w2" });
    const r = pairTransfer(watch(), [tr("a", 15000)], { otherWatches: [other] });
    expect(r.status).toBe("ambiguous");
    expect(r.candidates.map((c) => c.id)).toEqual(["a"]);
    // La otra espera ya lo rechazó: no compite.
    expect(pairTransfer(watch(), [tr("a", 15000)], { otherWatches: [{ ...other, rejected_ids: ["a"] }] }).status).toBe("matched");
  });
});

describe("cuenta de Mercado Pago", () => {
  it("se reconoce por el slug o por el PSP 0003 del CVU", () => {
    expect(isMpCvuAccount({ bank_slug: "mercado-pago", cbu: null })).toBe(true);
    expect(isMpCvuAccount({ bank_slug: null, cbu: "0000003100012345678901" })).toBe(true);
    expect(isMpCvuAccount({ bank_slug: "uala", cbu: "0000007900012345678901" })).toBe(false);
    expect(isMpCvuAccount({ bank_slug: "galicia", cbu: "0070999030004123456789" })).toBe(false);
  });
  it("valores por defecto de la detección", () => {
    expect(autoSettingsOf({ id: "a" } as TransferAccount)).toEqual({
      auto_detect: false,
      auto_tolerance: 0,
      auto_mode: "notify",
      auto_window_min: 30,
    });
  });
});
