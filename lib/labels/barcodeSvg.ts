// Código de barras de la etiqueta como SVG en milímetros (ADR-148). Puro.
// Elige la simbología: EAN-13 si el código es un EAN válido (o 12 dígitos),
// si no Code 128 (más angosto que Code 39); Code 39 queda como opción manual.

import { code39Segments, sanitizeCode39, type BarSegment } from "@/lib/barcode/code39";
import { code128Segments, isCode128B, escapeXml } from "@/lib/barcode/code128";
import { ean13Bits, toEan13 } from "@/lib/barcode/ean13";
import type { Symbology } from "./designs";

export interface ResolvedCode {
  symbology: "ean13" | "code128" | "code39";
  value: string;
}

/** Valor y simbología del código de una etiqueta (barcode > SKU). Null si no hay. */
export function resolveCode(barcode: string | null, sku: string | null, pref: Symbology = "auto"): ResolvedCode | null {
  const raw = (barcode || sku || "").trim();
  if (!raw) return null;
  const ean = toEan13(barcode?.trim() ?? null);
  if ((pref === "auto" || pref === "ean13") && ean) return { symbology: "ean13", value: ean };
  if (pref === "code39") {
    const v = sanitizeCode39(raw);
    return v ? { symbology: "code39", value: v } : null;
  }
  if (isCode128B(raw)) return { symbology: "code128", value: raw };
  const ascii = raw.replace(/[^\x20-\x7e]/g, "");
  return ascii ? { symbology: "code128", value: ascii } : null;
}

/** Módulos totales (con zona de silencio) para dimensionar el ancho mínimo legible. */
export function codeModules(c: ResolvedCode): number {
  if (c.symbology === "ean13") return 95 + 18;
  const segs = c.symbology === "code39" ? code39Segments(c.value) : code128Segments(c.value);
  return segs.reduce((a, s) => a + s.width, 0) + 20;
}

/** Ancho mínimo recomendado (mm) con módulo de 0,25 mm: debajo de eso cuesta leerlo. */
export function minCodeWidthMm(c: ResolvedCode): number {
  return Math.round(codeModules(c) * 0.25 * 10) / 10;
}

function barsSvg(segs: BarSegment[], quiet: number, w: number, h: number, label: string, text: string | null, fontMm: number): string {
  const modules = segs.reduce((a, s) => a + s.width, 0) + quiet * 2;
  const textH = text ? fontMm * 1.15 : 0;
  const barH = Math.max(1, h - textH);
  // viewBox en módulos × mm de alto; preserveAspectRatio none estira sólo el ancho.
  let x = quiet;
  const rects: string[] = [];
  for (const s of segs) {
    if (s.on) rects.push(`<rect x="${x}" y="0" width="${s.width}" height="${barH.toFixed(2)}"/>`);
    x += s.width;
  }
  const bars =
    `<svg x="0" y="0" width="${w}mm" height="${barH.toFixed(2)}mm" viewBox="0 0 ${modules} ${barH.toFixed(2)}" ` +
    `preserveAspectRatio="none" shape-rendering="crispEdges"><g fill="#000">${rects.join("")}</g></svg>`;
  const caption = text
    ? `<div class="bc-t" style="font-size:${fontMm.toFixed(2)}mm;line-height:${textH.toFixed(2)}mm">${escapeXml(text)}</div>`
    : "";
  return `<div class="bc" role="img" aria-label="${escapeXml(label)}" style="width:${w}mm;height:${h}mm">${bars}${caption}</div>`;
}

function ean13Svg(code: string, w: number, h: number, fontMm: number, withText: boolean): string {
  const bits = ean13Bits(code);
  const quietL = 11;
  const quietR = 7;
  const modules = 95 + quietL + quietR;
  const textH = withText ? fontMm * 1.15 : 0;
  const barH = Math.max(1, h - textH);
  // Las guardas (inicio, centro y fin) bajan hasta la mitad de los dígitos.
  const guardH = withText ? barH + textH * 0.55 : barH;
  const guards = new Set([0, 2, 46, 48, 92, 94]);
  const rects: string[] = [];
  let i = 0;
  while (i < bits.length) {
    if (bits[i] !== "1") {
      i++;
      continue;
    }
    let j = i;
    while (j < bits.length && bits[j] === "1") j++;
    const tall = guards.has(i);
    rects.push(`<rect x="${quietL + i}" y="0" width="${j - i}" height="${(tall ? guardH : barH).toFixed(2)}"/>`);
    i = j;
  }
  const pct = (m: number) => `${((m / modules) * 100).toFixed(3)}%`;
  // Dígitos en las posiciones del estándar: 1 afuera a la izquierda y 6 + 6
  // debajo de cada mitad (entre las guardas).
  const digits = withText
    ? `<div class="bc-ean" style="font-size:${fontMm.toFixed(2)}mm;height:${textH.toFixed(2)}mm;line-height:${textH.toFixed(2)}mm">` +
      `<span style="left:0;width:${pct(quietL - 1)};text-align:right">${code[0]}</span>` +
      `<span style="left:${pct(quietL + 3)};width:${pct(42)}">${code.slice(1, 7)}</span>` +
      `<span style="left:${pct(quietL + 50)};width:${pct(42)}">${code.slice(7)}</span>` +
      `</div>`
    : "";
  return (
    `<div class="bc" role="img" aria-label="EAN-13 ${code}" style="width:${w}mm;height:${h}mm">` +
    `<svg width="${w}mm" height="${h}mm" viewBox="0 0 ${modules} ${h.toFixed(2)}" preserveAspectRatio="none" shape-rendering="crispEdges">` +
    `<g fill="#000">${rects.join("")}</g></svg>${digits}</div>`
  );
}

/**
 * HTML del código (SVG + texto legible) de exactamente `w` × `h` mm.
 * `fontMm` es el tamaño de los dígitos; `withText` los muestra.
 */
export function codeHtml(c: ResolvedCode, w: number, h: number, fontMm: number, withText = true): string {
  if (c.symbology === "ean13") return ean13Svg(c.value, w, h, fontMm, withText);
  const segs = c.symbology === "code39" ? code39Segments(c.value) : code128Segments(c.value);
  return barsSvg(segs, 10, w, h, `${c.symbology === "code39" ? "Code 39" : "Code 128"} ${c.value}`, withText ? c.value : null, fontMm);
}
