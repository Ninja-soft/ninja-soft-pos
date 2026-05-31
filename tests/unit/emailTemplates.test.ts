import { describe, it, expect } from "vitest";
import {
  renderTemplate,
  EMAIL_TEMPLATES,
  sampleVars,
} from "@/lib/email/templates";

describe("renderTemplate", () => {
  it("reemplaza variables existentes", () => {
    expect(renderTemplate("Hola {{nombre}} de {{negocio}}", { nombre: "Ana", negocio: "Kiosco" })).toBe(
      "Hola Ana de Kiosco",
    );
  });

  it("deja el placeholder si falta la variable", () => {
    expect(renderTemplate("Hola {{nombre}}", {})).toBe("Hola {{nombre}}");
  });

  it("tolera espacios dentro de las llaves", () => {
    expect(renderTemplate("{{ negocio }}", { negocio: "X" })).toBe("X");
  });

  it("cada template del catálogo renderiza con sampleVars sin dejar variables base", () => {
    const vars = sampleVars("Mi Negocio");
    for (const t of EMAIL_TEMPLATES) {
      const out = renderTemplate(t.defaultSubject + t.defaultHtml, vars);
      expect(out).not.toContain("{{negocio}}");
    }
  });
});
