// Requisitos legales del comprobante (ADR-112). PURO.
//
// Resume lo que exige la normativa vigente (RG 1415 y modificatorias, RG 4291
// factura electrónica, RG 4892 QR, Ley 27.743 y RG 5614 transparencia fiscal,
// RG 5700 identificación del consumidor final) en una lista de "campos
// legales" por tipo de comprobante. Cada modelo marca en el DOM lo que imprime
// con `data-legal="<clave>"` y los tests verifican que TODOS los modelos
// cubren la lista de cada tipo (A, B, C, NC, no fiscal). Orientativo: validar
// textos exactos con el contador del negocio.

import type { InvoiceDoc, InvoiceLetter } from "./types";

/** Monto desde el cual hay que identificar al consumidor final (RG 5700, actualizable). */
export const RECEIVER_ID_THRESHOLD = 10_000_000;

export type LegalField =
  | "letra"
  | "codigo"
  | "tipo"
  | "numero"
  | "fecha"
  | "emisor_razon_social"
  | "emisor_domicilio"
  | "emisor_cuit"
  | "emisor_iibb"
  | "emisor_inicio"
  | "emisor_iva"
  | "receptor"
  | "receptor_iva"
  | "receptor_doc"
  | "receptor_domicilio"
  | "condicion_venta"
  | "detalle"
  | "alicuota"
  | "subtotal"
  | "iva_discriminado"
  | "transparencia"
  | "otros_tributos"
  | "total"
  | "cae"
  | "cae_vto"
  | "qr"
  | "copia"
  | "moneda"
  | "periodo"
  | "asociado"
  | "no_fiscal";

/** El comprobante discrimina IVA (A y M). */
export const discriminatesIva = (letter: InvoiceLetter) => letter === "A" || letter === "M";

/** Leyenda obligatoria del comprobante que no es factura. */
export const NON_FISCAL_LEGEND = "Documento no válido como factura";

/** Ley 27.743: título del bloque de transparencia fiscal. */
export const TRANSPARENCY_TITLE = "Régimen de Transparencia Fiscal al Consumidor (Ley 27.743)";

export const IVA_CONDITION_LABEL: Record<string, string> = {
  responsable_inscripto: "IVA Responsable Inscripto",
  monotributo: "Responsable Monotributo",
  monotributo_social: "Monotributista Social",
  exento: "IVA Sujeto Exento",
  consumidor_final: "Consumidor Final",
  no_categorizado: "Sujeto No Categorizado",
  exterior: "Cliente del Exterior",
};

export function ivaConditionLabel(c: string | null | undefined): string {
  if (!c) return "Consumidor Final";
  return IVA_CONDITION_LABEL[c] ?? c;
}

/** Códigos de documento de ARCA (FEParamGetTiposDoc) a etiqueta. */
export const DOC_TYPE_LABEL: Record<string, string> = {
  "80": "CUIT",
  "86": "CUIL",
  "96": "DNI",
  "94": "Pasaporte",
  "87": "CDI",
  "99": "Sin identificar",
};

export function docTypeLabel(t: string | number | null | undefined): string | null {
  if (t == null || t === "") return null;
  const k = String(t);
  return DOC_TYPE_LABEL[k] ?? k.toUpperCase();
}

/** Moneda no local: se imprime moneda y cotización. */
export const isForeignCurrency = (doc: Pick<InvoiceDoc, "currency">) =>
  Boolean(doc.currency.code) && doc.currency.code.toUpperCase() !== "ARS" && doc.currency.code.toUpperCase() !== "PES";

/** Ley 27.743: B (y C según RG 5614) a consumidor final informan IVA contenido. */
export const showsTransparency = (doc: Pick<InvoiceDoc, "letter" | "fiscal" | "transparency">) =>
  doc.fiscal && (doc.letter === "B" || doc.letter === "C") && doc.transparency != null;

/** Hay que identificar al receptor (A, M, o B/C por encima del umbral). */
export function receiverIdRequired(doc: Pick<InvoiceDoc, "letter" | "fiscal" | "totals">): boolean {
  if (!doc.fiscal) return false;
  if (doc.letter === "A" || doc.letter === "M" || doc.letter === "E") return true;
  return doc.totals.total >= RECEIVER_ID_THRESHOLD;
}

/**
 * Campos que el comprobante DEBE imprimir según su tipo. `format` diferencia
 * la hoja A4 (lleva "Original/Duplicado") del ticket.
 */
export function legalRequirements(doc: InvoiceDoc, format: "a4" | "ticket"): LegalField[] {
  const out: LegalField[] = [
    "tipo",
    "numero",
    "fecha",
    "emisor_razon_social",
    "emisor_domicilio",
    "emisor_cuit",
    "emisor_iva",
    "receptor",
    "detalle",
    "subtotal",
    "total",
    "qr",
  ];
  if (!doc.fiscal) {
    out.push("no_fiscal");
    return out;
  }
  out.push("letra", "codigo", "emisor_iibb", "emisor_inicio", "receptor_iva", "condicion_venta");
  if (discriminatesIva(doc.letter)) out.push("alicuota", "iva_discriminado");
  if (receiverIdRequired(doc)) out.push("receptor_doc");
  if (doc.letter === "A" || doc.letter === "M") out.push("receptor_domicilio");
  if (showsTransparency(doc)) out.push("transparencia");
  if (doc.totals.otherTaxes.length > 0) out.push("otros_tributos");
  if (doc.authorization) out.push("cae", "cae_vto");
  if (format === "a4") out.push("copia");
  if (isForeignCurrency(doc)) out.push("moneda");
  if (doc.concepto === 2 || doc.concepto === 3) out.push("periodo");
  if (doc.cbteClass === "nota_credito" || doc.cbteClass === "nota_debito") out.push("asociado");
  return out;
}

/** Leyendas obligatorias según tipo (además de las propias del negocio). */
export function mandatoryLegends(doc: InvoiceDoc): string[] {
  // La de no fiscal ("Documento no válido como factura") la imprime cada
  // modelo junto al QR (NonFiscalNote), no se repite acá.
  const out: string[] = [];
  if (doc.fiscal && doc.letter === "M") out.push("Operación sujeta a retención.");
  if (doc.fiscal && doc.homologacion) out.push("Comprobante emitido en modo prueba (homologación): sin validez fiscal.");
  if (doc.pendingAuthorization) out.push("Factura pendiente de autorización de ARCA.");
  return out;
}

// ---------------------------------------------------------------------------
// Formatos
// ---------------------------------------------------------------------------

/** dd/mm/aaaa desde ISO (o devuelve el texto tal cual si ya viene formateado). */
export function fmtDate(v: string | null | undefined): string {
  if (!v) return "";
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(v)) return v;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Argentina/Buenos_Aires" });
}

export function fmtTime(v: string | null | undefined): string {
  if (!v || /^\d{4}-\d{2}-\d{2}$/.test(v)) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Argentina/Buenos_Aires" });
}

/** Importe con signo de la moneda del comprobante ("$ 1.234,50", "US$ 10,00"). */
export function fmtMoney(n: number, currency = "ARS"): string {
  const c = currency.toUpperCase();
  const sym = c === "ARS" || c === "PES" ? "$" : c === "USD" || c === "DOL" ? "US$" : c === "EUR" || c === "060" ? "€" : c;
  const v = new Intl.NumberFormat("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    Math.round((Number(n) || 0) * 100) / 100,
  );
  return `${sym} ${v}`;
}

export function fmtQty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, "").replace(".", ",");
}

export function fmtRate(r: number | null | undefined): string {
  if (r == null) return "";
  return `${String(r).replace(".", ",")} %`;
}

/** CUIT con guiones (30-12345678-9) si viene sólo con dígitos. */
export function fmtCuit(c: string | null | undefined): string {
  if (!c) return "";
  const d = c.replace(/\D/g, "");
  return d.length === 11 ? `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}` : c;
}

/** Nombre de la moneda para la línea "Moneda". */
export function currencyName(code: string): string {
  const c = code.toUpperCase();
  if (c === "USD" || c === "DOL") return "Dólar estadounidense (USD)";
  if (c === "EUR" || c === "060") return "Euro (EUR)";
  if (c === "ARS" || c === "PES") return "Peso argentino (ARS)";
  return c;
}
