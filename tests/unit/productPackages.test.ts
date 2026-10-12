import { describe, expect, it } from "vitest";
import {
  chargeableWeightKg,
  diffPackages,
  formatCm3,
  formatM3,
  formatWeight,
  isPackageEmpty,
  isoBoxGeometry,
  newPackage,
  packageTotalCm3,
  packageVolumeCm3,
  toPositiveOrNull,
  unitVolumeCm3,
  volumetricWeightKg,
} from "@/lib/products/packages";

describe("medidas por bulto", () => {
  const box = newPackage({ heightCm: 45, widthCm: 22, depthCm: 21.5, weightKg: 3 });

  it("calcula volumen por bulto, por unidad y total", () => {
    expect(packageVolumeCm3(box)).toBeCloseTo(21285);
    expect(packageTotalCm3({ ...box, packCount: 3 })).toBeCloseTo(63855);
    expect(unitVolumeCm3({ ...box, unitsPerPack: 5 })).toBeCloseTo(4257);
    expect(packageVolumeCm3(newPackage({ heightCm: 10 }))).toBeNull();
  });

  it("formatea en es-AR", () => {
    expect(formatCm3(21285)).toBe("21.285 cm³");
    expect(formatM3(21285)).toBe("0,021 m³");
    expect(formatWeight(3)).toBe("3 kg");
    expect(formatWeight(0.75)).toBe("750 g");
    expect(formatWeight(2.5)).toBe("2,5 kg");
  });

  it("peso volumétrico y peso a facturar", () => {
    expect(volumetricWeightKg(21285)).toBeCloseTo(4.257);
    expect(chargeableWeightKg(box)).toBeCloseTo(4.257);
    expect(chargeableWeightKg({ ...box, weightKg: 9 })).toBe(9);
  });

  it("parsea números con coma y descarta inválidos", () => {
    expect(toPositiveOrNull("22,5")).toBe(22.5);
    expect(toPositiveOrNull("")).toBeNull();
    expect(toPositiveOrNull("-3")).toBeNull();
    expect(toPositiveOrNull("abc")).toBeNull();
  });

  it("dibuja la caja isométrica proporcional", () => {
    const tall = isoBoxGeometry(80, 20, 20);
    const flat = isoBoxGeometry(10, 60, 40);
    expect(tall.viewBox).toBe("0 0 120 120");
    for (const g of [tall, flat]) {
      expect(g.top.split(" ")).toHaveLength(4);
      expect(g.left.split(" ")).toHaveLength(4);
      expect(g.right.split(" ")).toHaveLength(4);
      // Todos los puntos dentro del viewBox.
      for (const p of [...g.top.split(" "), ...g.left.split(" "), ...g.right.split(" ")]) {
        const [x, y] = p.split(",").map(Number);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(120);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(120);
      }
    }
    // Sin medidas igual dibuja algo.
    expect(isoBoxGeometry(null, null, null).top).toMatch(/\d/);
  });

  it("detecta bultos vacíos", () => {
    expect(isPackageEmpty(newPackage())).toBe(true);
    expect(isPackageEmpty(newPackage({ code: "K-COMPACTA" }))).toBe(false);
  });

  it("diff de bultos: alta, edición y baja lógica con idx ordenado", () => {
    const a = newPackage({ id: "a", key: "a", heightCm: 10 });
    const b = newPackage({ id: "b", key: "b", heightCm: 20 });
    const c = newPackage({ heightCm: 30 });
    const d = diffPackages([a, b], [b, c, newPackage()]);
    expect(d.remove).toEqual(["a"]);
    expect(d.update).toHaveLength(1);
    expect(d.update[0]).toMatchObject({ id: "b", idx: 1, height_cm: 20 });
    expect(d.insert).toHaveLength(1);
    expect(d.insert[0]).toMatchObject({ idx: 2, height_cm: 30, units_per_pack: 1, pack_count: 1 });
  });
});
