// Tamaños de etiqueta y papel (ADR-148 · H24 etiquetas PRO). Lógica pura.
//
// Todo se mide en milímetros. Hay dos tipos de soporte:
//  - "thermal": rollo de etiquetadora térmica (Zebra, Argox, Brother, Xprinter).
//    Cada "página" de impresión es UNA fila del rollo: alto = alto de la
//    etiqueta y ancho = columnas × ancho + separaciones + márgenes del liner.
//    El navegador recibe @page exacto y corta una página por fila (nunca
//    estira la etiqueta al alto de una hoja).
//  - "sheet": hoja A4 / Carta / Oficio con grilla filas × columnas, márgenes,
//    separación y marcas de corte opcionales. Se puede saltear las primeras N
//    etiquetas de la primera hoja (hojas autoadhesivas ya usadas).

export type MediaKind = "thermal" | "sheet";

export interface MediaConfig {
  kind: MediaKind;
  /** Clave del preset elegido ("custom" si se tocó a mano). */
  preset: string;
  /** Térmica: tamaño de cada etiqueta. Hoja: se calcula desde la grilla. */
  labelW: number;
  labelH: number;
  /** Columnas (térmica: etiquetas a lo ancho del rollo; hoja: columnas). */
  cols: number;
  /** Filas por hoja (térmica: siempre 1). */
  rows: number;
  /** Hoja: tamaño del papel. */
  pageW: number;
  pageH: number;
  /** Márgenes del papel (hoja) o del liner a cada lado (térmica). */
  marginX: number;
  marginY: number;
  /** Separación entre etiquetas. */
  gapX: number;
  gapY: number;
  /** Hoja: dibujar marcas de corte en las esquinas de cada etiqueta. */
  cutMarks: boolean;
}

export interface ThermalPreset {
  key: string;
  label: string;
  hint: string;
  labelW: number;
  labelH: number;
  cols: number;
  gapX: number;
  marginX: number;
}

/** Presets de etiquetadoras térmicas comunes (rollo de 1, 2 o 3 columnas). */
export const THERMAL_PRESETS: ThermalPreset[] = [
  { key: "t30x20", label: "30 × 20 mm", hint: "Góndola chica, cosmética", labelW: 30, labelH: 20, cols: 1, gapX: 0, marginX: 0 },
  { key: "t40x25", label: "40 × 25 mm", hint: "Almacén y kiosco", labelW: 40, labelH: 25, cols: 1, gapX: 0, marginX: 0 },
  { key: "t50x25", label: "50 × 25 mm", hint: "La más usada en góndola", labelW: 50, labelH: 25, cols: 1, gapX: 0, marginX: 0 },
  { key: "t50x30", label: "50 × 30 mm", hint: "Góndola con código grande", labelW: 50, labelH: 30, cols: 1, gapX: 0, marginX: 0 },
  { key: "t58x40", label: "58 × 40 mm", hint: "Rollo de 58 mm", labelW: 58, labelH: 40, cols: 1, gapX: 0, marginX: 0 },
  { key: "t60x40", label: "60 × 40 mm", hint: "Precio grande, ofertas", labelW: 60, labelH: 40, cols: 1, gapX: 0, marginX: 0 },
  { key: "t100x50", label: "100 × 50 mm", hint: "Cartel de oferta chico", labelW: 100, labelH: 50, cols: 1, gapX: 0, marginX: 0 },
  { key: "t100x150", label: "100 × 150 mm", hint: "Cartel o etiqueta de envío", labelW: 100, labelH: 150, cols: 1, gapX: 0, marginX: 0 },
  { key: "t35x55", label: "Colgante 35 × 55 mm", hint: "Ropa, regalería (con agujero)", labelW: 35, labelH: 55, cols: 1, gapX: 0, marginX: 0 },
  { key: "t2x40x25", label: "2 columnas · 40 × 25 mm", hint: "Rollo de 84 mm", labelW: 40, labelH: 25, cols: 2, gapX: 2, marginX: 1 },
  { key: "t2x50x25", label: "2 columnas · 50 × 25 mm", hint: "Rollo de 104 mm", labelW: 50, labelH: 25, cols: 2, gapX: 2, marginX: 1 },
  { key: "t3x30x20", label: "3 columnas · 30 × 20 mm", hint: "Rollo de 96 mm", labelW: 30, labelH: 20, cols: 3, gapX: 2, marginX: 1 },
];

export interface SheetPreset {
  key: string;
  label: string;
  hint: string;
  pageW: number;
  pageH: number;
  cols: number;
  rows: number;
  marginX: number;
  marginY: number;
  gapX: number;
  gapY: number;
}

export const PAPER_SIZES = {
  a4: { label: "A4", w: 210, h: 297 },
  letter: { label: "Carta", w: 215.9, h: 279.4 },
  legal: { label: "Oficio", w: 216, h: 356 },
} as const;

/** Grillas habituales de hojas autoadhesivas (o para recortar). */
export const SHEET_PRESETS: SheetPreset[] = [
  { key: "a4_3x8", label: "A4 · 24 por hoja (3 × 8)", hint: "70 × 37 mm, autoadhesiva común", pageW: 210, pageH: 297, cols: 3, rows: 8, marginX: 0, marginY: 0.5, gapX: 0, gapY: 0 },
  { key: "a4_3x7", label: "A4 · 21 por hoja (3 × 7)", hint: "70 × 42 mm", pageW: 210, pageH: 297, cols: 3, rows: 7, marginX: 0, marginY: 0.5, gapX: 0, gapY: 0 },
  { key: "a4_4x10", label: "A4 · 40 por hoja (4 × 10)", hint: "48 × 25 mm, góndola", pageW: 210, pageH: 297, cols: 4, rows: 10, marginX: 9, marginY: 23.5, gapX: 0, gapY: 0 },
  { key: "a4_5x13", label: "A4 · 65 por hoja (5 × 13)", hint: "38 × 21 mm, chiquitas", pageW: 210, pageH: 297, cols: 5, rows: 13, marginX: 4.75, marginY: 10.7, gapX: 2.5, gapY: 0 },
  { key: "a4_2x7", label: "A4 · 14 por hoja (2 × 7)", hint: "99 × 38 mm, oferta", pageW: 210, pageH: 297, cols: 2, rows: 7, marginX: 4.7, marginY: 15.15, gapX: 2.5, gapY: 0 },
  { key: "a4_cut_3x6", label: "A4 para recortar (3 × 6)", hint: "Con marcas de corte", pageW: 210, pageH: 297, cols: 3, rows: 6, marginX: 10, marginY: 10, gapX: 4, gapY: 4 },
  { key: "letter_3x10", label: "Carta · 30 por hoja (3 × 10)", hint: "67 × 25 mm", pageW: 215.9, pageH: 279.4, cols: 3, rows: 10, marginX: 4.8, marginY: 12.7, gapX: 3.2, gapY: 0 },
];

/** Límites razonables (el editor no deja salir de acá). */
export const MEDIA_LIMITS = {
  minLabel: 10,
  maxLabelW: 200,
  maxLabelH: 300,
  maxCols: 10,
  maxRows: 30,
  maxThermalCols: 4,
};

const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);
export const round2 = (n: number) => Math.round(n * 100) / 100;

export function thermalMedia(p: ThermalPreset): MediaConfig {
  const pageW = p.cols * p.labelW + (p.cols - 1) * p.gapX + p.marginX * 2;
  return {
    kind: "thermal",
    preset: p.key,
    labelW: p.labelW,
    labelH: p.labelH,
    cols: p.cols,
    rows: 1,
    pageW: round2(pageW),
    pageH: p.labelH,
    marginX: p.marginX,
    marginY: 0,
    gapX: p.gapX,
    gapY: 0,
    cutMarks: false,
  };
}

export function sheetMedia(p: SheetPreset, cutMarks = p.key.includes("cut")): MediaConfig {
  return normalizeMedia({
    kind: "sheet",
    preset: p.key,
    labelW: 0,
    labelH: 0,
    cols: p.cols,
    rows: p.rows,
    pageW: p.pageW,
    pageH: p.pageH,
    marginX: p.marginX,
    marginY: p.marginY,
    gapX: p.gapX,
    gapY: p.gapY,
    cutMarks,
  });
}

export const DEFAULT_MEDIA: MediaConfig = thermalMedia(THERMAL_PRESETS[2]!);

export function mediaFromPreset(key: string): MediaConfig | null {
  const t = THERMAL_PRESETS.find((p) => p.key === key);
  if (t) return thermalMedia(t);
  const s = SHEET_PRESETS.find((p) => p.key === key);
  if (s) return sheetMedia(s);
  return null;
}

/**
 * Deja la configuración coherente:
 *  - térmica: ancho de página = columnas × etiqueta + separaciones + liner; alto = etiqueta.
 *  - hoja: el tamaño de cada etiqueta sale de repartir el papel útil entre la grilla.
 * Valores fuera de rango se acotan; nunca devuelve tamaños negativos.
 */
export function normalizeMedia(m: MediaConfig): MediaConfig {
  if (m.kind === "thermal") {
    const cols = Math.round(clamp(m.cols, 1, MEDIA_LIMITS.maxThermalCols));
    const labelW = round2(clamp(m.labelW, MEDIA_LIMITS.minLabel, MEDIA_LIMITS.maxLabelW));
    const labelH = round2(clamp(m.labelH, MEDIA_LIMITS.minLabel, MEDIA_LIMITS.maxLabelH));
    const gapX = cols > 1 ? round2(clamp(m.gapX, 0, 20)) : 0;
    const marginX = round2(clamp(m.marginX, 0, 20));
    return {
      ...m,
      kind: "thermal",
      cols,
      rows: 1,
      labelW,
      labelH,
      gapX,
      gapY: 0,
      marginX,
      marginY: 0,
      pageW: round2(cols * labelW + (cols - 1) * gapX + marginX * 2),
      pageH: labelH,
      cutMarks: false,
    };
  }
  const pageW = round2(clamp(m.pageW, 50, 500));
  const pageH = round2(clamp(m.pageH, 50, 500));
  const cols = Math.round(clamp(m.cols, 1, MEDIA_LIMITS.maxCols));
  const rows = Math.round(clamp(m.rows, 1, MEDIA_LIMITS.maxRows));
  const marginX = round2(clamp(m.marginX, 0, pageW / 3));
  const marginY = round2(clamp(m.marginY, 0, pageH / 3));
  const gapX = round2(clamp(m.gapX, 0, 30));
  const gapY = round2(clamp(m.gapY, 0, 30));
  const labelW = round2(Math.max(5, (pageW - marginX * 2 - gapX * (cols - 1)) / cols));
  const labelH = round2(Math.max(5, (pageH - marginY * 2 - gapY * (rows - 1)) / rows));
  return { ...m, kind: "sheet", pageW, pageH, cols, rows, marginX, marginY, gapX, gapY, labelW, labelH };
}

/** Etiquetas por página (térmica: por fila del rollo). */
export function labelsPerPage(m: MediaConfig): number {
  return m.kind === "thermal" ? m.cols : m.cols * m.rows;
}

export interface Cell {
  /** Posición de la esquina superior izquierda dentro de la página (mm). */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Posición de cada etiqueta dentro de una página, de izquierda a derecha y de arriba abajo. */
export function cellPositions(m: MediaConfig): Cell[] {
  const cells: Cell[] = [];
  const rows = m.kind === "thermal" ? 1 : m.rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < m.cols; c++) {
      cells.push({
        x: round2(m.marginX + c * (m.labelW + m.gapX)),
        y: round2(m.marginY + r * (m.labelH + m.gapY)),
        w: m.labelW,
        h: m.labelH,
      });
    }
  }
  return cells;
}

/**
 * Reparte las etiquetas en páginas. `skip` (sólo hojas) deja vacías las
 * primeras posiciones de la primera hoja para aprovechar una hoja ya usada.
 * Cada página es un arreglo de largo `labelsPerPage` con `null` en los huecos.
 */
export function paginateLabels<T>(items: T[], m: MediaConfig, skip = 0): (T | null)[][] {
  const per = labelsPerPage(m);
  const lead = m.kind === "sheet" ? Math.max(0, Math.min(per - 1, Math.floor(skip) || 0)) : 0;
  const slots: (T | null)[] = [...Array<null>(lead).fill(null), ...items];
  const pages: (T | null)[][] = [];
  for (let i = 0; i < slots.length; i += per) {
    const page = slots.slice(i, i + per);
    while (page.length < per) page.push(null);
    pages.push(page);
  }
  return pages;
}

/** Texto corto del tamaño para la UI ("50 × 25 mm · 2 columnas"). */
export function mediaSummary(m: MediaConfig): string {
  const size = `${fmtMm(m.labelW)} × ${fmtMm(m.labelH)} mm`;
  if (m.kind === "thermal") return m.cols > 1 ? `${size} · ${m.cols} columnas` : size;
  const paper = Object.values(PAPER_SIZES).find((p) => Math.abs(p.w - m.pageW) < 0.5 && Math.abs(p.h - m.pageH) < 0.5);
  return `${paper?.label ?? `${fmtMm(m.pageW)} × ${fmtMm(m.pageH)} mm`} · ${m.cols * m.rows} por hoja (${size})`;
}

export function fmtMm(n: number): string {
  return String(round2(n)).replace(".", ",");
}
