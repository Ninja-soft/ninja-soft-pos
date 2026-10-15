// =============================================================================
// Conciliación con Mercado Pago (F20-10 · H136 · ADR-131): lógica pura de
// supabase/functions/_shared/billing/reconcile.ts (la usa la Edge
// platform_mp_reconcile) y las acciones de la bandeja.
// =============================================================================
import { describe, expect, it } from "vitest";
import {
  parseMpPayment,
  reconActionsFor,
  reconcile,
  reconWindow,
  RECON_KIND_LABELS,
  type LocalPayment,
  type MpPayment,
  type ReconcileInput,
  type SubRef,
} from "@/lib/billing/reconcile";

const T1 = "t-1";
const T2 = "t-2";
const TX = "t-x";
const SUBS: SubRef[] = [
  { id: "sub-1", tenant_id: T1, preapproval_id: "pre-1", tenant_name: "Kiosco Uno", excluded: null },
  { id: "sub-2", tenant_id: T2, preapproval_id: null, tenant_name: "Kiosco Dos", excluded: null },
  { id: "sub-x", tenant_id: TX, preapproval_id: "pre-x", tenant_name: "QA", excluded: "test" },
];
const WINDOW = { from: "2026-10-11T00:00:00.000Z", to: "2026-10-14T00:00:00.000Z" };

const mp = (over: Partial<MpPayment> & { mp_payment_id: string }): MpPayment => ({
  status: "approved",
  status_detail: "accredited",
  operation_type: "recurring_payment",
  amount_cents: 6_000_000,
  refunded_cents: 0,
  fee_cents: 300_000,
  net_cents: 5_700_000,
  date_created: "2026-10-12T10:00:00.000Z",
  date_approved: "2026-10-12T10:00:05.000Z",
  date_last_updated: "2026-10-12T10:00:05.000Z",
  external_reference: "sub-1",
  preapproval_id: null,
  description: "Plan Start",
  ...over,
});

const loc = (over: Partial<LocalPayment> & { id: string }): LocalPayment => ({
  tenant_id: T1,
  method: "mp_preapproval",
  status: "approved",
  amount_cents: 6_000_000,
  fee_cents: null,
  net_cents: null,
  paid_at: "2026-10-12T10:00:05.000Z",
  provider: "mercadopago",
  external_id: null,
  period_start: null,
  refunded_cents: 0,
  ...over,
});

const run = (over: Partial<ReconcileInput>) =>
  reconcile({ mp: [], local: [], subscriptions: SUBS, seen: [], window: WINDOW, toleranceCents: 100, mpAvailable: true, ...over });

const kinds = (r: ReturnType<typeof reconcile>) => r.diffs.map((d) => d.kind).sort();

describe("parseMpPayment", () => {
  it("pasa a centavos, suma la comisión del cobrador y no guarda datos del pagador", () => {
    const p = parseMpPayment({
      id: 123456789,
      status: "approved",
      status_detail: "accredited",
      operation_type: "recurring_payment",
      transaction_amount: 60000.5,
      transaction_amount_refunded: 0,
      fee_details: [
        { type: "mercadopago_fee", amount: 2400.13, fee_payer: "collector" },
        { type: "financing_fee", amount: 500, fee_payer: "payer" },
        { type: "application_fee", amount: 100 },
      ],
      transaction_details: { net_received_amount: 57500.37 },
      date_created: "2026-10-12T10:00:00.000-03:00",
      date_approved: "2026-10-12T10:00:05.000-03:00",
      date_last_updated: "2026-10-12T10:00:05.000-03:00",
      external_reference: "sub-1",
      metadata: { preapproval_id: "pre-1" },
      payer: { email: "x@y.com", identification: { number: "20123456789" } },
      description: "Plan Start",
    });
    expect(p).toMatchObject({
      mp_payment_id: "123456789",
      amount_cents: 6_000_050,
      fee_cents: 250_013,
      net_cents: 5_750_037,
      refunded_cents: 0,
      preapproval_id: "pre-1",
      external_reference: "sub-1",
    });
    expect(JSON.stringify(p)).not.toContain("x@y.com");
    expect(JSON.stringify(p)).not.toContain("20123456789");
  });

  it("sin fee_details deriva la comisión del neto; preapproval desde point_of_interaction", () => {
    const p = parseMpPayment({
      id: "9",
      status: "refunded",
      transaction_amount: "100",
      transaction_amount_refunded: 100,
      transaction_details: { net_received_amount: 95 },
      point_of_interaction: { transaction_data: { subscription_id: "pre-9" } },
    });
    expect(p).toMatchObject({ fee_cents: 500, net_cents: 9500, refunded_cents: 10000, preapproval_id: "pre-9", status: "refunded" });
  });

  it("sin id o sin monto devuelve null; sin neto ni detalle la comisión queda null", () => {
    expect(parseMpPayment({ transaction_amount: 10 })).toBeNull();
    expect(parseMpPayment({ id: 1 })).toBeNull();
    expect(parseMpPayment(null)).toBeNull();
    expect(parseMpPayment({ id: 1, transaction_amount: 10 })?.fee_cents).toBeNull();
  });
});

describe("reconWindow", () => {
  it("últimas N horas hasta ahora", () => {
    const w = reconWindow(new Date("2026-10-14T07:00:00.000Z"), 72);
    expect(w).toEqual({ from: "2026-10-11T07:00:00.000Z", to: "2026-10-14T07:00:00.000Z" });
  });
});

describe("reconcile: cruces", () => {
  it("cruce exacto sin diferencias y con la comisión para el pago local", () => {
    const r = run({ mp: [mp({ mp_payment_id: "100" })], local: [loc({ id: "p1", external_id: "100" })] });
    expect(r.diffs).toEqual([]);
    expect(r.matched).toBe(1);
    expect(r.mp_payments[0]).toMatchObject({ tenant_id: T1, payment_id: "p1", match_kind: "exact" });
    expect(r.fees).toEqual([{ payment_id: "p1", fee_cents: 300_000, net_cents: 5_700_000 }]);
    expect(r.scope_mp_ids).toEqual(["100"]);
    expect(r.scope_payment_ids).toContain("p1");
  });

  it("no repite la comisión si ya coincide", () => {
    const r = run({
      mp: [mp({ mp_payment_id: "100" })],
      local: [loc({ id: "p1", external_id: "100", fee_cents: 300_000, net_cents: 5_700_000 })],
    });
    expect(r.fees).toEqual([]);
  });

  it("cruce flojo: el webhook guardó el id del preapproval (mismo negocio, monto y fecha)", () => {
    const r = run({
      mp: [mp({ mp_payment_id: "200", external_reference: null, preapproval_id: "pre-1" })],
      local: [loc({ id: "p1", external_id: "pre-1", paid_at: "2026-10-13T20:00:00.000Z" })],
    });
    expect(r.diffs).toEqual([]);
    expect(r.mp_payments[0]).toMatchObject({ payment_id: "p1", match_kind: "loose", tenant_id: T1 });
  });

  it("cruce flojo dentro de la tolerancia; fuera de ella es un faltante", () => {
    const inTol = run({ mp: [mp({ mp_payment_id: "201", amount_cents: 6_000_080 })], local: [loc({ id: "p1", external_id: "x" })] });
    expect(inTol.diffs).toEqual([]);
    const outTol = run({ mp: [mp({ mp_payment_id: "202", amount_cents: 6_000_500 })], local: [loc({ id: "p1", external_id: "x" })] });
    expect(kinds(outTol)).toEqual(["missing_local", "missing_mp"]);
  });

  it("cruce flojo sólo a ±3 días", () => {
    const r = run({
      mp: [mp({ mp_payment_id: "203" })],
      local: [loc({ id: "p1", external_id: "x", paid_at: "2026-10-08T09:00:00.000Z" })],
    });
    expect(kinds(r)).toEqual(["missing_local"]);
  });

  it("usa el cruce grabado en una corrida anterior", () => {
    const r = run({
      mp: [mp({ mp_payment_id: "204", external_reference: null })],
      local: [loc({ id: "p9", external_id: "otro", amount_cents: 1 })],
      seen: [{ mp_payment_id: "204", payment_id: "p9", tenant_id: T1 }],
    });
    expect(r.mp_payments[0]?.match_kind).toBe("exact");
    expect(kinds(r)).toEqual(["amount_mismatch"]);
  });
});

describe("reconcile: diferencias", () => {
  it("faltante en el ledger con negocio sugerido, clave estable y severidad alta", () => {
    const a = run({ mp: [mp({ mp_payment_id: "300" })] });
    const b = run({ mp: [mp({ mp_payment_id: "300" })] });
    expect(a.diffs).toHaveLength(1);
    expect(a.diffs[0]).toMatchObject({
      key: "missing_local:300",
      kind: "missing_local",
      severity: "high",
      tenant_id: T1,
      expected_cents: 6_000_000,
    });
    expect(a.diffs[0]?.detail.tenant_name).toBe("Kiosco Uno");
    expect(b.diffs[0]?.key).toBe(a.diffs[0]?.key);
  });

  it("un pago rechazado o pendiente sin cruce no es faltante", () => {
    const r = run({ mp: [mp({ mp_payment_id: "301", status: "rejected" }), mp({ mp_payment_id: "302", status: "pending" })] });
    expect(r.diffs).toEqual([]);
  });

  it("montos distintos en un cruce exacto", () => {
    const r = run({ mp: [mp({ mp_payment_id: "400", amount_cents: 7_000_000 })], local: [loc({ id: "p1", external_id: "400" })] });
    expect(r.diffs).toEqual([
      expect.objectContaining({ key: "amount:400", kind: "amount_mismatch", expected_cents: 6_000_000, actual_cents: 7_000_000 }),
    ]);
  });

  it("contracargo y mediación sobre un pago aprobado", () => {
    const r = run({
      mp: [mp({ mp_payment_id: "500", status: "charged_back" }), mp({ mp_payment_id: "501", status: "in_mediation" })],
      local: [loc({ id: "p1", external_id: "500" }), loc({ id: "p2", external_id: "501" })],
    });
    expect(r.diffs.map((d) => [d.key, d.severity, d.payment_id])).toEqual([
      ["chargeback:500", "high", "p1"],
      ["chargeback:501", "high", "p2"],
    ]);
  });

  it("contracargo ya registrado acá no se repite", () => {
    const r = run({ mp: [mp({ mp_payment_id: "500", status: "charged_back" })], local: [loc({ id: "p1", external_id: "500", status: "charged_back" })] });
    expect(r.diffs).toEqual([]);
  });

  it("reintegro total y parcial, con el total devuelto en la clave", () => {
    const r = run({
      mp: [
        mp({ mp_payment_id: "600", status: "refunded", refunded_cents: 6_000_000 }),
        mp({ mp_payment_id: "601", refunded_cents: 1_000_000 }),
      ],
      local: [loc({ id: "p1", external_id: "600" }), loc({ id: "p2", external_id: "601" })],
    });
    expect(r.diffs.map((d) => [d.key, d.detail.partial])).toEqual([
      ["refund:600:6000000", false],
      ["refund:601:1000000", true],
    ]);
  });

  it("reintegro ya registrado (total o el mismo parcial) no genera diferencia; uno mayor sí", () => {
    const done = run({
      mp: [mp({ mp_payment_id: "601", refunded_cents: 1_000_000 })],
      local: [loc({ id: "p2", external_id: "601", status: "partially_refunded", refunded_cents: 1_000_000 })],
    });
    expect(done.diffs).toEqual([]);
    const more = run({
      mp: [mp({ mp_payment_id: "601", refunded_cents: 2_000_000 })],
      local: [loc({ id: "p2", external_id: "601", status: "partially_refunded", refunded_cents: 1_000_000 })],
    });
    expect(more.diffs.map((d) => d.key)).toEqual(["refund:601:2000000"]);
    const full = run({
      mp: [mp({ mp_payment_id: "600", status: "refunded", refunded_cents: 6_000_000 })],
      local: [loc({ id: "p1", external_id: "600", status: "refunded", refunded_cents: 6_000_000 })],
    });
    expect(full.diffs).toEqual([]);
  });

  it("estado distinto: aprobado acá, rechazado en MP", () => {
    const r = run({ mp: [mp({ mp_payment_id: "700", status: "cancelled" })], local: [loc({ id: "p1", external_id: "700" })] });
    expect(r.diffs.map((d) => d.key)).toEqual(["status:700:cancelled"]);
  });

  it("faltante en MP: pago de MP del ledger dentro de la ventana sin cruce", () => {
    const r = run({
      local: [
        loc({ id: "p1", external_id: "999" }),
        loc({ id: "p2", external_id: "998", paid_at: "2026-09-01T10:00:00.000Z" }),
        loc({ id: "p3", method: "transfer", provider: null }),
      ],
    });
    expect(r.diffs.map((d) => [d.key, d.severity])).toEqual([["missing_mp:p1", "low"]]);
    expect(r.local_count).toBe(2);
  });

  it("duplicado en MP: mismo negocio y monto en menos de 72 h", () => {
    const r = run({
      mp: [
        mp({ mp_payment_id: "800", date_approved: "2026-10-12T10:00:00.000Z" }),
        mp({ mp_payment_id: "801", date_approved: "2026-10-13T09:00:00.000Z" }),
        mp({ mp_payment_id: "802", date_approved: "2026-10-12T11:00:00.000Z", external_reference: "sub-2" }),
      ],
      local: [loc({ id: "p1", external_id: "800" }), loc({ id: "p2", external_id: "801" }), loc({ id: "p3", tenant_id: T2, external_id: "802" })],
    });
    expect(r.diffs).toEqual([
      expect.objectContaining({ key: "dup_mp:801", kind: "duplicate", payment_id: "p2", tenant_id: T1 }),
    ]);
    expect(r.diffs[0]?.detail).toMatchObject({ other_mp_payment_id: "800", source: "mp", days_apart: 1 });
  });

  it("renovaciones legítimas separadas por un mes no son duplicado", () => {
    const r = run({
      window: { from: "2026-09-01T00:00:00.000Z", to: "2026-10-14T00:00:00.000Z" },
      mp: [
        mp({ mp_payment_id: "810", date_approved: "2026-09-12T10:00:00.000Z" }),
        mp({ mp_payment_id: "811", date_approved: "2026-10-12T10:00:00.000Z" }),
      ],
      local: [
        loc({ id: "p1", external_id: "810", paid_at: "2026-09-12T10:00:00.000Z" }),
        loc({ id: "p2", external_id: "811" }),
      ],
    });
    expect(r.diffs).toEqual([]);
  });

  it("duplicado en el ledger: dos pagos aprobados del mismo período (sólo los posteriores)", () => {
    const r = run({
      local: [
        loc({ id: "a", method: "transfer", provider: null, period_start: "2026-10-01", paid_at: "2026-10-12T10:00:00.000Z" }),
        loc({ id: "b", method: "transfer", provider: null, period_start: "2026-10-01", paid_at: "2026-10-12T12:00:00.000Z" }),
        loc({ id: "c", method: "cash", provider: null, period_start: "2026-10-01", paid_at: "2026-10-13T12:00:00.000Z" }),
        loc({ id: "d", method: "cash", provider: null, period_start: "2026-10-01", status: "refunded" }),
      ],
    });
    expect(r.diffs.map((d) => [d.key, d.detail.other_payment_id])).toEqual([
      [`dup_local:${T1}:2026-10-01:b`, "a"],
      [`dup_local:${T1}:2026-10-01:c`, "a"],
    ]);
  });

  it("negocios excluidos: la diferencia sale igual, marcada", () => {
    const r = run({ mp: [mp({ mp_payment_id: "900", external_reference: "sub-x" })] });
    expect(r.diffs[0]).toMatchObject({ tenant_id: TX });
    expect(r.diffs[0]?.detail.excluded).toBe("test");
  });

  it("sin negocio identificable: faltante sin negocio sugerido", () => {
    const r = run({ mp: [mp({ mp_payment_id: "901", external_reference: "otra-cosa" })] });
    expect(r.diffs[0]).toMatchObject({ kind: "missing_local", tenant_id: null });
  });

  it("los cobros que no son de suscripciones (compras de catálogos) quedan fuera", () => {
    const r = run({
      mp: [
        mp({ mp_payment_id: "950", operation_type: "regular_payment", external_reference: "intent-1" }),
        mp({ mp_payment_id: "951", operation_type: "regular_payment", external_reference: "sub-2" }),
      ],
    });
    expect(r.mp_payments.map((m) => m.mp_payment_id)).toEqual(["951"]);
    expect(r.scope_mp_ids).toEqual(["951"]);
    expect(r.diffs.map((d) => d.mp_payment_id)).toEqual(["951"]);
  });
});

describe("reconcile: modo degradado (sin credenciales)", () => {
  it("ignora MP y sólo revisa duplicados locales; sin faltantes en MP ni alcance de MP", () => {
    const r = run({
      mpAvailable: false,
      mp: [mp({ mp_payment_id: "1" })],
      local: [
        loc({ id: "a", period_start: "2026-10-01", paid_at: "2026-10-12T10:00:00.000Z" }),
        loc({ id: "b", period_start: "2026-10-01", paid_at: "2026-10-12T11:00:00.000Z" }),
      ],
    });
    expect(kinds(r)).toEqual(["duplicate"]);
    expect(r.mp_payments).toEqual([]);
    expect(r.scope_mp_ids).toEqual([]);
    expect(r.matched).toBe(0);
  });
});

describe("acciones y textos de la bandeja", () => {
  it("las acciones replican internal_recon_resolve", () => {
    expect(reconActionsFor("missing_local")).toEqual(["impute", "ignore"]);
    expect(reconActionsFor("duplicate")).toEqual(["keep_credit", "refund", "ignore"]);
    expect(reconActionsFor("amount_mismatch")).toEqual(["accept", "ignore"]);
    expect(reconActionsFor("chargeback")).toEqual(["chargeback", "accept", "ignore"]);
    expect(reconActionsFor("refund")).toEqual(["refund", "accept", "ignore"]);
    expect(reconActionsFor("status_mismatch")).toEqual(["chargeback", "accept", "ignore"]);
    expect(reconActionsFor("missing_mp")).toEqual(["accept", "ignore"]);
    expect(reconActionsFor("otra")).toEqual(["ignore"]);
  });

  it("los textos no usan raya larga", () => {
    for (const v of Object.values(RECON_KIND_LABELS)) expect(v).not.toContain(String.fromCharCode(0x2014));
  });
});
