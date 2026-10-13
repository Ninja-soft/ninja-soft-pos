// =============================================================================
// XML mínimo para los SOAP de ARCA (ADR-072). PURO: sin DOMParser (Deno Deploy
// no lo trae) y sin dependencias. Alcanza para las respuestas de WSAA y
// WSFEv1, que son planas y conocidas: se busca por nombre local del elemento
// (con o sin prefijo de namespace).
// =============================================================================

export function escapeXml(v: string | number): string {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function decodeEntities(v: string): string {
  return v
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function reFor(name: string): RegExp {
  // <ns:Name attr="..">contenido</ns:Name>  o  <Name/>
  return new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${name}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[A-Za-z_][\\w.-]*:)?${name}\\s*>)`,
    "g",
  );
}

/** Contenido crudo (sin decodificar) de cada aparición del elemento. */
export function rawAll(xml: string, name: string): string[] {
  const out: string[] = [];
  const re = reFor(name);
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1] ?? "");
  return out;
}

/** Contenido crudo de la primera aparición, o null. */
export function raw(xml: string, name: string): string | null {
  const all = rawAll(xml, name);
  return all.length > 0 ? (all[0] as string) : null;
}

/** Texto (decodificado y sin espacios en los bordes) de la primera aparición. */
export function text(xml: string, name: string): string | null {
  const r = raw(xml, name);
  if (r == null) return null;
  const t = decodeEntities(r.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();
  return t;
}

export function num(xml: string, name: string): number | null {
  const t = text(xml, name);
  if (t == null || t === "" || t.toUpperCase() === "NULL") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Envoltorio SOAP 1.1. */
export function soapEnvelope(body: string, ns: Record<string, string>): string {
  const attrs = Object.entries(ns)
    .map(([k, v]) => ` xmlns:${k}="${escapeXml(v)}"`)
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"${attrs}>` +
    `<soapenv:Header/><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`
  );
}

export interface SoapFault {
  code: string;
  message: string;
}

/** Fault SOAP (WSAA los usa para todos sus errores). */
export function parseFault(xml: string): SoapFault | null {
  const f = raw(xml, "Fault");
  if (f == null) return null;
  const code = (text(f, "faultcode") ?? "").replace(/^[\w.-]+:/, "");
  const message = text(f, "faultstring") ?? "";
  return { code, message };
}
