// F8 · ADR-099: comisiones estimadas por medio de pago, id del reintegro de
// Mercado Pago en el comprobante y la migración (gating, RLS, barrido).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describeFeeRule,
  estimateFee,
  feeTotals,
  normalizeFeeReport,
  pickFeeRule,
  validateFeeRule,
  type FeeRule,
  type FeeReportRow,
} from "@/lib/payments/feeEstimate";
import { mpRefundReceipt } from "@/lib/payments/mpRefund";
import { FEATURE_INFO } from "@/lib/saas/featureInfo";

const rule = (p: Partial<FeeRule>): FeeRule => ({
  id: p.id ?? Math.random().toString(36).slice(2),
  method: "credit",
  provider_key: null,
  installments: null,
  fee_pct: 0,
  fixed_fee: 0,
  vat_on_fee: false,
  created_at: "2026-10-01T00:00:00Z",
  ...p,
});

describe("pickFeeRule", () => {
  const general = rule({ id: "general", fee_pct: 3 });
  const tres = rule({ id: "tres", installments: 3, fee_pct: 6 });
  const mp = rule({ id: "mp", method: "qr", provider_key: "mercadopago", fee_pct: 0.8 });
  const qr = rule({ id: "qr", method: "qr", fee_pct: 1 });
  const mpTres = rule({ id: "mp3", provider_key: "mercadopago", installments: 3, fee_pct: 9 });
  const mpCredit = rule({ id: "mpc", provider_key: "mercadopago", fee_pct: 4 });
  const rules = [general, tres, mp, qr, mpTres, mpCredit];

  it("la más específica gana: procesador y cuotas > procesador > cuotas > general", () => {
    expect(pickFeeRule(rules, { method: "credit", provider_key: "mercadopago", installments: 3 })?.id).toBe("mp3");
    expect(pickFeeRule(rules, { method: "credit", provider_key: "mercadopago", installments: 6 })?.id).toBe("mpc");
    expect(pickFeeRule(rules, { method: "credit", provider_key: null, installments: 3 })?.id).toBe("tres");
    expect(pickFeeRule(rules, { method: "credit", provider_key: null, installments: null })?.id).toBe("general");
  });

  it("una regla de procesador no aplica a otro procesador", () => {
    expect(pickFeeRule(rules, { method: "qr", provider_key: "mobbex", installments: null })?.id).toBe("qr");
    expect(pickFeeRule(rules, { method: "qr", provider_key: "mercadopago", installments: null })?.id).toBe("mp");
  });

  it("sin regla del medio devuelve null", () => {
    expect(pickFeeRule(rules, { method: "debit", provider_key: null, installments: null })).toBeNull();
  });

  it("empate: la más vieja", () => {
    const a = rule({ id: "a", created_at: "2026-01-01" });
    const b = rule({ id: "b", created_at: "2025-01-01" });
    expect(pickFeeRule([a, b], { method: "credit", provider_key: null, installments: null })?.id).toBe("b");
  });
});

describe("estimateFee", () => {
  it("porcentaje + fijo por cobro + IVA 21 % sobre la comisión", () => {
    const e = estimateFee({ fee_pct: 3.5, fixed_fee: 10, vat_on_fee: true }, 10_000, 4);
    expect(e.fee).toBe(390);
    expect(e.vat).toBe(81.9);
    expect(e.net).toBe(9528.1);
  });

  it("sin IVA y sin regla", () => {
    expect(estimateFee({ fee_pct: 1, fixed_fee: 0, vat_on_fee: false }, 1000, 1)).toEqual({ fee: 10, vat: 0, net: 990 });
    expect(estimateFee(null, 500, 2)).toEqual({ fee: 0, vat: 0, net: 500 });
  });

  it("redondea al centavo", () => {
    const e = estimateFee({ fee_pct: 2.999, fixed_fee: 0, vat_on_fee: true }, 333.33, 1);
    expect(e.fee).toBe(10);
    expect(e.vat).toBe(2.1);
  });
});

describe("normalizeFeeReport y feeTotals", () => {
  const raw = {
    rows: [
      { method: "credit", provider_key: null, installments: 3, count: 2, gross: "1000", rule_id: "r1", fee_pct: "5", fixed_fee: 0, vat_on_fee: true, fee: "50", vat: "10.5", net: "939.5" },
      { method: "cash", provider_key: null, installments: null, count: 5, gross: 2000, rule_id: null, fee_pct: 0, fixed_fee: 0, vat_on_fee: false, fee: 0, vat: 0, net: 2000 },
      { method: "qr", provider_key: "mercadopago", installments: null, count: 1, gross: 300, rule_id: null, fee_pct: 0, fixed_fee: 0, vat_on_fee: false, fee: 0, vat: 0, net: 300 },
    ],
    tips: [{ method: "cash", count: 2, amount: "150" }],
  };

  it("convierte números y nulls", () => {
    const r = normalizeFeeReport(raw);
    expect(r.rows[0]!.gross).toBe(1000);
    expect(r.rows[0]!.installments).toBe(3);
    expect(r.rows[1]!.installments).toBeNull();
    expect(r.tips[0]).toEqual({ method: "cash", count: 2, amount: 150 });
    expect(normalizeFeeReport(null)).toEqual({ rows: [], tips: [] });
  });

  it("totales: neto, % efectivo sobre lo que tiene comisión y medios sin regla", () => {
    const t = feeTotals(normalizeFeeReport(raw).rows as FeeReportRow[]);
    expect(t.gross).toBe(3300);
    expect(t.fee).toBe(50);
    expect(t.vat).toBe(10.5);
    expect(t.net).toBe(3239.5);
    expect(t.effectivePct).toBe(6.05);
    // El efectivo no cuenta como "sin regla"; el QR sí.
    expect(t.withoutRule).toBe(1);
  });
});

describe("validateFeeRule y describeFeeRule", () => {
  const ok = { method: "credit", provider_key: null, installments: 3, fee_pct: 3.5, fixed_fee: 0, vat_on_fee: true, note: null };
  it("valida rangos como la tabla", () => {
    expect(validateFeeRule(ok)).toBeNull();
    expect(validateFeeRule({ ...ok, method: "cash" })).toMatch(/medio/);
    expect(validateFeeRule({ ...ok, installments: 0 })).toMatch(/cuotas/);
    expect(validateFeeRule({ ...ok, fee_pct: 101 })).toMatch(/0 a 100/);
    expect(validateFeeRule({ ...ok, fixed_fee: -1 })).toMatch(/fijo/);
    expect(validateFeeRule({ ...ok, note: "x".repeat(121) })).toMatch(/120/);
  });
  it("texto corto", () => {
    expect(describeFeeRule({ fee_pct: 3.5, fixed_fee: 10, vat_on_fee: true })).toBe("3,5 % + $10 por cobro + IVA");
    expect(describeFeeRule({ fee_pct: 0, fixed_fee: 0, vat_on_fee: true })).toBe("Sin comisión");
  });
});

describe("mpRefundReceipt (H21h)", () => {
  it("sólo con el id de Mercado Pago y aprobado o en proceso", () => {
    expect(mpRefundReceipt({ amount: 500, status: "approved", mp_refund_id: "123456" })).toMatchObject({
      id: "123456",
      amount: 500,
    });
    expect(mpRefundReceipt({ amount: 500, status: "in_process", mp_refund_id: "9" })?.note).toMatch(/procesando/);
    expect(mpRefundReceipt({ amount: 500, status: "failed", mp_refund_id: "9" })).toBeNull();
    expect(mpRefundReceipt({ amount: 500, status: "approved", mp_refund_id: null })).toBeNull();
    expect(mpRefundReceipt(null)).toBeNull();
  });
});

describe("migraciones ADR-099", () => {
  const dir = join(process.cwd(), "supabase", "migrations");
  const feat = readFileSync(join(dir, "20261109800000_features_comisiones_estimadas.sql"), "utf8");
  const sql = readFileSync(join(dir, "20261109800100_pagos_sin_terceros.sql"), "utf8");

  it("feature OPTIONAL de pagos marcada por plan y con copy", () => {
    expect(feat).toMatch(/'comisiones_estimadas'[\s\S]*'pagos', false/);
    expect(feat).toMatch(/p\.key in \('pro', 'business', 'enterprise'\)/);
    expect(FEATURE_INFO.comisiones_estimadas?.minPlan).toBe("Pro");
  });

  it("gating server-side en el trigger y en la RPC", () => {
    expect(sql.match(/tenant_has_feature_for\([^)]*'comisiones_estimadas'\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("policies con (select ...), sin is_internal y sin DELETE", () => {
    const policies = sql.match(/create policy[\s\S]*?;/g) ?? [];
    expect(policies.length).toBe(3);
    for (const p of policies) {
      expect(p).not.toMatch(/is_internal/);
      expect(p).toMatch(/\(select current_tenant_id\(\)\)/);
    }
    expect(sql).not.toMatch(/for delete/i);
    expect(sql).toMatch(/trg_role_write_guard\('manage'\)/);
  });

  it("el trigger de payments sólo corre para transferencias con n° de operación", () => {
    expect(sql).toMatch(/when \(new\.method = 'transfer' and new\.reference is not null\)/);
    expect(sql).toMatch(/cron\.schedule\('transfer-watches-sweep'/);
    expect(sql).not.toMatch(/create or replace function create_sale/);
  });
});
