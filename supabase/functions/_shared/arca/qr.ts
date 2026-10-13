// =============================================================================
// QR fiscal de ARCA (RG 4892) · ADR-072. PURO.
//
// URL: https://www.afip.gob.ar/fe/qr/?p=<base64 del JSON>. Campos (en este
// orden, versión 1): ver, fecha (AAAA-MM-DD), cuit, ptoVta, tipoCmp, nroCmp,
// importe, moneda, ctz, tipoDocRec y nroDocRec (opcionales, si el receptor
// está identificado), tipoCodAut ("E" = CAE, "A" = CAEA) y codAut.
// =============================================================================

export const QR_BASE_URL = "https://www.afip.gob.ar/fe/qr/";

export interface QrInput {
  fecha: string; // AAAA-MM-DD o AAAAMMDD
  cuit: string | number;
  ptoVta: number;
  tipoCmp: number;
  nroCmp: number;
  importe: number;
  moneda?: string;
  ctz?: number;
  tipoDocRec?: number | null;
  nroDocRec?: string | number | null;
  tipoCodAut: "E" | "A";
  codAut: string | number;
}

export interface QrPayload {
  ver: 1;
  fecha: string;
  cuit: number;
  ptoVta: number;
  tipoCmp: number;
  nroCmp: number;
  importe: number;
  moneda: string;
  ctz: number;
  tipoDocRec?: number;
  nroDocRec?: number;
  tipoCodAut: "E" | "A";
  codAut: number;
}

function isoDate(v: string): string {
  if (/^\d{8}$/.test(v)) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  return v.slice(0, 10);
}

export function qrPayload(i: QrInput): QrPayload {
  const p: QrPayload = {
    ver: 1,
    fecha: isoDate(i.fecha),
    cuit: Number(String(i.cuit).replace(/\D/g, "")),
    ptoVta: i.ptoVta,
    tipoCmp: i.tipoCmp,
    nroCmp: i.nroCmp,
    importe: Math.round(i.importe * 100) / 100,
    moneda: i.moneda ?? "PES",
    ctz: i.ctz ?? 1,
    tipoCodAut: i.tipoCodAut,
    codAut: Number(String(i.codAut)),
  };
  const docNro = i.nroDocRec == null ? 0 : Number(String(i.nroDocRec).replace(/\D/g, "") || 0);
  if (i.tipoDocRec && i.tipoDocRec !== 99 && docNro > 0) {
    p.tipoDocRec = i.tipoDocRec;
    p.nroDocRec = docNro;
  }
  // Orden de claves estable (el del ejemplo de la RG).
  const ordered: QrPayload = {
    ver: p.ver,
    fecha: p.fecha,
    cuit: p.cuit,
    ptoVta: p.ptoVta,
    tipoCmp: p.tipoCmp,
    nroCmp: p.nroCmp,
    importe: p.importe,
    moneda: p.moneda,
    ctz: p.ctz,
    ...(p.tipoDocRec ? { tipoDocRec: p.tipoDocRec, nroDocRec: p.nroDocRec } : {}),
    tipoCodAut: p.tipoCodAut,
    codAut: p.codAut,
  };
  return ordered;
}

function b64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function qrUrl(i: QrInput): string {
  return `${QR_BASE_URL}?p=${b64Utf8(JSON.stringify(qrPayload(i)))}`;
}

/** Lee el JSON de una URL de QR (para tests y para mostrarlo). */
export function decodeQrUrl(url: string): QrPayload | null {
  try {
    // El base64 va tal cual (como en la RG): un "+" leído como espacio se repone.
    const p = new URL(url).searchParams.get("p")?.replace(/ /g, "+");
    if (!p) return null;
    const bin = atob(p);
    const bytes = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
    return JSON.parse(new TextDecoder().decode(bytes)) as QrPayload;
  } catch {
    return null;
  }
}
