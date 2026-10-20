// lib/purchases/arcaImport.ts
//
// Import de "Mis Comprobantes Recibidos" de ARCA (F24 · H167, ADR-178). PURO:
// lee la grilla del XLSX (readXlsxGrid) o del CSV que baja el comercio del
// portal, ubica la fila de encabezados (la primera fila del archivo es un
// título con la CUIT del receptor), mapea las columnas por nombre (tolerante a
// acentos, puntos y mayúsculas) y arma los comprobantes que recibe
// purchase_arca_import.
//
// Columnas (ver ADR-178, "verificado vs inferido"):
//   • Diseño clásico: Fecha, Tipo, Punto de Venta, Número Desde, Número Hasta,
//     Cód. Autorización, Tipo Doc. Emisor, Nro. Doc. Emisor, Denominación
//     Emisor, Tipo Cambio, Moneda, Imp. Neto Gravado, Imp. Neto No Gravado,
//     Imp. Op. Exentas, Otros Tributos (o IVA y Otros Tributos), IVA, Imp. Total.
//   • Diseño nuevo: además, neto e IVA por alícuota ("Neto Gravado IVA 21%",
//     "IVA 21%", ...) y "Total Neto Gravado" / "Total IVA". Los nombres exactos
//     por alícuota se infieren: se reconocen por patrón, no por texto fijo.
//   • Una columna de CUIT del receptor (si existe) o la CUIT del título se
//     compara con la del negocio.

import { normalizeHeader, toIsoDay, toNumber } from "@/lib/utils/xlsxImport";
import { isValidCuit } from "@/modules/customers/schemas";
import { round } from "./costs";
import type { InvoiceKind, InvoiceLetter, OtherTaxLine, VatLine } from "./invoices";
import { vatFor } from "./invoices";

/** Código de comprobante de ARCA → clase y letra (espejo de purchase_arca_cbte). */
export const ARCA_CBTE: Record<number, { kind: InvoiceKind; letter: InvoiceLetter }> = {
  1: { kind: "invoice", letter: "A" },
  2: { kind: "debit_note", letter: "A" },
  3: { kind: "credit_note", letter: "A" },
  6: { kind: "invoice", letter: "B" },
  7: { kind: "debit_note", letter: "B" },
  8: { kind: "credit_note", letter: "B" },
  11: { kind: "invoice", letter: "C" },
  12: { kind: "debit_note", letter: "C" },
  13: { kind: "credit_note", letter: "C" },
  19: { kind: "invoice", letter: "E" },
  20: { kind: "debit_note", letter: "E" },
  21: { kind: "credit_note", letter: "E" },
  51: { kind: "invoice", letter: "M" },
  52: { kind: "debit_note", letter: "M" },
  53: { kind: "credit_note", letter: "M" },
  201: { kind: "invoice", letter: "A" },
  202: { kind: "debit_note", letter: "A" },
  203: { kind: "credit_note", letter: "A" },
  206: { kind: "invoice", letter: "B" },
  207: { kind: "debit_note", letter: "B" },
  208: { kind: "credit_note", letter: "B" },
  211: { kind: "invoice", letter: "C" },
  212: { kind: "debit_note", letter: "C" },
  213: { kind: "credit_note", letter: "C" },
};

type Field =
  | "date"
  | "type"
  | "pos"
  | "from"
  | "to"
  | "cae"
  | "issuerDocType"
  | "issuerDoc"
  | "issuerName"
  | "receptorDoc"
  | "fx"
  | "currency"
  | "netTaxed"
  | "netUntaxed"
  | "exempt"
  | "otherTaxes"
  | "vat"
  | "total";

/** Encabezados aceptados por campo, ya normalizados (normalizeHeader). */
const HEADERS: Record<Field, string[]> = {
  date: ["fecha", "fecha de emision", "fecha emision", "fecha del comprobante"],
  type: ["tipo", "tipo de comprobante", "tipo comprobante", "tipo cbte"],
  pos: ["punto de venta", "pto vta", "punto vta", "pto de venta"],
  from: ["numero desde", "nro desde", "numero", "nro comprobante", "numero de comprobante"],
  to: ["numero hasta", "nro hasta"],
  cae: ["cod autorizacion", "codigo de autorizacion", "cod de autorizacion", "cae", "cae cai"],
  issuerDocType: ["tipo doc emisor", "tipo doc vendedor", "tipo documento emisor"],
  issuerDoc: ["nro doc emisor", "nro doc vendedor", "numero doc emisor", "cuit emisor", "nro documento emisor"],
  issuerName: ["denominacion emisor", "denominacion vendedor", "razon social emisor", "denominacion"],
  receptorDoc: ["nro doc receptor", "cuit receptor", "numero doc receptor"],
  fx: ["tipo cambio", "tipo de cambio", "tc"],
  currency: ["moneda"],
  netTaxed: ["imp neto gravado", "neto gravado", "total neto gravado", "imp neto gravado total", "importe neto gravado"],
  netUntaxed: ["imp neto no gravado", "neto no gravado", "importe neto no gravado"],
  exempt: ["imp op exentas", "op exentas", "importe op exentas", "exento", "imp exento"],
  otherTaxes: ["otros tributos", "imp otros tributos", "importe otros tributos"],
  vat: ["iva", "total iva", "imp iva", "importe iva"],
  total: ["imp total", "importe total", "total"],
};

export interface ArcaColumns {
  /** Índice de columna por campo. */
  fields: Partial<Record<Field, number>>;
  /** Columnas de neto e IVA por alícuota (diseño nuevo). */
  rates: Array<{ rate: number; net?: number; vat?: number }>;
}

const RATES = [0, 2.5, 5, 10.5, 21, 27];

function rateFrom(intPart: string, dec: string | undefined): number | null {
  const r = Number(dec ? `${intPart}.${dec}` : intPart);
  return RATES.includes(r) ? r : null;
}

/** Reconoce "Neto Gravado IVA 21%" / "IVA 10,5%" (normalizados). */
export function rateHeader(h: string): { rate: number; part: "net" | "vat" } | null {
  const m = /(?:^|\s)(?:iva\s+)?(\d{1,2})(?:[ ,](\d))?\s*%?$/.exec(h);
  if (!m) return null;
  const rate = rateFrom(m[1]!, m[2]);
  if (rate == null) return null;
  if (/\bneto\b|\bgrav/.test(h)) return { rate, part: "net" };
  if (/^(?:imp\s+|importe\s+)?iva\b/.test(h)) return { rate, part: "vat" };
  return null;
}

/** Mapea una fila de encabezados. null si no parece el archivo de ARCA. */
export function mapArcaHeaders(row: string[]): ArcaColumns | null {
  const fields: Partial<Record<Field, number>> = {};
  const byRate = new Map<number, { rate: number; net?: number; vat?: number }>();
  row.forEach((raw, idx) => {
    const h = normalizeHeader(String(raw ?? ""));
    if (!h) return;
    const r = rateHeader(h);
    if (r) {
      const cur = byRate.get(r.rate) ?? { rate: r.rate };
      cur[r.part] = idx;
      byRate.set(r.rate, cur);
      return;
    }
    for (const f of Object.keys(HEADERS) as Field[]) {
      if (fields[f] === undefined && HEADERS[f].includes(h)) {
        fields[f] = idx;
        return;
      }
    }
  });
  const required: Field[] = ["date", "type", "pos", "from", "issuerDoc", "total"];
  if (required.some((f) => fields[f] === undefined)) return null;
  return { fields, rates: [...byRate.values()].sort((a, b) => a.rate - b.rate) };
}

/** CUIT del título ("Mis Comprobantes Recibidos - CUIT 30-71234567-8"). */
export function cuitFromTitle(cells: string[]): string | null {
  for (const c of cells) {
    const m = /cuit\D{0,6}(\d{2}-?\d{8}-?\d)/i.exec(String(c ?? ""));
    if (m) {
      const d = m[1]!.replace(/\D/g, "");
      if (isValidCuit(d)) return d;
    }
  }
  return null;
}

const KIND_WORDS: Array<[RegExp, InvoiceKind]> = [
  [/nota de credito|^nc\b/, "credit_note"],
  [/nota de debito|^nd\b/, "debit_note"],
  [/factura/, "invoice"],
];

/** "1 - Factura A", "Factura A", "011" → código de ARCA. */
export function parseCbteType(raw: string): number | null {
  const t = normalizeHeader(String(raw ?? ""));
  const lead = /^(\d{1,3})\b/.exec(t);
  if (lead) return Number(lead[1]);
  const letter = /\b([abcem])$/.exec(t)?.[1]?.toUpperCase() as InvoiceLetter | undefined;
  const kind = KIND_WORDS.find(([re]) => re.test(t))?.[1];
  if (!letter || !kind) return null;
  const fce = /credito electronica|fce|mipyme/.test(t);
  for (const [code, v] of Object.entries(ARCA_CBTE)) {
    const n = Number(code);
    if (v.kind === kind && v.letter === letter && (fce ? n >= 200 : n < 200)) return n;
  }
  return null;
}

/** "$", "PES" → ARS; "DOL" → USD; "060" → EUR. */
export function parseCurrency(raw: string): string | null {
  const t = String(raw ?? "").trim().toUpperCase();
  if (!t || t === "$" || t === "PES" || t === "ARS" || t === "PESOS") return "ARS";
  if (t === "DOL" || t === "USD" || t === "U$S" || t === "US$" || t === "DOLAR") return "USD";
  if (t === "060" || t === "EUR" || t === "EURO") return "EUR";
  if (t === "012" || t === "BRL") return "BRL";
  if (t === "011" || t === "UYU") return "UYU";
  return /^[A-Z]{3}$/.test(t) ? t : null;
}

export interface ArcaRow {
  rowNumber: number;
  issue_date: string | null;
  cbte_type: number | null;
  kind: InvoiceKind | null;
  letter: InvoiceLetter | null;
  point_of_sale: number | null;
  number: number | null;
  number_to: number | null;
  cae: string | null;
  issuer_cuit: string | null;
  issuer_name: string | null;
  receptor_cuit: string | null;
  currency: string;
  fx_rate: number;
  net_taxed: number;
  net_untaxed: number;
  exempt: number;
  other_taxes: number;
  vat: number;
  total: number;
  /** Del diseño nuevo (por alícuota); null si el archivo no las trae. */
  rate_lines: VatLine[] | null;
  errors: string[];
  warnings: string[];
}

export interface ArcaParseResult {
  rows: ArcaRow[];
  /** CUIT del receptor del título del archivo (si la trae). */
  receptorCuit: string | null;
  layout: "clasico" | "por_alicuota";
  fatalError: string | null;
}

const abs = (n: number | null | undefined) => round(Math.abs(Number(n) || 0), 2);

/** Grilla (fila 0 = primera fila del archivo) → comprobantes. */
export function parseArcaGrid(grid: string[][]): ArcaParseResult {
  let headerIdx = -1;
  let cols: ArcaColumns | null = null;
  for (let i = 0; i < Math.min(grid.length, 15); i++) {
    cols = mapArcaHeaders(grid[i] ?? []);
    if (cols) {
      headerIdx = i;
      break;
    }
  }
  if (!cols || headerIdx < 0) {
    return {
      rows: [],
      receptorCuit: null,
      layout: "clasico",
      fatalError:
        "No encontramos las columnas de Mis Comprobantes (Fecha, Tipo, Punto de Venta, Número, Nro. Doc. Emisor, Imp. Total). Subí el archivo tal como lo baja ARCA.",
    };
  }
  let receptorCuit: string | null = null;
  for (let i = 0; i < headerIdx && !receptorCuit; i++) receptorCuit = cuitFromTitle(grid[i] ?? []);

  const f = cols.fields;
  const cell = (r: string[], k: Field) => (f[k] === undefined ? "" : String(r[f[k]!] ?? "").trim());
  const num = (r: string[], k: Field) => toNumber(cell(r, k)) ?? 0;
  const rows: ArcaRow[] = [];

  for (let i = headerIdx + 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    if (r.every((c) => !String(c ?? "").trim())) continue;
    // Filas de totales al pie: sin tipo ni número.
    if (!cell(r, "type") && !cell(r, "from")) continue;
    const errors: string[] = [];
    const warnings: string[] = [];
    const code = parseCbteType(cell(r, "type"));
    const map = code != null ? ARCA_CBTE[code] : undefined;
    if (code == null) errors.push("No reconocemos el tipo de comprobante.");
    else if (!map) errors.push(`El tipo ${code} no es una factura, nota de débito o nota de crédito.`);
    const date = toIsoDay(cell(r, "date"));
    if (!date) errors.push("Fecha inválida.");
    const pos = toNumber(cell(r, "pos"));
    const from = toNumber(cell(r, "from"));
    const to = f.to !== undefined ? toNumber(cell(r, "to")) : from;
    if (!(pos && pos >= 1 && pos <= 99999 && Number.isInteger(pos))) errors.push("Punto de venta inválido.");
    if (!(from && from >= 1 && from <= 99_999_999 && Number.isInteger(from))) errors.push("Número inválido.");
    else if (to && to !== from) errors.push("Es un rango de comprobantes (Número Desde y Hasta distintos): cargalo a mano.");
    const docType = cell(r, "issuerDocType");
    const doc = cell(r, "issuerDoc").replace(/\D/g, "");
    if (docType && !/^80$|cuit/i.test(docType) && doc.length !== 11) errors.push("El emisor no tiene CUIT.");
    else if (!isValidCuit(doc)) errors.push("La CUIT del emisor no es válida.");
    const currency = parseCurrency(cell(r, "currency"));
    if (!currency) errors.push("Moneda desconocida.");
    const fxRaw = toNumber(cell(r, "fx"));
    const fx = currency === "ARS" ? 1 : fxRaw && fxRaw > 0 ? fxRaw : 0;
    if (currency && currency !== "ARS" && !(fx > 0)) errors.push("Falta el tipo de cambio.");
    const caeDigits = cell(r, "cae").replace(/\D/g, "");
    const receptor = cell(r, "receptorDoc").replace(/\D/g, "");

    let rateLines: VatLine[] | null = null;
    if (cols.rates.length > 0) {
      rateLines = cols.rates
        .map((c) => ({
          rate: c.rate,
          net: abs(c.net !== undefined ? toNumber(String(r[c.net] ?? "")) : 0),
          vat: abs(c.vat !== undefined ? toNumber(String(r[c.vat] ?? "")) : 0),
        }))
        .filter((l) => l.net > 0 || l.vat > 0);
    }

    rows.push({
      rowNumber: i + 1,
      issue_date: date,
      cbte_type: code,
      kind: map?.kind ?? null,
      letter: map?.letter ?? null,
      point_of_sale: pos,
      number: from,
      number_to: to,
      cae: caeDigits.length === 14 ? caeDigits : null,
      issuer_cuit: doc || null,
      issuer_name: cell(r, "issuerName") || null,
      receptor_cuit: receptor.length === 11 ? receptor : null,
      currency: currency ?? "ARS",
      fx_rate: fx,
      net_taxed: abs(num(r, "netTaxed")),
      net_untaxed: abs(num(r, "netUntaxed")),
      exempt: abs(num(r, "exempt")),
      other_taxes: abs(num(r, "otherTaxes")),
      vat: abs(num(r, "vat")),
      total: abs(num(r, "total")),
      rate_lines: rateLines,
      errors,
      warnings,
    });
  }
  if (rows.length === 0) {
    return { rows, receptorCuit, layout: "clasico", fatalError: "El archivo no tiene comprobantes." };
  }
  return { rows, receptorCuit, layout: cols.rates.length > 0 ? "por_alicuota" : "clasico", fatalError: null };
}

/** CSV de ARCA (separador ; o ,; comillas dobles). */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, "");
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? "";
  const sep = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const out: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]!;
    if (q) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) {
      row.push(cur);
      cur = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && clean[i + 1] === "\n") i++;
      row.push(cur);
      out.push(row);
      row = [];
      cur = "";
    } else cur += ch;
  }
  if (cur !== "" || row.length > 0) {
    row.push(cur);
    out.push(row);
  }
  return out.map((r) => r.map((c) => c.trim()));
}

export interface ArcaInvoiceAmounts {
  vat_lines: VatLine[];
  exempt_amount: number;
  non_taxed_amount: number;
  other_taxes: OtherTaxLine[];
  total: number;
}

const DISCRIMINATES = new Set<InvoiceLetter>(["A", "M"]);

/** Alícuota que explica el IVA de un neto (o null). */
export function inferRate(net: number, vat: number): number | null {
  if (!(net > 0)) return null;
  for (const r of [21, 10.5, 27, 5, 2.5]) {
    if (Math.abs(vatFor(net, r) - vat) <= Math.max(0.05, net * 0.0005)) return r;
  }
  return null;
}

/**
 * Importes del comprobante para supplier_invoice_save. A y M discriminan IVA
 * (por alícuota si el archivo lo trae, si no la alícuota que explica el IVA);
 * B, C y E van con el importe entero como neto. Lo que no suma (percepciones
 * que el portal no detalla) va como "otros tributos sin detalle" con aviso.
 */
export function arcaAmounts(row: ArcaRow): { amounts: ArcaInvoiceAmounts | null; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!row.letter) return { amounts: null, errors, warnings };
  const exempt = row.exempt;
  const untaxed = row.net_untaxed;
  const other = row.other_taxes;
  const total = row.total;
  if (!(total > 0)) return { amounts: null, errors: ["El total es cero."], warnings };
  let vatLines: VatLine[] = [];

  if (DISCRIMINATES.has(row.letter)) {
    if (row.rate_lines && row.rate_lines.length > 0) {
      vatLines = row.rate_lines.map((l) => ({ ...l }));
    } else if (row.vat > 0) {
      const rate = inferRate(row.net_taxed, row.vat);
      if (rate == null) {
        // Varias alícuotas sin desglose: no se puede saber cuánto va a cada una.
        errors.push("El IVA no corresponde a una sola alícuota y el archivo no trae el desglose: cargalo a mano.");
      } else {
        vatLines = [{ rate, net: row.net_taxed, vat: row.vat }];
      }
    } else if (row.net_taxed > 0) {
      vatLines = [{ rate: 0, net: row.net_taxed, vat: 0 }];
    }
  } else {
    const plain = round(total - exempt - untaxed - other, 2);
    if (plain < -0.01) errors.push("Los importes no suman el total.");
    else if (plain > 0) vatLines = [{ rate: 0, net: plain, vat: 0 }];
  }

  const otherTaxes: OtherTaxLine[] = [];
  if (other > 0) otherTaxes.push({ kind: "otro", description: "Otros tributos (ARCA)", amount: other });
  const sum = round(
    vatLines.reduce((t, l) => t + l.net + l.vat, 0) + exempt + untaxed + other,
    2,
  );
  const diff = round(total - sum, 2);
  if (errors.length === 0 && Math.abs(diff) > 0.01) {
    if (diff > 0) {
      otherTaxes.push({ kind: "otro", description: "Percepciones u otros sin detalle (ARCA)", amount: diff });
      warnings.push("El total supera la suma de los importes: la diferencia queda como otros tributos sin detalle.");
    } else {
      errors.push("Los importes suman más que el total.");
    }
  }
  if (errors.length > 0) return { amounts: null, errors, warnings };
  return {
    amounts: {
      vat_lines: vatLines,
      exempt_amount: exempt,
      non_taxed_amount: untaxed,
      other_taxes: otherTaxes,
      total,
    },
    errors,
    warnings,
  };
}

/** Clave de duplicado dentro del archivo. */
export function arcaKey(r: Pick<ArcaRow, "issuer_cuit" | "cbte_type" | "point_of_sale" | "number">): string {
  return `${r.issuer_cuit}|${r.cbte_type}|${r.point_of_sale}|${r.number}`;
}

export type ArcaStatus = "nuevo" | "proveedor_a_crear" | "duplicado" | "receptor_distinto" | "error";

export const ARCA_STATUS_LABEL: Record<ArcaStatus, string> = {
  nuevo: "Nuevo",
  proveedor_a_crear: "Proveedor a crear",
  duplicado: "Ya cargado",
  receptor_distinto: "CUIT ajena",
  error: "Error",
};

export interface ArcaPrepared {
  row: ArcaRow;
  payload: Record<string, unknown> | null;
  errors: string[];
  warnings: string[];
  /** El receptor del comprobante no es este negocio. */
  foreign: boolean;
}

/**
 * Valida cada fila y arma lo que se manda a purchase_arca_import. `businessCuit`
 * = CUIT del negocio (tax_settings) para el aviso de CUIT ajena.
 */
export function prepareArcaRows(
  parsed: ArcaParseResult,
  businessCuit: string | null | undefined,
  supplierIva: Map<string, string> = new Map(),
): ArcaPrepared[] {
  const mine = String(businessCuit ?? "").replace(/\D/g, "");
  const seen = new Set<string>();
  return parsed.rows.map((row) => {
    const errors = [...row.errors];
    const warnings = [...row.warnings];
    const receptor = row.receptor_cuit ?? parsed.receptorCuit;
    const foreign = Boolean(mine && receptor && receptor !== mine);
    if (errors.length === 0) {
      const key = arcaKey(row);
      if (seen.has(key)) errors.push("Está repetido en el archivo.");
      seen.add(key);
    }
    let payload: Record<string, unknown> | null = null;
    if (errors.length === 0) {
      const a = arcaAmounts(row);
      errors.push(...a.errors);
      warnings.push(...a.warnings);
      if (a.amounts) {
        payload = {
          _row: row.rowNumber,
          cbte_type: row.cbte_type,
          point_of_sale: row.point_of_sale,
          number: row.number,
          issue_date: row.issue_date,
          cae: row.cae,
          issuer_cuit: row.issuer_cuit,
          issuer_name: row.issuer_name,
          supplier_iva: row.issuer_cuit ? (supplierIva.get(row.issuer_cuit) ?? null) : null,
          currency: row.currency,
          fx_rate: row.fx_rate,
          ...a.amounts,
        };
      }
    }
    return { row, payload, errors, warnings, foreign };
  });
}

/** Estado de la fila con la respuesta del servidor (vista previa). */
export function arcaStatus(
  p: ArcaPrepared,
  server: { action: string; message: string | null } | undefined,
): ArcaStatus {
  if (p.errors.length > 0 || !p.payload) return "error";
  if (server?.action === "error") return "error";
  if (server?.action === "skip") return "duplicado";
  if (p.foreign) return "receptor_distinto";
  if (server?.message === "supplier_new" || server?.message === "supplier_created") return "proveedor_a_crear";
  return "nuevo";
}

/** Error del servidor por fila → texto. */
export function arcaErrorMessage(code: string | null | undefined): string {
  const c = String(code ?? "");
  if (/invoice_letter_mismatch/.test(c)) {
    return "La letra no corresponde a la condición de IVA del proveedor y la de tu negocio: revisá la ficha del proveedor.";
  }
  if (/arca_cbte_unsupported/.test(c)) return "Tipo de comprobante no admitido.";
  if (/arca_cuit_invalid/.test(c)) return "La CUIT del emisor no es válida.";
  if (/supplier_not_found/.test(c)) return "El proveedor no está cargado.";
  if (/total_mismatch/.test(c)) return "Los importes no suman el total.";
  if (/vat_not_discriminated/.test(c)) return "Los comprobantes B y C no discriminan IVA.";
  if (/invalid_vat_rate/.test(c)) return "Alícuota de IVA inválida.";
  if (/invalid_fx_rate/.test(c)) return "Falta el tipo de cambio.";
  if (/duplicate|invoice_duplicated/.test(c)) return "Ya estaba cargado.";
  return c ? `No se pudo cargar (${c.slice(0, 80)}).` : "No se pudo cargar.";
}
