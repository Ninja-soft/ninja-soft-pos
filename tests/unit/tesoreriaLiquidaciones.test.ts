import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fileCandidateAllowed, fileCandidateRule } from "@/supabase/functions/_shared/settlementMatch";
import { parseReconciledSales, reconciledQuery, reconciledStatusOf } from "@/supabase/functions/_shared/nubceo";
import { guessMapping, IMPORT_PRESETS, rowsToLines } from "@/lib/reports/processorReconciliation";
import { buildCashFlow, groupPendingByDate, pendingToDated, pendingWithin } from "@/lib/treasury/cashflow";
import { movementOrigin, movementOriginHref, treasuryErrorMessage } from "@/lib/treasury/accounts";
import { eventLabel, sourceHref, sourceLabel } from "@/lib/accounting/sources";
import { defaultFromMonth, openMonthStarts } from "@/lib/accounting/settlementSource";
import { CONCEPTS } from "@/lib/accounting/mappings";
import { FEATURE_INFO } from "@/lib/saas/featureInfo";

// Tesorería: liquidaciones, extracto y NubCeo (F23 · H151, H152, H153, ADR-162).

const M1 = readFileSync("supabase/migrations/20261231100000_tesoreria_liquidaciones.sql", "utf8");
const M2 = readFileSync("supabase/migrations/20261231100100_conciliacion_bancaria.sql", "utf8");
const M3 = readFileSync("supabase/migrations/20261231100200_nubceo_contabilidad.sql", "utf8");

describe("candidatos por archivo (T21)", () => {
  it("las tarjetas cruzan sólo con débito y crédito de su adquirente (o sin adquirente)", () => {
    const r = fileCandidateRule("payway")!;
    expect(fileCandidateAllowed(r, "credit", "payway")).toBe(true);
    expect(fileCandidateAllowed(r, "debit", null)).toBe(true);
    expect(fileCandidateAllowed(r, "credit", "fiserv")).toBe(false);
    expect(fileCandidateAllowed(r, "ualabis", null)).toBe(false);
    expect(fileCandidateAllowed(fileCandidateRule("otro")!, "credit", "fiserv")).toBe(true);
  });

  it("Ualá Bis, Transferencias y Directo sólo con su propio medio: nunca contra una tarjeta", () => {
    expect(fileCandidateAllowed(fileCandidateRule("ualabis")!, "ualabis", null)).toBe(true);
    expect(fileCandidateAllowed(fileCandidateRule("ualabis")!, "credit", null)).toBe(false);
    expect(fileCandidateAllowed(fileCandidateRule("transfer")!, "transfer", null)).toBe(true);
    expect(fileCandidateAllowed(fileCandidateRule("transfer")!, "debit", null)).toBe(false);
    expect(fileCandidateAllowed(fileCandidateRule("directo")!, "directo", null)).toBe(true);
    expect(fileCandidateAllowed(fileCandidateRule("directo")!, "qr", null)).toBe(false);
  });

  it("MODO exige que el cupón diga MODO; Mercado Pago y GO Cuotas no van por archivo suelto", () => {
    const modo = fileCandidateRule("modo")!;
    expect(fileCandidateAllowed(modo, "qr", "modo")).toBe(true);
    expect(fileCandidateAllowed(modo, "qr", null)).toBe(false);
    expect(fileCandidateAllowed(modo, "credit", "payway")).toBe(false);
    expect(fileCandidateRule("mercadopago")).toBeNull();
    expect(fileCandidateRule("gocuotas")).toBeNull();
  });
});

describe("presets de liquidación e IVA del arancel", () => {
  it("hay presets de Ualá Bis, MODO, Transferencias y Directo", () => {
    for (const k of ["ualabis", "modo", "transfer", "directo"]) expect(IMPORT_PRESETS[k]?.hint).toBeTruthy();
  });

  it("el preset gana sobre los sinónimos genéricos", () => {
    const header = ["Fecha y hora", "ID de transacción", "Monto bruto", "Comisión", "IVA", "Monto neto"];
    const m = guessMapping(header, "ualabis");
    expect(m).toMatchObject({ operation_at: 0, external_id: 1, gross: 2, fee: 3, fee_vat: 4, net: 5 });
    // Sin preset, "IVA" va a impuestos como siempre.
    expect(guessMapping(header).taxes).toBe(4);
  });

  it("el IVA del arancel suma en impuestos pero viaja aparte en el detalle", () => {
    const [r] = rowsToLines("payway", [["01/10/2026", "1000", "20", "4,20", "5", "970,80"]], {
      operation_at: 0,
      gross: 1,
      fee: 2,
      fee_vat: 3,
      taxes: 4,
      net: 5,
    });
    expect(r!.line!.taxes).toBe(9.2);
    expect(r!.line!.fee_detail).toEqual([
      { label: "Arancel", amount: 20, kind: "fee" },
      { label: "IVA sobre el arancel", amount: 4.2, kind: "tax", code: "iva_comision" },
      { label: "Impuestos y retenciones", amount: 5, kind: "tax" },
    ]);
  });
});

describe("a acreditar en el flujo de fondos (T6)", () => {
  const rows = [
    { amount: 100, expected_date: "2026-10-10", expected_known: true },
    { amount: 50, expected_date: "2026-10-16", expected_known: false },
    { amount: 25, expected_date: "2026-10-16", expected_known: true },
    { amount: 999, expected_date: "2026-12-01", expected_known: false },
    { amount: 7, expected_date: null },
  ];

  it("agrupa por fecha; lo atrasado cae hoy", () => {
    expect(groupPendingByDate(rows, "2026-10-15")).toEqual([
      { date: "2026-10-15", amount: 100, count: 1, estimated: false },
      { date: "2026-10-16", amount: 75, count: 2, estimated: true },
      { date: "2026-12-01", amount: 999, count: 1, estimated: true },
    ]);
  });

  it("lo que entra en los próximos 7 días incluye lo atrasado", () => {
    expect(pendingWithin(rows, 7, "2026-10-15")).toBe(175);
  });

  it("suma como columna propia en el flujo", () => {
    const out = buildCashFlow({
      startBalance: 0,
      from: "2026-10-15",
      to: "2026-10-31",
      granularity: "month",
      receivables: [],
      chequesIn: [],
      payables: [{ date: "2026-10-20", amount: 30 }],
      chequesOut: [],
      settlements: pendingToDated(rows),
    });
    expect(out[0]!.settlements).toBe(175);
    expect(out[0]!.balance).toBe(145);
  });
});

describe("movimientos con origen nuevos", () => {
  const mov = (type: string) => ({ id: "m", type, reference_type: null, reference_id: "r", cheque_id: null, counterpart_id: null });
  it("liquidación, contracargo, caja del POS y cuenta corriente", () => {
    expect(movementOrigin(mov("settlement_credit"))).toBe("liquidacion");
    expect(movementOrigin(mov("settlement_credit_void"))).toBe("liquidacion");
    expect(movementOrigin(mov("processor_debit"))).toBe("contracargo");
    expect(movementOrigin(mov("cash_drop"))).toBe("caja_pos");
    expect(movementOrigin(mov("cc_collection_void"))).toBe("cuenta_corriente");
    expect(movementOriginHref(mov("settlement_credit"))).toBe("/tesoreria/conciliacion");
    expect(movementOriginHref(mov("cash_fund"))).toBe("/caja");
  });

  it("errores en castellano", () => {
    expect(treasuryErrorMessage({ message: "cash_destination_invalid" })).toMatch(/caja fuerte o un banco/);
    expect(treasuryErrorMessage({ message: "feature_not_in_plan: conciliacion_bancaria" })).toMatch(/conciliación bancaria/);
    expect(treasuryErrorMessage({ message: "amount_mismatch" })).toMatch(/mismo importe/);
  });
});

describe("asientos por estado y NubCeo en la contabilidad", () => {
  it("eventos con versión y reversión", () => {
    expect(eventLabel("release")).toBe("Acreditación");
    expect(eventLabel("release#2")).toBe("Acreditación (otra vez)");
    expect(eventLabel("release:rev")).toBe("Reversión de acreditación");
    expect(eventLabel("loss#3:rev")).toBe("Reversión de pérdida (otra vez)");
    expect(eventLabel("import")).toBe("Importado de NubCeo");
    expect(sourceLabel("nubceo_ledger")).toBe("Asiento de NubCeo");
    expect(sourceHref("nubceo_ledger", "x")).toBe("/tesoreria/nubceo");
  });

  it("el catálogo de mapeos tiene el IVA de la comisión", () => {
    expect(CONCEPTS.find((c) => c.key === "iva_comision")?.group).toBe("procesadores");
  });

  it("meses desde los que se puede cambiar la fuente", () => {
    expect(openMonthStarts("2026-09-01", "2026-10-15")).toEqual(["2026-09-01", "2026-10-01", "2026-11-01"]);
    expect(openMonthStarts("2026-11-01", "2026-12-20")).toEqual(["2026-11-01", "2026-12-01", "2027-01-01"]);
    expect(defaultFromMonth(["2026-09-01", "2026-10-01", "2026-11-01"], "2026-10-15")).toBe("2026-10-01");
    expect(defaultFromMonth(["2026-11-01"], "2026-10-15")).toBe("2026-11-01");
  });

  it("estado de conciliación de NubCeo por venta", () => {
    expect(reconciledStatusOf("RECONCILED")).toBe("reconciled");
    expect(reconciledStatusOf("conciliada")).toBe("reconciled");
    expect(reconciledStatusOf("not_reconciled")).toBe("pending");
    expect(reconciledStatusOf("Pendiente")).toBe("pending");
    expect(reconciledStatusOf("partially-reconciled")).toBe("difference");
    expect(reconciledStatusOf("")).toBeNull();
    const p = parseReconciledSales({
      meta: { total: 3 },
      data: [
        { ventaId: "FC-A-1", reconciliationStatus: "reconciled", reconciledAt: "2026-10-02T10:00:00Z" },
        { venta_id: "FC-B-2", reconciliationStatus: "with_difference", difference: 12.5 },
        { reconciliationStatus: "reconciled" },
      ],
    });
    expect(p.total).toBe(3);
    expect(p.rows).toEqual([
      { venta_id: "FC-A-1", status: "reconciled", reconciled_at: "2026-10-02T10:00:00.000Z", detail: null },
      { venta_id: "FC-B-2", status: "difference", reconciled_at: null, detail: { difference: 12.5 } },
    ]);
    expect(reconciledQuery({ page: 2, pageSize: 1000, from: "2026-09-01", to: "2026-10-15" })).toBe(
      "getReconciledSales=true&page=2&pageSize=500&filter[fecha][gte]=2026-09-01&filter[fecha][lte]=2026-10-15",
    );
  });
});

describe("feature conciliacion_bancaria (CLAUDE.md §6)", () => {
  it("key OPTIONAL en features, Business y Enterprise en plans.limits.modules", () => {
    expect(M2).toMatch(/'conciliacion_bancaria', 'Conciliación bancaria',[\s\S]*?'reportes', false/);
    expect(M2).toMatch(/jsonb_build_object\('conciliacion_bancaria', p\.key in \('business', 'enterprise'\)\)/);
  });

  it("gating real en el servidor y copy con plan mínimo", () => {
    expect(M2).toMatch(/tenant_has_feature_for\(v_tenant, 'conciliacion_bancaria'\)/);
    for (const fn of ["bank_statement_import", "bank_statement_line_resolve", "bank_statement_rematch", "bank_statement_import_delete"]) {
      const body = M2.slice(M2.indexOf(`create or replace function ${fn}(`));
      expect(body.slice(0, 600)).toMatch(/bank_statement_assert\(\)/);
    }
    expect(FEATURE_INFO.conciliacion_bancaria?.minPlan).toBe("Business");
    expect(FEATURE_INFO.conciliacion_bancaria?.needs).toMatch(/Tesorería/);
  });
});

describe("migraciones de ADR-162", () => {
  it("RLS con initplan y staff sólo con internal_scope()", () => {
    for (const sql of [M1, M2, M3]) {
      expect(sql).not.toMatch(/or\s+\(?\s*(select\s+)?is_internal\(\)/i);
      for (const m of sql.matchAll(/create policy[\s\S]*?;/g)) {
        expect(m[0]).toMatch(/\(select current_tenant_id\(\)\)/);
        expect(m[0]).toMatch(/\(select internal_scope\(\)\)/);
      }
    }
  });

  it("no recrean create_sale ni ml_ingest_pack", () => {
    for (const sql of [M1, M2, M3]) {
      expect(sql).not.toMatch(/function\s+create_sale\s*\(/i);
      expect(sql).not.toMatch(/function\s+ml_ingest_pack\s*\(/i);
    }
  });

  it("sólo las líneas conciliadas contabilizan y mueven plata, por estado", () => {
    const acc = M1.slice(M1.indexOf("create or replace function acc_sync_settlement_line("));
    expect(acc.slice(0, 2500)).toMatch(/sl\.match_status = 'matched'/);
    expect(acc.slice(0, 6000)).toMatch(/acc_post_state\(p_tenant, 'settlement_line'/);
    const tr = M1.slice(M1.indexOf("create or replace function treasury_sync_settlement("));
    expect(tr.slice(0, 1800)).toMatch(/sl\.match_status = 'matched'/);
  });

  it("el IVA de la comisión no es un impuesto sufrido", () => {
    const fn = M1.slice(M1.indexOf("create or replace function _tax_suffered_from_settlement("));
    expect(fn.slice(0, 2000)).toMatch(/continue when settlement_fee_item_is_vat\(f\.e\)/);
  });

  it("la fuente de liquidaciones se cambia con auditoría y sólo desde un mes abierto", () => {
    const fn = M3.slice(M3.indexOf("create or replace function acc_settlement_source_set("));
    expect(fn).toMatch(/acc_source_from_not_month_start/);
    expect(fn).toMatch(/acc_period_closed/);
    expect(fn).toMatch(/'acc_settlement_source_changed'/);
  });

  it("los asientos de NubCeo exigen equivalencias y balance", () => {
    const fn = M3.slice(M3.indexOf("create or replace function acc_sync_nubceo_ledger("));
    expect(fn).toMatch(/nubceo_account_unmapped/);
    expect(fn).toMatch(/nubceo_entry_unbalanced/);
    expect(fn).toMatch(/acc_settlement_source_at\(p_tenant, h\.entry_date\) = 'nubceo'/);
  });
});
