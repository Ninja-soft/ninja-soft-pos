// =============================================================================
// WSAA (autenticación de ARCA) · ADR-072. PURO salvo la firma (pki.ts).
//
// Flujo: TRA (loginTicketRequest) → CMS firmado con el certificado → SOAP
// loginCms(in0) → loginCmsReturn (XML escapado) con token, sign y
// expirationTime. El ticket (TA) dura 12 h y ARCA NO entrega otro mientras
// el anterior siga vigente (fault coe.alreadyAuthenticated): se cachea y,
// si se perdió, hay que esperar a que venza.
// Referencia: "Especificación técnica WSAA" de ARCA (versión 1.2.x).
// =============================================================================
import { decodeEntities, escapeXml, parseFault, soapEnvelope, text } from "./xml.ts";

export const WSAA_NS = "http://wsaa.view.sua.dvadac.desein.afip.gov";

/** Fecha ISO con offset de Argentina (-03:00), como en los ejemplos de ARCA. */
export function isoAr(d: Date): string {
  const t = new Date(d.getTime() - 3 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}` +
    `T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}-03:00`
  );
}

/**
 * TRA. generationTime 10 minutos antes (tolera relojes desfasados) y
 * expirationTime 10 minutos después; uniqueId en segundos.
 */
export function buildTra(service: string, now: Date = new Date()): string {
  const gen = new Date(now.getTime() - 10 * 60_000);
  const exp = new Date(now.getTime() + 10 * 60_000);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<loginTicketRequest version="1.0">` +
    `<header><uniqueId>${Math.floor(now.getTime() / 1000)}</uniqueId>` +
    `<generationTime>${isoAr(gen)}</generationTime>` +
    `<expirationTime>${isoAr(exp)}</expirationTime></header>` +
    `<service>${escapeXml(service)}</service>` +
    `</loginTicketRequest>`
  );
}

export function buildLoginCms(cmsBase64: string): string {
  return soapEnvelope(`<wsaa:loginCms><wsaa:in0>${cmsBase64}</wsaa:in0></wsaa:loginCms>`, { wsaa: WSAA_NS });
}

export interface AccessTicket {
  token: string;
  sign: string;
  generationTime: string;
  expirationTime: string;
  destination: string | null;
}

export type LoginResult =
  | { ok: true; ticket: AccessTicket }
  | { ok: false; code: string; message: string };

export function parseLoginCmsResponse(xml: string): LoginResult {
  const fault = parseFault(xml);
  if (fault) return { ok: false, code: fault.code || "wsaa_fault", message: fault.message };
  const ret = text(xml, "loginCmsReturn");
  if (!ret) return { ok: false, code: "wsaa_respuesta_invalida", message: "WSAA no devolvió loginCmsReturn" };
  const inner = ret.includes("<") ? ret : decodeEntities(ret);
  const token = text(inner, "token");
  const sign = text(inner, "sign");
  const exp = text(inner, "expirationTime");
  const gen = text(inner, "generationTime");
  if (!token || !sign || !exp) {
    return { ok: false, code: "wsaa_respuesta_invalida", message: "Ticket de acceso incompleto" };
  }
  return {
    ok: true,
    ticket: { token, sign, expirationTime: exp, generationTime: gen ?? "", destination: text(inner, "destination") },
  };
}

/** ¿El ticket cacheado sirve? Con margen (por defecto 10 minutos). */
export function ticketUsable(expiresAt: string | Date | null | undefined, now: Date = new Date(), marginMs = 10 * 60_000): boolean {
  if (!expiresAt) return false;
  const t = new Date(expiresAt).getTime();
  return Number.isFinite(t) && t - marginMs > now.getTime();
}

/** Clasificación de los faults de WSAA. */
export type WsaaErrorKind = "transient" | "action" | "already";

export function classifyWsaaFault(code: string): WsaaErrorKind {
  const c = code.toLowerCase();
  if (c.includes("alreadyauthenticated")) return "already";
  if (c.includes("generationtime") || c.includes("expirationtime") || c.includes("server") || c.includes("unavailable")) {
    return "transient";
  }
  return "action";
}
