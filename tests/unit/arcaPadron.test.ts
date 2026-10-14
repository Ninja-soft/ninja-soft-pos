// @vitest-environment node
// Padrón A5 de ARCA (ws_sr_constancia_inscripcion · F20-3): request, parser
// con fixtures, mapeo a la condición frente al IVA, cache y rate limit.
// Nunca se llama a ARCA.
import { describe, expect, it } from "vitest";
import {
  buildGetPersonaV2,
  condicionFromImpuestos,
  isFresh,
  padronEndpointFor,
  parsePersonaV2,
  PADRON_ENDPOINTS,
  rateLimited,
  redactPadronXml,
} from "@/supabase/functions/_shared/arca/padron";
import * as F from "../fixtures/padronA5";

describe("request getPersona_v2", () => {
  const xml = buildGetPersonaV2({ token: "TOK<&>", sign: "SIG", cuitRepresentada: "30-71234567-1" }, "20-28765432-9");
  it("lleva token, sign, CUIT representada e idPersona sin guiones", () => {
    expect(xml).toContain('xmlns:a5="http://a5.soap.ws.server.puc.sr/"');
    expect(xml).toContain("<a5:getPersona_v2>");
    expect(xml).toContain("<token>TOK&lt;&amp;&gt;</token>");
    expect(xml).toContain("<cuitRepresentada>30712345671</cuitRepresentada>");
    expect(xml).toContain("<idPersona>20287654329</idPersona>");
  });
  it("se redacta para logs", () => {
    const r = redactPadronXml(xml);
    expect(r).not.toContain("TOK");
    expect(r).not.toContain("<sign>SIG");
  });
});

describe("parser", () => {
  it("responsable inscripto (sociedad)", () => {
    const r = parsePersonaV2(F.RI_JURIDICA);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.persona).toMatchObject({
      cuit: "30712345671",
      tipo_persona: "JURIDICA",
      razon_social: "ACME & ASOCIADOS S.R.L.",
      estado_clave: "ACTIVO",
      activa: true,
      iva_condition: "responsable_inscripto",
      iva_source: "regimen_general",
      provincia: "SANTA FE",
    });
    expect(r.persona.domicilio).toBe("MITRE 123 PISO 2, ROSARIO, SANTA FE, CP 2000");
    expect(r.persona.impuestos).toEqual([10, 30]);
  });
  it("monotributista (persona física): nombre con apellido y categoría", () => {
    const r = parsePersonaV2(F.MONOTRIBUTO_FISICA);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.persona.razon_social).toBe("PEREZ JUAN CARLOS");
    expect(r.persona.iva_condition).toBe("monotributo");
    expect(r.persona.monotributo_categoria).toBe("B VENTAS DE COSAS MUEBLES");
    expect(r.persona.impuestos).toEqual([20]);
  });
  it("exento", () => {
    const r = parsePersonaV2(F.EXENTO);
    expect(r.status === "ok" && r.persona.iva_condition).toBe("exento");
  });
  it("sin IVA ni monotributo: consumidor final, inactiva y con avisos", () => {
    const r = parsePersonaV2(F.SIN_IVA);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.persona.iva_condition).toBe("consumidor_final");
    expect(r.persona.iva_source).toBe("sin_iva");
    expect(r.persona.activa).toBe(false);
    expect(r.persona.avisos[0]).toMatch(/baja de oficio/);
  });
  it("sólo errorConstancia: no encontrado con el mensaje", () => {
    expect(parsePersonaV2(F.SOLO_ERROR)).toEqual({ status: "no_encontrado", message: "La clave se encuentra inactiva" });
  });
  it("fault 'No existe persona': no encontrado", () => {
    expect(parsePersonaV2(F.NO_EXISTE).status).toBe("no_encontrado");
  });
  it("otro fault: error", () => {
    const r = parsePersonaV2(F.SIN_AUTORIZACION);
    expect(r.status).toBe("error");
  });
  it("respuesta sin personaReturn: error", () => {
    expect(parsePersonaV2("<html>caído</html>")).toMatchObject({ status: "error", code: "padron_respuesta_invalida" });
  });
});

describe("mapeo de impuestos", () => {
  it.each([
    [[30], [], "responsable_inscripto"],
    [[10, 30], [], "responsable_inscripto"],
    [[32], [], "exento"],
    [[], [20], "monotributo"],
    [[11], [], "consumidor_final"],
    [[], [], "consumidor_final"],
  ])("RG %j · MT %j → %s", (rg, mt, cond) => {
    expect(condicionFromImpuestos(rg as number[], mt as number[]).iva_condition).toBe(cond);
  });
});

describe("endpoints, cache y rate limit", () => {
  it("endpoints oficiales y override sólo de ARCA o localhost", () => {
    expect(padronEndpointFor("homologacion")).toBe(PADRON_ENDPOINTS.homologacion);
    expect(padronEndpointFor("produccion", { ARCA_PADRON_URL_PROD: "https://evil.example.com/x" })).toBe(PADRON_ENDPOINTS.produccion);
    expect(padronEndpointFor("homologacion", { ARCA_PADRON_URL_HOMO: "http://localhost:9000/a5" })).toBe("http://localhost:9000/a5");
  });
  it("cache de 30 días", () => {
    const now = new Date("2026-10-14T12:00:00Z");
    expect(isFresh("2026-09-20T12:00:00Z", now)).toBe(true);
    expect(isFresh("2026-09-10T12:00:00Z", now)).toBe(false);
    expect(isFresh(null, now)).toBe(false);
  });
  it("10 por hora por negocio y 300 en total", () => {
    expect(rateLimited({ tenantHour: 9, globalHour: 100 })).toBeNull();
    expect(rateLimited({ tenantHour: 10, globalHour: 100 })).toBe("tenant");
    expect(rateLimited({ tenantHour: 0, globalHour: 300 })).toBe("global");
  });
});
