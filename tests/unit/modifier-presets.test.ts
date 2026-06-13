import { describe, it, expect } from "vitest";
import {
  MODIFIER_PRESETS,
  findModifierPreset,
} from "@/lib/gastro/modifierPresets";

// F13 · H47 — el catálogo de presets gastronómicos alimenta directamente el
// editor de modificadores (H37), que valida grupo con nombre + al menos una
// opción + max>=min y, si es required, min>=1. Estos tests garantizan que cada
// preset entra LIMPIO a esas reglas (no rompe el persist del producto).

describe("MODIFIER_PRESETS — integridad del catálogo", () => {
  it("tiene keys únicas y no vacías", () => {
    const keys = MODIFIER_PRESETS.map((p) => p.key);
    expect(keys.every((k) => k.trim().length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("cada preset respeta las reglas del editor (H37)", () => {
    for (const preset of MODIFIER_PRESETS) {
      const g = preset.group;
      // Etiqueta y nombre presentes.
      expect(preset.label.trim().length).toBeGreaterThan(0);
      expect(g.name.trim().length).toBeGreaterThan(0);
      // Al menos una opción, todas con nombre.
      expect(g.options.length).toBeGreaterThan(0);
      expect(g.options.every((o) => o.name.trim().length > 0)).toBe(true);
      // min >= 0; max null (sin tope) o >= 1 y >= min.
      expect(g.min_select).toBeGreaterThanOrEqual(0);
      if (g.max_select != null) {
        expect(g.max_select).toBeGreaterThanOrEqual(1);
        expect(g.max_select).toBeGreaterThanOrEqual(g.min_select);
      }
      // Si es obligatorio, debe poder elegirse al menos 1.
      if (g.required) {
        expect(g.min_select).toBeGreaterThanOrEqual(1);
      }
      // Los deltas de precio, cuando existen, son finitos y no negativos.
      for (const o of g.options) {
        if (o.price_delta != null) {
          expect(Number.isFinite(o.price_delta)).toBe(true);
          expect(o.price_delta).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("findModifierPreset encuentra por key y devuelve undefined si no existe", () => {
    expect(findModifierPreset("coccion")?.group.name).toBe("Punto de cocción");
    expect(findModifierPreset("no-existe")).toBeUndefined();
  });
});
