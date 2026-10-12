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

  it("GO Cuotas pide la API Key de la sucursal y es desde Pro", () => {
    expect(FEATURE_INFO.gocuotas?.needs).toMatch(/API Key de la sucursal/);
    expect(FEATURE_INFO.gocuotas?.minPlan).toBe("Pro");
  });

  it("Directo pide las credenciales de su API y aclara el respaldo manual", () => {
    expect(FEATURE_INFO.directo?.needs).toMatch(/credenciales de la API de Directo/);
    expect(FEATURE_INFO.directo?.needs).toMatch(/número de operación/);
    expect(FEATURE_INFO.directo?.minPlan).toBe("Pro");
  });

  it("las teclas rápidas pro tienen copy, plan mínimo y dependen del POS", () => {
    expect(FEATURE_INFO.pos_quick_keys_pro?.minPlan).toBe("Pro");
    expect(featureRequires("pos_quick_keys_pro")).toEqual(["pos"]);
  });

  it("featureRequires devuelve las dependencias directas", () => {
    expect(featureRequires("pos")).toEqual([]);
  });

  it("punitorios y cobranza dependen de cuenta corriente (mismo plan)", () => {
    for (const key of ["cc_punitorios", "cc_cobranza"]) {
      expect(featureRequires(key), key).toEqual(["cuenta_corriente"]);
      expect(FEATURE_INFO[key]?.minPlan, key).toBe(FEATURE_INFO.cuenta_corriente?.minPlan);
    }
    expect(FEATURE_INFO.cc_cobranza?.needs).toBeTruthy();
  });

  it("stock por sucursal y traslados dependen de multi-sucursal (mismo plan)", () => {
    expect(featureRequires("stock_sucursales")).toEqual(["multi_sucursal"]);
    expect(featureRequires("traslados")).toEqual(["stock_sucursales"]);
    for (const key of ["stock_sucursales", "traslados"]) {
      expect(FEATURE_INFO[key]?.minPlan, key).toBe(FEATURE_INFO.multi_sucursal?.minPlan);
    }
    expect(FEATURE_INFO.traslados?.needs).toMatch(/dos sucursales/);
  });
});
