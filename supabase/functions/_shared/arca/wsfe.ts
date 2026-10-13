// =============================================================================
// WSFEv1 (factura electrónica de mercado interno) · ADR-072. PURO.
//
// Armado y lectura de los mensajes SOAP según el "Manual para el
// desarrollador WSFEv1" de ARCA (RG 4291 y modificatorias, con
// CondicionIVAReceptorId de la RG 5616): FECAESolicitar,
// FECompUltimoAutorizado, FECompConsultar, FEDummy, FEParamGet* y los de
// CAEA (FECAEASolicitar, FECAEAConsultar, FECAEARegInformativo,
// FECAEASinMovimientoInformar). Namespace http://ar.gov.afip.dif.FEV1/ y
// SOAPAction = namespace + operación.
// =============================================================================
import type { AlicIva, Breakdown, Tributo } from "./comprobante.ts";
import { escapeXml, num, raw, rawAll, soapEnvelope, text } from "./xml.ts";

export const WSFE_NS = "http://ar.gov.afip.dif.FEV1/";
export const soapAction = (op: string) => `${WSFE_NS}${op}`;

export interface WsfeAuth {
  token: string;
  sign: string;
  /** CUIT representada (la del negocio que factura). */
  cuit: string;
}

const env = (op: string, inner: string) => soapEnvelope(`<ar:${op}>${inner}</ar:${op}>`, { ar: WSFE_NS });

const authXml = (a: WsfeAuth) =>
  `<ar:Auth><ar:Token>${escapeXml(a.token)}</ar:Token><ar:Sign>${escapeXml(a.sign)}</ar:Sign>` +
  `<ar:Cuit>${escapeXml(a.cuit)}</ar:Cuit></ar:Auth>`;

/** Importe con dos decimales y punto. */
export const amt = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/** El XML que se guarda: sin Token ni Sign (dan acceso por 12 h). */
export function redactXml(xml: string): string {
  return xml
    .replace(/(<(?:\w+:)?Token>)[\s\S]*?(<\/(?:\w+:)?Token>)/g, "$1***$2")
    .replace(/(<(?:\w+:)?Sign>)[\s\S]*?(<\/(?:\w+:)?Sign>)/g, "$1***$2")
    .replace(/(<(?:\w+:)?in0>)[\s\S]*?(<\/(?:\w+:)?in0>)/g, "$1***$2");
}

// ---------------------------------------------------------------------------
// Detalle de un comprobante
// ---------------------------------------------------------------------------
export interface CbteAsoc {
  Tipo: number;
  PtoVta: number;
  Nro: number;
  Cuit?: string | null;
  CbteFch?: string | null;
}

export interface CbteDetalle extends Breakdown {
  Concepto: number;
  DocTipo: number;
  DocNro: string;
  CbteDesde: number;
  CbteHasta: number;
  CbteFch: string; // AAAAMMDD
  FchServDesde?: string | null;
  FchServHasta?: string | null;
  FchVtoPago?: string | null;
  MonId: string;
  MonCotiz: number;
  CondicionIVAReceptorId?: number | null;
  CbtesAsoc?: CbteAsoc[];
  /** Sólo CAEA (FECAEARegInformativo). */
  CAEA?: string;
  CbteFchHsGen?: string;
}

function ivaXml(iva: AlicIva[]): string {
  if (iva.length === 0) return "";
  return (
    `<ar:Iva>` +
    iva
      .map((a) => `<ar:AlicIva><ar:Id>${a.Id}</ar:Id><ar:BaseImp>${amt(a.BaseImp)}</ar:BaseImp><ar:Importe>${amt(a.Importe)}</ar:Importe></ar:AlicIva>`)
      .join("") +
    `</ar:Iva>`
  );
}

function tributosXml(t: Tributo[]): string {
  if (t.length === 0) return "";
  return (
    `<ar:Tributos>` +
    t
      .map(
        (x) =>
          `<ar:Tributo><ar:Id>${x.Id}</ar:Id><ar:Desc>${escapeXml(x.Desc)}</ar:Desc><ar:BaseImp>${amt(x.BaseImp)}</ar:BaseImp>` +
          `<ar:Alic>${amt(x.Alic)}</ar:Alic><ar:Importe>${amt(x.Importe)}</ar:Importe></ar:Tributo>`,
      )
      .join("") +
    `</ar:Tributos>`
  );
}

function asocXml(a: CbteAsoc[] | undefined): string {
  if (!a || a.length === 0) return "";
  return (
    `<ar:CbtesAsoc>` +
    a
      .map(
        (x) =>
          `<ar:CbteAsoc><ar:Tipo>${x.Tipo}</ar:Tipo><ar:PtoVta>${x.PtoVta}</ar:PtoVta><ar:Nro>${x.Nro}</ar:Nro>` +
          (x.Cuit ? `<ar:Cuit>${escapeXml(x.Cuit)}</ar:Cuit>` : "") +
          (x.CbteFch ? `<ar:CbteFch>${escapeXml(x.CbteFch)}</ar:CbteFch>` : "") +
          `</ar:CbteAsoc>`,
      )
      .join("") +
    `</ar:CbtesAsoc>`
  );
}

/** Cuerpo de FECAEDetRequest / FECAEADetRequest en el orden del WSDL. */
export function detalleXml(d: CbteDetalle, tag = "FECAEDetRequest"): string {
  const serv = d.Concepto === 2 || d.Concepto === 3;
  return (
    `<ar:${tag}>` +
    `<ar:Concepto>${d.Concepto}</ar:Concepto>` +
    `<ar:DocTipo>${d.DocTipo}</ar:DocTipo>` +
    `<ar:DocNro>${escapeXml(d.DocNro)}</ar:DocNro>` +
    `<ar:CbteDesde>${d.CbteDesde}</ar:CbteDesde>` +
    `<ar:CbteHasta>${d.CbteHasta}</ar:CbteHasta>` +
    `<ar:CbteFch>${d.CbteFch}</ar:CbteFch>` +
    `<ar:ImpTotal>${amt(d.ImpTotal)}</ar:ImpTotal>` +
    `<ar:ImpTotConc>${amt(d.ImpTotConc)}</ar:ImpTotConc>` +
    `<ar:ImpNeto>${amt(d.ImpNeto)}</ar:ImpNeto>` +
    `<ar:ImpOpEx>${amt(d.ImpOpEx)}</ar:ImpOpEx>` +
    `<ar:ImpTrib>${amt(d.ImpTrib)}</ar:ImpTrib>` +
    `<ar:ImpIVA>${amt(d.ImpIVA)}</ar:ImpIVA>` +
    (serv
      ? `<ar:FchServDesde>${d.FchServDesde ?? d.CbteFch}</ar:FchServDesde>` +
        `<ar:FchServHasta>${d.FchServHasta ?? d.CbteFch}</ar:FchServHasta>` +
        `<ar:FchVtoPago>${d.FchVtoPago ?? d.CbteFch}</ar:FchVtoPago>`
      : "") +
    `<ar:MonId>${escapeXml(d.MonId)}</ar:MonId>` +
    `<ar:MonCotiz>${d.MonCotiz}</ar:MonCotiz>` +
    (d.CondicionIVAReceptorId ? `<ar:CondicionIVAReceptorId>${d.CondicionIVAReceptorId}</ar:CondicionIVAReceptorId>` : "") +
    asocXml(d.CbtesAsoc) +
    tributosXml(d.Tributos) +
    ivaXml(d.Iva) +
    (d.CAEA ? `<ar:CAEA>${escapeXml(d.CAEA)}</ar:CAEA>` : "") +
    (d.CbteFchHsGen ? `<ar:CbteFchHsGen>${escapeXml(d.CbteFchHsGen)}</ar:CbteFchHsGen>` : "") +
    `</ar:${tag}>`
  );
}

export function buildFECAESolicitar(auth: WsfeAuth, ptoVta: number, cbteTipo: number, d: CbteDetalle): string {
  return env(
    "FECAESolicitar",
    authXml(auth) +
      `<ar:FeCAEReq><ar:FeCabReq><ar:CantReg>1</ar:CantReg><ar:PtoVta>${ptoVta}</ar:PtoVta><ar:CbteTipo>${cbteTipo}</ar:CbteTipo></ar:FeCabReq>` +
      `<ar:FeDetReq>${detalleXml(d)}</ar:FeDetReq></ar:FeCAEReq>`,
  );
}

export function buildFECompUltimoAutorizado(auth: WsfeAuth, ptoVta: number, cbteTipo: number): string {
  return env("FECompUltimoAutorizado", authXml(auth) + `<ar:PtoVta>${ptoVta}</ar:PtoVta><ar:CbteTipo>${cbteTipo}</ar:CbteTipo>`);
}

export function buildFECompConsultar(auth: WsfeAuth, ptoVta: number, cbteTipo: number, nro: number): string {
  return env(
    "FECompConsultar",
    authXml(auth) +
      `<ar:FeCompConsReq><ar:CbteTipo>${cbteTipo}</ar:CbteTipo><ar:CbteNro>${nro}</ar:CbteNro><ar:PtoVta>${ptoVta}</ar:PtoVta></ar:FeCompConsReq>`,
  );
}

export function buildFEDummy(): string {
  return env("FEDummy", "");
}

export const PARAM_OPS = {
  tipos_cbte: "FEParamGetTiposCbte",
  tipos_iva: "FEParamGetTiposIva",
  tipos_tributos: "FEParamGetTiposTributos",
  tipos_doc: "FEParamGetTiposDoc",
  tipos_concepto: "FEParamGetTiposConcepto",
  monedas: "FEParamGetTiposMonedas",
  ptos_venta: "FEParamGetPtosVenta",
  condicion_iva_receptor: "FEParamGetCondicionIvaReceptor",
} as const;
export type ParamTable = keyof typeof PARAM_OPS;

export function buildParam(auth: WsfeAuth, table: ParamTable, claseCmp?: string): string {
  const op = PARAM_OPS[table];
  const extra = table === "condicion_iva_receptor" && claseCmp ? `<ar:ClaseCmp>${escapeXml(claseCmp)}</ar:ClaseCmp>` : "";
  return env(op, authXml(auth) + extra);
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------
export interface ArcaMsg {
  code: string;
  msg: string;
}

function msgs(xml: string, container: string, item: string): ArcaMsg[] {
  const c = raw(xml, container);
  if (c == null) return [];
  return rawAll(c, item).map((x) => ({ code: text(x, "Code") ?? "", msg: text(x, "Msg") ?? "" }));
}

export interface CaeResult {
  resultado: "A" | "R" | "P" | null;
  cae: string | null;
  caeVto: string | null; // AAAAMMDD
  cbteDesde: number | null;
  cbteFch: string | null;
  observaciones: ArcaMsg[];
  errors: ArcaMsg[];
  events: ArcaMsg[];
}

export function parseFECAESolicitar(xml: string): CaeResult {
  const det = raw(xml, "FECAEDetResponse") ?? "";
  const cab = raw(xml, "FeCabResp") ?? "";
  const r = (text(det, "Resultado") ?? text(cab, "Resultado") ?? "") as CaeResult["resultado"] | "";
  const cae = text(det, "CAE");
  return {
    resultado: r === "A" || r === "R" || r === "P" ? r : null,
    cae: cae && /^\d{14}$/.test(cae) ? cae : null,
    caeVto: text(det, "CAEFchVto") || null,
    cbteDesde: num(det, "CbteDesde"),
    cbteFch: text(det, "CbteFch") || null,
    observaciones: msgs(det, "Observaciones", "Obs"),
    errors: msgs(xml, "Errors", "Err"),
    events: msgs(xml, "Events", "Evt"),
  };
}

export interface UltimoResult {
  nro: number | null;
  errors: ArcaMsg[];
}

export function parseFECompUltimoAutorizado(xml: string): UltimoResult {
  const r = raw(xml, "FECompUltimoAutorizadoResult") ?? xml;
  return { nro: num(r, "CbteNro"), errors: msgs(r, "Errors", "Err") };
}

export interface ConsultaResult {
  found: boolean;
  resultado: string | null;
  cae: string | null;
  caeVto: string | null;
  cbteFch: string | null;
  impTotal: number | null;
  docTipo: number | null;
  docNro: string | null;
  emisionTipo: string | null;
  errors: ArcaMsg[];
}

export function parseFECompConsultar(xml: string): ConsultaResult {
  const g = raw(xml, "ResultGet");
  const errors = msgs(xml, "Errors", "Err");
  if (!g) {
    return { found: false, resultado: null, cae: null, caeVto: null, cbteFch: null, impTotal: null, docTipo: null, docNro: null, emisionTipo: null, errors };
  }
  return {
    found: true,
    resultado: text(g, "Resultado"),
    cae: text(g, "CodAutorizacion"),
    caeVto: text(g, "FchVto"),
    cbteFch: text(g, "CbteFch"),
    impTotal: num(g, "ImpTotal"),
    docTipo: num(g, "DocTipo"),
    docNro: text(g, "DocNro"),
    emisionTipo: text(g, "EmisionTipo"),
    errors,
  };
}

export interface DummyResult {
  app: string | null;
  db: string | null;
  auth: string | null;
  ok: boolean;
}

export function parseFEDummy(xml: string): DummyResult {
  const app = text(xml, "AppServer");
  const db = text(xml, "DbServer");
  const auth = text(xml, "AuthServer");
  return { app, db, auth, ok: app === "OK" && db === "OK" && auth === "OK" };
}

export interface ParamItem {
  id: string;
  desc: string;
  desde: string | null;
  hasta: string | null;
  extra: Record<string, string | null>;
}

const ITEM_TAG: Record<ParamTable, string> = {
  tipos_cbte: "CbteTipo",
  tipos_iva: "IvaTipo",
  tipos_tributos: "TributoTipo",
  tipos_doc: "DocTipo",
  tipos_concepto: "ConceptoTipo",
  monedas: "Moneda",
  ptos_venta: "PtoVenta",
  condicion_iva_receptor: "CondicionIvaReceptor",
};

export function parseParam(table: ParamTable, xml: string): { items: ParamItem[]; errors: ArcaMsg[] } {
  const g = raw(xml, "ResultGet") ?? "";
  const items = rawAll(g, ITEM_TAG[table]).map((x): ParamItem => {
    if (table === "ptos_venta") {
      return {
        id: text(x, "Nro") ?? "",
        desc: text(x, "EmisionTipo") ?? "",
        desde: null,
        hasta: text(x, "FchBaja"),
        extra: { bloqueado: text(x, "Bloqueado"), fchBaja: text(x, "FchBaja") },
      };
    }
    return {
      id: text(x, "Id") ?? "",
      desc: text(x, "Desc") ?? "",
      desde: text(x, "FchDesde"),
      hasta: text(x, "FchHasta"),
      extra: { cmpClase: text(x, "Cmp_Clase") },
    };
  });
  return { items, errors: msgs(xml, "Errors", "Err") };
}

/** Puntos de venta habilitados (no bloqueados ni dados de baja), por tipo de emisión. */
export function activePointsOfSale(items: ParamItem[]): { nro: number; emisionTipo: string }[] {
  return items
    .filter((p) => (p.extra.bloqueado ?? "N").toUpperCase() !== "S")
    .filter((p) => !p.extra.fchBaja || p.extra.fchBaja.toUpperCase() === "NULL")
    .map((p) => ({ nro: Number(p.id), emisionTipo: p.desc }))
    .filter((p) => Number.isFinite(p.nro) && p.nro > 0);
}

// ---------------------------------------------------------------------------
// CAEA
// ---------------------------------------------------------------------------
export function buildFECAEASolicitar(auth: WsfeAuth, periodo: number, orden: number): string {
  return env("FECAEASolicitar", authXml(auth) + `<ar:Periodo>${periodo}</ar:Periodo><ar:Orden>${orden}</ar:Orden>`);
}

export function buildFECAEAConsultar(auth: WsfeAuth, periodo: number, orden: number): string {
  return env("FECAEAConsultar", authXml(auth) + `<ar:Periodo>${periodo}</ar:Periodo><ar:Orden>${orden}</ar:Orden>`);
}

export interface CaeaGrant {
  caea: string | null;
  periodo: number | null;
  orden: number | null;
  fchVigDesde: string | null;
  fchVigHasta: string | null;
  fchTopeInf: string | null;
  fchProceso: string | null;
  errors: ArcaMsg[];
  observaciones: ArcaMsg[];
}

export function parseCaeaGrant(xml: string): CaeaGrant {
  const g = raw(xml, "ResultGet") ?? "";
  const caea = text(g, "CAEA");
  return {
    caea: caea && /^\d{14}$/.test(caea) ? caea : null,
    periodo: num(g, "Periodo"),
    orden: num(g, "Orden"),
    fchVigDesde: text(g, "FchVigDesde"),
    fchVigHasta: text(g, "FchVigHasta"),
    fchTopeInf: text(g, "FchTopeInf"),
    fchProceso: text(g, "FchProceso"),
    errors: msgs(xml, "Errors", "Err"),
    observaciones: msgs(g, "Observaciones", "Obs"),
  };
}

export function buildFECAEARegInformativo(auth: WsfeAuth, ptoVta: number, cbteTipo: number, d: CbteDetalle): string {
  return env(
    "FECAEARegInformativo",
    authXml(auth) +
      `<ar:FeCAEARegInfReq><ar:FeCabReq><ar:CantReg>1</ar:CantReg><ar:PtoVta>${ptoVta}</ar:PtoVta><ar:CbteTipo>${cbteTipo}</ar:CbteTipo></ar:FeCabReq>` +
      `<ar:FeDetReq>${detalleXml(d, "FECAEADetRequest")}</ar:FeDetReq></ar:FeCAEARegInfReq>`,
  );
}

export interface InformResult {
  resultado: "A" | "R" | "P" | null;
  observaciones: ArcaMsg[];
  errors: ArcaMsg[];
}

export function parseFECAEARegInformativo(xml: string): InformResult {
  const det = raw(xml, "FECAEADetResponse") ?? "";
  const cab = raw(xml, "FeCabResp") ?? "";
  const r = text(det, "Resultado") ?? text(cab, "Resultado") ?? "";
  return {
    resultado: r === "A" || r === "R" || r === "P" ? r : null,
    observaciones: msgs(det, "Observaciones", "Obs"),
    errors: msgs(xml, "Errors", "Err"),
  };
}

export function buildFECAEASinMovimientoInformar(auth: WsfeAuth, ptoVta: number, caea: string): string {
  return env(
    "FECAEASinMovimientoInformar",
    authXml(auth) + `<ar:PtoVta>${ptoVta}</ar:PtoVta><ar:CAEA>${escapeXml(caea)}</ar:CAEA>`,
  );
}

export function parseSinMovimiento(xml: string): { resultado: string | null; errors: ArcaMsg[] } {
  const r = raw(xml, "FECAEASinMovimientoInformarResult") ?? xml;
  return { resultado: text(r, "Resultado"), errors: msgs(r, "Errors", "Err") };
}
