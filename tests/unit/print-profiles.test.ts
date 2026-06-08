import { describe, it, expect } from "vitest";
import {
  clampPrintCopies,
  coercePaper,
  defaultPrintProfiles,
  defaultProfile,
  normalizePrintProfiles,
  normalizeProfile,
  PRINT_DOC_TYPES,
} from "@/lib/print/profiles";

describe("clampPrintCopies", () => {
  it("acota a 1..20 y trunca", () => {
    expect(clampPrintCopies(0)).toBe(1);
    expect(clampPrintCopies(-5)).toBe(1);
    expect(clampPrintCopies(3.9)).toBe(3);
    expect(clampPrintCopies(99)).toBe(20);
  });
  it("cae a 1 ante valores no numéricos", () => {
    expect(clampPrintCopies("abc")).toBe(1);
    expect(clampPrintCopies(NaN)).toBe(1);
    expect(clampPrintCopies(null)).toBe(1);
  });
});

describe("coercePaper", () => {
  it("respeta un papel válido para el tipo", () => {
    expect(coercePaper("sale", "a4")).toBe("a4");
    expect(coercePaper("product_label", "80")).toBe("80");
  });
  it("cae al papel por default del tipo si el guardado no aplica", () => {
    // La etiqueta no admite A4 → cae a su default (58).
    expect(coercePaper("product_label", "a4")).toBe("58");
    // Un papel basura en el ticket de venta → cae a su default (80).
    expect(coercePaper("sale", "thermal")).toBe("80");
  });
});

describe("defaultProfile / defaultPrintProfiles", () => {
  it("la etiqueta arranca en 58mm/font chica; el resto en 80mm/normal", () => {
    expect(defaultProfile("product_label")).toMatchObject({ paper: "58", font: "sm" });
    expect(defaultProfile("sale")).toMatchObject({ paper: "80", font: "md" });
  });
  it("ningún default imprime en automático (manual por defecto)", () => {
    const all = defaultPrintProfiles();
    for (const t of PRINT_DOC_TYPES) expect(all[t].auto).toBe(false);
  });
});

describe("normalizeProfile", () => {
  it("completa campos faltantes con el default del tipo", () => {
    expect(normalizeProfile("sale", { copies: 2 })).toEqual({
      paper: "80",
      copies: 2,
      auto: false,
      font: "md",
      margin: "normal",
    });
  });
  it("ignora basura y mantiene tipos válidos", () => {
    const p = normalizeProfile("sale", { paper: "xx", copies: 999, auto: "yes", font: "huge" });
    expect(p.paper).toBe("80"); // 'xx' inválido → default del tipo
    expect(p.copies).toBe(20); // acotado
    expect(p.auto).toBe(false); // 'yes' no es booleano → default
    expect(p.font).toBe("md"); // 'huge' inválido → default
  });
  it("respeta auto=true cuando es booleano", () => {
    expect(normalizeProfile("sale", { auto: true }).auto).toBe(true);
  });
});

describe("normalizePrintProfiles", () => {
  it("ante null/objeto vacío devuelve los 5 perfiles por default", () => {
    expect(normalizePrintProfiles(null)).toEqual(defaultPrintProfiles());
    expect(normalizePrintProfiles({})).toEqual(defaultPrintProfiles());
  });
  it("mezcla lo guardado con defaults por tipo", () => {
    const out = normalizePrintProfiles({
      sale: { paper: "a4", copies: 2, auto: true },
      product_label: { paper: "a4" }, // A4 no aplica a etiqueta → cae a 58
    });
    expect(out.sale).toMatchObject({ paper: "a4", copies: 2, auto: true });
    expect(out.product_label.paper).toBe("58");
    expect(out.z_close).toEqual(defaultProfile("z_close"));
  });
});
