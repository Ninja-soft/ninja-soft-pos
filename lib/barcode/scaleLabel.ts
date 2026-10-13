// Etiquetas de balanza (F10 · H23, ADR-063). PURO.
//
// La balanza etiquetadora imprime un EAN-13 de "circulación restringida"
// (prefijos 20 a 29, GS1) con el producto y el precio o el peso embebidos:
//
//   [prefijo 2][código del producto N][dígito del valor?][valor][DV EAN]
//
//   • N (4 a 6) dígitos de código: el PLU o código corto del producto.
//   • Valor: el resto (10 - N, o uno menos si la balanza agrega el dígito
//     verificador del valor). Precio en pesos o peso en kg, con los
//     decimales que diga el formato (peso con 3 decimales = gramos).
//   • DV EAN: dígito verificador estándar del EAN-13.
//
// Espejo de la validación SQL scale_label_error() en
// supabase/migrations/20261026100100_balanza_cajon.sql. El formato se define
// por negocio o sucursal (pos_settings.scale_label, heredable, ADR-049).

export type ScaleEmbed = "price" | "weight";

export interface ScaleLabelFormat {
  /** Prefijos de 2 dígitos que son etiquetas de balanza ("20" a "29"). */
  prefixes: string[];
  /** Dígitos del código del producto (4 a 6). */
  codeDigits: number;
  /** Qué trae embebido: precio (importe) o peso. */
  embed: ScaleEmbed;
  /** Decimales del valor: precio 0 a 2; peso 3 = gramos. */
  decimals: number;
  /** La balanza agrega el dígito verificador del valor (GS1, sólo 4 o 5 dígitos). */
  valueCheckDigit: boolean;
  /** Validar el dígito verificador del EAN-13 (recomendado). */
  verifyCheckDigit: boolean;
}

export const ALL_SCALE_PREFIXES = ["20", "21", "22", "23", "24", "25", "26", "27", "28", "29"];

export const DEFAULT_SCALE_FORMAT: ScaleLabelFormat = {
  prefixes: [...ALL_SCALE_PREFIXES],
  codeDigits: 5,
  embed: "price",
  decimals: 0,
  valueCheckDigit: false,
  verifyCheckDigit: true,
};

/** Dígitos del valor según el formato. */
export function valueDigits(f: Pick<ScaleLabelFormat, "codeDigits" | "valueCheckDigit">): number {
  return 10 - f.codeDigits - (f.valueCheckDigit ? 1 : 0);
}

/** Problema del formato (null = válido). Mensajes para el dueño. */
export function scaleFormatProblem(f: ScaleLabelFormat): string | null {
  if (!f.prefixes.length) return "Elegí al menos un prefijo.";
  if (f.prefixes.some((p) => !/^2[0-9]$/.test(p))) return "Los prefijos de balanza van del 20 al 29.";
  if (!Number.isInteger(f.codeDigits) || f.codeDigits < 4 || f.codeDigits > 6) {
    return "El código del producto tiene que tener entre 4 y 6 dígitos.";
  }
  if (!Number.isInteger(f.decimals) || f.decimals < 0 || f.decimals > 3) return "Los decimales van de 0 a 3.";
  const len = valueDigits(f);
  if (f.valueCheckDigit && len !== 4 && len !== 5) {
    return "El dígito verificador del valor sólo existe para valores de 4 o 5 dígitos.";
  }
  if (f.decimals > len) return "Hay más decimales que dígitos de valor.";
  return null;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Lee el jsonb de pos_settings.scale_label (snake_case) y lo sanea. */
export function parseScaleFormat(raw: unknown): ScaleLabelFormat {
  const o = obj(raw);
  const prefixes = Array.isArray(o.prefixes)
    ? [...new Set(o.prefixes.filter((p): p is string => typeof p === "string" && /^2[0-9]$/.test(p)))].sort()
    : [];
  const n = Number(o.code_digits);
  const dec = Number(o.decimals);
  const f: ScaleLabelFormat = {
    prefixes: prefixes.length ? prefixes : [...DEFAULT_SCALE_FORMAT.prefixes],
    codeDigits: Number.isInteger(n) && n >= 4 && n <= 6 ? n : DEFAULT_SCALE_FORMAT.codeDigits,
    embed: o.embed === "weight" ? "weight" : "price",
    decimals: Number.isInteger(dec) && dec >= 0 && dec <= 3 ? dec : DEFAULT_SCALE_FORMAT.decimals,
    valueCheckDigit: o.value_check_digit === true,
    verifyCheckDigit: o.verify_check_digit !== false,
  };
  // Un formato guardado incoherente cae al default antes que leer mal.
  return scaleFormatProblem(f) ? { ...DEFAULT_SCALE_FORMAT } : f;
}

/** Formato → jsonb de pos_settings.scale_label. */
export function serializeScaleFormat(f: ScaleLabelFormat): Record<string, unknown> {
  return {
    prefixes: [...f.prefixes].sort(),
    code_digits: f.codeDigits,
    embed: f.embed,
    decimals: f.decimals,
    value_check_digit: f.valueCheckDigit,
    verify_check_digit: f.verifyCheckDigit,
  };
}

// ── Dígitos verificadores ────────────────────────────────────────────────────

/** DV del EAN-13 para los primeros 12 dígitos. */
export function ean13CheckDigit(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(code: string): boolean {
  return /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

// Factores de ponderación de GS1 para el dígito verificador del precio
// (Especificaciones Generales, "price check digit"). Cada tabla da el
// producto ya reducido a un dígito.
const W2M = [0, 2, 4, 6, 8, 9, 1, 3, 5, 7]; // 2-
const W3 = [0, 3, 6, 9, 2, 5, 8, 1, 4, 7]; // 3
const W5P = [0, 5, 1, 6, 2, 7, 3, 8, 4, 9]; // 5+
const W5M = [0, 5, 9, 4, 8, 3, 7, 2, 6, 1]; // 5-

/** Dígito verificador de un valor de 4 o 5 dígitos (GS1). null si no aplica. */
export function valueCheckDigit(value: string): number | null {
  const d = value.split("").map(Number);
  if (value.length === 4 && d.every((x) => x >= 0 && x <= 9)) {
    const s = W2M[d[0]!]! + W2M[d[1]!]! + W3[d[2]!]! + W5M[d[3]!]!;
    return (s * 3) % 10;
  }
  if (value.length === 5 && d.every((x) => x >= 0 && x <= 9)) {
    const s = W5P[d[0]!]! + W2M[d[1]!]! + W5M[d[2]!]! + W5P[d[3]!]! + W2M[d[4]!]!;
    const r = (10 - (s % 10)) % 10;
    // El DV es el dígito cuyo producto 5- da r.
    return W5M.indexOf(r);
  }
  return null;
}

// ── Decodificar ──────────────────────────────────────────────────────────────

export type ScaleDecodeError = "check_digit" | "value_check_digit";

export type ScaleDecode =
  | {
      ok: true;
      prefix: string;
      /** Código del producto tal cual viene (con ceros a la izquierda). */
      itemCode: string;
      embed: ScaleEmbed;
      /** Precio en pesos o peso en kg, ya con los decimales aplicados. */
      value: number;
    }
  | { ok: false; error: ScaleDecodeError };

/**
 * ¿Es una etiqueta de balanza con este formato? null = no lo es (se busca
 * como código común). Con error = parece de balanza pero está mal leída.
 */
export function decodeScaleLabel(raw: string, f: ScaleLabelFormat): ScaleDecode | null {
  const code = raw.trim();
  if (!/^\d{13}$/.test(code)) return null;
  const prefix = code.slice(0, 2);
  if (!f.prefixes.includes(prefix)) return null;
  if (f.verifyCheckDigit && !isValidEan13(code)) return { ok: false, error: "check_digit" };
  const itemCode = code.slice(2, 2 + f.codeDigits);
  let pos = 2 + f.codeDigits;
  const len = valueDigits(f);
  let vcd: number | null = null;
  if (f.valueCheckDigit) {
    vcd = Number(code[pos]);
    pos += 1;
  }
  const digits = code.slice(pos, pos + len);
  if (vcd !== null && valueCheckDigit(digits) !== vcd) return { ok: false, error: "value_check_digit" };
  const value = Number(digits) / 10 ** f.decimals;
  return { ok: true, prefix, itemCode, embed: f.embed, value };
}

/** Códigos a buscar para el producto: tal cual, sin ceros y a 6 dígitos (PLU). */
export function productCodeCandidates(itemCode: string): string[] {
  const stripped = itemCode.replace(/^0+(?=\d)/, "");
  return [...new Set([itemCode, stripped, stripped.padStart(6, "0")])];
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Cantidad (kg) y monto de la línea. Peso embebido: el peso y el precio del
 * producto. Precio embebido: el importe de la etiqueta y el peso que resulta
 * del precio por kg (3 decimales; el total de la línea puede diferir unos
 * centavos del impreso por el redondeo del peso). null = no se puede calcular
 * (precio por kg en cero con precio embebido, o valor en cero).
 */
export function scaleLine(
  d: Extract<ScaleDecode, { ok: true }>,
  pricePerKg: number,
): { quantityKg: number; amount: number } | null {
  if (!(d.value > 0)) return null;
  if (d.embed === "weight") {
    const q = round(d.value, 3);
    return { quantityKg: q, amount: round(q * pricePerKg, 2) };
  }
  if (!(pricePerKg > 0)) return null;
  const q = round(d.value / pricePerKg, 3);
  if (!(q > 0)) return null;
  return { quantityKg: q, amount: round(d.value, 2) };
}

/** Arma una etiqueta (pruebas, simulador y vista previa del formato). */
export function buildScaleLabel(f: ScaleLabelFormat, prefix: string, itemCode: string, value: number): string {
  const len = valueDigits(f);
  const v = String(Math.round(value * 10 ** f.decimals)).padStart(len, "0");
  if (v.length > len) throw new Error("value_too_large");
  const code = itemCode.padStart(f.codeDigits, "0").slice(-f.codeDigits);
  const vcd = f.valueCheckDigit ? String(valueCheckDigit(v) ?? 0) : "";
  const first12 = `${prefix}${code}${vcd}${v}`;
  return `${first12}${ean13CheckDigit(first12)}`;
}

/** Mensaje para el cajero cuando la etiqueta está mal leída. */
export function scaleDecodeErrorMessage(e: ScaleDecodeError): string {
  return e === "check_digit"
    ? "La etiqueta de balanza no pasó el dígito verificador: volvé a escanearla."
    : "El importe de la etiqueta no coincide con su dígito verificador: volvé a escanearla.";
}
