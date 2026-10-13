// Catálogos fiscales (F18 · H103-H105, ADR-068). PURO.
//
// Espejo de las tablas `tax_iva_rates`, `tax_jurisdictions` y de las funciones
// `fiscal_condition_arca_id` / `doc_type_arca_id` de la migración
// 20261028100100_impuestos_base. Los códigos de ARCA son orientativos: se
// confirman con FEParamGetTiposIva, FEParamGetCondicionIvaReceptor,
// FEParamGetTiposDoc y FEParamGetTiposTributos cuando se integre WSFE (F3).

// ── IVA ─────────────────────────────────────────────────────────────────────

export const IVA_CODES = ["21", "10.5", "27", "5", "2.5", "0", "exento", "no_gravado"] as const;
export type IvaCode = (typeof IVA_CODES)[number];
export type IvaKind = "gravado" | "exento" | "no_gravado";

export interface IvaRate {
  code: IvaCode;
  /** Alícuota en %. Exento y no gravado: 0 (se distinguen por `kind`). */
  rate: number;
  /** Id de ARCA: AlicIva (3 a 9) y, para el Libro IVA, 1 no gravado y 2 exento. */
  arcaId: number;
  kind: IvaKind;
  label: string;
}

export const IVA_RATES: Record<IvaCode, IvaRate> = {
  "21": { code: "21", rate: 21, arcaId: 5, kind: "gravado", label: "21 %" },
  "10.5": { code: "10.5", rate: 10.5, arcaId: 4, kind: "gravado", label: "10,5 %" },
  "27": { code: "27", rate: 27, arcaId: 6, kind: "gravado", label: "27 %" },
  "5": { code: "5", rate: 5, arcaId: 8, kind: "gravado", label: "5 %" },
  "2.5": { code: "2.5", rate: 2.5, arcaId: 9, kind: "gravado", label: "2,5 %" },
  "0": { code: "0", rate: 0, arcaId: 3, kind: "gravado", label: "0 %" },
  exento: { code: "exento", rate: 0, arcaId: 2, kind: "exento", label: "Exento" },
  no_gravado: { code: "no_gravado", rate: 0, arcaId: 1, kind: "no_gravado", label: "No gravado" },
};

export function isIvaCode(v: unknown): v is IvaCode {
  return typeof v === "string" && (IVA_CODES as readonly string[]).includes(v);
}

/** Código del catálogo para una alícuota numérica (compatibilidad con `tax_rate`). */
export function ivaCodeFromRate(rate: number | string | null | undefined): IvaCode | null {
  if (rate == null || rate === "") return null;
  const n = Number(rate);
  if (!Number.isFinite(n)) return null;
  const hit = IVA_CODES.find((c) => IVA_RATES[c].kind === "gravado" && IVA_RATES[c].rate === n);
  return hit ?? null;
}

// ── Condición frente al IVA ────────────────────────────────────────────────

export const FISCAL_CONDITIONS = [
  "consumidor_final",
  "responsable_inscripto",
  "monotributo",
  "monotributo_social",
  "exento",
  "no_responsable",
  "no_categorizado",
  "no_alcanzado",
  "iva_liberado",
  "exterior",
] as const;
export type FiscalCondition = (typeof FISCAL_CONDITIONS)[number];

export const FISCAL_CONDITION_LABEL: Record<FiscalCondition, string> = {
  consumidor_final: "Consumidor final",
  responsable_inscripto: "Responsable inscripto",
  monotributo: "Monotributo",
  monotributo_social: "Monotributo social",
  exento: "IVA exento",
  no_responsable: "No responsable",
  no_categorizado: "Sujeto no categorizado",
  no_alcanzado: "IVA no alcanzado",
  iva_liberado: "IVA liberado (Ley 19.640)",
  exterior: "Cliente del exterior",
};

/**
 * Id de la condición frente al IVA del receptor para WSFE (RG 5616,
 * FEParamGetCondicionIvaReceptor). "No responsable" no tiene id propio en la
 * tabla vigente: se informa como no alcanzado (15). Orientativo.
 */
export const FISCAL_CONDITION_ARCA_ID: Record<FiscalCondition, number> = {
  responsable_inscripto: 1,
  exento: 4,
  consumidor_final: 5,
  monotributo: 6,
  no_categorizado: 7,
  exterior: 9,
  iva_liberado: 10,
  monotributo_social: 13,
  no_alcanzado: 15,
  no_responsable: 15,
};

/** Condiciones que puede tener el comercio (emisor). */
export const EMITTER_CONDITIONS = [
  "responsable_inscripto",
  "monotributo",
  "monotributo_social",
  "exento",
  "no_alcanzado",
] as const;
export type EmitterCondition = (typeof EMITTER_CONDITIONS)[number];

/** El emisor discrimina IVA (comprobantes A, B y M). */
export function emitterDiscriminatesIva(c: string | null | undefined): boolean {
  return c == null || c === "" || c === "responsable_inscripto";
}

// ── Documento ──────────────────────────────────────────────────────────────

export type DocType = "cuit" | "dni" | "cuil" | "passport" | "other";

/** Tipos de documento de ARCA (FEParamGetTiposDoc). 99 = sin identificar. */
export const DOC_TYPE_ARCA_ID: Record<DocType, number> = {
  cuit: 80,
  cuil: 86,
  dni: 96,
  passport: 94,
  other: 99,
};

export function normalizeDigits(v: string | null | undefined): string {
  return String(v ?? "").replace(/\D/g, "");
}

/** Dígito verificador de CUIT y CUIL (módulo 11). */
export function isValidCuit(value: string | null | undefined): boolean {
  const d = normalizeDigits(value);
  if (d.length !== 11) return false;
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(d[i]) * w[i]!;
  let check = 11 - (sum % 11);
  if (check === 11) check = 0;
  if (check === 10) check = 9;
  return check === Number(d[10]);
}

export function isValidDni(value: string | null | undefined): boolean {
  return /^\d{7,8}$/.test(normalizeDigits(value));
}

/** Error de validación del documento o null si está bien (o vacío). */
export function documentError(type: string | null | undefined, number: string | null | undefined): string | null {
  const n = String(number ?? "").trim();
  if (!n || !type) return null;
  if ((type === "cuit" || type === "cuil") && !isValidCuit(n)) return "invalid_cuit";
  if (type === "dni" && !isValidDni(n)) return "invalid_dni";
  return null;
}

// ── Jurisdicciones (código de Convenio Multilateral) ──────────────────────

export interface Jurisdiction {
  code: string;
  name: string;
  /** Formato de padrón que se sabe importar. */
  padron: "arba" | "agip" | null;
  agency: string;
}

export const JURISDICTIONS: Jurisdiction[] = [
  { code: "901", name: "Ciudad de Buenos Aires", padron: "agip", agency: "AGIP" },
  { code: "902", name: "Buenos Aires", padron: "arba", agency: "ARBA" },
  { code: "903", name: "Catamarca", padron: null, agency: "AGR Catamarca" },
  { code: "904", name: "Córdoba", padron: null, agency: "Rentas Córdoba" },
  { code: "905", name: "Corrientes", padron: null, agency: "DGR Corrientes" },
  { code: "906", name: "Chaco", padron: null, agency: "ATP Chaco" },
  { code: "907", name: "Chubut", padron: null, agency: "DGR Chubut" },
  { code: "908", name: "Entre Ríos", padron: null, agency: "ATER" },
  { code: "909", name: "Formosa", padron: null, agency: "DGR Formosa" },
  { code: "910", name: "Jujuy", padron: null, agency: "DPR Jujuy" },
  { code: "911", name: "La Pampa", padron: null, agency: "DGR La Pampa" },
  { code: "912", name: "La Rioja", padron: null, agency: "DGIP La Rioja" },
  { code: "913", name: "Mendoza", padron: null, agency: "ATM Mendoza" },
  { code: "914", name: "Misiones", padron: null, agency: "DGR Misiones" },
  { code: "915", name: "Neuquén", padron: null, agency: "DPR Neuquén" },
  { code: "916", name: "Río Negro", padron: null, agency: "ART Río Negro" },
  { code: "917", name: "Salta", padron: null, agency: "DGR Salta" },
  { code: "918", name: "San Juan", padron: null, agency: "DGR San Juan" },
  { code: "919", name: "San Luis", padron: null, agency: "DPIP San Luis" },
  { code: "920", name: "Santa Cruz", padron: null, agency: "ASIP Santa Cruz" },
  { code: "921", name: "Santa Fe", padron: null, agency: "API Santa Fe" },
  { code: "922", name: "Santiago del Estero", padron: null, agency: "DGR Santiago del Estero" },
  { code: "923", name: "Tierra del Fuego", padron: null, agency: "AREF" },
  { code: "924", name: "Tucumán", padron: null, agency: "DGR Tucumán" },
];

export function jurisdictionName(code: string | null | undefined): string {
  if (!code) return "";
  return JURISDICTIONS.find((j) => j.code === code)?.name ?? code;
}

// ── Tributos de WSFE (FEParamGetTiposTributos, orientativo) ───────────────

export const ARCA_TRIBUTO = {
  internos: 4,
  percepcion_iva: 6,
  percepcion_iibb: 7,
} as const;
