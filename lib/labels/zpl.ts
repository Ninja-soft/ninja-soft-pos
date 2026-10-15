// Salida ZPL para etiquetadoras Zebra (y compatibles: Argox en modo ZPL,
// Xprinter, Honeywell) (ADR-148). Puro.
//
// El navegador imprime cualquier diseño; el ZPL es la opción "directa" para
// la Zebra: texto, precio, PLU, código de barras (EAN-13 o Code 128) y QR,
// con un diseño fijo y simple (la impresora dibuja con sus fuentes). Sale
// una orden ^XA…^XZ por fila del rollo (1, 2 o 3 columnas).

import { resolveCode } from "./barcodeSvg";
import type { LabelDesign } from "./designs";
import { formatPrice, type LabelItem } from "./items";
import type { MediaConfig } from "./media";

export type ZplDpi = 203 | 300;

/** Puntos por mm según la resolución del cabezal. */
export function dotsPerMm(dpi: ZplDpi): number {
  return dpi === 300 ? 11.81 : 8;
}

/** Texto apto para ZPL: sin acentos, sin ^ ni ~ (son comandos). */
export function zplText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[\^~]/g, " ")
    .trim();
}

function fitName(name: string, maxChars: number): string {
  const t = zplText(name);
  return t.length > maxChars ? `${t.slice(0, Math.max(1, maxChars - 1))}.` : t;
}

function labelZpl(item: LabelItem, d: LabelDesign, w: number, h: number, dpm: number, x0: number): string {
  const W = Math.round(w * dpm);
  const H = Math.round(h * dpm);
  const pad = Math.round(Math.min(w, h) * 0.06 * dpm);
  const nameH = Math.max(16, Math.round(H * 0.12));
  const priceH = Math.max(28, Math.round(H * 0.3));
  const smallH = Math.max(14, Math.round(H * 0.08));
  const qrOn = d.show.qr && !!item.qrUrl;
  const qrMag = Math.max(1, Math.min(10, Math.floor((Math.min(H - pad * 2, W * 0.32) / 37) * 1)));
  const qrW = qrOn ? qrMag * 37 : 0;
  const textW = W - pad * 2 - (qrOn ? qrW + pad : 0);
  const out: string[] = [];
  let y = pad;
  const name = d.uppercase ? item.name.toUpperCase() : item.name;
  if (d.show.name) {
    out.push(`^FO${x0 + pad},${y}^A0N,${nameH},${Math.round(nameH * 0.85)}^FB${textW},2,0,C^FD${fitName(name + (d.show.variant && item.variant ? ` ${item.variant}` : ""), 60)}^FS`);
    y += nameH * 2 + 4;
  }
  if (d.show.price) {
    out.push(`^FO${x0 + pad},${y}^A0N,${priceH},${Math.round(priceH * 0.9)}^FB${textW},1,0,C^FD${zplText(formatPrice(item.price, d.decimals))}^FS`);
    y += priceH + 4;
  }
  const meta: string[] = [];
  if (d.show.unitPrice && item.unitPrice) meta.push(`${formatPrice(item.unitPrice.value, "always")} x ${item.unitPrice.per}`);
  if (d.show.plu && item.plu) meta.push(`PLU ${item.plu}`);
  if (meta.length) {
    out.push(`^FO${x0 + pad},${y}^A0N,${smallH},${smallH}^FB${textW},1,0,C^FD${zplText(meta.join("  "))}^FS`);
    y += smallH + 4;
  }
  const code = d.show.barcode ? resolveCode(item.barcode, item.sku, d.symbology) : null;
  if (code) {
    const barH = Math.max(20, H - y - pad - smallH - 4);
    const mod = Math.max(1, Math.min(3, Math.floor(textW / (code.symbology === "ean13" ? 113 : (code.value.length + 3) * 11 + 20))));
    const codeW = code.symbology === "ean13" ? 113 * mod : ((code.value.length + 3) * 11 + 20) * mod;
    const bx = x0 + pad + Math.max(0, Math.round((textW - codeW) / 2));
    if (code.symbology === "ean13") out.push(`^FO${bx},${y}^BY${mod}^BEN,${barH},Y,N^FD${code.value.slice(0, 12)}^FS`);
    else if (code.symbology === "code39") out.push(`^FO${bx},${y}^BY${mod}^B3N,N,${barH},Y,N^FD${zplText(code.value)}^FS`);
    else out.push(`^FO${bx},${y}^BY${mod}^BCN,${barH},Y,N,N^FD${zplText(code.value)}^FS`);
  }
  if (qrOn) {
    const qx = x0 + W - pad - qrW;
    const qy = Math.max(pad, Math.round((H - qrW) / 2));
    out.push(`^FO${qx},${qy}^BQN,2,${qrMag}^FDMA,${zplText(item.qrUrl!)}^FS`);
  }
  return out.join("\n");
}

/**
 * ZPL de todas las etiquetas. Rollo de N columnas: cada ^XA…^XZ es una fila
 * con las etiquetas corridas en X. En hojas no aplica (se usa el navegador).
 */
export function buildZpl(items: LabelItem[], d: LabelDesign, media: MediaConfig, dpi: ZplDpi = 203): string {
  const dpm = dotsPerMm(dpi);
  const cols = media.kind === "thermal" ? media.cols : 1;
  const pw = Math.round(media.pageW * dpm);
  const ll = Math.round(media.labelH * dpm);
  const rows: string[] = [];
  for (let i = 0; i < items.length; i += cols) {
    const parts: string[] = [];
    for (let c = 0; c < cols && i + c < items.length; c++) {
      const x0 = Math.round((media.marginX + c * (media.labelW + media.gapX)) * dpm);
      parts.push(labelZpl(items[i + c]!, d, media.labelW, media.labelH, dpm, x0));
    }
    rows.push(`^XA\n^PW${pw}\n^LL${ll}\n^LH0,0\n^CI0\n${parts.join("\n")}\n^XZ`);
  }
  return rows.join("\n");
}
