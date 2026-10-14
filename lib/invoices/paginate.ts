// Paginación del comprobante A4 (ADR-119). PURO.
//
// Con muchos renglones la factura no entra en una hoja: el detalle se parte en
// varias y cada hoja repite encabezado, emisor y receptor; totales, pie fiscal
// (QR y CAE) y leyendas van sólo en la última. El render no mide el DOM (los
// modelos se pueden dibujar en el servidor), así que se ESTIMA el alto de cada
// renglón con la letra, la densidad, el largo de la descripción, las líneas de
// detalle (ADR-116) y la foto. Las capacidades son conservadoras: si aun así
// una hoja se estira, el PDF la achica para que entre en su página A4 (nunca
// se corta un renglón por la mitad).

import type { InvoiceLine } from "./types";

export interface PaginateOptions {
  /** Factor del tamaño de letra (1 = normal). */
  fontScale?: number;
  /** Factor de la densidad (1 = normal). */
  density?: number;
  /** Tamaño de la foto del producto en px (0 = sin foto). */
  photo?: number;
  /** Modelo denso (Compacto de una hoja): más renglones por hoja. */
  dense?: boolean;
}

/** Alto disponible para renglones (px a 96 dpi) según la posición de la hoja. */
export const PAGE_ROWS_PX = {
  /** Única hoja: encabezado + totales + pie fiscal. */
  single: 430,
  /** Primera de varias: encabezado, sin totales ni pie. */
  first: 700,
  /** Del medio: encabezado compacto, sin totales ni pie. */
  middle: 700,
  /** Última de varias: encabezado + totales + pie. */
  last: 430,
};

const CHARS_PER_LINE = 58;

/** Alto estimado de un renglón en px. */
export function lineHeightPx(l: InvoiceLine, o: PaginateOptions = {}): number {
  const f = o.fontScale ?? 1;
  const d = o.density ?? 1;
  const textLine = 14.5 * f;
  const pad = (o.dense ? 8 : 16) * d;
  const descLines = Math.max(
    1,
    Math.ceil((l.description?.length ?? 0) / (CHARS_PER_LINE / f)),
  );
  const detail = (l.detailLines ?? []).reduce(
    (a, x) =>
      a + Math.max(1, Math.ceil(x.text.length / ((CHARS_PER_LINE + 8) / f))),
    0,
  );
  const text = descLines * textLine + detail * 13.5 * f;
  const photo = o.photo ? o.photo + 2 : 0;
  return Math.max(text, photo) + pad + 1;
}

/**
 * Parte los renglones en hojas. Devuelve los cortes [desde, hasta) de cada
 * hoja; siempre al menos una (aunque no haya renglones).
 */
export function paginateLines(
  lines: InvoiceLine[],
  o: PaginateOptions = {},
): [number, number][] {
  const k = o.dense ? 1.25 : 1;
  const cap = {
    single: PAGE_ROWS_PX.single * k,
    first: PAGE_ROWS_PX.first * k,
    middle: PAGE_ROWS_PX.middle * k,
    last: PAGE_ROWS_PX.last * k,
  };
  const h = lines.map((l) => lineHeightPx(l, o));
  const total = h.reduce((a, x) => a + x, 0);
  if (total <= cap.single) return [[0, lines.length]];

  const pages: [number, number][] = [];
  let start = 0;
  let used = 0;
  let room = cap.first;
  for (let i = 0; i < lines.length; i++) {
    if (used > 0 && used + h[i]! > room) {
      pages.push([start, i]);
      start = i;
      used = 0;
      room = cap.middle;
    }
    used += h[i]!;
  }
  // La última hoja tiene que dejar lugar a totales y pie fiscal: si lo que
  // quedó no entra, se pasa el excedente a una hoja final.
  const tail: number[] = [];
  let tailUsed = used;
  let end = lines.length;
  while (tailUsed > cap.last && end - start > 1) {
    end--;
    tailUsed -= h[end]!;
    tail.unshift(end);
  }
  pages.push([start, end]);
  if (tail.length) pages.push([end, lines.length]);
  return pages;
}
