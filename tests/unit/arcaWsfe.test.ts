// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  allocate,
  breakdownCloses,
  breakdownFromSale,
  cbteTipoFor,
  conceptoFor,
  inferLetter as inferArca,
  letterOfTipo,
  pickCbteDate,
  scaleBreakdown,
  type TaxLine,
} from "@/supabase/functions/_shared/arca/comprobante";
import { inferLetter } from "@/lib/tax/comprobante";
import {
  activePointsOfSale,
  buildFECAESolicitar,
  buildFECompUltimoAutorizado,
  detalleXml,
  parseCaeaGrant,
  parseFECAEARegInformativo,
  parseFECAESolicitar,
  parseFECompConsultar,
  parseFECompUltimoAutorizado,
  parseFEDummy,
  parseParam,
  parseSinMovimiento,
  redactXml,
  type CbteDetalle,
} from "@/supabase/functions/_shared/arca/wsfe";
import { classifyWsfeErrors, HUMAN_ERRORS, humanError, nextAttemptAt } from "@/supabase/functions/_shared/arca/errors";
import { allowedEndpoint, endpointsFor } from "@/supabase/functions/_shared/arca/config";
import * as F from "../fixtures/arcaSoap";

const AUTH = { token: "TOKEN-SECRETO", sign: "SIGN-SECRETO", cuit: "30500000003" };

describe("tipo de comprobante", () => {
  it("letra × clase → código de ARCA (espejo de arca_cbte_tipo)", () => {
    expect(cbteTipoFor("A", "factura")).toBe(1);
    expect(cbteTipoFor("A", "nc")).toBe(3);
    expect(cbteTipoFor("B", "factura")).toBe(6);
    expect(cbteTipoFor("B", "nc")).toBe(8);
    expect(cbteTipoFor("C", "factura")).toBe(11);
    expect(cbteTipoFor("C", "nc")).toBe(13);
    expect(cbteTipoFor("M", "factura")).toBe(51);
    expect(cbteTipoFor("E", "factura")).toBe(19);
    expect(cbteTipoFor(null, "factura")).toBeNull();
    expect(letterOfTipo(8)).toBe("B");
    expect(letterOfTipo(13)).toBe("C");
  });

  it("condición del emisor × receptor: misma letra que el motor de impuestos", () => {
    const emitters = [null, "responsable_inscripto", "monotributo", "monotributo_social", "exento", "no_alcanzado"];
    const receptors = [null, "consumidor_final", "responsable_inscripto", "monotributo", "exento", "exterior", "no_categorizado"];
    for (const e of emitters) for (const r of receptors) for (const m of [false, true]) {
      expect(inferArca(e, r, m), `${e}/${r}/${m}`).toBe(inferLetter(e, r, { issuesM: m }));
    }
    expect(inferArca("responsable_inscripto", "responsable_inscripto")).toBe("A");
    expect(inferArca("responsable_inscripto", "consumidor_final")).toBe("B");
    expect(inferArca("monotributo", "responsable_inscripto")).toBe("C");
  });

  it("concepto según productos y servicios", () => {
    expect(conceptoFor(true, false)).toBe(1);
    expect(conceptoFor(false, true)).toBe(2);
    expect(conceptoFor(true, true)).toBe(3);
  });

  it("fecha: la de la venta dentro de la ventana, nunca antes del último autorizado", () => {
    expect(pickCbteDate("20261012", "20261013", null, 1)).toBe("20261012");
    expect(pickCbteDate("20261001", "20261013", null, 1)).toBe("20261008");
    expect(pickCbteDate("20261001", "20261013", null, 2)).toBe("20261003");
    expect(pickCbteDate("20261010", "20261013", "20261012", 1)).toBe("20261012");
    expect(pickCbteDate("20261020", "20261013", null, 1)).toBe("20261013");
  });
});

describe("importes", () => {
  const lines: TaxLine[] = [
    { kind: "iva", tax: "iva", rate_code: "21", rate: 21, base: 100, amount: 21, arca_id: 5 },
    { kind: "iva", tax: "iva", rate_code: "10.5", rate: 10.5, base: 200, amount: 21, arca_id: 4 },
    { kind: "iva", tax: "iva", rate_code: "exento", rate: 0, base: 50, amount: 0, arca_id: 2 },
    { kind: "iva", tax: "iva", rate_code: "no_gravado", rate: 0, base: 10, amount: 0, arca_id: 1 },
    { kind: "internos", tax: "internos", rate_code: null, rate: null, base: 0, amount: 8, arca_id: 4, name: "Impuestos internos" },
    { kind: "perception", tax: "iibb", rate_code: null, rate: 1.5, base: 300, amount: 4.5, arca_id: 7, jurisdiction: "902", name: "IIBB ARBA" },
  ];
  const total = 100 + 21 + 200 + 21 + 50 + 10 + 8 + 4.5;

  it("factura A/B: neto, IVA por alícuota, exento, no gravado y tributos", () => {
    const b = breakdownFromSale("B", { total }, lines);
    expect(b).toMatchObject({ ImpTotal: 414.5, ImpNeto: 300, ImpIVA: 42, ImpOpEx: 50, ImpTotConc: 10, ImpTrib: 12.5 });
    expect(b.Iva).toEqual([
      { Id: 4, BaseImp: 200, Importe: 21 },
      { Id: 5, BaseImp: 100, Importe: 21 },
    ]);
    expect(b.Tributos.map((t) => t.Id)).toEqual([4, 7]);
    expect(breakdownCloses(b)).toBe(true);
  });

  it("factura C: todo neto, sin IVA", () => {
    const b = breakdownFromSale("C", { total: 1000 }, []);
    expect(b).toMatchObject({ ImpTotal: 1000, ImpNeto: 1000, ImpIVA: 0, Iva: [] });
    expect(breakdownCloses(b)).toBe(true);
  });

  it("venta sin desglose (anterior al motor): 21 % para A/B", () => {
    const b = breakdownFromSale("B", { total: 121 }, []);
    expect(b).toMatchObject({ ImpNeto: 100, ImpIVA: 21, Iva: [{ Id: 5, BaseImp: 100, Importe: 21 }] });
  });

  it("nota de crédito parcial: proporcional y siempre cierra", () => {
    const full = breakdownFromSale("B", { total }, lines);
    for (const t of [0.01, 1, 33.33, 100, 207.25, 414.49, 414.5]) {
      const nc = scaleBreakdown(full, t);
      expect(nc.ImpTotal, String(t)).toBe(t);
      expect(breakdownCloses(nc), String(t)).toBe(true);
    }
    const half = scaleBreakdown(full, 207.25);
    expect(half.ImpNeto).toBeCloseTo(150, 0);
  });

  it("reparto por resto mayor", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(0, [1, 2])).toEqual([0, 0]);
  });
});

describe("armado SOAP", () => {
  const det: CbteDetalle = {
    ...breakdownFromSale("B", { total: 121 }, [{ kind: "iva", tax: "iva", rate_code: "21", rate: 21, base: 100, amount: 21, arca_id: 5 }]),
    Concepto: 1,
    DocTipo: 99,
    DocNro: "0",
    CbteDesde: 12,
    CbteHasta: 12,
    CbteFch: "20261013",
    MonId: "PES",
    MonCotiz: 1,
    CondicionIVAReceptorId: 5,
  };

  it("FECAESolicitar en el orden del WSDL, con IVA y condición del receptor", () => {
    const xml = buildFECAESolicitar(AUTH, 3, 6, det);
    expect(xml).toContain("<ar:FeCabReq><ar:CantReg>1</ar:CantReg><ar:PtoVta>3</ar:PtoVta><ar:CbteTipo>6</ar:CbteTipo></ar:FeCabReq>");
    const order = ["Concepto", "DocTipo", "DocNro", "CbteDesde", "CbteHasta", "CbteFch", "ImpTotal", "ImpTotConc", "ImpNeto", "ImpOpEx", "ImpTrib", "ImpIVA", "MonId", "MonCotiz", "CondicionIVAReceptorId", "Iva"];
    const pos = order.map((t) => xml.indexOf(`<ar:${t}>`));
    expect(pos.every((p) => p > 0)).toBe(true);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
    expect(xml).toContain("<ar:ImpTotal>121.00</ar:ImpTotal>");
    expect(xml).toContain("<ar:AlicIva><ar:Id>5</ar:Id><ar:BaseImp>100.00</ar:BaseImp><ar:Importe>21.00</ar:Importe></ar:AlicIva>");
    expect(xml).not.toContain("FchServDesde");
  });

  it("servicios llevan fechas de servicio y vencimiento; NC lleva el comprobante asociado", () => {
    const xml = detalleXml({ ...det, Concepto: 2, CbtesAsoc: [{ Tipo: 6, PtoVta: 3, Nro: 11, Cuit: "30500000003", CbteFch: "20261012" }] });
    expect(xml).toContain("<ar:FchServDesde>20261013</ar:FchServDesde>");
    expect(xml).toContain("<ar:CbteAsoc><ar:Tipo>6</ar:Tipo><ar:PtoVta>3</ar:PtoVta><ar:Nro>11</ar:Nro><ar:Cuit>30500000003</ar:Cuit><ar:CbteFch>20261012</ar:CbteFch></ar:CbteAsoc>");
    expect(xml.indexOf("CbtesAsoc")).toBeLessThan(xml.indexOf("<ar:Iva>"));
  });

  it("el XML guardado no lleva Token ni Sign", () => {
    const xml = redactXml(buildFECompUltimoAutorizado(AUTH, 3, 6));
    expect(xml).not.toContain("TOKEN-SECRETO");
    expect(xml).not.toContain("SIGN-SECRETO");
    expect(xml).toContain("<ar:Token>***</ar:Token>");
    expect(xml).toContain("<ar:Cuit>30500000003</ar:Cuit>");
  });
});

describe("lectura de respuestas (fixtures)", () => {
  it("éxito: CAE y vencimiento", () => {
    const r = parseFECAESolicitar(F.CAE_APROBADO(12));
    expect(r).toMatchObject({ resultado: "A", cae: "76412345678901", caeVto: "20261023", cbteDesde: 12, errors: [] });
  });

  it("rechazo con observaciones", () => {
    const r = parseFECAESolicitar(F.CAE_RECHAZADO_OBS(4));
    expect(r.resultado).toBe("R");
    expect(r.cae).toBeNull();
    expect(r.observaciones.map((o) => o.code)).toEqual(["10013", "10242"]);
    expect(classifyWsfeErrors(r.errors)).toBeNull();
  });

  it("error transitorio y numeración desfasada", () => {
    const t = parseFECAESolicitar(F.CAE_TRANSITORIO);
    expect(classifyWsfeErrors(t.errors)).toBe("transient");
    const n = parseFECAESolicitar(F.CAE_NUMERACION);
    expect(n.errors[0]?.code).toBe("10016");
    expect(classifyWsfeErrors(n.errors)).toBe("numbering");
    expect(classifyWsfeErrors([{ code: "600", msg: "ValidacionDeToken" }])).toBe("action");
    expect(classifyWsfeErrors([{ code: "10015", msg: "x" }])).toBe("rejected");
  });

  it("último autorizado, consulta, dummy y parámetros", () => {
    expect(parseFECompUltimoAutorizado(F.ULTIMO(11))).toEqual({ nro: 11, errors: [] });
    expect(parseFECompUltimoAutorizado(F.ULTIMO_ERR("600", "No aparecio CUIT en lista de relaciones")).errors[0]?.code).toBe("600");
    const c = parseFECompConsultar(F.CONSULTA(12, "76412345678901", "121"));
    expect(c).toMatchObject({ found: true, resultado: "A", cae: "76412345678901", impTotal: 121, emisionTipo: "CAE" });
    expect(parseFEDummy(F.FEDUMMY_OK).ok).toBe(true);
    const pv = parseParam("ptos_venta", F.PTOS_VENTA);
    expect(activePointsOfSale(pv.items)).toEqual([
      { nro: 3, emisionTipo: "CAE - RECE" },
      { nro: 90, emisionTipo: "CAEA - RECE" },
    ]);
    expect(parseParam("ptos_venta", F.PTOS_VENTA_VACIO).errors[0]?.code).toBe("602");
    expect(parseParam("tipos_iva", F.TIPOS_IVA).items.map((i) => i.id)).toEqual(["3", "4", "5"]);
  });

  it("CAEA: otorgado, ya pedido, informado, rechazado y sin movimiento", () => {
    expect(parseCaeaGrant(F.CAEA_OTORGADO())).toMatchObject({ caea: "31423456789012", periodo: 202610, orden: 2, fchTopeInf: "20261108" });
    const ya = parseCaeaGrant(F.CAEA_YA_SOLICITADO);
    expect(ya.caea).toBeNull();
    expect(ya.errors[0]?.code).toBe("15008");
    expect(parseFECAEARegInformativo(F.CAEA_INFORMADO(1)).resultado).toBe("A");
    const rej = parseFECAEARegInformativo(F.CAEA_INFORME_RECHAZADO(1));
    expect(rej.resultado).toBe("R");
    expect(rej.observaciones[0]?.code).toBe("1504");
    expect(parseSinMovimiento(F.CAEA_SIN_MOV_OK).resultado).toBe("A");
  });
});

describe("errores, backoff y endpoints", () => {
  it("backoff exponencial con techo", () => {
    const t = new Date("2026-10-13T10:00:00Z");
    const m = (n: number) => (nextAttemptAt(n, t).getTime() - t.getTime()) / 60_000;
    expect([1, 2, 3, 4, 5, 6, 7, 10].map(m)).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
  });

  it("mensajes humanos para los errores comunes", () => {
    for (const c of ["coe.alreadyAuthenticated", "cms.cert.expired", "coe.notAuthorized", "600", "601", "602", "ta_ya_emitido"]) {
      expect(humanError(c).title.length, c).toBeGreaterThan(5);
    }
    expect(humanError("raro", "Mensaje de ARCA").title).toBe("Mensaje de ARCA");
    for (const v of Object.values(HUMAN_ERRORS)) expect(v.title).not.toMatch(/—/);
  });

  it("endpoints oficiales y overrides sólo de ARCA o localhost", () => {
    expect(endpointsFor("homologacion").wsfe).toBe("https://wswhomo.afip.gov.ar/wsfev1/service.asmx");
    expect(endpointsFor("produccion").wsaa).toBe("https://wsaa.afip.gov.ar/ws/services/LoginCms");
    expect(endpointsFor("homologacion", { ARCA_WSFE_URL_HOMO: "https://evil.example.com/x" }).wsfe).toContain("wswhomo.afip.gov.ar");
    expect(endpointsFor("homologacion", { ARCA_WSFE_URL_HOMO: "http://localhost:9999/wsfe" }).wsfe).toBe("http://localhost:9999/wsfe");
    expect(allowedEndpoint("https://servicios1.afip.gov.ar/wsfev1/service.asmx")).toBe(true);
  });
});
