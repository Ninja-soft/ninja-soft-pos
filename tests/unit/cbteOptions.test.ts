// @vitest-environment node
// Tipos de comprobante que ARCA acepta y el forzado a mano (ADR-133). Espejo
// de cbte_letter_check (SQL): mismos códigos para la misma combinación.
import { describe, expect, it } from "vitest";
import {
  checkLetter,
  emitterLetters,
  letterCheckMessage,
  letterOptions,
  overrideRiskText,
} from "@/lib/billing/cbteOptions";
import { inferLetter } from "@/lib/tax/comprobante";
import { FISCAL_CONDITIONS } from "@/lib/tax/catalog";

const EMITTERS = ["responsable_inscripto", "monotributo", "monotributo_social", "exento", "no_alcanzado"] as const;

describe("tipos que puede emitir cada negocio", () => {
  it("RI: A, B y E; con M: M en lugar de A", () => {
    expect(emitterLetters("responsable_inscripto")).toEqual(["A", "B", "E"]);
    expect(emitterLetters("responsable_inscripto", { issuesM: true })).toEqual(["M", "B", "E"]);
  });
  it.each(["monotributo", "monotributo_social", "exento", "no_alcanzado"])("%s: C y E", (e) => {
    expect(emitterLetters(e)).toEqual(["C", "E"]);
  });
  it("sin condición no emite", () => {
    expect(emitterLetters(null)).toEqual([]);
  });
});

describe("matriz de ARCA (checkLetter)", () => {
  const ri = "responsable_inscripto";
  it("A a RI o monotributista con CUIT: válida", () => {
    expect(checkLetter(ri, "responsable_inscripto", { hasCuit: true }, "A")).toBeNull();
    expect(checkLetter(ri, "monotributo", { hasCuit: true }, "A")).toBeNull();
    expect(checkLetter(ri, "monotributo_social", { hasCuit: true }, "A")).toBeNull();
  });
  it("A a consumidor final sin CUIT: ARCA la rechaza", () => {
    expect(checkLetter(ri, "consumidor_final", { hasCuit: false }, "A")).toBe("condicion_receptor_no_valida");
    expect(checkLetter(ri, null, { hasCuit: false }, "A")).toBe("condicion_receptor_no_valida");
  });
  it("A a RI sin CUIT: falta el CUIT", () => {
    expect(checkLetter(ri, "responsable_inscripto", { hasCuit: false }, "A")).toBe("receptor_sin_cuit");
  });
  it("B a RI o monotributista: rechazada; B a consumidor final, exento o exterior: válida", () => {
    expect(checkLetter(ri, "responsable_inscripto", { hasCuit: true }, "B")).toBe("condicion_receptor_no_valida");
    expect(checkLetter(ri, "monotributo", { hasCuit: true }, "B")).toBe("condicion_receptor_no_valida");
    expect(checkLetter(ri, "consumidor_final", { hasCuit: false }, "B")).toBeNull();
    expect(checkLetter(ri, "exento", { hasCuit: true }, "B")).toBeNull();
    expect(checkLetter(ri, "exterior", { hasCuit: false }, "B")).toBeNull();
  });
  it("C sólo para monotributo o exento", () => {
    expect(checkLetter(ri, "consumidor_final", { hasCuit: false }, "C")).toBe("letra_no_habilitada_emisor");
    expect(checkLetter("monotributo", "responsable_inscripto", { hasCuit: true }, "A")).toBe("letra_no_habilitada_emisor");
    expect(checkLetter("monotributo", "responsable_inscripto", { hasCuit: true }, "C")).toBeNull();
    expect(checkLetter("exento", "consumidor_final", { hasCuit: false }, "C")).toBeNull();
  });
  it("M sólo si ARCA la pidió, y entonces no A", () => {
    expect(checkLetter(ri, "responsable_inscripto", { hasCuit: true, issuesM: false }, "M")).toBe("m_no_habilitada");
    expect(checkLetter(ri, "responsable_inscripto", { hasCuit: true, issuesM: true }, "M")).toBeNull();
    expect(checkLetter(ri, "responsable_inscripto", { hasCuit: true, issuesM: true }, "A")).toBe("emisor_emite_m");
  });
  it("E todavía no se emite y sin emisor no hay letra", () => {
    expect(checkLetter(ri, "exterior", { hasCuit: false }, "E")).toBe("exportacion_no_soportada");
    expect(checkLetter(null, "consumidor_final", { hasCuit: false }, "B")).toBe("emisor_sin_configurar");
    expect(checkLetter(ri, "consumidor_final", { hasCuit: false }, "Z")).toBe("letra_invalida");
  });

  it("la letra sugerida (inferLetter) siempre es válida cuando hay CUIT (salvo E)", () => {
    for (const e of EMITTERS) {
      for (const r of FISCAL_CONDITIONS) {
        for (const issuesM of [false, true]) {
          const l = inferLetter(e, r, { issuesM });
          if (!l || l === "E") continue;
          expect(checkLetter(e, r, { hasCuit: true, issuesM }, l), `${e} → ${r} = ${l}`).toBeNull();
        }
      }
    }
  });
});

describe("opciones de Cambiar tipo", () => {
  it("RI a consumidor final: B sugerida y habilitada, A deshabilitada con motivo, E deshabilitada", () => {
    const o = letterOptions("responsable_inscripto", "consumidor_final", { hasCuit: false });
    expect(o.map((x) => [x.letter, x.allowed, x.suggested])).toEqual([
      ["A", false, false],
      ["B", true, true],
      ["E", false, false],
    ]);
    expect(o[0]?.reason).toMatch(/sólo acepta factura A a responsables inscriptos/);
    expect(o[2]?.reason).toMatch(/exportación/);
  });
  it("RI a cliente del exterior: la sugerida es E (no se emite) y se puede forzar B", () => {
    const o = letterOptions("responsable_inscripto", "exterior", { hasCuit: false });
    const b = o.find((x) => x.letter === "B");
    const e = o.find((x) => x.letter === "E");
    expect(e).toMatchObject({ suggested: true, allowed: false });
    expect(b).toMatchObject({ suggested: false, allowed: true });
  });
  it("monotributista: sólo C habilitada", () => {
    const o = letterOptions("monotributo", "responsable_inscripto", { hasCuit: true });
    expect(o.filter((x) => x.allowed).map((x) => x.letter)).toEqual(["C"]);
  });
  it("B a un RI explica qué hacer", () => {
    expect(letterCheckMessage("condicion_receptor_no_valida", { letter: "B", receptor: "responsable_inscripto" })).toMatch(
      /consumidor final sin elegir cliente/,
    );
  });
  it("el riesgo del forzado nombra las dos letras y la auditoría", () => {
    const t = overrideRiskText("E", "B");
    expect(t).toMatch(/factura B en lugar de la E/);
    expect(t).toMatch(/nota de crédito/);
    expect(t).toMatch(/registrado/);
    expect(t).not.toMatch(/—/);
  });
});
