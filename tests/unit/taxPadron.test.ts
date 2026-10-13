import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PadronReader, parsePadronDate, parsePadronLine, parsePadronText } from "@/lib/tax/padron";

// Padrones de IIBB (ADR-068) con archivos de ejemplo armados con el diseño de
// registro publicado por cada organismo (CUIT de prueba).
const fx = (name: string) => readFileSync(join(__dirname, "../fixtures/padron", name), "latin1");

describe("ARBA · padrón de regímenes generales", () => {
  it("percepción: alícuota por CUIT, vigencia y grupo; descarta el CUIT inválido", () => {
    const r = parsePadronText(fx("PadronRGSPer102026.txt"), "arba");
    expect(r.rows).toEqual([
      { cuit: "30712345671", valid_from: "2026-10-01", valid_to: "2026-10-31", perception_rate: 1.5, retention_rate: null, group_code: "03", name: null },
      { cuit: "20444444445", valid_from: "2026-10-01", valid_to: "2026-10-31", perception_rate: 0, retention_rate: null, group_code: "00", name: null },
      { cuit: "27333333339", valid_from: "2026-10-01", valid_to: "2026-10-31", perception_rate: 8, retention_rate: null, group_code: "20", name: null },
    ]);
    expect(r.errors).toEqual([{ line: 3, reason: "cuit" }]);
    expect(r.period).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });

  it("retención: va a retention_rate; alícuota ilegible es error", () => {
    const r = parsePadronText(fx("PadronRGSRet102026.txt"), "arba");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ cuit: "30712345671", perception_rate: null, retention_rate: 0.75 });
    expect(r.errors).toEqual([{ line: 2, reason: "alicuota" }]);
  });
});

describe("AGIP · padrón de regímenes generales", () => {
  it("percepción y retención en la misma línea con la razón social", () => {
    const r = parsePadronText(fx("ARDJU008102026.txt"), "agip");
    expect(r.rows[0]).toEqual({
      cuit: "30712345671",
      valid_from: "2026-10-01",
      valid_to: "2026-10-31",
      perception_rate: 1,
      retention_rate: 0.5,
      group_code: "03",
      name: "EMPRESA DE PRUEBA SA",
    });
    expect(r.rows[1]).toMatchObject({ cuit: "20444444445", perception_rate: 0, retention_rate: 0 });
    expect(r.errors).toEqual([{ line: 3, reason: "fecha" }]);
  });
});

describe("genérico", () => {
  it("encabezado, CUIT con guiones, coma o punto y fechas en dos formatos", () => {
    const r = parsePadronText(fx("generico.csv"), "generic");
    expect(r.rows).toEqual([
      { cuit: "30712345671", valid_from: "2026-10-01", valid_to: "2026-10-31", perception_rate: 2.5, retention_rate: 1, group_code: null, name: null },
      { cuit: "20444444445", valid_from: "2026-10-01", valid_to: "2026-10-31", perception_rate: 0.5, retention_rate: null, group_code: null, name: null },
    ]);
    expect(r.errors).toEqual([{ line: 4, reason: "alicuota" }]);
  });
});

describe("lector incremental", () => {
  it("corta líneas entre pedazos y filtra a los CUIT conocidos", () => {
    const text = fx("PadronRGSPer102026.txt");
    const r = new PadronReader("arba", { only: new Set(["27333333339"]) });
    for (let i = 0; i < text.length; i += 7) r.push(text.slice(i, i + 7));
    const done = r.finish();
    expect(done.rows.map((x) => x.cuit)).toEqual(["27333333339"]);
    expect(done.skipped).toBe(2);
    expect(done.errors).toHaveLength(1);
  });

  it("take() vacía lo leído para mandarlo por partes", () => {
    const r = new PadronReader("arba");
    r.push(fx("PadronRGSPer102026.txt"));
    expect(r.take()).toHaveLength(3);
    expect(r.take()).toHaveLength(0);
  });
});

describe("helpers", () => {
  it("fechas", () => {
    expect(parsePadronDate("01102026")).toBe("2026-10-01");
    expect(parsePadronDate("1/10/2026")).toBe("2026-10-01");
    expect(parsePadronDate("2026-10-31")).toBe("2026-10-31");
    expect(parsePadronDate("31022026")).toBeNull();
    expect(parsePadronDate("")).toBeNull();
  });
  it("líneas vacías y encabezados se saltean sin error", () => {
    expect(parsePadronLine("", "arba")).toBeNull();
    expect(parsePadronLine("Regimen;Fecha;Desde;Hasta;CUIT", "arba")).toBeNull();
    expect(parsePadronLine("FECHA;DESDE;HASTA;CUIT", "agip")).toBeNull();
  });
});
