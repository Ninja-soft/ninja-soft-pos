import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STORE_ICONS, STORE_ICON_VARIANTS, storeIcon, themeTone } from "@/lib/catalog/storeLogos";

describe("storeLogos", () => {
  it("cada ícono existe en public", () => {
    for (const src of Object.values(STORE_ICONS)) {
      expect(existsSync(join(process.cwd(), "public", src))).toBe(true);
    }
    for (const v of Object.values(STORE_ICON_VARIANTS)) {
      for (const src of Object.values(v)) {
        expect(existsSync(join(process.cwd(), "public", src!))).toBe(true);
      }
    }
  });
  it("elige la variante por tema y cae al ícono base", () => {
    expect(themeTone("ninja-sand")).toBe("light");
    expect(themeTone("ninja-noir")).toBe("dark");
    expect(themeTone(null)).toBe("dark");
    expect(storeIcon("macro", { theme: "ninja-dark" })).toBe("/tiendas/iconos/macro-claro.webp");
    expect(storeIcon("MACRO", { theme: "ninja-light" })).toBe("/tiendas/iconos/macro.webp");
    expect(storeIcon("BANCOR", { tone: "light" })).toBe("/tiendas/iconos/bancor-oscuro.webp");
    expect(storeIcon("BANCOR", { tone: "dark" })).toBe("/tiendas/iconos/bancor.webp");
    expect(storeIcon("COTO", { theme: "ninja-light" })).toBe("/tiendas/iconos/coto.webp");
    expect(storeIcon("MACRO")).toBe("/tiendas/iconos/macro.webp");
  });
  it("resuelve sin importar mayúsculas y devuelve null si no hay", () => {
    expect(storeIcon("coto")).toBe("/tiendas/iconos/coto.webp");
    expect(storeIcon("NO_EXISTE")).toBeNull();
    expect(storeIcon(null)).toBeNull();
  });
});
