import { describe, expect, it } from "vitest";
import {
  chargebackStatus,
  claimPaymentId,
  dedupeDisputes,
  mergeMpChargeback,
  mergeMpClaim,
  mpDisputesFromPayment,
  refundStatus,
  staleDisputeUpdates,
  webhookTopicKind,
} from "@/supabase/functions/_shared/paymentDisputes";
import {
  deadlineInfo,
  disputeSummary,
  disputeTimeline,
  effectiveNet,
  indexDisputes,
  isSaleAlert,
  lineDisputeState,
  pendingAlertCount,
  saleAlertBadges,
  type PaymentDisputeRow,
} from "@/lib/reports/paymentDisputes";
import { filterLines, summarize, summarySentences, type SettlementLineRow } from "@/lib/reports/processorReconciliation";

// ── Fixtures de la API de Mercado Pago ───────────────────────────────────────

const basePayment = {
  id: 1001,
  status: "approved",
  status_detail: "accredited",
  currency_id: "ARS",
  external_reference: "6f1c2a3b-0000-4000-8000-000000000001",
  transaction_amount: 1000,
  transaction_amount_refunded: 0,
  date_created: "2026-10-01T12:00:00.000-03:00",
  date_last_updated: "2026-10-05T10:00:00.000-03:00",
  refunds: [],
};

/** Fixture de GET /v1/chargebacks/{id} (respuesta de ejemplo de la documentación de MP). */
const chargebackCase = {
  id: "234000062890459000",
  payments: [1001],
  currency: "ARS",
  amount: 1000.5,
  reason: "unauthorized",
  reason_id: "6",
  coverage_applied: null,
  coverage_eligible: true,
  documentation_required: true,
  documentation_status: "pending",
  documentation: [],
  date_documentation_deadline: "2026-10-20T23:59:59.000-04:00",
  date_created: "2026-10-04T09:00:00.000-04:00",
  date_last_updated: "2026-10-04T09:00:00.000-04:00",
  live_mode: true,
};

describe("mpDisputesFromPayment", () => {
  it("un pago aprobado sin devoluciones no tiene disputas", () => {
    expect(mpDisputesFromPayment(basePayment)).toEqual([]);
    expect(mpDisputesFromPayment(null)).toEqual([]);
    expect(mpDisputesFromPayment({ status: "charged_back" })).toEqual([]);
  });

  it("una fila por devolución de refunds[], con origen y estado", () => {
    const out = mpDisputesFromPayment({
      ...basePayment,
      status_detail: "partially_refunded",
      transaction_amount_refunded: 300,
      refunds: [
        { id: 77, amount: 200, status: "approved", date_created: "2026-10-03T10:00:00.000-03:00", source: { type: "collector" }, reason: "buyer_request" },
        { id: 78, amount: 100, status: "in_process", date_created: "2026-10-04T10:00:00.000-03:00" },
        { id: 79, amount: 0, status: "approved" },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      kind: "refund",
      dispute_key: "mp_refund:77",
      provider_case_id: "77",
      provider_payment_id: "1001",
      amount: 200,
      status: "refunded",
      resolved: true,
      refund_source: "collector",
      reason: "buyer_request",
      occurred_at: "2026-10-03T13:00:00.000Z",
    });
    expect(out[1]).toMatchObject({ dispute_key: "mp_refund:78", status: "open", resolved: false });
  });

  it("sin refunds[] usa el total devuelto", () => {
    const [d] = mpDisputesFromPayment({ ...basePayment, status: "refunded", status_detail: "refunded", transaction_amount_refunded: 1000 });
    expect(d).toMatchObject({ kind: "refund", dispute_key: "mp_refund_total:1001", amount: 1000, status: "refunded" });
  });

  it("contracargo por pago, con el estado del status_detail", () => {
    const inProcess = mpDisputesFromPayment({ ...basePayment, status: "charged_back", status_detail: "in_process" });
    expect(inProcess).toEqual([
      expect.objectContaining({ kind: "chargeback", dispute_key: "mp_cb:1001", amount: 1000, status: "open", resolved: false }),
    ]);
    expect(mpDisputesFromPayment({ ...basePayment, status: "charged_back", status_detail: "settled" })[0]).toMatchObject({
      status: "lost",
      resolved: true,
    });
    expect(mpDisputesFromPayment({ ...basePayment, status: "charged_back", status_detail: "reimbursed" })[0]).toMatchObject({
      status: "won",
      resolved: true,
    });
  });

  it("reclamo abierto con el pago en mediación", () => {
    const [d] = mpDisputesFromPayment({ ...basePayment, status: "in_mediation", status_detail: "pending" });
    expect(d).toMatchObject({ kind: "claim", dispute_key: "mp_claim:1001", status: "open", amount: 1000 });
  });
});

describe("estados", () => {
  it("devoluciones", () => {
    expect(refundStatus("approved")).toEqual({ status: "refunded", resolved: true });
    expect(refundStatus("rejected")).toEqual({ status: "closed", resolved: true });
    expect(refundStatus("in_process")).toEqual({ status: "open", resolved: false });
  });

  it("contracargos: cobertura > documentación > status_detail", () => {
    expect(chargebackStatus({ coverage_applied: true, documentation_status: "pending" }).status).toBe("won");
    expect(chargebackStatus({ coverage_applied: false }).status).toBe("lost");
    expect(chargebackStatus({ documentation_status: "review_pending" })).toEqual({ status: "in_review", resolved: false });
    expect(chargebackStatus({ documentation_status: "pending", status_detail: "in_process" })).toEqual({ status: "open", resolved: false });
    expect(chargebackStatus({ status_detail: "settled" }).status).toBe("lost");
  });
});

describe("mergeMpChargeback", () => {
  it("completa el contracargo del pago con el caso", () => {
    const [cb] = mpDisputesFromPayment({ ...basePayment, status: "charged_back", status_detail: "in_process" });
    const m = mergeMpChargeback(cb!, chargebackCase)!;
    expect(m).toMatchObject({
      dispute_key: "mp_cb:1001",
      provider_case_id: "234000062890459000",
      amount: 1000.5,
      reason: "unauthorized",
      documentation_status: "pending",
      documentation_deadline: "2026-10-21T03:59:59.000Z",
      coverage_eligible: true,
      coverage_applied: null,
      status: "open",
      resolved: false,
    });
  });

  it("arma el contracargo desde el caso si el pago todavía no figura", () => {
    const m = mergeMpChargeback(null, { ...chargebackCase, coverage_applied: false }, "1001")!;
    expect(m).toMatchObject({ kind: "chargeback", dispute_key: "mp_cb:1001", status: "lost", resolved: true });
  });

  it("documentación presentada: en revisión", () => {
    const m = mergeMpChargeback(null, { ...chargebackCase, documentation_status: "review_pending" })!;
    expect(m.status).toBe("in_review");
    expect(m.provider_payment_id).toBe("1001");
  });
});

describe("reclamos y avisos", () => {
  it("topic del aviso", () => {
    expect(webhookTopicKind("topic_chargebacks_wh")).toBe("chargeback");
    expect(webhookTopicKind("chargebacks")).toBe("chargeback");
    expect(webhookTopicKind("topic_claims_integration_wh")).toBe("claim");
    expect(webhookTopicKind("payment")).toBeNull();
    expect(webhookTopicKind(null)).toBeNull();
  });

  it("pago del reclamo sólo si el recurso es un pago", () => {
    expect(claimPaymentId({ resource: "payment", resource_id: 1001 })).toBe("1001");
    expect(claimPaymentId({ resource: "shipment", resource_id: 5 })).toBeNull();
  });

  it("mergeMpClaim abre o cierra el reclamo", () => {
    const pay = { ...basePayment, status: "in_mediation" };
    const open = mergeMpClaim(null, { id: 555, status: "opened", reason_id: "PDD9939", date_created: "2026-10-06T10:00:00.000-03:00" }, pay)!;
    expect(open).toMatchObject({ dispute_key: "mp_claim:1001", provider_case_id: "555", status: "open", reason: "PDD9939" });
    const closed = mergeMpClaim(open, { id: 555, status: "closed" }, pay)!;
    expect(closed).toMatchObject({ status: "closed", resolved: true });
  });
});

describe("staleDisputeUpdates", () => {
  const open = [
    { dispute_key: "mp_claim:1001", kind: "claim" as const, provider_payment_id: "1001", provider_case_id: null, status: "open" as const },
    { dispute_key: "mp_cb:2002", kind: "chargeback" as const, provider_payment_id: "2002", provider_case_id: "9", status: "open" as const },
    { dispute_key: "mp_cb:3003", kind: "chargeback" as const, provider_payment_id: "3003", provider_case_id: null, status: "open" as const },
  ];
  it("cierra lo que dejó de estar en disputa y no toca lo que no se vio", () => {
    const out = staleDisputeUpdates(open, [
      { ...basePayment, id: 1001, status: "approved" },
      { ...basePayment, id: 2002, status: "approved" },
    ]);
    expect(out.map((d) => [d.dispute_key, d.status, d.resolved])).toEqual([
      ["mp_claim:1001", "closed", true],
      ["mp_cb:2002", "won", true],
    ]);
  });
  it("sigue abierto si el pago sigue en mediación o contracargo", () => {
    expect(
      staleDisputeUpdates(open, [
        { ...basePayment, id: 1001, status: "in_mediation" },
        { ...basePayment, id: 2002, status: "charged_back" },
      ]),
    ).toEqual([]);
  });
  it("dedupe conserva el caso y el plazo", () => {
    const [cb] = mpDisputesFromPayment({ ...basePayment, status: "charged_back", status_detail: "in_process" });
    const enriched = mergeMpChargeback(cb!, chargebackCase)!;
    const [m] = dedupeDisputes([enriched, cb!]);
    expect(m!.provider_case_id).toBe("234000062890459000");
    expect(m!.documentation_deadline).toBe("2026-10-21T03:59:59.000Z");
  });
});

// ── Conciliación y ventas ────────────────────────────────────────────────────

const NOW = new Date("2026-10-12T15:00:00Z");

const line = (over: Partial<SettlementLineRow>): SettlementLineRow => ({
  id: "l",
  provider_key: "mercadopago",
  scope_store_id: null,
  external_id: "1001",
  order_id: null,
  external_reference: null,
  kind: "payment",
  status: "approved",
  operation_at: "2026-10-05T15:00:00Z",
  release_date: "2026-10-06T15:00:00Z",
  released: true,
  gross: 1000,
  fee: 50,
  taxes: 10,
  net: 940,
  refunded: 0,
  payment_method: null,
  payment_type: null,
  card_brand: null,
  last4: null,
  installments: null,
  lote: null,
  cupon: null,
  autorizacion: null,
  comercio: null,
  terminal: null,
  description: null,
  payer: null,
  fee_detail: [],
  payment_id: null,
  intent_id: null,
  sale_id: null,
  match_status: "matched",
  match_method: "provider_id",
  diff_amount: 0,
  review_note: null,
  reviewed_at: null,
  ...over,
});

const dispute = (over: Partial<PaymentDisputeRow>): PaymentDisputeRow => ({
  id: "d",
  provider_key: "mercadopago",
  kind: "chargeback",
  provider_payment_id: "1001",
  provider_case_id: null,
  payment_id: "p1",
  sale_id: "s1",
  settlement_line_id: null,
  amount: 1000,
  currency: "ARS",
  status: "open",
  provider_status: "charged_back",
  provider_status_detail: "in_process",
  reason: null,
  refund_source: null,
  origin: "provider",
  documentation_status: "pending",
  documentation_deadline: "2026-10-13T12:00:00Z",
  coverage_applied: null,
  coverage_eligible: null,
  occurred_at: "2026-10-10T12:00:00Z",
  first_seen_at: "2026-10-11T09:20:00Z",
  resolved_at: null,
  acknowledged_at: null,
  ...over,
});

describe("estado de disputa de una línea y neto efectivo", () => {
  it("mapea estados", () => {
    expect(lineDisputeState(line({}))).toBeNull();
    expect(lineDisputeState(line({ status: "refunded", refunded: 1000 }))).toBe("refunded");
    expect(lineDisputeState(line({ refunded: 1000 }))).toBe("refunded");
    expect(lineDisputeState(line({ refunded: 300 }))).toBe("partially_refunded");
    expect(lineDisputeState(line({ status: "charged_back" }))).toBe("chargeback");
    expect(lineDisputeState(line({ status: "in_mediation" }))).toBe("claim");
    // Un contracargo guardado pesa aunque la línea no esté actualizada.
    expect(lineDisputeState(line({}), [dispute({})])).toBe("chargeback");
    // Ganado: deja de ser contracargo.
    expect(lineDisputeState(line({ status: "charged_back" }), [dispute({ status: "won", resolved_at: NOW.toISOString() })])).toBeNull();
  });

  it("neto efectivo", () => {
    expect(effectiveNet(line({}), null)).toBe(940);
    expect(effectiveNet(line({}), "refunded")).toBe(0);
    expect(effectiveNet(line({}), "chargeback")).toBe(0);
    expect(effectiveNet(line({ net: 600 }), "partially_refunded")).toBe(600);
    expect(effectiveNet(line({}), "claim")).toBe(940);
  });

  it("resumen de disputas: montos, neto perdido y en riesgo", () => {
    const lines = [
      line({ id: "a", external_id: "1", status: "refunded", refunded: 1000 }),
      line({ id: "b", external_id: "2", refunded: 300, net: 640 }),
      line({ id: "c", external_id: "3", status: "charged_back" }),
      line({ id: "d", external_id: "4", status: "in_mediation", gross: 500, net: 470 }),
      line({ id: "e", external_id: "5" }),
    ];
    const idx = indexDisputes([dispute({ provider_payment_id: "3", amount: 950 })]);
    const s = disputeSummary(lines, idx);
    expect(s.counts).toEqual({ refunded: 1, partially_refunded: 1, chargeback: 1, claim: 1 });
    expect(s.amounts).toEqual({ refunded: 1000, partially_refunded: 300, chargeback: 950, claim: 500 });
    expect(s.netLost).toBe(1880);
    expect(s.atRisk).toBe(1450);
    expect(s.total).toBe(4);

    const sum = summarize(lines, [], NOW, idx);
    // Neto: 0 + 640 + 0 + 470 + 940
    expect(sum.net).toBe(2050);
    expect(sum.released).toBe(2050);
    expect(sum.disputes.total).toBe(4);
    const f = summarySentences(sum, "mercadopago", (n) => `$${n}`, (iso) => iso);
    expect(f).toContain("Tuviste 1 contracargo por $950.");
    expect(f).toContain("Mercado Pago devolvió $1300 en 2 cobros.");
    expect(f).toContain("Hay $1450 en riesgo por contracargos o reclamos abiertos.");

    expect(filterLines(lines, "disputes", NOW, idx).map((l) => l.id)).toEqual(["a", "b", "c", "d"]);
    expect(filterLines(lines, "d_chargeback", NOW, idx).map((l) => l.id)).toEqual(["c"]);
    expect(filterLines(lines, "d_partially_refunded", NOW, idx).map((l) => l.id)).toEqual(["b"]);
  });

  it("contracargo perdido: neto 0 y nada en riesgo", () => {
    const idx = indexDisputes([dispute({ status: "lost", resolved_at: NOW.toISOString() })]);
    const s = disputeSummary([line({ status: "charged_back" })], idx);
    expect(s.atRisk).toBe(0);
    expect(s.netLost).toBe(940);
  });
});

describe("plazo, línea de tiempo y marcas", () => {
  it("plazo de documentación", () => {
    expect(deadlineInfo(dispute({}), NOW)).toMatchObject({ daysLeft: 1, overdue: false, urgent: true });
    expect(deadlineInfo(dispute({ documentation_deadline: "2026-10-01T00:00:00Z" }), NOW)).toMatchObject({ overdue: true });
    expect(deadlineInfo(dispute({ documentation_status: "review_pending" }), NOW)).toBeNull();
    expect(deadlineInfo(dispute({ kind: "refund" }), NOW)).toBeNull();
    expect(deadlineInfo(dispute({ resolved_at: NOW.toISOString() }), NOW)).toBeNull();
  });

  it("línea de tiempo ordenada", () => {
    const t = disputeTimeline(dispute({ status: "won", resolved_at: "2026-10-15T00:00:00Z" }));
    expect(t.map((e) => e.label)).toEqual([
      "Contracargo en Mercado Pago",
      "Lo detectó NinjaPos",
      "Plazo para presentar la documentación",
      "Resuelto a tu favor",
    ]);
  });

  it("marcas de la venta y conteo del Panel del dueño", () => {
    expect(isSaleAlert({ kind: "refund", origin: "pos", status: "refunded" })).toBe(false);
    expect(isSaleAlert({ kind: "refund", origin: "provider", status: "refunded" })).toBe(true);
    const badges = saleAlertBadges([
      dispute({}),
      dispute({ id: "r", kind: "refund", status: "refunded", amount: 200 }),
      dispute({ id: "rp", kind: "refund", status: "refunded", origin: "pos" }),
      dispute({ id: "c", kind: "claim", status: "open" }),
    ]);
    expect(badges.map((b) => [b.label, b.tone])).toEqual([
      ["Contracargo", "danger"],
      ["Reclamo abierto", "warning"],
      ["Devuelto por MP", "warning"],
    ]);
    expect(saleAlertBadges([dispute({ status: "won", resolved_at: NOW.toISOString() })])[0]).toMatchObject({
      label: "Contracargo ganado",
      tone: "success",
    });
    expect(
      pendingAlertCount([
        dispute({}),
        dispute({ kind: "refund", origin: "pos", status: "refunded" }),
        dispute({ acknowledged_at: NOW.toISOString() }),
        dispute({ kind: "claim", status: "closed" }),
      ]),
    ).toBe(1);
  });
});
