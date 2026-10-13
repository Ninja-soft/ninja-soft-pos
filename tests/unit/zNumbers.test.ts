import { describe, expect, it } from "vitest";
import { showRegisterFilter, zFileName, zMain, zSeriesLabel } from "@/lib/cash/zNumbers";

describe("numeración de cierres Z por sucursal y caja (H97)", () => {
  const z = { z_number: 41, store_id: "s1", cash_register_id: "r1", store_z_number: 12, register_z_number: 5 };

  it("número del negocio", () => {
    expect(zMain(z)).toBe("Z 41");
  });

  it("series de sucursal y caja cuando hay nombres", () => {
    expect(zSeriesLabel(z, { branch: "Norte", register: "Caja 1" })).toBe("Norte Z 12 · Caja 1 Z 5");
  });

  it("con una sola sucursal sólo muestra la serie de la caja", () => {
    expect(zSeriesLabel(z, { branch: null, register: "Caja 1" })).toBe("Caja 1 Z 5");
  });

  it("Z sin numeración propia (previos sin turno) no muestra serie", () => {
    expect(zSeriesLabel({ z_number: 3 }, { branch: "Norte", register: "Caja 1" })).toBeNull();
    expect(zSeriesLabel({ ...z, register_z_number: null }, { register: "Caja 1" })).toBeNull();
  });

  it("nombre de archivo con slug sin acentos", () => {
    expect(zFileName(z)).toBe("cierre-z-41");
    expect(zFileName(z, { branch: "Shopping Córdoba", register: "Caja 1" })).toBe(
      "cierre-z-41-shopping-cordoba-12-caja-1-5",
    );
  });

  it("filtro por caja sólo con una sucursal elegida y más de una caja", () => {
    const regs = [
      { store_id: "s1", deleted_at: null },
      { store_id: "s1", deleted_at: "2026-10-01" },
      { store_id: "s2", deleted_at: null },
    ];
    expect(showRegisterFilter(null, regs)).toBe(false);
    expect(showRegisterFilter("s1", regs)).toBe(true);
    expect(showRegisterFilter("s2", regs)).toBe(false);
  });
});
