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
    for (const key of ["mercadopago_point", "payway_point", "getnet_point", "nave_point", "fiserv_point"]) {
      expect(FEATURE_INFO[key]?.needs, key).toBeTruthy();
    }
  });

  it("Clover Point depende de la marca Fiserv conectada y va en su mismo plan", () => {
    expect(featureRequires("fiserv_point")).toEqual(["fiserv"]);
    expect(FEATURE_INFO.fiserv_point?.minPlan).toBe(FEATURE_INFO.fiserv?.minPlan);
    expect(FEATURE_INFO.fiserv_point?.needs).toMatch(/Marca Fiserv conectada/);
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

  it("conciliación de tarjetas: Pro, sin dependencias de plan y aclara el n° de comercio", () => {
    expect(FEATURE_INFO.conciliacion_tarjetas?.minPlan).toBe("Pro");
    expect(featureRequires("conciliacion_tarjetas")).toEqual([]);
    expect(FEATURE_INFO.conciliacion_tarjetas?.needs).toMatch(/números de comercio/);
  });

  it("multi-sucursal y multi-caja tienen copy y plan mínimo (F17 · H89)", () => {
    expect(FEATURE_INFO.multi_sucursal?.minPlan).toBe("Business");
    expect(FEATURE_INFO.multi_caja?.minPlan).toBe("Pro");
    expect(FEATURE_INFO.multi_caja?.impact).toMatch(/primera caja/);
  });

  it("tesorería es Business y depende de compras (ADR-059)", () => {
    expect(FEATURE_INFO.tesoreria?.minPlan).toBe("Business");
    expect(featureRequires("tesoreria")).toEqual(["compras"]);
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

  it("compras desde Pro y costeo de importación desde Business, que requiere compras (ADR-050)", () => {
    expect(FEATURE_INFO.compras?.minPlan).toBe("Pro");
    expect(featureRequires("compras")).toEqual([]);
    expect(FEATURE_INFO.compras_importacion?.minPlan).toBe("Business");
    expect(featureRequires("compras_importacion")).toEqual(["compras"]);
    expect(FEATURE_INFO.compras_importacion?.desc).toMatch(/no se suma al costo/);
    expect(FEATURE_INFO.compras_importacion?.needs).toMatch(/modo profesional/);
  });

  it("impuestos (ADR-068): IVA BASE, internos Pro y percepciones Business", () => {
    expect(FEATURE_INFO.impuestos_iva?.minPlan).toBe("Start");
    expect(FEATURE_INFO.impuestos_internos?.minPlan).toBe("Pro");
    expect(FEATURE_INFO.percepciones_retenciones?.minPlan).toBe("Business");
    expect(featureRequires("percepciones_retenciones")).toEqual(["impuestos_iva"]);
    expect(FEATURE_INFO.percepciones_retenciones?.needs).toMatch(/designado agente/);
  });
});
