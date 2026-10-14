// @vitest-environment node
// Guía de letras para el dueño (ADR-123): la matriz sale de inferLetter, la
// misma regla que usan la venta y el worker de ARCA.
import { describe, expect, it } from "vitest";
import {
  ISSUER_CONDITIONS,
  compareConditionWithPadron,
  isCreditOrDebitNote,
  letterGuide,
  letterGuideSummary,
  letterReason,
} from "@/lib/billing/letter";
import { inferLetter } from "@/lib/tax/comprobante";

const byKey = (rows: ReturnType<typeof letterGuide>) => Object.fromEntries(rows.map((r) => [r.key, r.letter]));

describe("letterGuide", () => {
  it("responsable inscripto: A a RI y monotributo, B al resto, E exterior", () => {
    expect(byKey(letterGuide("responsable_inscripto"))).toEqual({ ri: "A", mono: "A", cf: "B", exento: "B", exterior: "E" });
  });

  it("responsable inscripto que emite M: M en lugar de A", () => {
    expect(byKey(letterGuide("responsable_inscripto", { issuesM: true }))).toEqual({
      ri: "M",
      mono: "M",
      cf: "B",
      exento: "B",
      exterior: "E",
    });
  });

  it.each(["monotributo", "monotributo_social", "exento", "no_alcanzado"])("%s: C a todos y E al exterior", (c) => {
    expect(byKey(letterGuide(c))).toEqual({ ri: "C", mono: "C", cf: "C", exento: "C", exterior: "E" });
  });

  it("sin condición: sin letras", () => {
    expect(letterGuide(null).every((r) => r.letter === null)).toBe(true);
  });

  it("coincide con inferLetter para cada condición del emisor", () => {
    for (const c of ISSUER_CONDITIONS) {
      const rows = byKey(letterGuide(c));
      expect(rows.cf).toBe(inferLetter(c, "consumidor_final"));
      expect(rows.ri).toBe(inferLetter(c, "responsable_inscripto"));
    }
  });
});

describe("letterGuideSummary", () => {
  it("resume según la condición", () => {
    expect(letterGuideSummary("monotributo")).toContain("todas tus facturas son C");
    expect(letterGuideSummary("responsable_inscripto")).toContain("A a responsables inscriptos y monotributistas, B al resto");
    expect(letterGuideSummary(null)).toContain("Elegí tu condición");
  });
  it("sin raya larga", () => {
    for (const c of [...ISSUER_CONDITIONS, null]) expect(letterGuideSummary(c)).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("letterReason", () => {
  it("explica cada letra en una frase", () => {
    expect(letterReason("C")).toContain("monotributista o exento");
    expect(letterReason("A")).toContain("responsable inscripto");
    expect(letterReason("B")).toContain("consumidor final");
    expect(letterReason(null)).toBeNull();
  });
  it("las notas llevan la letra de la factura que corrigen", () => {
    expect(isCreditOrDebitNote(13)).toBe(true);
    expect(isCreditOrDebitNote(11)).toBe(false);
    expect(letterReason("C", { cbteTipo: 13 })).toContain("factura que corrigen");
  });
});

describe("compareConditionWithPadron", () => {
  it("coincide (monotributo social cuenta como monotributo)", () => {
    expect(compareConditionWithPadron("monotributo", "monotributo")).toEqual({ status: "match" });
    expect(compareConditionWithPadron("monotributo_social", "monotributo")).toEqual({ status: "match" });
  });
  it("difiere", () => {
    expect(compareConditionWithPadron("monotributo", "responsable_inscripto")).toEqual({
      status: "mismatch",
      arca: "responsable_inscripto",
    });
    expect(compareConditionWithPadron(null, "exento")).toEqual({ status: "mismatch", arca: "exento" });
  });
  it("sin inscripción en IVA ni monotributo", () => {
    expect(compareConditionWithPadron("monotributo", "consumidor_final")).toEqual({ status: "not_registered" });
  });
});
