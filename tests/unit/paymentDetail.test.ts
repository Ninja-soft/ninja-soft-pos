import { describe, expect, it } from "vitest";
import {
  isIntentRef,
  isLocalOnly,
  methodLabel,
  needsLivePolling,
  paymentFields,
  paymentProviderKey,
  paymentTimeline,
  providerErrorMessage,
  providerName,
  voucherInfo,
  type PaymentIntentRow,
  type SalePaymentRow,
} from "@/lib/sales/paymentDetail";

const INTENT_ID = "6a3c1c35-7b7a-4f61-8f6a-0f1c2a9d1b11";

const pay = (over: Partial<SalePaymentRow> = {}): SalePaymentRow => ({
  id: "p1",
  method: "credit",
  amount: 1000,
  reference: null,
  created_at: "2026-10-10T15:00:05Z",
  card_voucher: null,
  reconciled_at: null,
  ...over,
});

const intent = (over: Partial<PaymentIntentRow> = {}): PaymentIntentRow => ({
  id: INTENT_ID,
  provider_key: "mercadopago_point",
  status: "approved",
  amount: 1000,
  mp_payment_id: "91234567890",
  mp_order_id: "ORD01ABC",
  preference_id: null,
  point_device_id: "PAX_A910__SMARTPOS1",
  payment_terminal_id: null,
  created_at: "2026-10-10T15:00:00Z",
  updated_at: "2026-10-10T15:00:03Z",
  secret_store_id: null,
  ...over,
});

describe("etiquetas", () => {
  it("medios y proveedores", () => {
    expect(methodLabel("qr")).toBe("QR o billetera");
    expect(methodLabel("account")).toBe("Cuenta corriente");
    expect(methodLabel("raro")).toBe("raro");
    expect(providerName("fiserv_point")).toBe("Clover");
    expect(providerName("nuevo")).toBe("Nuevo");
    expect(providerName(null)).toBeNull();
    expect(isLocalOnly("cash")).toBe(true);
    expect(isLocalOnly("qr")).toBe(false);
  });
  it("referencia de intent", () => {
    expect(isIntentRef(INTENT_ID)).toBe(true);
    expect(isIntentRef("Operación 123")).toBe(false);
    expect(isIntentRef(null)).toBe(false);
  });
});

describe("paymentProviderKey y voucher", () => {
  it("intent primero, si no el adquirente del cupón", () => {
    expect(paymentProviderKey(pay(), intent())).toBe("mercadopago_point");
    expect(paymentProviderKey(pay({ card_voucher: { adquirente: "payway" } }), null)).toBe("payway");
    expect(paymentProviderKey(pay({ method: "directo" }), null)).toBe("directo");
    expect(paymentProviderKey(pay({ method: "cash" }), null)).toBeNull();
  });
  it("marca, últimos 4 y cuotas", () => {
    expect(voucherInfo(pay({ card_voucher: { marca: "Visa", ultimos4: "3704", cuotas: 3 } }))).toEqual({
      brand: "Visa",
      last4: "3704",
      cuotas: 3,
    });
    expect(voucherInfo(pay()).cuotas).toBeNull();
  });
});

describe("paymentFields", () => {
  it("cupón, comercio, terminal e ids copiables en orden", () => {
    const f = paymentFields(
      pay({ reference: INTENT_ID, card_voucher: { lote: "15", cupon: "42", autorizacion: "AB12", comercio: "12345", adquirente: "fiserv", cuotas: 1 } }),
      intent({ payment_terminal_id: "t1" }),
      "Caja 1 Point",
    );
    expect(f.map((x) => x.key)).toEqual([
      "cuotas",
      "autorizacion",
      "cupon",
      "lote",
      "comercio",
      "adquirente",
      "terminal",
      "provider_payment",
      "provider_order",
      "intent",
    ]);
    expect(f.find((x) => x.key === "cuotas")?.value).toBe("1 pago");
    expect(f.find((x) => x.key === "adquirente")?.value).toBe("Fiserv");
    expect(f.find((x) => x.key === "terminal")?.value).toBe("Caja 1 Point");
    expect(f.filter((x) => x.copy).length).toBe(3);
  });
  it("transferencia: referencia; cuenta corriente: nada", () => {
    expect(paymentFields(pay({ method: "transfer", reference: "Operación 9" }), null, null)).toEqual([
      { key: "reference", label: "Referencia", value: "Operación 9", mono: true, copy: true },
    ]);
    expect(paymentFields(pay({ method: "account", reference: "{}" }), null, null)).toEqual([]);
  });
});

describe("paymentTimeline", () => {
  it("ordena intent, aprobación, venta, procesador y conciliación sin duplicar", () => {
    const steps = paymentTimeline(
      pay({ reconciled_at: "2026-10-12T10:00:00Z" }),
      intent(),
      "2026-10-10T15:00:05Z",
      [
        { at: "2026-10-10T15:00:01Z", label: "Aprobado" },
        { at: "2026-10-24T15:00:00Z", label: "Acreditación prevista" },
      ],
    );
    expect(steps.map((s) => s.label)).toEqual([
      "Cobro iniciado",
      "Pago aprobado",
      "Venta registrada",
      "Conciliado",
      "Acreditación prevista (procesador)",
    ]);
    expect(steps.at(-1)?.tone).toBe("warning");
  });
  it("sin intent: sólo la venta", () => {
    expect(paymentTimeline(pay({ method: "cash" }), null, "2026-10-10T15:00:05Z").map((s) => s.label)).toEqual([
      "Venta registrada",
    ]);
  });
});

describe("sondeo y errores", () => {
  it("sondea con intents pendientes o plata por acreditar", () => {
    expect(needsLivePolling([intent({ status: "pending" })], [])).toBe(true);
    expect(needsLivePolling([intent()], [false])).toBe(true);
    expect(needsLivePolling([intent()], [true, null])).toBe(false);
  });
  it("mensajes por código", () => {
    expect(providerErrorMessage("not_connected", "Payway")).toBe("Conectá Payway para ver los datos de este cobro.");
    expect(providerErrorMessage("otra", null)).toBe("No pudimos consultar al procesador.");
  });
});
