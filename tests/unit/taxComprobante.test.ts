import { describe, it, expect } from "vitest";
import { inferLetter, needsIdentification } from "@/lib/tax/comprobante";
import {
  DOC_TYPE_ARCA_ID,
  FISCAL_CONDITIONS,
  FISCAL_CONDITION_ARCA_ID,
  IVA_CODES,
  IVA_RATES,
  documentError,
  ivaCodeFromRate,
} from "@/lib/tax/catalog";

describe("tipo de comprobante (espejo de cbte_letter_infer)", () => {
  it("emisor responsable inscripto", () => {
    expect(inferLetter("responsable_inscripto", "responsable_inscripto")).toBe("A");
    expect(inferLetter("responsable_inscripto", "monotributo")).toBe("A");
    expect(inferLetter("responsable_inscripto", "monotributo_social")).toBe("A");
    expect(inferLetter("responsable_inscripto", "responsable_inscripto", { issuesM: true })).toBe("M");
    for (const r of ["consumidor_final", "exento", "no_responsable", "no_categorizado", "no_alcanzado", "iva_liberado"]) {
      expect(inferLetter("responsable_inscripto", r), r).toBe("B");
    }
    expect(inferLetter("responsable_inscripto", null)).toBe("B");
    expect(inferLetter("responsable_inscripto", "exterior")).toBe("E");
  });

  it("emisor que no discrimina: C (salvo exportación)", () => {
    for (const e of ["monotributo", "monotributo_social", "exento", "no_alcanzado"]) {
      expect(inferLetter(e, "responsable_inscripto"), e).toBe("C");
      expect(inferLetter(e, "consumidor_final"), e).toBe("C");
      expect(inferLetter(e, "exterior"), e).toBe("E");
    }
  });

  it("sin configurar: sin letra", () => {
    expect(inferLetter(null, "responsable_inscripto")).toBeNull();
    expect(inferLetter("", "consumidor_final")).toBeNull();
  });

  it("consumidor final sin identificar sobre el tope", () => {
    expect(needsIdentification("B", "consumidor_final", null, 10_000_000, 10_000_000)).toBe(true);
    expect(needsIdentification("B", "consumidor_final", "12345678", 10_000_000, 10_000_000)).toBe(false);
    expect(needsIdentification("B", "consumidor_final", null, 9_999_999.99, 10_000_000)).toBe(false);
    expect(needsIdentification("A", "responsable_inscripto", null, 20_000_000, 10_000_000)).toBe(false);
    expect(needsIdentification("C", null, "", 20_000_000, 10_000_000)).toBe(true);
  });
});

describe("catálogo", () => {
  it("IVA: ids de ARCA únicos y exento distinto de no gravado y de 0 %", () => {
    const ids = IVA_CODES.map((c) => IVA_RATES[c].arcaId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(IVA_RATES.exento.kind).toBe("exento");
    expect(IVA_RATES.no_gravado.kind).toBe("no_gravado");
    expect(IVA_RATES["0"].kind).toBe("gravado");
  });

  it("alícuota numérica → código (compatibilidad con tax_rate)", () => {
    expect(ivaCodeFromRate(21)).toBe("21");
    expect(ivaCodeFromRate("10.5")).toBe("10.5");
    expect(ivaCodeFromRate(0)).toBe("0");
    expect(ivaCodeFromRate(19)).toBeNull();
    expect(ivaCodeFromRate(null)).toBeNull();
  });

  it("toda condición tiene id de ARCA y los documentos su tipo", () => {
    for (const c of FISCAL_CONDITIONS) expect(FISCAL_CONDITION_ARCA_ID[c], c).toBeGreaterThan(0);
    expect(DOC_TYPE_ARCA_ID.cuit).toBe(80);
    expect(DOC_TYPE_ARCA_ID.dni).toBe(96);
  });

  it("documento: CUIT con dígito verificador y DNI de 7 u 8 dígitos", () => {
    expect(documentError("cuit", "30-71234567-1")).toBeNull();
    expect(documentError("cuit", "30712345670")).toBe("invalid_cuit");
    expect(documentError("cuil", "20123456786")).toBeNull();
    expect(documentError("dni", "1234567")).toBeNull();
    expect(documentError("dni", "123")).toBe("invalid_dni");
    expect(documentError("passport", "AB123")).toBeNull();
    expect(documentError("cuit", "")).toBeNull();
  });
});
