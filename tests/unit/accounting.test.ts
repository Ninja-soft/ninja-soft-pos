import { describe, expect, it } from "vitest";
import { round2, splitVat } from "@/lib/accounting/vat";
import { qualifierCandidates, resolveMapping, CONCEPTS, type MappingRow } from "@/lib/accounting/mappings";
import {
  compareCodes,
  entryTotals,
  groupEntries,
  incomeStatement,
  ledgerRows,
  rollupTrialBalance,
  summarizeEntries,
  trialTotals,
  type JournalLine,
  type TrialRow,
} from "@/lib/accounting/journal";
import { buildExport, encodeText, formatAmount, formatDate, EXPORT_FORMATS } from "@/lib/accounting/exporters";
import { closeBlock, fiscalYearStart, monthsBetween, reopenBlock, type PeriodState } from "@/lib/accounting/periods";
import { accErrorMessage, sourceHref } from "@/lib/accounting/sources";

// ── IVA incluido (espejo de acc_vat_split) ───────────────────────────────
describe("splitVat", () => {
  it("separa dos alícuotas en proporción (mismo caso que el smoke SQL)", () => {
    const parts = splitVat(2315, [
      { amount: 1210, rate: 21 },
      { amount: 1105, rate: 10.5 },
    ], "included_rate");
    expect(parts).toEqual([
      { rate: 21, gross: 1210, net: 1000, vat: 210 },
      { rate: 10.5, gross: 1105, net: 1000, vat: 105 },
    ]);
  });

  it("prorratea un descuento global y la última alícuota absorbe el redondeo", () => {
    const parts = splitVat(100, [
      { amount: 50, rate: 21 },
      { amount: 33.33, rate: 10.5 },
      { amount: 16.67, rate: 27 },
    ], "included_rate");
    expect(parts.map((p) => p.rate)).toEqual([27, 21, 10.5]);
    expect(round2(parts.reduce((t, p) => t + p.gross, 0))).toBe(100);
    for (const p of parts) expect(round2(p.net + p.vat)).toBe(p.gross);
  });

  it("sin IVA (monotributo) todo es neto", () => {
    expect(splitVat(500, [{ amount: 500, rate: 21 }], "none")).toEqual([{ rate: 0, gross: 500, net: 500, vat: 0 }]);
  });

  it("usa la alícuota por defecto sin ítems o sin alícuota", () => {
    expect(splitVat(121, [], "included_rate")).toEqual([{ rate: 21, gross: 121, net: 100, vat: 21 }]);
    expect(splitVat(121, [{ amount: 121, rate: null }], "included_rate", 21)[0]!.vat).toBe(21);
  });

  it("round2 redondea mitad hacia arriba como Postgres", () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(-1.005)).toBe(-1.01);
    expect(round2(2.675)).toBe(2.68);
  });
});

// ── Mapeos ───────────────────────────────────────────────────────────────
describe("mapeos", () => {
  const rows: MappingRow[] = [
    { concept: "cobro", qualifier: "*", store_id: null, account_id: "otros" },
    { concept: "cobro", qualifier: "credit", store_id: null, account_id: "tarjetas" },
    { concept: "cobro", qualifier: "*:payway", store_id: null, account_id: "payway" },
    { concept: "cobro", qualifier: "cash", store_id: null, account_id: "caja" },
    { concept: "cobro", qualifier: "cash", store_id: "norte", account_id: "caja-norte" },
    { concept: "ventas", qualifier: "*", store_id: null, account_id: "ventas" },
  ];

  it("candidatos de lo específico a lo general", () => {
    expect(qualifierCandidates("credit:payway")).toEqual(["credit:payway", "*:payway", "credit", "*"]);
    expect(qualifierCandidates("cash")).toEqual(["cash", "*"]);
    expect(qualifierCandidates(null)).toEqual(["*"]);
  });

  it("gana el adquirente sobre el medio y el medio sobre la general", () => {
    expect(resolveMapping(rows, "cobro", "credit:payway", null)?.account_id).toBe("payway");
    expect(resolveMapping(rows, "cobro", "debit:payway", null)?.account_id).toBe("payway");
    expect(resolveMapping(rows, "cobro", "credit:getnet", null)?.account_id).toBe("tarjetas");
    expect(resolveMapping(rows, "cobro", "directo", null)?.account_id).toBe("otros");
  });

  it("la regla de la sucursal gana en el mismo nivel", () => {
    expect(resolveMapping(rows, "cobro", "cash", "norte")?.account_id).toBe("caja-norte");
    expect(resolveMapping(rows, "cobro", "cash", "centro")?.account_id).toBe("caja");
  });

  it("sin regla devuelve null (el evento queda como problema)", () => {
    expect(resolveMapping(rows, "iva_df", "21", null)).toBeNull();
  });

  it("el catálogo cubre todos los conceptos que usan los armadores SQL", () => {
    const keys = new Set(CONCEPTS.map((c) => c.key));
    for (const k of [
      "cobro", "ventas", "devoluciones_ventas", "iva_df", "propinas", "redondeo", "cmv", "mercaderias",
      "intereses_cc", "ajustes_cc", "faltante_caja", "sobrante_caja", "caja_movimiento", "compras", "iva_cf",
      "percepcion", "proveedores", "pago", "retencion_practicada", "tesoreria", "tesoreria_mov",
      "comision_procesador", "impuestos_procesador", "acreditacion", "diferencia_procesador", "contracargos",
    ]) expect(keys.has(k)).toBe(true);
  });
});

// ── Libros ───────────────────────────────────────────────────────────────
const L = (over: Partial<JournalLine>): JournalLine => ({
  entry_id: "e1",
  number: 1,
  official_number: null,
  entry_date: "2026-08-10",
  kind: "auto",
  source_type: "sale",
  source_id: "s1",
  source_event: "sale",
  entry_description: "Venta #1",
  store_id: "centro",
  line_no: 1,
  account_id: "caja",
  account_code: "1.1.01.01",
  account_name: "Caja",
  account_external_code: "11101",
  account_kind: "activo",
  cost_center_id: "cc1",
  cost_center_code: "S01",
  cost_center_name: "Centro",
  debit: 0,
  credit: 0,
  description: null,
  ...over,
});

const lines: JournalLine[] = [
  L({ line_no: 1, account_id: "caja", debit: 1210 }),
  L({ line_no: 2, account_id: "ventas", account_code: "4.1.01", account_name: "Ventas", account_kind: "ingreso", account_external_code: null, credit: 1000 }),
  L({ line_no: 3, account_id: "iva", account_code: "2.1.02.01", account_name: "IVA DF", account_kind: "pasivo", account_external_code: "21201", credit: 210, description: "IVA 21 %" }),
  L({ entry_id: "e2", number: 2, line_no: 1, account_id: "caja", debit: 605, source_id: "s2", entry_description: "Venta #2" }),
  L({ entry_id: "e2", number: 2, line_no: 2, account_id: "ventas", account_code: "4.1.01", account_name: "Ventas", account_kind: "ingreso", account_external_code: null, credit: 500, source_id: "s2", entry_description: "Venta #2" }),
  L({ entry_id: "e2", number: 2, line_no: 3, account_id: "iva", account_code: "2.1.02.01", account_name: "IVA DF", account_kind: "pasivo", account_external_code: "21201", credit: 105, source_id: "s2", entry_description: "Venta #2" }),
];

describe("asientos", () => {
  it("balanceo", () => {
    expect(entryTotals([{ debit: 10, credit: 0 }, { debit: 0, credit: 10 }]).balanced).toBe(true);
    expect(entryTotals([{ debit: 10, credit: 0 }, { debit: 0, credit: 9.99 }]).balanced).toBe(false);
    expect(entryTotals([{ debit: 10, credit: 10 }]).balanced).toBe(false);
  });

  it("agrupa renglones en asientos con totales", () => {
    const es = groupEntries(lines);
    expect(es).toHaveLength(2);
    expect(es[0]!.debit).toBe(1210);
    expect(es[0]!.credit).toBe(1210);
    expect(es[1]!.lines.map((l) => l.line_no)).toEqual([1, 2, 3]);
  });

  it("resumen diario por sucursal sin netear debe y haber", () => {
    const es = groupEntries([
      ...lines,
      L({ entry_id: "e3", number: 3, line_no: 1, account_id: "ventas", account_code: "4.1.01", account_name: "Ventas", account_kind: "ingreso", debit: 100, entry_description: "Anulación" }),
      L({ entry_id: "e3", number: 3, line_no: 2, account_id: "caja", credit: 100, entry_description: "Anulación" }),
    ]);
    const s = summarizeEntries(es, "daily", () => "Centro");
    expect(s).toHaveLength(1);
    const e = s[0]!;
    expect(e.description).toBe("Resumen del 10/08/2026 · Centro");
    expect(e.debit).toBe(e.credit);
    expect(e.debit).toBe(1210 + 605 + 100);
    const caja = e.lines.filter((l) => l.account_id === "caja");
    expect(caja.map((l) => [l.debit, l.credit])).toEqual([[1815, 0], [0, 100]]);
    expect(summarizeEntries(es, "monthly")[0]!.entry_date).toBe("2026-08-31");
  });

  it("mayor con saldo corrido", () => {
    const caja = lines.filter((l) => l.account_id === "caja");
    const rows = ledgerRows(caja, 100);
    expect(rows.map((r) => r.balance)).toEqual([1310, 1915]);
  });
});

describe("sumas y saldos y resultados", () => {
  const rows: TrialRow[] = [
    { account_id: "1", code: "1", name: "ACTIVO", kind: "activo", parent_id: null, imputable: false, external_code: null, opening: 0, debit: 0, credit: 0 },
    { account_id: "11", code: "1.1", name: "Caja", kind: "activo", parent_id: "1", imputable: true, external_code: null, opening: 100, debit: 1815, credit: 0 },
    { account_id: "12", code: "1.10", name: "Banco", kind: "activo", parent_id: "1", imputable: true, external_code: null, opening: 0, debit: 0, credit: 0 },
    { account_id: "2", code: "2", name: "PASIVO", kind: "pasivo", parent_id: null, imputable: false, external_code: null, opening: 0, debit: 0, credit: 0 },
    { account_id: "21", code: "2.1", name: "IVA DF", kind: "pasivo", parent_id: "2", imputable: true, external_code: null, opening: 0, debit: 0, credit: 315 },
    { account_id: "3", code: "3", name: "Capital", kind: "patrimonio", parent_id: null, imputable: true, external_code: null, opening: -100, debit: 0, credit: 0 },
    { account_id: "4", code: "4", name: "Ventas", kind: "ingreso", parent_id: null, imputable: true, external_code: null, opening: 0, debit: 0, credit: 1500 },
    { account_id: "5", code: "5", name: "Comisiones", kind: "egreso", parent_id: null, imputable: true, external_code: null, opening: 0, debit: 60, credit: 0 },
    { account_id: "51", code: "5.9", name: "Caja huérfana", kind: "egreso", parent_id: null, imputable: true, external_code: null, opening: 0, debit: 0, credit: 60 },
  ];

  it("propaga a las madres y calcula saldo final", () => {
    const t = rollupTrialBalance(rows);
    const activo = t.find((n) => n.account_id === "1")!;
    expect(activo.opening).toBe(100);
    expect(activo.debit).toBe(1815);
    expect(activo.closing).toBe(1915);
    expect(t.find((n) => n.account_id === "11")!.depth).toBe(1);
    expect(t.map((n) => n.code).indexOf("1.10")).toBeGreaterThan(t.map((n) => n.code).indexOf("1.1"));
    expect(rollupTrialBalance(rows, { hideEmpty: true }).some((n) => n.code === "1.10")).toBe(false);
  });

  it("totales cuadran", () => {
    const tt = trialTotals(rows);
    expect(tt.debit).toBe(1875);
    expect(tt.credit).toBe(1875);
    expect(tt.balanced).toBe(true);
  });

  it("estado de resultados", () => {
    const r = incomeStatement(rows);
    expect(r.totalIngresos).toBe(1500);
    expect(r.totalEgresos).toBe(0);
    expect(r.resultado).toBe(1500);
    expect(r.egresos.map((e) => e.amount)).toEqual([60, -60]);
  });

  it("orden natural de códigos", () => {
    expect(["1.10", "1.2", "1", "1.1.01"].sort(compareCodes)).toEqual(["1", "1.1.01", "1.2", "1.10"]);
  });
});

// ── Export a estudios ────────────────────────────────────────────────────
describe("exportadores", () => {
  const entries = groupEntries(lines.map((l) => ({ ...l, entry_description: l.entry_description + "; ñandú" })));

  it("formatos de fecha e importe", () => {
    expect(formatDate("2026-08-10", "dd/mm/yyyy")).toBe("10/08/2026");
    expect(formatDate("2026-08-10", "yyyymmdd")).toBe("20260810");
    expect(formatAmount(1234.5, ",")).toBe("1234,50");
    expect(formatAmount(-0.1, ".")).toBe("-0.10");
  });

  it("Tango: punto y coma, coma decimal, código externo y Latin-1", () => {
    const r = buildExport(entries, "tango", { baseName: "agosto" });
    const rows = r.text.trim().split("\r\n");
    expect(rows[0]).toBe("Nro. asiento;Fecha;Leyenda;Cuenta;Debe;Haber;Centro de costo;Leyenda renglon");
    expect(rows[1]).toBe('1;10/08/2026;"Venta #1; ñandú";11101;1210,00;0,00;S01;');
    // Sin código externo usa el del plan.
    expect(rows[2]).toContain(";4.1.01;0,00;1000,00;");
    expect(r.rows).toBe(6);
    expect(r.fileName).toBe("agosto-tango.txt");
    expect(r.bytes[0]).not.toBe(0xef);
    expect(Array.from(r.bytes).includes(0xf1)).toBe(true); // ñ en Latin-1
  });

  it("Holistor sin encabezado", () => {
    const r = buildExport(entries, "holistor");
    expect(r.text.split("\r\n")[0]).toBe('10/08/2026;1;11101;"Venta #1; ñandú";1210,00;0,00;S01');
  });

  it("Xubio y Colppy en CSV con comillas y UTF-8 con BOM", () => {
    const x = buildExport(entries, "xubio");
    expect(x.text.split("\r\n")[0]).toBe('"Numero de asiento","Fecha","Descripcion","Cuenta contable","Debe","Haber","Centro de costo"');
    expect(x.text.split("\r\n")[1]).toBe('"1","10/08/2026","Venta #1; ñandú","11101","1210.00","0.00","S01"');
    expect(Array.from(x.bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const c = buildExport(entries, "colppy");
    expect(c.text.split("\r\n")[3]).toBe('"10/08/2026","Venta #1; ñandú","21201","0.00","210.00","S01","IVA 21 %"');
  });

  it("CSV a medida con importe con signo, D/H y número oficial", () => {
    const withOfficial = entries.map((e) => ({ ...e, official_number: e.number + 100 }));
    const r = buildExport(withOfficial, "generic", {
      useOfficialNumber: true,
      custom: { separator: "|", decimal: ".", dateFormat: "yyyy-mm-dd", header: false, columns: ["numero", "fecha", "cuenta", "importe", "dh"], useExternalCode: false },
    });
    expect(r.text.split("\r\n").slice(0, 3)).toEqual([
      "101|2026-08-10|1.1.01.01|1210.00|D",
      "101|2026-08-10|4.1.01|-1000.00|H",
      "101|2026-08-10|2.1.02.01|-210.00|H",
    ]);
  });

  it("Latin-1 reemplaza lo que no entra", () => {
    expect(Array.from(encodeText("a€b", "latin1"))).toEqual([0x61, 0x3f, 0x62]);
  });

  it("cada formato documenta sus columnas", () => {
    for (const f of EXPORT_FORMATS) expect(f.headers.length).toBe(f.layout.columns.length);
  });
});

// ── Cierres ──────────────────────────────────────────────────────────────
describe("cierres", () => {
  const periods: PeriodState[] = [
    { period: "2026-07-01", status: "closed", entries: 10 },
    { period: "2026-08-01", status: "open", entries: 5 },
    { period: "2026-09-01", status: "open", entries: 3 },
  ];
  it("sólo meses terminados y en orden", () => {
    expect(closeBlock(periods, "2026-10-01", "2026-10-12")).toBe("not_ended");
    expect(closeBlock(periods, "2026-09-01", "2026-10-12")).toBe("previous_open");
    expect(closeBlock(periods, "2026-08-01", "2026-10-12")).toBeNull();
    expect(closeBlock(periods, "2026-07-01", "2026-10-12")).toBe("already_closed");
  });
  it("reabre sólo el último cerrado", () => {
    expect(reopenBlock(periods, "2026-07-01")).toBeNull();
    expect(reopenBlock(periods, "2026-08-01")).toBe("not_closed");
    expect(reopenBlock([...periods, { period: "2026-06-01", status: "closed", entries: 1 }], "2026-06-01")).toBe("later_closed");
  });
  it("meses y ejercicio", () => {
    expect(monthsBetween("2026-07-01", "2026-09-15")).toEqual(["2026-09-01", "2026-08-01", "2026-07-01"]);
    expect(monthsBetween("2025-12-01", "2026-01-31")).toEqual(["2026-01-01", "2025-12-01"]);
    expect(fiscalYearStart("2026-03-10", 7)).toBe("2025-07-01");
    expect(fiscalYearStart("2026-08-10", 7)).toBe("2026-07-01");
  });
});

describe("origen y errores", () => {
  it("link al documento", () => {
    expect(sourceHref("sale", "abc")).toBe("/ventas?venta=abc");
    expect(sourceHref(null, "abc")).toBeNull();
  });
  it("mensajes claros", () => {
    expect(accErrorMessage(new Error("acc_entry_unbalanced: diferencia 1"))).toMatch(/no balancea/);
    expect(accErrorMessage({ message: "feature_not_in_plan: contabilidad" })).toMatch(/plan/);
  });
});

describe("feature de plan contabilidad (CLAUDE.md §6)", () => {
  it("OPTIONAL en Business y Enterprise, con copy y gating en el servidor", async () => {
    const { readFileSync } = await import("node:fs");
    const { FEATURE_INFO } = await import("@/lib/saas/featureInfo");
    const sql = readFileSync("supabase/migrations/20261029100000_features_contabilidad.sql", "utf8");
    expect(sql).toMatch(/'contabilidad', 'Contabilidad',[\s\S]*?'reportes', false/);
    expect(sql).toMatch(/jsonb_build_object\('contabilidad', \(p\.key in \('business', 'enterprise'\)\)\)/);
    expect(FEATURE_INFO.contabilidad?.minPlan).toBe("Business");
    const gating = readFileSync("supabase/migrations/20261029100100_contabilidad_esquema.sql", "utf8");
    expect(gating).toMatch(/tenant_has_feature_for\(v_tenant, 'contabilidad'\)/);
    expect(gating).toMatch(/tenant_has_feature_for\(p_tenant, 'contabilidad'\)/);
  });
});

describe("auditoría de tesorería (ADR-150): arreglos chicos", () => {
  it("la devolución reintegrada por Mercado Pago no va a la Caja del POS", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync("supabase/migrations/20261217100100_tesoreria_fixes_auditoria.sql", "utf8");
    const reintegro = sql.match(/case r\.refund_method([\s\S]*?)end,/)?.[1] ?? "";
    // Cada medio de reintegro que admite sale_returns tiene su rama explícita.
    const check = readFileSync("supabase/migrations/20261030100100_reintegro_mp.sql", "utf8").match(
      /check \(refund_method in \(([^)]*)\)\)/,
    )?.[1];
    const methods = (check ?? "").split(",").map((m) => m.trim().replace(/'/g, ""));
    expect(methods).toEqual(["cash", "store_credit", "account", "mercadopago"]);
    for (const m of methods.filter((x) => x !== "cash")) expect(reintegro).toContain(`when '${m}'`);
    expect(reintegro).toMatch(/when 'mercadopago' then '\*:mercadopago'/);

    // Con la plantilla, '*:mercadopago' resuelve a "Mercado Pago a cobrar", no a la caja.
    const rows: MappingRow[] = [
      { concept: "cobro", qualifier: "*", store_id: null, account_id: "otros_a_cobrar" },
      { concept: "cobro", qualifier: "cash", store_id: null, account_id: "caja" },
      { concept: "cobro", qualifier: "*:mercadopago", store_id: null, account_id: "mp_a_cobrar" },
    ];
    expect(resolveMapping(rows, "cobro", "*:mercadopago", null)?.account_id).toBe("mp_a_cobrar");
  });

  it("los movimientos de tesorería sin fecha toman el día de Argentina, no el de UTC", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync("supabase/migrations/20261217100100_tesoreria_fixes_auditoria.sql", "utf8");
    const fn = sql.slice(sql.indexOf("create or replace function _treasury_move"));
    expect(fn).toMatch(/coalesce\(p_date, \(now\(\) at time zone 'America\/Argentina\/Buenos_Aires'\)::date\)/);
    expect(fn).not.toMatch(/current_date/);
  });
});
