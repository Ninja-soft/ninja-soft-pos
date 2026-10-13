import { describe, expect, it } from "vitest";
import {
  classifyTaxText,
  groupSuffered,
  jurisdictionFromText,
  parseArAmount,
  parseSufferedFile,
  sufferedErrorMessage,
  type SufferedRow,
} from "@/lib/tax/suffered";
import { SUFFERED_CASES } from "../fixtures/sufferedMatrix";

describe("classifyTaxText · matriz compartida con _tax_suffered_classify (SQL)", () => {
  for (const c of SUFFERED_CASES) {
    it(c.text, () => {
      expect(classifyTaxText(c.text, c.defaultJurisdiction, c.defaultRegime)).toEqual(c.expect);
    });
  }
});

describe("jurisdictionFromText", () => {
  it("reconoce nombres, siglas y códigos", () => {
    expect(jurisdictionFromText("CABA")).toBe("901");
    expect(jurisdictionFromText("Capital Federal")).toBe("901");
    expect(jurisdictionFromText("Buenos Aires")).toBe("902");
    expect(jurisdictionFromText("Provincia de Buenos Aires")).toBe("902");
    expect(jurisdictionFromText("Neuquén")).toBe("915");
    expect(jurisdictionFromText("Entre Ríos")).toBe("908");
    expect(jurisdictionFromText("Tucumán")).toBe("924");
    expect(jurisdictionFromText("jurisdicción 913")).toBe("913");
    expect(jurisdictionFromText("925")).toBeNull();
    expect(jurisdictionFromText("")).toBeNull();
    expect(jurisdictionFromText(null)).toBeNull();
  });
});

describe("parseArAmount", () => {
  it("lee formatos argentinos e internacionales", () => {
    expect(parseArAmount("1.234,56")).toBe(1234.56);
    expect(parseArAmount("1234,56")).toBe(1234.56);
    expect(parseArAmount("1234.56")).toBe(1234.56);
    expect(parseArAmount("1,234.56")).toBe(1234.56);
    expect(parseArAmount("$ 1.234.567")).toBe(1234567);
    expect(parseArAmount("-15,5")).toBe(-15.5);
    expect(parseArAmount("(15,5)")).toBe(-15.5);
    expect(parseArAmount("abc")).toBeNull();
    expect(parseArAmount("")).toBeNull();
  });
});

describe("parseSufferedFile", () => {
  it("lee un CSV estilo Mis Retenciones con códigos de impuesto de ARCA", () => {
    const csv = [
      "CUIT Agente;Denominación;Impuesto;Régimen;Fecha Retención;Nro. Certificado;Importe Retenido",
      "30-50001091-2;BANCO SA;217;Ganancias - Enajenación de bienes;03/09/2026;000123;1.500,25",
      "30500010912;BANCO SA;767;Retención IVA;2026-09-04;000124;200",
      "30500010912;BANCO SA;IIBB;Retención Ingresos Brutos Córdoba;05092026;000125;35,10",
      "30500010912;BANCO SA;Ganancias;;31/02/2026;000126;10",
      "30500010912;BANCO SA;Ganancias;;03/09/2026;000127;0",
    ].join("\r\n");
    const r = parseSufferedFile(csv, "902");
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.line).toBe(5);
    expect(r.skipped).toBe(1);
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0]).toMatchObject({
      tax: "ganancias",
      kind: "retencion",
      operation_date: "2026-09-03",
      amount: 1500.25,
      agent_cuit: "30500010912",
      agent_name: "BANCO SA",
      certificate: "000123",
      needs_review: false,
    });
    expect(r.rows[1]).toMatchObject({ tax: "iva", amount: 200 });
    expect(r.rows[2]).toMatchObject({ tax: "iibb", jurisdiction: "904", amount: 35.1, needs_review: false });
  });

  it("consulta de SIRCREB: régimen forzado y jurisdicción por columna", () => {
    const csv = ["CUIT,Jurisdicción,CBU,Fecha,Importe", "30712345671,921,0000,10/09/2026,123.45", "30712345671,,0000,11/09/2026,10"].join("\n");
    const r = parseSufferedFile(csv, "902", "sircreb");
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ tax: "iibb", regime: "sircreb", jurisdiction: "921", amount: 123.45 });
    expect(r.rows[1]).toMatchObject({ jurisdiction: "902", needs_review: true });
  });

  it("planilla propia con base, alícuota y tipo", () => {
    const csv = [
      "Fecha\tImpuesto\tJurisdicción\tTipo\tBase\tAlícuota\tImporte\tCertificado",
      "2026-09-01\tIngresos Brutos\tCABA\tPercepción\t10000\t1,5\t150\tP-1",
      "2026-09-02\tDébitos y créditos\t\t\t\t\t60\t",
    ].join("\n");
    const r = parseSufferedFile(csv, null);
    expect(r.rows[0]).toMatchObject({
      tax: "iibb",
      kind: "percepcion",
      jurisdiction: "901",
      base_amount: 10000,
      rate: 1.5,
      amount: 150,
      certificate: "P-1",
    });
    expect(r.rows[1]).toMatchObject({ tax: "debitos_creditos", kind: "pago_a_cuenta", jurisdiction: null });
  });

  it("sin columnas de fecha e importe avisa y no lee", () => {
    const r = parseSufferedFile("a;b;c\n1;2;3");
    expect(r.rows).toHaveLength(0);
    expect(r.errors[0]!.message).toMatch(/fecha e importe/);
  });

  it("archivo vacío", () => {
    expect(parseSufferedFile("\n\n").errors[0]!.message).toMatch(/vacío/);
  });
});

describe("groupSuffered", () => {
  const base: Omit<SufferedRow, "id" | "tax" | "kind" | "regime" | "jurisdiction" | "amount"> = {
    source: "entry",
    origin: "manual",
    operation_date: "2026-09-01",
    period: "2026-09-01",
    base_amount: null,
    rate: null,
    agent_cuit: null,
    agent_name: null,
    certificate: null,
    status: "active",
    needs_review: false,
  };
  it("agrupa vigentes por impuesto, jurisdicción, tipo y régimen y suma en centavos", () => {
    const rows: SufferedRow[] = [
      { ...base, id: "1", tax: "iibb", kind: "retencion", regime: "procesador", jurisdiction: "902", amount: 0.1 },
      { ...base, id: "2", tax: "iibb", kind: "retencion", regime: "general", jurisdiction: "902", amount: 0.2 },
      { ...base, id: "3", tax: "iibb", kind: "retencion", regime: "sircreb", jurisdiction: "902", amount: 5 },
      { ...base, id: "4", tax: "iva", kind: "percepcion", regime: "general", jurisdiction: null, amount: 7.77, source: "purchase", origin: "compra" },
      { ...base, id: "5", tax: "iva", kind: "percepcion", regime: "general", jurisdiction: null, amount: 100, status: "voided" },
    ];
    const g = groupSuffered(rows);
    expect(g.groups).toHaveLength(3);
    expect(g.groups[0]).toMatchObject({ tax: "iibb", regime: "general", amount: 0.3, count: 2 });
    expect(g.groups[0]!.label).toBe("Retención · Ingresos Brutos · Buenos Aires");
    expect(g.groups[1]).toMatchObject({ regime: "sircreb", amount: 5 });
    expect(g.groups[1]!.label).toContain("SIRCREB");
    expect(g.byTax.iibb).toBe(5.3);
    expect(g.byTax.iva).toBe(7.77);
    expect(g.total).toBe(13.07);
  });
});

describe("sufferedErrorMessage", () => {
  it("traduce los errores del servidor", () => {
    expect(sufferedErrorMessage("iibb_period_liquidated")).toMatch(/liquidado/);
    expect(sufferedErrorMessage("iibb_changed")).toMatch(/cambiaron/);
    expect(sufferedErrorMessage("feature_not_in_plan: percepciones_retenciones")).toMatch(/Business/);
    expect(sufferedErrorMessage("algo raro")).toBeNull();
  });
});
