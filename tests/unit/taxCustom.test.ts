import { describe, it, expect } from "vitest";
import {
  RET_CONCEPT_FIELDS,
  buildData,
  describeHistory,
  resolveCustom,
  scaleAmountOf,
  validateScale,
  validateValidity,
  versionAt,
  type CustomValue,
} from "@/lib/tax/custom";
import { scaleAmount } from "@/lib/tax/retentions";
import { priceToFinal } from "@/lib/tax/engine";
import { buildExport, exportFileName, type WithholdingExportRow } from "@/lib/tax/sicore";
import { classifyTaxText, classifyWithRules, parseSufferedFile, type SufferedRule } from "@/lib/tax/suffered";

// Valores impositivos del negocio sobre las plantillas (ADR-101): resolución
// override > plantilla con vigencias (espejo de _tax_custom_at).
let n = 0;
const v = (p: Partial<CustomValue>): CustomValue => ({
  id: `v${++n}`,
  catalog: "iva_rate",
  item_key: "21",
  valid_from: "2000-01-01",
  valid_to: null,
  is_active: true,
  is_custom: false,
  data: {},
  notes: null,
  created_at: `2026-10-0${(n % 9) + 1}T10:00:00Z`,
  ...p,
});

describe("versión vigente a una fecha", () => {
  const a = v({ valid_from: "2026-01-01", data: { rate: 19 } });
  const b = v({ valid_from: "2026-07-01", valid_to: "2026-09-30", data: { rate: 18 } });
  const c = v({ valid_from: "2027-01-01", data: { rate: 17 } });
  const all = [c, a, b];

  it("antes de toda versión: rige la plantilla", () => {
    expect(versionAt(all, "2025-12-31")).toBeNull();
  });
  it("la de valid_from más nueva que cubre la fecha", () => {
    expect(versionAt(all, "2026-03-15")?.id).toBe(a.id);
    expect(versionAt(all, "2026-08-01")?.id).toBe(b.id);
  });
  it("una versión vencida no tapa a la anterior abierta", () => {
    expect(versionAt(all, "2026-10-01")?.id).toBe(a.id);
  });
  it("una versión futura no aplica hoy", () => {
    expect(versionAt(all, "2026-12-31")?.id).toBe(a.id);
    expect(versionAt(all, "2027-01-01")?.id).toBe(c.id);
  });
  it("los bordes de la vigencia son inclusivos", () => {
    expect(versionAt(all, "2026-07-01")?.id).toBe(b.id);
    expect(versionAt(all, "2026-09-30")?.id).toBe(b.id);
  });
});

describe("valor efectivo: override > plantilla", () => {
  const tpl = { rate: 21, label: "21 %" };

  it("sin versiones: la plantilla", () => {
    expect(resolveCustom(tpl, [], "2026-10-13")).toMatchObject({ values: tpl, state: "template", active: true, version: null });
  });
  it("los campos de la versión pisan; los vacíos siguen la plantilla", () => {
    const r = resolveCustom(tpl, [v({ data: { rate: 10.5 } })], "2026-10-13");
    expect(r.values).toEqual({ rate: 10.5, label: "21 %" });
    expect(r.state).toBe("custom");
  });
  it("una versión desactivada apaga el valor en su vigencia y después vuelve", () => {
    const off = v({ valid_from: "2026-10-01", valid_to: "2026-10-31", is_active: false });
    expect(resolveCustom(tpl, [off], "2026-10-13")).toMatchObject({ state: "disabled", active: false });
    expect(resolveCustom(tpl, [off], "2026-11-01")).toMatchObject({ state: "template", active: true });
  });
  it("valor propio (sin plantilla)", () => {
    const own = v({ catalog: "ret_concept", item_key: "ganancias:x", is_custom: true, data: { name: "X", rate_registered: 1 } });
    expect(resolveCustom(null, [own], "2026-10-13")).toMatchObject({ state: "own", values: { name: "X", rate_registered: 1 } });
    expect(resolveCustom(null, [], "2026-10-13")).toMatchObject({ state: "own", active: false });
  });
});

describe("formularios", () => {
  it("vacío = plantilla; números con coma; errores por campo", () => {
    const r = buildData(RET_CONCEPT_FIELDS, {
      name: "  ",
      min_non_taxable: "1.234,50",
      rate_registered: "2,5",
      rate_unregistered: "",
      min_withholding: "-1",
      sicore_regime_code: "12a",
      uses_scale: "false",
    });
    expect(r.data).toEqual({ min_non_taxable: 1234.5, rate_registered: 2.5, uses_scale: false });
    expect(Object.keys(r.errors).sort()).toEqual(["min_withholding", "sicore_regime_code"]);
  });
  it("alícuota mayor a 100 y vigencia al revés", () => {
    expect(buildData(RET_CONCEPT_FIELDS, { rate_registered: "120" }).errors.rate_registered).toBeTruthy();
    expect(validateValidity("2026-10-01", "2026-09-30")).toBeTruthy();
    expect(validateValidity("2026-10-01", null)).toBeNull();
  });
});

describe("escalas del negocio", () => {
  const rows = [
    { from_amount: 0, to_amount: 8000, fixed: 0, rate: 5 },
    { from_amount: 8000, to_amount: null, fixed: 400, rate: 9 },
  ];
  it("misma cuenta que la escala de la RG 830 (scaleAmount)", () => {
    const asRet = rows.map((r) => ({ from: r.from_amount, to: r.to_amount, fixed: r.fixed, rate: r.rate }));
    for (const s of [0, 1, 7999.99, 8000, 8000.01, 12345.67]) {
      expect(scaleAmountOf(s, rows)).toBe(scaleAmount(s, asRet));
    }
  });
  it("validación", () => {
    expect(validateScale(rows)).toBeNull();
    expect(validateScale([{ from_amount: 10, to_amount: null, fixed: 0, rate: 5 }])).toMatch(/empezar en 0/);
    expect(validateScale([...rows, { from_amount: 8000, to_amount: null, fixed: 0, rate: 1 }])).toMatch(/mismo monto/);
    expect(validateScale([{ from_amount: 0, to_amount: 0, fixed: 0, rate: 5 }])).toMatch(/hasta/);
  });
});

describe("historial", () => {
  it("cuenta lo que cambió en palabras", () => {
    const out = describeHistory([
      {
        at: "2026-10-13T12:00:00Z",
        action: "UPDATE",
        actor: "Ana",
        before: { id: "1", data: { rate: 21 }, valid_from: "2026-10-01", deleted_at: null },
        after: { id: "1", data: { rate: 10.5 }, valid_from: "2026-10-01", deleted_at: null },
      },
      { at: "2026-10-14T12:00:00Z", action: "tax_custom_reset", actor: null, before: null, after: { versions: 2 } },
    ]);
    expect(out[0]).toMatchObject({ actor: "Ana", what: "Cambió", changes: [{ field: "rate", before: "21", after: "10.5" }] });
    expect(out[1]).toMatchObject({ actor: "Sistema", what: "Volvió a la plantilla", changes: [] });
  });
});

describe("cálculo con los valores del negocio", () => {
  it("lista neta: precio final con la alícuota del negocio", () => {
    const base = { rateCode: "21" as const, discriminates: true, internalEnabled: false, listIncludesIva: false };
    expect(priceToFinal(1000, base)).toBe(1210);
    expect(priceToFinal(1000, { ...base, rates: { "21": 10.5 } })).toBe(1105);
    // exento no toma alícuota aunque venga una
    expect(priceToFinal(1000, { ...base, rateCode: "exento", rates: { exento: 5 } })).toBe(1000);
  });

  it("archivos de SICORE y ARBA con los códigos del negocio", () => {
    const row: WithholdingExportRow = {
      tax: "iibb",
      jurisdiction: "902",
      date: "2026-10-05",
      payment_number: 1,
      payment_total: 1000,
      payment_base: 1000,
      prior_base: 0,
      non_taxable_min: 0,
      taxable_base: 1000,
      amount: 10,
      exemption_pct: 0,
      condition: null,
      certificate_number: 3,
      certificate: "IIBB902-00000003",
      sicore_tax_code: null,
      sicore_regime_code: null,
      subject_snapshot: { name: "Prov", cuit: "20123456786" },
    };
    const agent = { name: "Yo", cuit: "30712345671" };
    const plantilla = buildExport("arba", agent, "2026-10-01", [row]);
    const propio = buildExport("arba", agent, "2026-10-01", [row], { arbaBranch: 2, arbaActivity: 7 });
    expect(plantilla.content.slice(23, 27)).toBe("0001");
    expect(propio.content.slice(23, 27)).toBe("0002");
    expect(propio.name).toBe("AR-30712345671-2026100-7-LOTE1.txt");
    expect(exportFileName("arba", "30712345671", "2026-10-01")).toBe("AR-30712345671-2026100-6-LOTE1.txt");
    const sic = buildExport("sicore", agent, "2026-10-01", [{ ...row, tax: "iva", sicore_tax_code: 767, sicore_regime_code: "499" }], {
      sicoreCbteCode: 1,
    });
    expect(sic.content.slice(0, 2)).toBe("01");
  });
});

describe("reglas del negocio para retenciones sufridas", () => {
  const rules: SufferedRule[] = [
    { pattern: "percepcion especial", tax: "iibb", kind: "percepcion", jurisdiction: "904" },
    { pattern: "cargo xyz", skip: true },
    { pattern: "especial", tax: "ganancias" },
    { pattern: "imp 999", tax: "ganancias", kind: "retencion", regime: "general" },
  ];

  it("gana la regla de patrón más largo; mayúsculas y tildes no importan", () => {
    expect(classifyWithRules("Percepción ESPECIAL mayo", "902", "procesador", rules)).toEqual({
      skip: false,
      tax: "iibb",
      kind: "percepcion",
      regime: "procesador",
      jurisdiction: "904",
      needs_review: false,
      rule: "percepcion especial",
    });
    expect(classifyWithRules("Cargo especial", "902", "procesador", rules)).toMatchObject({ tax: "ganancias", rule: "especial" });
  });

  it("ignorar y sin regla", () => {
    expect(classifyWithRules("Cargo XYZ", "902", "procesador", rules)).toMatchObject({ skip: true, rule: "cargo xyz" });
    expect(classifyWithRules("Retención IIBB SIRTAC Córdoba", "902", "procesador", rules)).toEqual(
      classifyTaxText("Retención IIBB SIRTAC Córdoba", "902", "procesador"),
    );
  });

  it("IIBB sin jurisdicción en la regla ni en el texto: la del negocio y para revisar", () => {
    const r = classifyWithRules("Retención rara", "902", "procesador", [{ pattern: "rara", tax: "iibb" }]);
    expect(r).toMatchObject({ tax: "iibb", jurisdiction: "902", needs_review: true });
  });

  it("el importador de archivos aplica las reglas (código de impuesto)", () => {
    const csv = ["Fecha;Importe;Impuesto;Regimen", "05/10/2026;100,00;IMP 999;x", "06/10/2026;5;Cargo XYZ;"].join("\n");
    const plain = parseSufferedFile(csv);
    const withRules = parseSufferedFile(csv, null, null, rules);
    expect(plain.rows[0]!.tax).not.toBe("ganancias");
    expect(withRules.rows).toHaveLength(1);
    expect(withRules.rows[0]).toMatchObject({ tax: "ganancias", kind: "retencion", amount: 100 });
    expect(withRules.skipped).toBe(1);
  });
});
