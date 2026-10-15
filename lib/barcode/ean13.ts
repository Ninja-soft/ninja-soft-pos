// Generador de EAN-13 sin dependencias (ADR-148 · H24 etiquetas PRO).
// El código de góndola de casi todo producto envasado en Argentina (779...)
// es EAN-13: 12 dígitos de datos + 1 dígito verificador (módulo 10 GS1).
// Devuelve segmentos (barra/espacio) en módulos igual que code39.ts/code128.ts.

import type { BarSegment } from "./code39";
import { ean13CheckDigit, isValidEan13 } from "./scaleLabel";

// Codificación de cada dígito (7 módulos) en los tres juegos L, G y R.
const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
const R = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"];
// Paridad (L/G) de los 6 dígitos de la izquierda según el primer dígito.
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

/** Zona de silencio a cada lado (módulos): 11 a la izquierda, 7 a la derecha. */
export const EAN13_QUIET_LEFT = 11;
export const EAN13_QUIET_RIGHT = 7;

// El dígito verificador GS1 ya vive en scaleLabel.ts (etiquetas de balanza,
// ADR-063): se reusa y se re-exporta para no tener dos implementaciones.
export { ean13CheckDigit, isValidEan13 };

/**
 * Normaliza a EAN-13: 13 dígitos válidos se devuelven tal cual; 12 dígitos se
 * completan con el verificador. Cualquier otra cosa (letras, largo distinto
 * o verificador mal cargado) devuelve null y la etiqueta usa Code 128.
 */
export function toEan13(code: string | null | undefined): string | null {
  const c = (code ?? "").trim();
  if (isValidEan13(c)) return c;
  if (/^\d{12}$/.test(c)) return c + String(ean13CheckDigit(c));
  return null;
}

/** Bits (1 = barra) de los 95 módulos del símbolo, sin zona de silencio. */
export function ean13Bits(code: string): string {
  if (!isValidEan13(code)) throw new Error("ean13_invalid");
  const first = Number(code[0]);
  const parity = PARITY[first]!;
  let bits = "101";
  for (let i = 1; i <= 6; i++) {
    const d = Number(code[i]);
    bits += parity[i - 1] === "L" ? L[d] : G[d];
  }
  bits += "01010";
  for (let i = 7; i <= 12; i++) bits += R[Number(code[i])];
  bits += "101";
  return bits;
}

/** Segmentos barra/espacio (sin zona de silencio), 95 módulos en total. */
export function ean13Segments(code: string): BarSegment[] {
  const bits = ean13Bits(code);
  const segs: BarSegment[] = [];
  for (const b of bits) {
    const on = b === "1";
    const last = segs[segs.length - 1];
    if (last && last.on === on) last.width += 1;
    else segs.push({ on, width: 1 });
  }
  return segs;
}
