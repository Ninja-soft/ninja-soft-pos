// lib/tax/sicore.ts
//
// Exportación de las retenciones practicadas como agente (F18 · H106,
// ADR-079). Lógica PURA, con golden files en tests/fixtures/sicore/.
//
//   · SICORE (ARCA): Ganancias, IVA y SUSS. Archivo de importación de
//     retenciones y percepciones en ancho fijo, 144 posiciones por registro
//     (17 campos; los 4 campos de beneficiarios del exterior no se generan).
//   · ARBA (Buenos Aires): IIBB, DDJJ de agente de retención (actividad 6),
//     47 posiciones por registro.
//   · AGIP (CABA, e-ARCIBA) queda como deuda documentada (ADR-079).
//
// DISEÑOS DE REGISTRO ORIENTATIVOS: validar con el contador y con una
// importación real en el aplicativo antes de presentar (ver
// docs/32-impuestos.md § Retenciones como agente). Cada campo está declarado
// abajo con su largo para corregirlo sin tocar la lógica.
//
// Reglas de formato SICORE: importes con coma decimal y ceros a la izquierda
// (ej. 16 → "0000000121000,00"), fechas dd/mm/aaaa, CRLF por registro.
// ARBA: CUIT con guiones, importe con punto decimal (11 → "00001000.00").

import { isValidCuit } from "./catalog";

export interface WithholdingExportRow {
  tax: "ganancias" | "iva" | "iibb" | "suss";
  jurisdiction: string | null;
  date: string;
  payment_number: number;
  payment_total: number;
  payment_base: number;
  prior_base: number;
  non_taxable_min: number;
  taxable_base: number;
  amount: number;
  exemption_pct: number;
  condition: string | null;
  certificate_number: number | null;
  certificate: string | null;
  sicore_tax_code: number | null;
  sicore_regime_code: string | null;
  subject_snapshot: { name?: string | null; cuit?: string | null };
}

export interface ExportAgent {
  name: string | null;
  cuit: string | null;
}

export interface ExportIssue {
  level: "error" | "warning";
  code: string;
  message: string;
  certificate?: string | null;
}

export class SicoreFormatError extends Error {}

/**
 * Valores de los archivos que el negocio puede ajustar (ADR-101, parámetros
 * sicore_cbte_code, arba_branch y arba_activity). Sin valor = plantilla de
 * NinjaSoft (06, 0001 y 6).
 */
export interface ExportOptions {
  sicoreCbteCode?: number | null;
  arbaBranch?: number | null;
  arbaActivity?: number | null;
}

// ---------------------------------------------------------------------------
// Diseños de registro
// ---------------------------------------------------------------------------
export const SICORE_FIELDS = [
  ["cbteCode", 2],
  ["cbteDate", 10],
  ["cbteNumber", 16],
  ["cbteAmount", 16],
  ["taxCode", 3],
  ["regimeCode", 3],
  ["operation", 1],
  ["base", 14],
  ["retDate", 10],
  ["condition", 2],
  ["suspended", 1],
  ["amount", 14],
  ["exclusionPct", 6],
  ["exclusionDate", 10],
  ["docType", 2],
  ["docNumber", 20],
  ["originalCert", 14],
] as const;

export const ARBA_FIELDS = [
  ["cuit", 13],
  ["date", 10],
  ["branch", 4],
  ["emission", 8],
  ["amount", 11],
  ["operation", 1],
] as const;

export const RECORD_LENGTH = {
  sicore: SICORE_FIELDS.reduce((t, [, n]) => t + n, 0),
  arba: ARBA_FIELDS.reduce((t, [, n]) => t + n, 0),
} as const;

/** Código de comprobante SICORE: 06 = orden de pago (verificar con contador). */
export const SICORE_CBTE_ORDEN_PAGO = "06";
/** Código de operación SICORE: 1 = retención. */
export const SICORE_OPERACION_RETENCION = "1";
/** Tipo de documento del retenido: 80 = CUIT. */
export const DOC_CUIT = "80";

// ---------------------------------------------------------------------------
// Formato de campos
// ---------------------------------------------------------------------------
function cents(n: number): number {
  if (!Number.isFinite(n)) throw new SicoreFormatError(`importe inválido: ${n}`);
  return Math.round(n * 100);
}

/** Importe con separador decimal (`,` SICORE, `.` ARBA) y ceros a la izquierda. */
export function fmtDecimal(n: number, width: number, sep: "," | "." = ","): string {
  const c = cents(n);
  if (c < 0) throw new SicoreFormatError(`importe negativo: ${n}`);
  const s = `${Math.floor(c / 100)}${sep}${String(c % 100).padStart(2, "0")}`;
  if (s.length > width) throw new SicoreFormatError(`importe demasiado grande para ${width} posiciones: ${n}`);
  return s.padStart(width, "0");
}

export function fmtNum(n: number | string, width: number): string {
  const s = String(n).replace(/\D/g, "");
  if (s.length > width) throw new SicoreFormatError(`número demasiado largo para ${width} posiciones: ${n}`);
  return s.padStart(width, "0");
}

/** "2026-10-05" → "05/10/2026". */
export function fmtDateAr(iso: string): string {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new SicoreFormatError(`fecha inválida: ${iso}`);
  return `${m[3]}/${m[2]}/${m[1]}`;
}

export function fmtCuitDashed(cuit: string): string {
  const d = String(cuit).replace(/\D/g, "");
  if (d.length !== 11) throw new SicoreFormatError(`CUIT inválido: ${cuit}`);
  return `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`;
}

function assemble(fields: readonly (readonly [string, number])[], values: Record<string, string>): string {
  return fields
    .map(([k, n]) => {
      const v = values[k] ?? "";
      if (v.length !== n) throw new SicoreFormatError(`campo ${k}: largo ${v.length}, se esperaba ${n}`);
      return v;
    })
    .join("");
}

/**
 * Base informada en SICORE. Ganancias con acumulado mensual: la parte del
 * sujeto a retención que corresponde a ESTE pago (sujeto del mes menos lo que
 * ya era sujeto antes), así la suma del mes da el sujeto total. Resto: la base
 * del pago.
 */
export function sicoreBase(r: WithholdingExportRow): number {
  if (r.tax !== "ganancias") return r.payment_base;
  const before = Math.max(r.prior_base - r.non_taxable_min, 0);
  return Math.round((r.taxable_base - before) * 100) / 100;
}

/** Código de condición SICORE: 01 inscripto, 02 no inscripto (verificar con contador). */
export function sicoreCondition(r: WithholdingExportRow): string {
  return r.tax === "ganancias" && r.condition === "no_inscripto" ? "02" : "01";
}

export function sicoreLine(r: WithholdingExportRow, opts: ExportOptions = {}): string {
  return assemble(SICORE_FIELDS, {
    cbteCode: opts.sicoreCbteCode != null ? fmtNum(opts.sicoreCbteCode, 2) : SICORE_CBTE_ORDEN_PAGO,
    cbteDate: fmtDateAr(r.date),
    cbteNumber: fmtNum(r.payment_number, 16),
    cbteAmount: fmtDecimal(r.payment_total, 16),
    taxCode: fmtNum(r.sicore_tax_code ?? 0, 3),
    regimeCode: fmtNum(r.sicore_regime_code ?? 0, 3),
    operation: SICORE_OPERACION_RETENCION,
    base: fmtDecimal(sicoreBase(r), 14),
    retDate: fmtDateAr(r.date),
    condition: sicoreCondition(r),
    suspended: "0",
    amount: fmtDecimal(r.amount, 14),
    exclusionPct: fmtDecimal(r.exemption_pct ?? 0, 6),
    exclusionDate: " ".repeat(10),
    docType: DOC_CUIT,
    docNumber: String(r.subject_snapshot.cuit ?? "").replace(/\D/g, "").padEnd(20, " "),
    originalCert: fmtNum(0, 14),
  });
}

export function arbaLine(r: WithholdingExportRow, opts: ExportOptions = {}): string {
  return assemble(ARBA_FIELDS, {
    cuit: fmtCuitDashed(r.subject_snapshot.cuit ?? ""),
    date: fmtDateAr(r.date),
    branch: fmtNum(opts.arbaBranch ?? 1, 4),
    emission: fmtNum(r.certificate_number ?? 0, 8),
    amount: fmtDecimal(r.amount, 11, "."),
    operation: "A",
  });
}

// ---------------------------------------------------------------------------
// Revisión previa y armado
// ---------------------------------------------------------------------------
export function validateExport(format: "sicore" | "arba", agent: ExportAgent, rows: WithholdingExportRow[]): ExportIssue[] {
  const out: ExportIssue[] = [];
  if (!isValidCuit(agent.cuit)) {
    out.push({ level: "error", code: "agent_cuit", message: "Falta el CUIT del negocio (o no es válido). Cargalo en Configuración > Impuestos." });
  }
  if (rows.length === 0) {
    out.push({ level: "warning", code: "empty", message: "No hay retenciones practicadas en el mes para este archivo." });
  }
  for (const r of rows) {
    const c = r.certificate;
    if (!isValidCuit(r.subject_snapshot.cuit)) {
      out.push({ level: "error", code: "subject_cuit", certificate: c, message: `${c ?? "Retención"}: el proveedor ${r.subject_snapshot.name ?? ""} no tiene un CUIT válido.` });
    }
    if (format === "sicore") {
      if (!r.sicore_tax_code) {
        out.push({ level: "error", code: "tax_code", certificate: c, message: `${c ?? "Retención"}: falta el código de impuesto de SICORE.` });
      }
      if (!r.sicore_regime_code || !/^\d{1,3}$/.test(r.sicore_regime_code)) {
        out.push({
          level: "error",
          code: "regime_code",
          certificate: c,
          message: `${c ?? "Retención"}: falta el código de régimen de SICORE (cargalo en el régimen o en el concepto, con tu contador).`,
        });
      }
      if (sicoreBase(r) < 0) {
        out.push({ level: "error", code: "base", certificate: c, message: `${c ?? "Retención"}: la base da negativa.` });
      }
    }
    if (!(r.amount > 0)) {
      out.push({ level: "error", code: "amount", certificate: c, message: `${c ?? "Retención"}: importe en cero.` });
    }
  }
  return out;
}

export interface ExportFile {
  name: string;
  content: string;
  records: number;
  total: number;
}

export function exportFileName(
  format: "sicore" | "arba",
  agentCuit: string | null,
  period: string,
  opts: ExportOptions = {},
): string {
  const ym = period.slice(0, 7).replace("-", "");
  if (format === "arba") {
    return `AR-${String(agentCuit ?? "").replace(/\D/g, "")}-${ym}0-${opts.arbaActivity ?? 6}-LOTE1.txt`;
  }
  return `SICORE_RETENCIONES_${ym}.txt`;
}

/** Arma el archivo (lanza si hay errores de revisión). */
export function buildExport(
  format: "sicore" | "arba",
  agent: ExportAgent,
  period: string,
  rows: WithholdingExportRow[],
  opts: ExportOptions = {},
): ExportFile {
  const errors = validateExport(format, agent, rows).filter((i) => i.level === "error");
  if (errors.length > 0) throw new SicoreFormatError(errors.map((e) => e.message).join(" "));
  const lines = rows.map((r) => (format === "sicore" ? sicoreLine(r, opts) : arbaLine(r, opts)));
  return {
    name: exportFileName(format, agent.cuit, period, opts),
    content: lines.map((l) => l + "\r\n").join(""),
    records: lines.length,
    total: Math.round(rows.reduce((t, r) => t + r.amount, 0) * 100) / 100,
  };
}
