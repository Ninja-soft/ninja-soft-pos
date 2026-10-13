import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STORE_ICONS, storeIcon } from "@/lib/catalog/storeLogos";

describe("storeLogos", () => {
  it("cada ícono existe en public", () => {
    for (const src of Object.values(STORE_ICONS)) {
      expect(existsSync(join(process.cwd(), "public", src))).toBe(true);
    }
  });
  it("resuelve sin importar mayúsculas y devuelve null si no hay", () => {
    expect(storeIcon("coto")).toBe("/tiendas/iconos/coto.webp");
    expect(storeIcon("NO_EXISTE")).toBeNull();
    expect(storeIcon(null)).toBeNull();
  });
});
