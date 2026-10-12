import { describe, expect, it } from "vitest";
import { FEATURE_INFO, featureRequires } from "@/lib/saas/featureInfo";

describe("dependencias de features", () => {
  it("cada requires apunta a una feature con copy", () => {
    for (const [key, info] of Object.entries(FEATURE_INFO)) {
      for (const dep of info.requires ?? []) {
        expect(FEATURE_INFO[dep], `${key} requiere ${dep}`).toBeDefined();
      }
    }
  });

  it("no hay ciclos de dependencias", () => {
    const visit = (key: string, path: string[]): void => {
      expect(path, `ciclo: ${[...path, key].join(" > ")}`).not.toContain(key);
      for (const dep of FEATURE_INFO[key]?.requires ?? []) visit(dep, [...path, key]);
    };
    for (const key of Object.keys(FEATURE_INFO)) visit(key, []);
  });

  it("los canales Point de cada marca tienen copy y aclaran su requisito", () => {
    for (const key of ["mercadopago_point", "payway_point", "getnet_point", "nave_point"]) {
      expect(FEATURE_INFO[key]?.needs, key).toBeTruthy();
    }
  });

  it("Nave QR + link aclara que hay que conectar la cuenta", () => {
    expect(FEATURE_INFO.nave?.needs).toMatch(/Conectar la cuenta de Nave/);
  });

  it("featureRequires devuelve las dependencias directas", () => {
    expect(featureRequires("pos")).toEqual([]);
  });
});
