// lib/tax/libroIva.ts
//
// Libro IVA Digital (RG 4597 de ARCA, F18 · H108, ADR-076). Lógica PURA:
// arma los archivos de importación del Portal IVA en ancho fijo y la lista de
// problemas que frenan o advierten antes de generar.
//
// Diseño de registro (importación de comprobantes y alícuotas del Libro IVA
// Digital, el mismo que heredó del régimen de información de compras y
// ventas, RG 3685). Orientativo: validar con el contador y con el diseño
// vigente publicado por ARCA antes de presentar.
//
//   VENTAS_CBTE       266 posiciones   VENTAS_ALICUOTAS   62
//   COMPRAS_CBTE      325 posiciones   COMPRAS_ALICUOTAS  84
//   COMPRAS_IMPORTACIONES (50) no se genera: NinjaSoft no registra despachos
//   como comprobante de compra.
//
// Reglas de formato:
//   · numéricos alineados a la derecha con ceros a la izquierda;
//   · importes en centavos sin separador (13 enteros + 2 decimales); un
//     importe negativo lleva "-" en la primera posición;
//   · las notas de crédito se informan con importes POSITIVOS: el tipo de
//     comprobante (3, 8, 13, 53) ya indica que restan;
//   · textos en mayúsculas, sin acentos, alineados a la izquierda con
//     espacios;
//   · fechas AAAAMMDD; tipo de cambio 4 enteros + 6 decimales;
//   · cada registro termina en CRLF.

import {
  CBTE_LABEL,
  breakdownCloses,
  breakdownFromSale,
  cbteTipoFor,
  letterOfTipo,
  scaleBreakdown,
  type Breakdown,
  type TaxLine,
} from "@/supabase/functions/_shared/arca/comprobante";
import { isValidCuit } from "./catalog";

// ---------------------------------------------------------------------------
// Diseños de registro (longitudes)
// ---------------------------------------------------------------------------
export const RECORD_LENGTH = {
  ventasCbte: 266,
  ventasAlicuotas: 62,
  comprasCbte: 325,
  comprasAlicuotas: 84,
} as const;

export const FILE_NAMES = {
  ventasCbte: "LIBRO_IVA_DIGITAL_VENTAS_CBTE.txt",
  ventasAlicuotas: "LIBRO_IVA_DIGITAL_VENTAS_ALICUOTAS.txt",
  comprasCbte: "LIBRO_IVA_DIGITAL_COMPRAS_CBTE.txt",
  comprasAlicuotas: "LIBRO_IVA_DIGITAL_COMPRAS_ALICUOTAS.txt",
  leeme: "LEEME.txt",
} as const;

/** Código de alícuota de ARCA (tabla de alícuotas de IVA). */
export const ALICUOTA_CODE_BY_RATE: Record<string, number> = {
  "0": 3,
  "10.5": 4,
  "21": 5,
  "27": 6,
  "5": 8,
  "2.5": 9,
};
export const ALICUOTA_RATE_BY_CODE: Record<number, number> = { 3: 0, 4: 10.5, 5: 21, 6: 27, 8: 5, 9: 2.5 };

export function alicuotaCodeForRate(rate: number | string | null | undefined): number | null {
  const n = Number(rate);
  if (!Number.isFinite(n)) return null;
  return ALICUOTA_CODE_BY_RATE[String(n)] ?? null;
}

// ---------------------------------------------------------------------------
// Campos
// ---------------------------------------------------------------------------
export class LibroFormatError extends Error {}

/**
 * Pesos (número o texto con punto decimal) → centavos enteros, mitad hacia
 * arriba en valor absoluto. Tolera el ruido de coma flotante (1.005 → 101).
 */
export function toCents(v: number | string | null | undefined): number {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) throw new LibroFormatError(`importe inválido: ${String(v)}`);
  const sign = n < 0 ? -1 : 1;
  const abs = Math.abs(n) * 100;
  const c = Math.round(Number(abs.toFixed(6)));
  return c === 0 ? 0 : sign * c;
}

/** Numérico entero con ceros a la izquierda. */
export function fmtNum(v: number | string | bigint, width: number): string {
  const s = String(v).replace(/^0+(?=\d)/, "");
  if (!/^\d+$/.test(s)) throw new LibroFormatError(`numérico inválido: ${String(v)}`);
  if (s.length > width) throw new LibroFormatError(`${s} no entra en ${width} posiciones`);
  return s.padStart(width, "0");
}

/** Importe en centavos (13 enteros + 2 decimales); negativo con "-" adelante. */
export function fmtAmount(cents: number, width = 15): string {
  if (!Number.isInteger(cents)) throw new LibroFormatError(`importe no entero en centavos: ${cents}`);
  if (cents < 0) return "-" + fmtNum(Math.abs(cents), width - 1);
  return fmtNum(cents, width);
}

/** Texto en mayúsculas, sin acentos ni caracteres fuera de ASCII imprimible. */
export function normalizeText(s: string | null | undefined): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function fmtText(s: string | null | undefined, width: number): string {
  return normalizeText(s).slice(0, width).padEnd(width, " ");
}

/** "2026-10-05" (o Date ISO) → "20261005". */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "00000000";
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new LibroFormatError(`fecha inválida: ${String(iso)}`);
  return `${m[1]}${m[2]}${m[3]}`;
}

/** Tipo de cambio: 4 enteros + 6 decimales ("0001000000" = 1). */
export function fmtFx(rate: number): string {
  if (!(rate > 0) || rate >= 10000) throw new LibroFormatError(`tipo de cambio inválido: ${rate}`);
  return fmtNum(Math.round(rate * 1_000_000), 10);
}

// ---------------------------------------------------------------------------
// Registros normalizados
// ---------------------------------------------------------------------------
export interface LibroAlicuota {
  code: number; // 3, 4, 5, 6, 8, 9
  neto: number; // centavos
  iva: number; // centavos
}

interface LibroCbteBase {
  ref: string; // "Factura B 00003-00000012" (para los mensajes)
  fecha: string; // ISO
  tipo: number;
  pv: number;
  nro: number;
  docCode: number;
  docNro: string;
  nombre: string;
  total: number;
  noGravado: number;
  exento: number;
  internos: number;
  percIibb: number;
  percMuni: number;
  otros: number;
  moneda: string;
  tc: number;
  alicuotas: LibroAlicuota[];
  codOperacion: string;
}

export interface LibroVenta extends LibroCbteBase {
  percNoCat: number;
  percNac: number;
  fechaVtoPago: string | null;
}

export interface LibroCompra extends LibroCbteBase {
  despacho: string;
  percIva: number;
  percNac: number;
  credito: number;
}

/**
 * Código de operación: "0" con alguna alícuota gravada distinta de 0 %; si no
 * hay IVA, "E" (exenta) o "N" (no gravada).
 */
export function codigoOperacion(alicuotas: LibroAlicuota[], exento: number): string {
  if (alicuotas.some((a) => a.code !== 3)) return "0";
  return exento !== 0 ? "E" : "N";
}

/**
 * Alícuotas a informar. Un comprobante sin IVA discriminado (exento, no
 * gravado, B o C de compras) lleva una alícuota 0 % (código 3) en cero: el
 * importador pide al menos una por comprobante.
 */
function withAtLeastOne(alicuotas: LibroAlicuota[]): LibroAlicuota[] {
  return alicuotas.length > 0 ? alicuotas : [{ code: 3, neto: 0, iva: 0 }];
}

export function ventaCbteLine(v: LibroVenta): string {
  const line =
    fmtDate(v.fecha) +
    fmtNum(v.tipo, 3) +
    fmtNum(v.pv, 5) +
    fmtNum(v.nro, 20) +
    fmtNum(v.nro, 20) +
    fmtNum(v.docCode, 2) +
    fmtNum(v.docNro || "0", 20) +
    fmtText(v.nombre, 30) +
    fmtAmount(v.total) +
    fmtAmount(v.noGravado) +
    fmtAmount(v.percNoCat) +
    fmtAmount(v.exento) +
    fmtAmount(v.percNac) +
    fmtAmount(v.percIibb) +
    fmtAmount(v.percMuni) +
    fmtAmount(v.internos) +
    fmtText(v.moneda, 3) +
    fmtFx(v.tc) +
    fmtNum(v.alicuotas.length, 1) +
    fmtText(v.codOperacion, 1) +
    fmtAmount(v.otros) +
    fmtDate(v.fechaVtoPago);
  return assertLength(line, RECORD_LENGTH.ventasCbte);
}

export function ventaAlicuotaLine(v: LibroVenta, a: LibroAlicuota): string {
  const line =
    fmtNum(v.tipo, 3) + fmtNum(v.pv, 5) + fmtNum(v.nro, 20) + fmtAmount(a.neto) + fmtNum(a.code, 4) + fmtAmount(a.iva);
  return assertLength(line, RECORD_LENGTH.ventasAlicuotas);
}

export function compraCbteLine(c: LibroCompra): string {
  const line =
    fmtDate(c.fecha) +
    fmtNum(c.tipo, 3) +
    fmtNum(c.pv, 5) +
    fmtNum(c.nro, 20) +
    fmtText(c.despacho, 16) +
    fmtNum(c.docCode, 2) +
    fmtNum(c.docNro || "0", 20) +
    fmtText(c.nombre, 30) +
    fmtAmount(c.total) +
    fmtAmount(c.noGravado) +
    fmtAmount(c.exento) +
    fmtAmount(c.percIva) +
    fmtAmount(c.percNac) +
    fmtAmount(c.percIibb) +
    fmtAmount(c.percMuni) +
    fmtAmount(c.internos) +
    fmtText(c.moneda, 3) +
    fmtFx(c.tc) +
    fmtNum(c.alicuotas.length, 1) +
    fmtText(c.codOperacion, 1) +
    fmtAmount(c.credito) +
    fmtAmount(c.otros) +
    fmtNum(0, 11) + // CUIT del emisor o corredor
    fmtText("", 30) + // denominación del emisor o corredor
    fmtAmount(0); // IVA comisión
  return assertLength(line, RECORD_LENGTH.comprasCbte);
}

export function compraAlicuotaLine(c: LibroCompra, a: LibroAlicuota): string {
  const line =
    fmtNum(c.tipo, 3) +
    fmtNum(c.pv, 5) +
    fmtNum(c.nro, 20) +
    fmtNum(c.docCode, 2) +
    fmtNum(c.docNro || "0", 20) +
    fmtAmount(a.neto) +
    fmtNum(a.code, 4) +
    fmtAmount(a.iva);
  return assertLength(line, RECORD_LENGTH.comprasAlicuotas);
}

function assertLength(line: string, len: number): string {
  if (line.length !== len) throw new LibroFormatError(`registro de ${line.length} posiciones (se esperaban ${len})`);
  return line;
}

export function toFile(lines: string[]): string {
  return lines.map((l) => l + "\r\n").join("");
}

// ---------------------------------------------------------------------------
// Datos de entrada (libro_iva_data)
// ---------------------------------------------------------------------------
export interface LibroVentaDoc {
  id: string;
  origin: "sale" | "return" | "void";
  cbte_tipo: number;
  pto_vta: number;
  cbte_nro: number;
  cbte_fch: string;
  concepto: number | null;
  doc_tipo: number | null;
  doc_nro: string | null;
  imp_total: number | string;
  emission_type?: "CAE" | "CAEA" | null;
  inform_status?: string | null;
  receptor_name: string | null;
  sale: { number?: number | null; total: number | string; net_taxed?: number | string | null; iva_total?: number | string | null };
  tax_lines: TaxLine[];
}

export interface LibroPendingDoc {
  id: string;
  origin: string;
  cbte_tipo: number | null;
  pto_vta: number | null;
  cbte_nro: number | null;
  status: string;
  error_code: string | null;
  sale_number: number | null;
  date: string;
}

export interface LibroCompraDoc {
  id: string;
  kind: "invoice" | "debit_note" | "credit_note";
  letter: string;
  point_of_sale: number;
  number: number;
  issue_date: string;
  currency: string;
  fx_rate: number | string;
  vat_lines: Array<{ rate: number | string; net: number | string; vat: number | string }>;
  exempt_amount: number | string;
  non_taxed_amount: number | string;
  other_taxes: Array<{ kind?: string | null; amount: number | string; description?: string | null; jurisdiction?: string | null }>;
  total: number | string;
  supplier: { id?: string; name: string; cuit: string | null; iva_condition?: string | null; foreign_tax_id?: string | null };
}

export interface LibroData {
  period: string; // "2026-10"
  today?: string | null;
  emitter: { cuit: string | null; iva_condition: string | null; name?: string | null };
  environment?: string | null;
  ventas: LibroVentaDoc[];
  pending: LibroPendingDoc[];
  homologacion_count?: number;
  compras: LibroCompraDoc[];
}

// ---------------------------------------------------------------------------
// Problemas
// ---------------------------------------------------------------------------
export type LibroIssueLevel = "error" | "warning";
export interface LibroIssue {
  level: LibroIssueLevel;
  code: string;
  message: string;
  ref?: string;
}

const pesos = (c: number) =>
  (c / 100).toLocaleString("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2 });

function cbteRef(tipo: number | null, pv: number | null, nro: number | null): string {
  const label = (tipo != null && CBTE_LABEL[tipo]) || "Comprobante";
  if (pv == null || nro == null) return label;
  return `${label} ${String(pv).padStart(5, "0")}-${String(nro).padStart(8, "0")}`;
}

// ---------------------------------------------------------------------------
// Ventas
// ---------------------------------------------------------------------------
/** Grupo del campo del registro según el código de tributo de ARCA. */
export function ventaTributoField(id: number): "percNoCat" | "percNac" | "percIibb" | "percMuni" | "internos" | "otros" {
  switch (id) {
    case 13:
      return "percNoCat";
    case 1:
    case 6:
      return "percNac";
    case 2:
    case 5:
    case 7:
      return "percIibb";
    case 3:
    case 8:
      return "percMuni";
    case 4:
      return "internos";
    default:
      return "otros";
  }
}

/** Importes del comprobante como se mandaron a ARCA (mismo cálculo que el worker). */
export function ventaBreakdown(d: LibroVentaDoc): Breakdown | null {
  const letter = letterOfTipo(d.cbte_tipo);
  if (!letter) return null;
  const full = breakdownFromSale(letter, d.sale, d.tax_lines ?? []);
  if (d.origin === "sale") return full;
  return scaleBreakdown(full, Number(d.imp_total));
}

export function buildVenta(d: LibroVentaDoc, issues: LibroIssue[]): LibroVenta | null {
  const ref = cbteRef(d.cbte_tipo, d.pto_vta, d.cbte_nro);
  const letter = letterOfTipo(d.cbte_tipo);
  if (!letter) {
    issues.push({ level: "error", code: "tipo_invalido", ref, message: `${ref}: el tipo de comprobante no es válido.` });
    return null;
  }
  const b = ventaBreakdown(d)!;
  let ok = true;
  if (!breakdownCloses(b)) {
    issues.push({
      level: "error",
      code: "totales_no_cierran",
      ref,
      message: `${ref}: la suma de neto, IVA, exento, no gravado y tributos no da el total. Revisá el desglose de la venta.`,
    });
    ok = false;
  } else if (toCents(b.ImpTotal) !== toCents(d.imp_total)) {
    issues.push({
      level: "error",
      code: "total_distinto_arca",
      ref,
      message: `${ref}: el total (${pesos(toCents(b.ImpTotal))}) no coincide con lo autorizado en ARCA (${pesos(toCents(d.imp_total))}).`,
    });
    ok = false;
  }

  const alicuotas: LibroAlicuota[] = [];
  for (const a of b.Iva) {
    if (!(a.Id in ALICUOTA_RATE_BY_CODE)) {
      issues.push({ level: "error", code: "alicuota_invalida", ref, message: `${ref}: tiene una alícuota de IVA que ARCA no acepta (código ${a.Id}).` });
      ok = false;
      continue;
    }
    alicuotas.push({ code: a.Id, neto: toCents(a.BaseImp), iva: toCents(a.Importe) });
  }

  const docCode = Number(d.doc_tipo ?? 99) || 99;
  const docNro = docCode === 99 ? "0" : String(d.doc_nro ?? "").replace(/\D/g, "");
  if ((letter === "A" || letter === "M") && docCode !== 80) {
    issues.push({ level: "error", code: "venta_sin_cuit", ref, message: `${ref}: es clase ${letter} y no tiene el CUIT del cliente.` });
    ok = false;
  }
  if ((docCode === 80 || docCode === 86) && !isValidCuit(docNro)) {
    issues.push({ level: "error", code: "cuit_invalido", ref, message: `${ref}: el CUIT o CUIL del cliente (${docNro || "vacío"}) no es válido.` });
    ok = false;
  }
  if (docCode !== 99 && !docNro) {
    issues.push({ level: "error", code: "documento_vacio", ref, message: `${ref}: el cliente tiene tipo de documento pero no el número.` });
    ok = false;
  }
  if (d.emission_type === "CAEA" && d.inform_status !== "informado") {
    issues.push({
      level: "warning",
      code: "caea_sin_informar",
      ref,
      message: `${ref}: salió en contingencia (CAEA) y todavía no se informó a ARCA. Se incluye igual; revisá que se informe antes del vencimiento.`,
    });
  }
  if (!ok) return null;

  const v: LibroVenta = {
    ref,
    fecha: d.cbte_fch,
    tipo: d.cbte_tipo,
    pv: d.pto_vta,
    nro: d.cbte_nro,
    docCode,
    docNro,
    nombre: docCode === 99 ? d.receptor_name || "CONSUMIDOR FINAL" : d.receptor_name || "SIN NOMBRE",
    total: toCents(b.ImpTotal),
    noGravado: toCents(b.ImpTotConc),
    exento: toCents(b.ImpOpEx),
    percNoCat: 0,
    percNac: 0,
    percIibb: 0,
    percMuni: 0,
    internos: 0,
    otros: 0,
    moneda: "PES",
    tc: 1,
    alicuotas: [],
    codOperacion: "0",
    fechaVtoPago: d.concepto === 2 || d.concepto === 3 ? d.cbte_fch : null,
  };
  for (const t of b.Tributos) {
    const f = ventaTributoField(t.Id);
    v[f] += toCents(t.Importe);
  }
  // Comprobante C (emisor no inscripto): sin alícuotas.
  v.alicuotas = letter === "C" ? [] : withAtLeastOne(alicuotas);
  v.codOperacion = letter === "C" ? "0" : codigoOperacion(v.alicuotas, v.exento);
  return v;
}

// ---------------------------------------------------------------------------
// Compras
// ---------------------------------------------------------------------------
const KIND_TO_CBTE: Record<LibroCompraDoc["kind"], "factura" | "nd" | "nc"> = {
  invoice: "factura",
  debit_note: "nd",
  credit_note: "nc",
};

export function buildCompra(c: LibroCompraDoc, issues: LibroIssue[]): LibroCompra | null {
  const tipo = cbteTipoFor(c.letter, KIND_TO_CBTE[c.kind] ?? "factura");
  const ref = `${cbteRef(tipo, c.point_of_sale, c.number)} de ${c.supplier.name}`;
  if (c.letter === "E" || tipo == null) {
    issues.push({
      level: "warning",
      code: "compra_importacion",
      ref,
      message: `${ref}: es un comprobante del exterior. No va en este archivo: las importaciones se cargan con el despacho en el Portal IVA.`,
    });
    return null;
  }
  let ok = true;
  const cuit = String(c.supplier.cuit ?? "").replace(/\D/g, "");
  if (!cuit) {
    issues.push({ level: "error", code: "compra_sin_cuit", ref, message: `${ref}: el proveedor no tiene CUIT. Cargalo en la ficha del proveedor.` });
    ok = false;
  } else if (!isValidCuit(cuit)) {
    issues.push({ level: "error", code: "cuit_invalido", ref, message: `${ref}: el CUIT del proveedor (${cuit}) no es válido.` });
    ok = false;
  }

  const fx = Number(c.fx_rate) || 1;
  const conv = (v: number | string | null | undefined) => {
    const cts = toCents(v);
    return fx === 1 ? cts : Math.round(cts * fx);
  };
  if (String(c.currency || "ARS").toUpperCase() !== "ARS") {
    issues.push({
      level: "warning",
      code: "compra_moneda_extranjera",
      ref,
      message: `${ref}: está en ${c.currency}. Se informa en pesos al tipo de cambio cargado (${String(c.fx_rate)}).`,
    });
  }

  const discriminates = c.letter === "A" || c.letter === "M";
  const alicuotas: LibroAlicuota[] = [];
  let sinIva = 0; // B y C: el importe va como no gravado (no da crédito fiscal)
  let sumOrig = 0;
  for (const l of c.vat_lines ?? []) {
    sumOrig += toCents(l.net) + toCents(l.vat);
    if (!discriminates) {
      sinIva += conv(l.net) + conv(l.vat);
      continue;
    }
    const code = alicuotaCodeForRate(l.rate);
    if (code == null) {
      issues.push({ level: "error", code: "alicuota_invalida", ref, message: `${ref}: la alícuota ${String(l.rate)} % no existe en ARCA.` });
      ok = false;
      continue;
    }
    const net = toCents(l.net);
    const iva = toCents(l.vat);
    const expected = Math.round((net * (ALICUOTA_RATE_BY_CODE[code] as number)) / 100);
    if (Math.abs(expected - iva) > 100) {
      issues.push({
        level: "error",
        code: "iva_no_corresponde",
        ref,
        message: `${ref}: el IVA al ${String(ALICUOTA_RATE_BY_CODE[code]).replace(".", ",")} % (${pesos(iva)}) no corresponde al neto (${pesos(net)}). Revisá la carga.`,
      });
      ok = false;
    }
    const prev = alicuotas.find((a) => a.code === code);
    if (prev) {
      prev.neto += conv(l.net);
      prev.iva += conv(l.vat);
    } else alicuotas.push({ code, neto: conv(l.net), iva: conv(l.vat) });
  }
  if (alicuotas.length > 9) {
    issues.push({ level: "error", code: "demasiadas_alicuotas", ref, message: `${ref}: tiene más de 9 alícuotas.` });
    ok = false;
  }

  const bucket = { percIva: 0, percNac: 0, percIibb: 0, percMuni: 0, internos: 0, otros: 0 };
  for (const t of c.other_taxes ?? []) {
    sumOrig += toCents(t.amount);
    const amt = conv(t.amount);
    switch (t.kind) {
      case "percepcion_iva":
        bucket.percIva += amt;
        break;
      case "percepcion_ganancias":
        bucket.percNac += amt;
        break;
      case "percepcion_iibb":
        bucket.percIibb += amt;
        break;
      case "percepcion_municipal":
        bucket.percMuni += amt;
        break;
      case "impuesto_interno":
        bucket.internos += amt;
        break;
      default:
        bucket.otros += amt;
    }
  }
  sumOrig += toCents(c.exempt_amount) + toCents(c.non_taxed_amount);
  if (sumOrig !== toCents(c.total)) {
    issues.push({
      level: "error",
      code: "totales_no_cierran",
      ref,
      message: `${ref}: la suma de los importes (${pesos(sumOrig)}) no da el total cargado (${pesos(toCents(c.total))}).`,
    });
    ok = false;
  }
  if (!ok) return null;

  const exento = conv(c.exempt_amount);
  const noGravado = conv(c.non_taxed_amount) + sinIva;
  const credito = alicuotas.reduce((t, a) => t + a.iva, 0);
  const ivaAlic = withAtLeastOne(alicuotas);
  // Total = suma de las partes ya convertidas (en pesos cierra exacto).
  const total =
    ivaAlic.reduce((t, a) => t + a.neto + a.iva, 0) +
    exento +
    noGravado +
    bucket.percIva +
    bucket.percNac +
    bucket.percIibb +
    bucket.percMuni +
    bucket.internos +
    bucket.otros;
  return {
    ref,
    fecha: c.issue_date,
    tipo,
    pv: c.point_of_sale,
    nro: c.number,
    despacho: "",
    docCode: 80,
    docNro: cuit,
    nombre: c.supplier.name,
    total,
    noGravado,
    exento,
    ...bucket,
    moneda: "PES",
    tc: 1,
    alicuotas: ivaAlic,
    codOperacion: codigoOperacion(ivaAlic, exento),
    credito,
  };
}

// ---------------------------------------------------------------------------
// Libro completo
// ---------------------------------------------------------------------------
export interface LibroSideSummary {
  count: number;
  total: number; // centavos, las notas de crédito restan
  neto: number;
  iva: number;
}

export interface LibroSummary {
  period: string;
  ventas: LibroSideSummary;
  compras: LibroSideSummary & { credito: number };
  errors: number;
  warnings: number;
}

export interface LibroResult {
  issues: LibroIssue[];
  summary: LibroSummary;
  ventas: LibroVenta[];
  compras: LibroCompra[];
  files: Array<{ name: string; content: string }>;
}

const NC_TIPOS = new Set([3, 8, 13, 53, 21]);

function side(rows: Array<LibroVenta | LibroCompra>): LibroSideSummary {
  return rows.reduce<LibroSideSummary>(
    (s, r) => {
      const sg = NC_TIPOS.has(r.tipo) ? -1 : 1;
      return {
        count: s.count + 1,
        total: s.total + sg * r.total,
        neto: s.neto + sg * r.alicuotas.reduce((t, a) => t + a.neto, 0),
        iva: s.iva + sg * r.alicuotas.reduce((t, a) => t + a.iva, 0),
      };
    },
    { count: 0, total: 0, neto: 0, iva: 0 },
  );
}

const IVA_CONDITION_LABEL: Record<string, string> = {
  responsable_inscripto: "Responsable Inscripto",
  monotributo: "Monotributo",
  exento: "Exento",
};

export function buildLibroIva(data: LibroData): LibroResult {
  const issues: LibroIssue[] = [];
  const cuit = String(data.emitter?.cuit ?? "").replace(/\D/g, "");
  if (!cuit) {
    issues.push({ level: "error", code: "emisor_sin_cuit", message: "Falta el CUIT del negocio. Cargalo en Configuración > Impuestos." });
  }
  const cond = data.emitter?.iva_condition ?? null;
  if (cond !== "responsable_inscripto") {
    issues.push({
      level: "warning",
      code: "emisor_no_ri",
      message: `El negocio figura como ${cond ? (IVA_CONDITION_LABEL[cond] ?? cond) : "sin condición frente al IVA"}. El Libro IVA Digital lo presentan los Responsables Inscriptos.`,
    });
  }
  if (data.today && data.period >= String(data.today).slice(0, 7)) {
    issues.push({
      level: "warning",
      code: "periodo_en_curso",
      message: "El mes todavía no terminó: el archivo va a quedar incompleto. Generalo de nuevo cuando cierre el mes.",
    });
  }

  if (data.pending.length > 0) {
    const sample = data.pending
      .slice(0, 5)
      .map((p) => (p.cbte_nro ? cbteRef(p.cbte_tipo, p.pto_vta, p.cbte_nro) : `venta ${p.sale_number ?? ""}`.trim()))
      .join(", ");
    issues.push({
      level: "error",
      code: "pendientes_cae",
      message: `Hay ${data.pending.length} comprobante${data.pending.length === 1 ? "" : "s"} del mes sin CAE (${sample}${data.pending.length > 5 ? "..." : ""}). Resolvelos en Configuración > Facturación electrónica antes de generar el libro.`,
    });
  }
  if ((data.homologacion_count ?? 0) > 0 && data.ventas.length === 0) {
    issues.push({
      level: "warning",
      code: "solo_homologacion",
      message: "Las facturas del mes son de prueba (homologación): no tienen validez fiscal y no van al libro.",
    });
  }

  const ventas: LibroVenta[] = [];
  for (const d of data.ventas) {
    const v = buildVenta(d, issues);
    if (v) ventas.push(v);
  }
  const compras: LibroCompra[] = [];
  for (const c of data.compras) {
    const r = buildCompra(c, issues);
    if (r) compras.push(r);
  }
  if (data.ventas.length === 0 && data.compras.length === 0) {
    issues.push({
      level: "warning",
      code: "periodo_vacio",
      message: "No hay comprobantes en el mes. En el Portal IVA podés presentar el libro sin movimiento.",
    });
  }

  const sortKey = (r: LibroVenta | LibroCompra) =>
    `${r.fecha}|${String(r.tipo).padStart(3, "0")}|${String(r.pv).padStart(5, "0")}|${String(r.nro).padStart(20, "0")}|${r.docNro}`;
  ventas.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  compras.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  const cSide = side(compras);
  const summary: LibroSummary = {
    period: data.period,
    ventas: side(ventas),
    compras: { ...cSide, credito: compras.reduce((t, c) => t + (NC_TIPOS.has(c.tipo) ? -1 : 1) * c.credito, 0) },
    errors: issues.filter((i) => i.level === "error").length,
    warnings: issues.filter((i) => i.level === "warning").length,
  };

  const files = [
    { name: FILE_NAMES.ventasCbte, content: toFile(ventas.map(ventaCbteLine)) },
    { name: FILE_NAMES.ventasAlicuotas, content: toFile(ventas.flatMap((v) => v.alicuotas.map((a) => ventaAlicuotaLine(v, a)))) },
    { name: FILE_NAMES.comprasCbte, content: toFile(compras.map(compraCbteLine)) },
    { name: FILE_NAMES.comprasAlicuotas, content: toFile(compras.flatMap((c) => c.alicuotas.map((a) => compraAlicuotaLine(c, a)))) },
    { name: FILE_NAMES.leeme, content: leeme(data, summary) },
  ];
  return { issues, summary, ventas, compras, files };
}

export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function zipName(cuit: string | null | undefined, period: string): string {
  const c = String(cuit ?? "").replace(/\D/g, "") || "sin-cuit";
  return `libro-iva-digital-${c}-${period.replace("-", "")}.zip`;
}

/** Pasos para importar en el Portal IVA (los mismos que muestra la pantalla). */
export const PORTAL_IVA_STEPS: string[] = [
  "Entrá a arca.gob.ar con tu CUIT y clave fiscal (nivel 3).",
  "Abrí el servicio Portal IVA. Si no aparece, adherilo desde el Administrador de Relaciones de Clave Fiscal.",
  "Elegí Nueva declaración, el período (mes y año) y entrá a Libro IVA.",
  "En Ventas, elegí Importar y subí LIBRO_IVA_DIGITAL_VENTAS_CBTE.txt como archivo de comprobantes y LIBRO_IVA_DIGITAL_VENTAS_ALICUOTAS.txt como archivo de alícuotas.",
  "Si el Portal ofrece traer las ventas desde Mis Comprobantes, usá uno solo de los dos caminos: si importás este archivo, no las traigas también desde ahí (quedarían duplicadas).",
  "En Compras, elegí Importar y subí LIBRO_IVA_DIGITAL_COMPRAS_CBTE.txt y LIBRO_IVA_DIGITAL_COMPRAS_ALICUOTAS.txt.",
  "Revisá que los totales del Portal coincidan con el resumen de NinjaSoft. Si ARCA marca errores, descargá el detalle, corregí en NinjaSoft y generá el archivo de nuevo.",
  "Cuando esté todo bien, cerrá el libro y seguí con la liquidación del IVA. Lo ideal es que tu contador lo revise antes de presentar.",
];

function leeme(data: LibroData, s: LibroSummary): string {
  const p = (c: number) => (c / 100).toFixed(2);
  const lines = [
    "LIBRO IVA DIGITAL - NINJASOFT",
    "",
    `Negocio: ${normalizeText(data.emitter?.name ?? "")}`,
    `CUIT: ${String(data.emitter?.cuit ?? "").replace(/\D/g, "") || "SIN CUIT"}`,
    `Periodo: ${data.period}`,
    "",
    `Ventas: ${s.ventas.count} comprobantes. Neto gravado ${p(s.ventas.neto)}. IVA debito ${p(s.ventas.iva)}. Total ${p(s.ventas.total)}.`,
    `Compras: ${s.compras.count} comprobantes. Neto gravado ${p(s.compras.neto)}. IVA credito ${p(s.compras.credito)}. Total ${p(s.compras.total)}.`,
    "(Las notas de credito restan en este resumen; en los archivos van en positivo.)",
    "",
    "COMO IMPORTARLO EN EL PORTAL IVA",
    ...PORTAL_IVA_STEPS.map((t, i) => `${i + 1}. ${normalizeText(t)}`),
    "",
    "Formato: diseno de registro de importacion del Libro IVA Digital (RG 4597). Validar con el contador antes de presentar.",
  ];
  return toFile(lines);
}
