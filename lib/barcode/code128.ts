// Generador de código de barras Code 128 (subconjunto B) sin dependencias
// (ADR-142). Lo usa la etiqueta de producto de Mercado Libre Full: el código
// de inventario de ML (inventory_id, p. ej. "LCQI05831") es alfanumérico y los
// lectores de los centros de Full leen Code 128. Code 39 (H24) también lo
// representaría, pero ocupa casi el doble de ancho y no entra legible en una
// etiqueta de 50 x 25 mm.
//
// Devuelve segmentos (barra/espacio) en módulos, igual que code39.ts, y un SVG
// listo para imprimir (negro sobre blanco, con zona de silencio).

import type { BarSegment } from "./code39";

// Anchos (barra, espacio, barra, espacio, barra, espacio) de los valores
// 0..105; 106 es el stop (7 elementos). Cada símbolo suma 11 módulos (el stop
// 13). Tabla estándar ISO/IEC 15417.
export const CODE128_PATTERNS: readonly string[] = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];

export const CODE128_START_B = 104;
export const CODE128_STOP = 106;
/** Zona de silencio a cada lado: 10 módulos (mínimo del estándar). */
export const CODE128_QUIET = 10;

/** ¿Se puede codificar en Code 128 B? ASCII imprimible (32..126). */
export function isCode128B(text: string): boolean {
  if (!text) return false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 32 || c > 126) return false;
  }
  return true;
}

/** Valores de los símbolos: start B, datos, checksum y stop. */
export function code128Values(text: string): number[] {
  if (!isCode128B(text)) throw new Error("code128_invalid");
  const data = Array.from(text, (ch) => ch.charCodeAt(0) - 32);
  let sum = CODE128_START_B;
  data.forEach((v, i) => {
    sum += v * (i + 1);
  });
  return [CODE128_START_B, ...data, sum % 103, CODE128_STOP];
}

/** Segmentos barra/espacio (sin zona de silencio). */
export function code128Segments(text: string): BarSegment[] {
  const segs: BarSegment[] = [];
  for (const v of code128Values(text)) {
    const p = CODE128_PATTERNS[v]!;
    for (let i = 0; i < p.length; i++) segs.push({ on: i % 2 === 0, width: Number(p[i]) });
  }
  return segs;
}

/** Ancho en módulos (sin zona de silencio): 11 por símbolo y 13 del stop. */
export function code128Width(text: string): number {
  return code128Segments(text).reduce((a, s) => a + s.width, 0);
}

/**
 * SVG del código. `width` y `height` en las unidades que se pidan (mm para
 * imprimir); las barras se escalan al ancho con la zona de silencio incluida.
 */
export function code128Svg(text: string, opts: { width: number; height: number; unit?: string }): string {
  const segs = code128Segments(text);
  const modules = segs.reduce((a, s) => a + s.width, 0) + CODE128_QUIET * 2;
  const unit = opts.unit ?? "mm";
  let x = CODE128_QUIET;
  const rects: string[] = [];
  for (const s of segs) {
    if (s.on) rects.push(`<rect x="${x}" y="0" width="${s.width}" height="100"/>`);
    x += s.width;
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${opts.width}${unit}" height="${opts.height}${unit}" ` +
    `viewBox="0 0 ${modules} 100" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" ` +
    `aria-label="Código ${escapeXml(text)}"><rect x="0" y="0" width="${modules}" height="100" fill="#fff"/>` +
    `<g fill="#000">${rects.join("")}</g></svg>`
  );
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
