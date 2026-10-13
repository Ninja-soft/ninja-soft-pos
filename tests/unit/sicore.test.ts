// @vitest-environment node
// Exportación de retenciones practicadas (F18 · H106, ADR-079): SICORE y ARBA
// en ancho fijo, revisión previa y golden files de un mes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ARBA_FIELDS,
  RECORD_LENGTH,
  SICORE_FIELDS,
  SicoreFormatError,
  arbaLine,
  buildExport,
  exportFileName,
  fmtCuitDashed,
  fmtDateAr,
  fmtDecimal,
  fmtNum,
  sicoreBase,
  sicoreCondition,
  sicoreLine,
  validateExport,
} from "@/lib/tax/sicore";
import { AGENT, ARBA_ROWS, PERIOD, SICORE_ROWS } from "../fixtures/sicore/period";

const GOLDEN_DIR = join(__dirname, "..", "fixtures", "sicore");

/** Lee un registro por el diseño (sin depender del formateador). */
function parse(fields: readonly (readonly [string, number])[], line: string): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  for (const [k, n] of fields) {
    out[k] = line.slice(pos, pos + n);
    pos += n;
  }
  return out;
}

describe("campos", () => {
  it("importes con coma (SICORE) o punto (ARBA) y ceros a la izquierda", () => {
    expect(fmtDecimal(121000, 16)).toBe("0000000121000,00");
    expect(fmtDecimal(656.6, 14)).toBe("00000000656,60");
    expect(fmtDecimal(0.005, 14)).toBe("00000000000,01");
    expect(fmtDecimal(1000, 11, ".")).toBe("00001000.00");
    expect(fmtDecimal(0, 6)).toBe("000,00");
    expect(() => fmtDecimal(-1, 14)).toThrow(SicoreFormatError);
    expect(() => fmtDecimal(1e12, 14)).toThrow(SicoreFormatError);
  });

  it("números, fechas y CUIT", () => {
    expect(fmtNum(12, 16)).toBe("0000000000000012");
    expect(fmtNum("094", 3)).toBe("094");
    expect(() => fmtNum(1234, 3)).toThrow(SicoreFormatError);
    expect(fmtDateAr("2026-10-05")).toBe("05/10/2026");
    expect(() => fmtDateAr("5/10/26")).toThrow(SicoreFormatError);
    expect(fmtCuitDashed("30712345671")).toBe("30-71234567-1");
    expect(() => fmtCuitDashed("123")).toThrow(SicoreFormatError);
  });

  it("largos de registro", () => {
    expect(RECORD_LENGTH.sicore).toBe(144);
    expect(RECORD_LENGTH.arba).toBe(47);
  });
});

describe("SICORE", () => {
  it("registro de Ganancias con acumulado: base de este pago", () => {
    const [first, second] = SICORE_ROWS;
    expect(sicoreBase(first!)).toBe(32830);
    // 82.830 sujetos en el mes menos 32.830 que ya eran sujetos = 50.000 de este pago
    expect(sicoreBase(second!)).toBe(50000);
    const r = parse(SICORE_FIELDS, sicoreLine(second!));
    expect(r).toMatchObject({
      cbteCode: "06",
      cbteDate: "20/10/2026",
      cbteNumber: "0000000000000015",
      cbteAmount: "0000000060500,00",
      taxCode: "217",
      regimeCode: "094",
      operation: "1",
      base: "00000050000,00",
      retDate: "20/10/2026",
      condition: "01",
      suspended: "0",
      amount: "00000001000,00",
      exclusionPct: "000,00",
      docType: "80",
      docNumber: "30712345671         ",
      originalCert: "00000000000000",
    });
  });

  it("no inscripto lleva condición 02; IVA y SUSS informan la base del pago", () => {
    expect(sicoreCondition(SICORE_ROWS[2]!)).toBe("02");
    expect(sicoreBase(SICORE_ROWS[3]!)).toBe(21000);
    expect(parse(SICORE_FIELDS, sicoreLine(SICORE_ROWS[4]!)).base).toBe("01020304,05".padStart(14, "0"));
  });

  it("cada registro mide 144 y termina en CRLF", () => {
    const f = buildExport("sicore", AGENT, PERIOD, SICORE_ROWS);
    const lines = f.content.split("\r\n");
    expect(lines.pop()).toBe("");
    expect(lines).toHaveLength(SICORE_ROWS.length);
    for (const l of lines) expect(l).toHaveLength(144);
    expect(f.records).toBe(5);
    expect(f.total).toBe(76174.84);
    expect(f.name).toBe("SICORE_RETENCIONES_202610.txt");
  });
});

describe("ARBA", () => {
  it("registro de IIBB", () => {
    const r = parse(ARBA_FIELDS, arbaLine(ARBA_ROWS[0]!));
    expect(r).toEqual({
      cuit: "30-71234567-1",
      date: "05/10/2026",
      branch: "0001",
      emission: "00000001",
      amount: "00001000.00",
      operation: "A",
    });
    expect(exportFileName("arba", AGENT.cuit, PERIOD)).toBe("AR-30500000003-2026100-6-LOTE1.txt");
  });
});

describe("revisión previa", () => {
  it("frena sin CUIT del negocio, con proveedor sin CUIT o sin código de régimen", () => {
    const bad = [{ ...SICORE_ROWS[0]!, sicore_regime_code: null, subject_snapshot: { name: "X", cuit: "20123456780" } }];
    const issues = validateExport("sicore", { name: "N", cuit: null }, bad);
    expect(issues.map((i) => i.code).sort()).toEqual(["agent_cuit", "regime_code", "subject_cuit"]);
    expect(() => buildExport("sicore", { name: "N", cuit: null }, PERIOD, bad)).toThrow(SicoreFormatError);
  });

  it("mes vacío avisa pero no frena", () => {
    const issues = validateExport("arba", AGENT, []);
    expect(issues).toEqual([expect.objectContaining({ level: "warning", code: "empty" })]);
    expect(buildExport("arba", AGENT, PERIOD, []).content).toBe("");
  });
});

describe("golden files", () => {
  it("SICORE y ARBA del mes", () => {
    const update = process.env.UPDATE_GOLDEN === "1";
    if (update && !existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });
    for (const f of [buildExport("sicore", AGENT, PERIOD, SICORE_ROWS), buildExport("arba", AGENT, PERIOD, ARBA_ROWS)]) {
      const path = join(GOLDEN_DIR, f.name);
      if (update) writeFileSync(path, f.content, "latin1");
      expect(readFileSync(path, "latin1")).toBe(f.content);
    }
  });
});
