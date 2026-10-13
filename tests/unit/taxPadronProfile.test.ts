import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePadronText, type PadronFormat } from "@/lib/tax/padron";
import {
  BUILTIN_PROFILES,
  ProfileReader,
  parseProfileDate,
  parseProfileLine,
  previewProfile,
  validateProfile,
  type PadronProfile,
} from "@/lib/tax/padronProfile";

// Importador de padrones con perfiles del negocio (ADR-101).
const fx = (name: string) => readFileSync(join(__dirname, "../fixtures/padron", name), "latin1");
const builtin = (k: PadronFormat) => BUILTIN_PROFILES.find((p) => p.builtin === k)!;

describe("perfiles de plantilla = lectores de NinjaSoft", () => {
  const cases: [PadronFormat, string][] = [
    ["arba", "PadronRGSPer102026.txt"],
    ["arba", "PadronRGSRet102026.txt"],
    ["agip", "ARDJU008102026.txt"],
    ["generic", "generico.csv"],
  ];
  for (const [fmt, file] of cases) {
    it(`${fmt} · ${file}: mismas filas que parsePadronText`, () => {
      const legacy = parsePadronText(fx(file), fmt);
      const r = new ProfileReader(builtin(fmt));
      r.push(fx(file));
      const res = r.finish();
      expect(res.rows).toEqual(legacy.rows);
      expect(res.errors.map((e) => e.line)).toEqual(legacy.errors.map((e) => e.line));
      expect(res.period).toEqual(legacy.period);
    });
  }
});

describe("perfil propio en CSV", () => {
  const santaFe: PadronProfile = {
    name: "API Santa Fe",
    jurisdiction: "921",
    kind: "perception",
    config: {
      file_type: "delimited",
      separator: "|",
      has_header: true,
      decimal_sep: ".",
      date_format: "yyyymmdd",
      columns: { cuit: { index: 2 }, rate: { index: 3 }, valid_from: { index: 4 }, valid_to: { index: 5 } },
    },
  };
  const text = [
    "Razon|CUIT|Alicuota|Desde|Hasta",
    "EMPRESA|30712345671|1.75|20261101|20261130",
    "OTRA|20123456786|0.5|20261101|20261130",
    "MALA|30712345672|1.0|20261101|20261130",
    "FECHA|20444444445|1.0|20261131|20261130",
    "TASA|27333333339|xx|20261101|20261130",
  ].join("\r\n");

  it("lee columnas por número, saltea el encabezado y devuelve errores por fila con su línea", () => {
    const p = previewProfile(text, santaFe);
    expect(p.rows).toEqual([
      { cuit: "30712345671", valid_from: "2026-11-01", valid_to: "2026-11-30", perception_rate: 1.75, retention_rate: null, group_code: null, name: null },
      { cuit: "20123456786", valid_from: "2026-11-01", valid_to: "2026-11-30", perception_rate: 0.5, retention_rate: null, group_code: null, name: null },
    ]);
    expect(p.errors.map((e) => [e.line, e.reason])).toEqual([
      [4, "cuit"],
      [5, "fecha"],
      [6, "alicuota"],
    ]);
    expect(p.errors[0]!.text).toContain("MALA|30712345672");
    expect(p.period).toEqual({ from: "2026-11-01", to: "2026-11-30" });
  });

  it("filtra a los CUIT conocidos y cuenta los salteados", () => {
    const r = new ProfileReader(santaFe, { only: new Set(["20123456786"]) });
    r.push(text);
    const res = r.finish();
    expect(res.rows.map((x) => x.cuit)).toEqual(["20123456786"]);
    expect(res.skipped).toBe(1);
    expect(r.errorTotal).toBe(3);
  });

  it("por partes da lo mismo que de una vez (cortes en el medio de una línea)", () => {
    const whole = previewProfile(text, santaFe).rows;
    const r = new ProfileReader(santaFe);
    for (let i = 0; i < text.length; i += 7) {
      r.push(text.slice(i, i + 7));
    }
    const res = r.finish();
    expect([...res.rows]).toEqual(whole);
  });
});

describe("perfil propio de ancho fijo", () => {
  // CUIT (1-11) · alícuota x100 (12-16) · desde ddmmaaaa (17-24) · hasta (25-32) · régimen (33)
  const fixed: PadronProfile = {
    name: "Córdoba ancho fijo",
    jurisdiction: "904",
    kind: "both",
    config: {
      file_type: "fixed",
      date_format: "ddmmyyyy",
      rate_divisor: 100,
      skip_lines: 1,
      columns: {
        cuit: { start: 1, length: 11 },
        rate: { start: 12, length: 5 },
        valid_from: { start: 17, length: 8 },
        valid_to: { start: 25, length: 8 },
        regime: { start: 33, length: 1 },
      },
      regime_values: { perception: "P", retention: "R" },
    },
  };
  const lines = [
    "PADRON CORDOBA 112026",
    "30712345671001500111202630112026P",
    "30712345671000750111202630112026R",
    "20123456786002000111202630112026X",
    "2012345",
  ].join("\n");

  it("posiciones, escala de la alícuota, régimen por fila y línea corta", () => {
    const p = previewProfile(lines, fixed);
    expect(p.rows).toEqual([
      { cuit: "30712345671", valid_from: "2026-11-01", valid_to: "2026-11-30", perception_rate: 1.5, retention_rate: null, group_code: null, name: null },
      { cuit: "30712345671", valid_from: "2026-11-01", valid_to: "2026-11-30", perception_rate: null, retention_rate: 0.75, group_code: null, name: null },
    ]);
    expect(p.errors.map((e) => [e.line, e.reason])).toEqual([
      [4, "regimen"],
      [5, "cuit"],
    ]);
  });

  it("el tipo del import filtra: percepción descarta las filas de retención", () => {
    const p = previewProfile(lines, fixed, { kind: "perception" });
    expect(p.rows).toHaveLength(1);
    expect(p.errors.some((e) => e.line === 3 && e.reason === "regimen")).toBe(true);
  });
});

describe("archivos sin fechas y una sola alícuota", () => {
  const noDates: PadronProfile = {
    name: "Sin fechas",
    jurisdiction: "913",
    kind: "retention",
    config: { file_type: "delimited", separator: ",", columns: { cuit: { index: 1 }, rate: { index: 2 } } },
  };

  it("usa el período elegido al importar", () => {
    const r = parseProfileLine("30712345671,2,5", noDates, { period: { from: "2026-12-01", to: "2026-12-31" } });
    // "2,5" con separador coma: la columna 2 es "2".
    expect(r).toEqual({
      ok: true,
      row: { cuit: "30712345671", valid_from: "2026-12-01", valid_to: "2026-12-31", perception_rate: null, retention_rate: 2, group_code: null, name: null },
    });
  });

  it("sin período ni fechas es error de fecha", () => {
    expect(parseProfileLine("30712345671,2", noDates)).toEqual({ ok: false, reason: "fecha" });
  });

  it("encabezado sin CUIT se saltea sin error", () => {
    expect(parseProfileLine("cuit,alicuota", noDates)).toBeNull();
    expect(parseProfileLine("   ", noDates)).toBeNull();
  });
});

describe("validación del perfil y fechas", () => {
  it("pide CUIT, alícuota y posiciones completas", () => {
    expect(validateProfile({ file_type: "delimited", columns: {} })).toHaveLength(2);
    expect(validateProfile({ file_type: "fixed", columns: { cuit: { index: 1 }, rate: { start: 1, length: 2 } } })).toHaveLength(1);
    expect(validateProfile(builtin("arba").config)).toEqual([]);
    expect(validateProfile({ file_type: "delimited", rate_divisor: 0, columns: { cuit: { index: 1 }, rate: { index: 2 } } })).toHaveLength(1);
  });

  it("formatos de fecha", () => {
    expect(parseProfileDate("01102026", "ddmmyyyy")).toBe("2026-10-01");
    expect(parseProfileDate("2026-10-01", "ddmmyyyy")).toBeNull();
    expect(parseProfileDate("20261001", "yyyymmdd")).toBe("2026-10-01");
    expect(parseProfileDate("31/02/2026", "dd/mm/yyyy")).toBeNull();
    expect(parseProfileDate("1/10/2026", "auto")).toBe("2026-10-01");
  });
});
