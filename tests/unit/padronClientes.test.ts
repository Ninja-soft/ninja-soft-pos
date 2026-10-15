// @vitest-environment node
// Padrón de ARCA para clientes y para el propio negocio (ADR-133): dígito
// verificador, mapeo de la respuesta (actividades, domicilio en partes,
// inicio de actividades aproximado), campos que completa, cupos, mensajes y
// etiquetas con la fecha en hora de Argentina. Nunca se llama a ARCA.
import { describe, expect, it } from "vitest";
import {
  cuitIsValid,
  inicioDesdePeriodos,
  parsePersonaV2,
  quotaExceeded,
} from "@/supabase/functions/_shared/arca/padron";
import { isValidCuit } from "@/lib/tax/catalog";
import { isValidCuit as schemaIsValidCuit } from "@/modules/customers/schemas";
import {
  canVerifyDocument,
  jurisdictionFromProvince,
  padronConditionLabel,
  padronErrorMessage,
  padronToCustomer,
  verificationLabel,
} from "@/lib/customers/padron";
import { brandingFromPadron } from "@/components/dashboard-team/BrandingPadron";
import * as F from "../fixtures/padronA5";

function withCheckDigit(body10: string): string {
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let s = 0;
  for (let i = 0; i < 10; i++) s += Number(body10[i]) * (w[i] as number);
  let c = 11 - (s % 11);
  if (c === 11) c = 0;
  if (c === 10) c = 9;
  return body10 + c;
}

describe("dígito verificador de CUIT y CUIL", () => {
  it.each([withCheckDigit("2028765432"), withCheckDigit("3071234567"), withCheckDigit("2711111111"), withCheckDigit("2012345678"), withCheckDigit("3050000000")])(
    "%s es válida en los tres validadores",
    (c) => {
      expect(cuitIsValid(c)).toBe(true);
      expect(isValidCuit(c)).toBe(true);
      expect(schemaIsValidCuit(c)).toBe(true);
    },
  );
  it("acepta guiones y espacios", () => {
    const ok = withCheckDigit("2028765432");
    expect(cuitIsValid(`${ok.slice(0, 2)}-${ok.slice(2, 10)}-${ok[10]}`)).toBe(true);
    expect(isValidCuit(`${ok.slice(0, 2)} ${ok.slice(2, 10)} ${ok[10]}`)).toBe(true);
  });
  it.each(["20287654328", "2028765432", "202876543299", "", "abcdefghijk"])("%s no es válida", (c) => {
    expect(cuitIsValid(c)).toBe(false);
    expect(isValidCuit(c)).toBe(false);
  });
  it("los tres validadores coinciden en 2000 números al azar", () => {
    let seed = 7;
    for (let i = 0; i < 2000; i++) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      const n = String(20_000_000_000 + (seed % 19_999_999_999)).slice(0, 11);
      expect(isValidCuit(n)).toBe(cuitIsValid(n));
      expect(schemaIsValidCuit(n)).toBe(cuitIsValid(n));
    }
  });
  it("sólo CUIT o CUIL válidos se pueden verificar", () => {
    expect(canVerifyDocument("cuit", withCheckDigit("2028765432"))).toBe(true);
    expect(canVerifyDocument("cuil", withCheckDigit("2028765432"))).toBe(true);
    expect(canVerifyDocument("dni", "28765432")).toBe(false);
    expect(canVerifyDocument("cuit", "20287654328")).toBe(false);
  });
});

describe("mapeo de la respuesta del padrón", () => {
  it("RI: actividades, domicilio en partes e inicio aproximado", () => {
    const r = parsePersonaV2(F.RI_JURIDICA);
    if (r.status !== "ok") throw new Error("esperaba ok");
    expect(r.persona.actividades).toEqual([{ id: "620100", descripcion: "SERVICIOS DE CONSULTORES EN INFORMATICA", orden: 1 }]);
    expect(r.persona.domicilio_partes).toEqual({
      direccion: "MITRE 123 PISO 2",
      localidad: "ROSARIO",
      provincia: "SANTA FE",
      cod_postal: "2000",
      id_provincia: 12,
    });
    expect(r.persona.inicio_actividades).toBe("2019-01-01");
  });
  it("monotributo: actividad del monotributo y período más viejo", () => {
    const r = parsePersonaV2(F.MONOTRIBUTO_FISICA);
    if (r.status !== "ok") throw new Error("esperaba ok");
    expect(r.persona.actividades?.[0]?.descripcion).toBe("VENTA AL POR MENOR EN KIOSCOS");
    expect(r.persona.inicio_actividades).toBe("2024-02-01");
  });
  it("inicio aproximado ignora períodos inválidos", () => {
    expect(inicioDesdePeriodos([null])).toBeNull();
    expect(inicioDesdePeriodos(["<impuesto><periodo>201913</periodo></impuesto>"])).toBeNull();
    expect(inicioDesdePeriodos(["<impuesto><periodo>202105</periodo></impuesto><impuesto><periodo>201811</periodo></impuesto>"])).toBe(
      "2018-11-01",
    );
  });
  it("fault de permisos: padron_no_autorizado", () => {
    expect(parsePersonaV2(F.SIN_AUTORIZACION)).toMatchObject({ status: "error", code: "padron_no_autorizado" });
  });

  it("campos del cliente: razón social, condición, domicilio corto y jurisdicción", () => {
    const r = parsePersonaV2(F.RI_JURIDICA);
    if (r.status !== "ok") throw new Error("esperaba ok");
    expect(padronToCustomer(r.persona)).toEqual({
      name: "ACME & ASOCIADOS S.R.L.",
      iva_condition: "responsable_inscripto",
      address: "MITRE 123 PISO 2, ROSARIO",
      iibb_jurisdiction: "921",
    });
  });
  it("datos del negocio: inicio aproximado y sin condición si no está inscripto", () => {
    const ri = parsePersonaV2(F.RI_JURIDICA);
    const sin = parsePersonaV2(F.SIN_IVA);
    if (ri.status !== "ok" || sin.status !== "ok") throw new Error("esperaba ok");
    expect(brandingFromPadron(ri.persona)).toMatchObject({
      legal_name: "ACME & ASOCIADOS S.R.L.",
      iva_condition: "responsable_inscripto",
      address: "MITRE 123 PISO 2, ROSARIO, SANTA FE",
      activity_start: "2019-01-01",
      iibb_jurisdiction: "921",
    });
    expect(brandingFromPadron(sin.persona).iva_condition).toBeNull();
  });
  it("jurisdicción por código de ARCA o por nombre", () => {
    expect(jurisdictionFromProvince(0)).toBe("901");
    expect(jurisdictionFromProvince(1)).toBe("902");
    expect(jurisdictionFromProvince(24)).toBe("923");
    expect(jurisdictionFromProvince(null, "CIUDAD AUTONOMA BUENOS AIRES")).toBe("901");
    expect(jurisdictionFromProvince(null, "CORDOBA")).toBe("904");
    expect(jurisdictionFromProvince(null, "ENTRE RIOS")).toBe("908");
    expect(jurisdictionFromProvince(null, "MARTE")).toBeNull();
  });
  it("condición en palabras simples", () => {
    expect(padronConditionLabel({ iva_condition: "monotributo", monotributo_categoria: "B" })).toBe("Monotributista (categoría B)");
    expect(padronConditionLabel({ iva_condition: "consumidor_final", monotributo_categoria: null })).toMatch(/consumidor final/);
  });
});

describe("cupos configurables", () => {
  const q = { tenant_per_hour: 30, tenant_per_day: 200, global_per_hour: 1000 };
  it("con cupo: null", () => {
    expect(quotaExceeded({ tenant_hour: 29, tenant_day: 199, global_hour: 999 }, q)).toBeNull();
  });
  it("global primero, después hora y día del negocio", () => {
    expect(quotaExceeded({ tenant_hour: 30, tenant_day: 200, global_hour: 1000 }, q)).toBe("global");
    expect(quotaExceeded({ tenant_hour: 30, tenant_day: 200, global_hour: 0 }, q)).toBe("tenant_hour");
    expect(quotaExceeded({ tenant_hour: 0, tenant_day: 200, global_hour: 0 }, q)).toBe("tenant_day");
  });
});

describe("mensajes y etiquetas", () => {
  it("errores claros", () => {
    expect(padronErrorMessage("invalid_cuit")).toMatch(/dígito de control/);
    expect(padronErrorMessage("no_encontrado")).toMatch(/no tiene registrada/);
    expect(padronErrorMessage("not_configured", { reason: "certificate_missing" })).toMatch(/certificado/);
    expect(padronErrorMessage("rate_limited", { scope: "tenant_day" })).toMatch(/hoy/);
    expect(padronErrorMessage("cualquier_cosa")).toMatch(/a mano/);
  });
  it("verificado con la fecha en hora de Argentina", () => {
    // 02:30 UTC del 13/10 = 23:30 del 12/10 en Buenos Aires.
    expect(verificationLabel("padron", "2026-10-13T02:30:00Z")).toBe("Verificado en ARCA el 12/10/2026");
    expect(verificationLabel("manual", null)).toBe("Cargado a mano");
    expect(verificationLabel(null, null)).toBeNull();
  });
});
