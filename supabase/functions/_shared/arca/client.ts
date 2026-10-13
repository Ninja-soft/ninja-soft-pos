// =============================================================================
// Cliente SOAP de ARCA (ADR-072). El fetch se inyecta: la Edge usa el real y
// los tests uno falso con fixtures (nunca se llama a ARCA desde los tests).
// Timeouts con AbortController. Una falla de transporte (sin respuesta,
// timeout, HTTP 5xx sin SOAP legible) se informa como transport = true.
// =============================================================================
import type { ArcaEndpoints } from "./config.ts";
import { buildLoginCms, parseLoginCmsResponse, type LoginResult } from "./wsaa.ts";
import {
  buildFECAEARegInformativo,
  buildFECAEAConsultar,
  buildFECAEASinMovimientoInformar,
  buildFECAEASolicitar,
  buildFECAESolicitar,
  buildFECompConsultar,
  buildFECompUltimoAutorizado,
  buildFEDummy,
  buildParam,
  parseCaeaGrant,
  parseFECAEARegInformativo,
  parseFECAESolicitar,
  parseFECompConsultar,
  parseFECompUltimoAutorizado,
  parseFEDummy,
  parseParam,
  parseSinMovimiento,
  redactXml,
  soapAction,
  PARAM_OPS,
  type CbteDetalle,
  type ParamTable,
  type WsfeAuth,
} from "./wsfe.ts";
import { parseFault } from "./xml.ts";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export interface SoapCall<T> {
  /** Sin respuesta utilizable (red, timeout, 5xx sin SOAP). */
  transport: boolean;
  status: number;
  ms: number;
  error: string | null;
  requestXml: string; // sin Token ni Sign
  responseXml: string;
  parsed: T | null;
}

export async function postSoap(
  fetcher: FetchLike,
  url: string,
  body: string,
  action: string,
  timeoutMs: number,
): Promise<{ transport: boolean; status: number; text: string; ms: number; error: string | null }> {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${action}"` },
      body,
      signal: ctrl.signal,
    });
    const text = await r.text();
    const soap = text.includes("Envelope");
    // Un 500 con Fault SOAP es una respuesta (WSAA responde así sus errores).
    const transport = r.status >= 500 ? !(soap && parseFault(text)) : r.status >= 400 && !soap;
    return { transport, status: r.status, text, ms: Date.now() - t0, error: transport ? `http_${r.status}` : null };
  } catch (e) {
    const aborted = (e as { name?: string })?.name === "AbortError";
    return { transport: true, status: 0, text: "", ms: Date.now() - t0, error: aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

export async function loginCms(
  fetcher: FetchLike,
  url: string,
  cms: string,
  timeoutMs = 20_000,
): Promise<{ transport: boolean; error: string | null; result: LoginResult | null; ms: number }> {
  const r = await postSoap(fetcher, url, buildLoginCms(cms), "", timeoutMs);
  if (r.transport) return { transport: true, error: r.error, result: null, ms: r.ms };
  return { transport: false, error: null, result: parseLoginCmsResponse(r.text), ms: r.ms };
}

export interface WsfeClientOpts {
  fetch: FetchLike;
  endpoints: ArcaEndpoints;
  /** Timeout de las consultas previas a emitir (FECompUltimoAutorizado, FEDummy). */
  queryTimeoutMs?: number;
  /** Timeout de FECAESolicitar (más largo: un timeout ahí deja el resultado incierto). */
  emitTimeoutMs?: number;
}

export function createWsfeClient(o: WsfeClientOpts) {
  const qT = o.queryTimeoutMs ?? 15_000;
  const eT = o.emitTimeoutMs ?? 30_000;
  async function call<T>(op: string, xml: string, parse: (x: string) => T, timeout: number): Promise<SoapCall<T>> {
    const r = await postSoap(o.fetch, o.endpoints.wsfe, xml, soapAction(op), timeout);
    let parsed: T | null = null;
    if (!r.transport) {
      try {
        parsed = parse(r.text);
      } catch {
        parsed = null;
      }
    }
    return {
      transport: r.transport,
      status: r.status,
      ms: r.ms,
      error: r.error,
      requestXml: redactXml(xml),
      responseXml: r.text.slice(0, 60_000),
      parsed,
    };
  }
  return {
    dummy: () => call("FEDummy", buildFEDummy(), parseFEDummy, qT),
    ultimo: (a: WsfeAuth, pv: number, tipo: number) =>
      call("FECompUltimoAutorizado", buildFECompUltimoAutorizado(a, pv, tipo), parseFECompUltimoAutorizado, qT),
    consultar: (a: WsfeAuth, pv: number, tipo: number, nro: number) =>
      call("FECompConsultar", buildFECompConsultar(a, pv, tipo, nro), parseFECompConsultar, qT),
    solicitar: (a: WsfeAuth, pv: number, tipo: number, d: CbteDetalle) =>
      call("FECAESolicitar", buildFECAESolicitar(a, pv, tipo, d), parseFECAESolicitar, eT),
    param: (a: WsfeAuth, table: ParamTable, clase?: string) =>
      call(PARAM_OPS[table], buildParam(a, table, clase), (x) => parseParam(table, x), qT),
    caeaSolicitar: (a: WsfeAuth, periodo: number, orden: number) =>
      call("FECAEASolicitar", buildFECAEASolicitar(a, periodo, orden), parseCaeaGrant, qT),
    caeaConsultar: (a: WsfeAuth, periodo: number, orden: number) =>
      call("FECAEAConsultar", buildFECAEAConsultar(a, periodo, orden), parseCaeaGrant, qT),
    caeaInformar: (a: WsfeAuth, pv: number, tipo: number, d: CbteDetalle) =>
      call("FECAEARegInformativo", buildFECAEARegInformativo(a, pv, tipo, d), parseFECAEARegInformativo, eT),
    caeaSinMovimiento: (a: WsfeAuth, pv: number, caea: string) =>
      call("FECAEASinMovimientoInformar", buildFECAEASinMovimientoInformar(a, pv, caea), parseSinMovimiento, qT),
  };
}

export type WsfeClient = ReturnType<typeof createWsfeClient>;
