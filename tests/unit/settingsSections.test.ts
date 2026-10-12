import { describe, expect, it } from "vitest";
import {
  SECTION_ALIASES,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  filterSettingsGroups,
  resolveSection,
} from "@/components/settings/sections";

describe("secciones de Configuración", () => {
  it("las keys son únicas", () => {
    const keys = SETTINGS_SECTIONS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("mantiene las keys de los links internos existentes", () => {
    for (const k of ["diseno-pos", "hardware", "marca", "operacion", "pagos", "salones", "tickets"]) {
      expect(resolveSection(k)).toBe(k);
    }
  });

  it("resuelve alias y descarta valores desconocidos", () => {
    expect(resolveSection("cupones")).toBe("promociones");
    expect(resolveSection("diagnostico")).toBe("hardware");
    expect(resolveSection("nada")).toBeNull();
    expect(resolveSection(null)).toBeNull();
    for (const target of Object.values(SECTION_ALIASES)) {
      expect(SETTINGS_SECTIONS.some((s) => s.key === target)).toBe(true);
    }
  });

  it("los textos de la UI no usan raya", () => {
    for (const s of SETTINGS_SECTIONS) {
      expect(`${s.label}${s.title}${s.description}`).not.toContain("—");
    }
  });

  it("el buscador ignora tildes y mayúsculas y busca en palabras clave", () => {
    const names = (q: string) =>
      filterSettingsGroups(SETTINGS_GROUPS, q).flatMap((g) => g.sections.map((s) => s.key));
    expect(names("ESCANER")).toContain("escaner");
    expect(names("mercado pago")).toEqual(["pagos"]);
    expect(names("cupon")).toContain("promociones");
    expect(names("")).toHaveLength(SETTINGS_SECTIONS.length);
    expect(names("zzzz")).toEqual([]);
  });
});
