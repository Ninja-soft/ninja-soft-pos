import { describe, expect, it } from "vitest";
import {
  classifyMpRefund,
  mpOrderPaymentId,
  mpRefundErrorCode,
  refundAmount,
} from "@/supabase/functions/_shared/mpRefund";
import {
  canFallback,
  canRetry,
  clampMpAmount,
  maxMpAmount,
  mpRefundAvailable,
  mpRefundErrorMessage,
  mpRefundUnavailableReason,
  mpRefundedTotal,
  usablePayments,
  type MpRefundOptions,
} from "@/lib/payments/mpRefund";
import { ALWAYS_PIN, DEFAULT_POLICY, PIN_ACTIONS, normalizeSettings, pinRequired } from "@/lib/security/pinPolicy";
import { lineDisputeLabel, refundsFromPos, type PaymentDisputeRow } from "@/lib/reports/paymentDisputes";

const pay = (over: Partial<MpRefundOptions["payments"][number]> = {}) => ({
  payment_id: "p1",
  intent_id: "i1",
  provider_key: "mercadopago",
  paid: 1000,
  refunded: 0,
  refundable: 1000,
  expired: false,
  paid_at: "2026-10-01T12:00:00Z",
  ...over,
});
const opts = (over: Partial<MpRefundOptions> = {}): MpRefundOptions => ({
  feature: true,
  enabled: true,
  is_supervisor: false,
  window_days: 180,
  payments: [pay()],
  ...over,
});

describe("mpRefund · respuesta de Mercado Pago", () => {
  it("201 approved con id: hecho", () => {
    expect(classifyMpRefund(201, { id: 123456, status: "approved", amount: 500 })).toEqual({
      outcome: "approved",
      refundId: "123456",
      mpStatus: "approved",
      code: null,
      detail: null,
    });
  });

  it("in_process / pending cuentan como aceptados", () => {
    expect(classifyMpRefund(201, { id: 9, status: "in_process" }).outcome).toBe("in_process");
    expect(classifyMpRefund(200, { id: 9, status: "pending" }).outcome).toBe("in_process");
  });

  it("2xx rechazado: failed con el id", () => {
    const r = classifyMpRefund(201, { id: 9, status: "rejected" });
    expect(r.outcome).toBe("failed");
    expect(r.refundId).toBe("9");
    expect(r.code).toBe("rejected_by_mp");
  });

  it("2xx sin id: dudoso", () => {
    expect(classifyMpRefund(201, { status: "approved" }).outcome).toBe("error");
  });

  it("red, 5xx, 429, 408 y 409: dudosos (se reintenta con la misma clave)", () => {
    for (const http of [0, 408, 409, 429, 500, 502, 503]) {
      const r = classifyMpRefund(http, { message: "boom" });
      expect(r.outcome, String(http)).toBe("error");
      expect(r.code).toBe("provider_unavailable");
    }
  });

  it("4xx: rechazo firme con código honesto", () => {
    expect(classifyMpRefund(400, { message: "Insufficient funds in the account", cause: [] }).code).toBe(
      "insufficient_balance",
    );
    expect(classifyMpRefund(400, { message: "Payment in mediation" }).code).toBe("payment_in_dispute");
    expect(classifyMpRefund(400, { message: "Payment already refunded" }).code).toBe("already_refunded");
    expect(classifyMpRefund(400, { message: "The refund period has expired" }).code).toBe("refund_period_expired");
    expect(classifyMpRefund(400, { message: "Invalid refund amount" }).code).toBe("invalid_amount");
    expect(classifyMpRefund(404, { message: "Payment not found" }).code).toBe("payment_not_found");
    expect(classifyMpRefund(401, { message: "invalid access token" }).code).toBe("mp_auth");
    expect(classifyMpRefund(400, { message: "bad request" }).code).toBe("rejected_by_mp");
    expect(classifyMpRefund(400, { message: "x" }).outcome).toBe("failed");
  });

  it("lee las causas de MP", () => {
    expect(
      mpRefundErrorCode(400, { message: "bad_request", cause: [{ code: 2063, description: "Not enough balance" }] }),
    ).toBe("insufficient_balance");
  });

  it("id del pago de una orden (Orders API)", () => {
    expect(
      mpOrderPaymentId({ transactions: { payments: [{ id: "PAY01", reference_id: "1234567890" }] } }),
    ).toBe("1234567890");
    expect(mpOrderPaymentId({ transactions: { payments: [{ id: "PAY01" }] } })).toBeNull();
    expect(mpOrderPaymentId(null)).toBeNull();
  });

  it("monto con dos decimales", () => {
    expect(refundAmount(10.005)).toBe(10.01);
    expect(refundAmount(1234.5)).toBe(1234.5);
  });
});

describe("mpRefund · wizard", () => {
  it("se ofrece con feature, ajuste y un cobro con saldo en plazo", () => {
    expect(mpRefundAvailable(opts())).toBe(true);
    expect(mpRefundAvailable(opts({ feature: false }))).toBe(false);
    expect(mpRefundAvailable(opts({ enabled: false }))).toBe(false);
    expect(mpRefundAvailable(opts({ payments: [pay({ expired: true })] }))).toBe(false);
    expect(mpRefundAvailable(opts({ payments: [pay({ refundable: 0 })] }))).toBe(false);
    expect(mpRefundAvailable(null)).toBe(false);
  });

  it("explica por qué no se ofrece", () => {
    expect(mpRefundUnavailableReason(opts())).toBeNull();
    expect(mpRefundUnavailableReason(opts({ payments: [] }))).toBeNull();
    expect(mpRefundUnavailableReason(opts({ feature: false }))).toMatch(/plan/);
    expect(mpRefundUnavailableReason(opts({ enabled: false }))).toMatch(/dueño/);
    expect(mpRefundUnavailableReason(opts({ payments: [pay({ expired: true })] }))).toMatch(/180 días/);
    expect(mpRefundUnavailableReason(opts({ payments: [pay({ refundable: 0 })] }))).toMatch(/reintegrado/);
  });

  it("tope: lo devuelto y lo disponible del cobro", () => {
    expect(maxMpAmount(600, pay())).toBe(600);
    expect(maxMpAmount(1500, pay({ refundable: 400 }))).toBe(400);
    expect(maxMpAmount(100, null)).toBe(0);
    expect(clampMpAmount(700, 600)).toBe(600);
    expect(clampMpAmount(-1, 600)).toBe(0);
    expect(clampMpAmount(Number.NaN, 600)).toBe(0);
    expect(clampMpAmount(250.555, 600)).toBe(250.56);
  });

  it("sólo cobros usables", () => {
    const o = opts({ payments: [pay(), pay({ payment_id: "p2", expired: true }), pay({ payment_id: "p3", refundable: 0 })] });
    expect(usablePayments(o).map((p) => p.payment_id)).toEqual(["p1"]);
  });

  it("acciones por estado", () => {
    expect(canRetry("error")).toBe(true);
    expect(canRetry("failed")).toBe(true);
    expect(canRetry("approved")).toBe(false);
    expect(canFallback("failed")).toBe(true);
    expect(canFallback("pending")).toBe(true);
    expect(canFallback("error")).toBe(false);
    expect(canFallback("approved")).toBe(false);
  });

  it("mensajes", () => {
    expect(mpRefundErrorMessage("insufficient_balance")).toMatch(/saldo suficiente/);
    expect(mpRefundErrorMessage("feature_not_in_plan: reintegro_mp")).toMatch(/plan/);
    expect(mpRefundErrorMessage("P0001: mp_amount_exceeds_refundable")).toMatch(/supera/);
    expect(mpRefundErrorMessage(null)).toMatch(/No se pudo/);
  });

  it("total reintegrado", () => {
    expect(
      mpRefundedTotal([
        { amount: 100, status: "approved" },
        { amount: 50, status: "in_process" },
        { amount: 30, status: "failed" },
        { amount: 20, status: "fallback" },
      ]),
    ).toBe(150);
  });
});

describe("PIN 'reintegro_mp'", () => {
  it("es acción de PIN que siempre se pide", () => {
    expect(PIN_ACTIONS).toContain("reintegro_mp");
    expect(ALWAYS_PIN).toContain("reintegro_mp");
    expect(pinRequired(DEFAULT_POLICY, "reintegro_mp", 1)).toBe(true);
    const s = normalizeSettings({ pin_policy: { ...DEFAULT_POLICY, reintegro_mp: { enabled: false, threshold: 0 } } });
    expect(s.pin_policy.reintegro_mp.enabled).toBe(true);
  });
});

describe("conciliación · Devuelto (POS)", () => {
  const d = (over: Partial<PaymentDisputeRow>) =>
    ({ kind: "refund", origin: "pos", status: "refunded", ...over }) as PaymentDisputeRow;

  it("todas las devoluciones del POS", () => {
    expect(refundsFromPos([d({})])).toBe(true);
    expect(refundsFromPos([d({}), d({ origin: "provider" })])).toBe(false);
    expect(refundsFromPos([])).toBe(false);
    expect(refundsFromPos([d({ status: "closed" })])).toBe(false);
  });

  it("etiqueta", () => {
    expect(lineDisputeLabel("refunded", [d({})]).label).toBe("Devuelto (POS)");
    expect(lineDisputeLabel("partially_refunded", [d({})]).label).toBe("Devuelto parcial (POS)");
    expect(lineDisputeLabel("refunded", [d({ origin: "provider" })]).label).toBe("Devuelto");
    expect(lineDisputeLabel("chargeback", [d({})]).label).toBe("Contracargo");
  });
});
