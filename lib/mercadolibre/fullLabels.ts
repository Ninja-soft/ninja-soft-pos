// =============================================================================
// lib/mercadolibre/fullLabels.ts (ADR-142). PURO: etiquetas para Full.
//
// Etiqueta de PRODUCTO (una por unidad): el código de inventario de Mercado
// Libre (inventory_id) en Code 128 con el código legible abajo, el título y la
// variante. Es lo que el centro de Full escanea para identificar la unidad:
// tiene que tapar cualquier otro código de barras del producto.
// Etiqueta de BULTO (una por caja): número del envío de ML, "Bulto i de N",
// cuenta y origen, con el número en Code 128. Mercado Libre entrega su propia
// etiqueta de bulto al crear el envío; ésta sirve para ordenar la preparación
// y no la reemplaza.
//
// Formatos: rollo térmico (una etiqueta por hoja del tamaño de la etiqueta) u
// hoja A4 con grilla. El HTML sale listo para imprimir sin escala.
// Reutiliza la idea de H24 (lib/labels: expandir la selección por copias) con
// Code 128 en lugar de Code 39 (ver lib/barcode/code128.ts).
// =============================================================================
import { code128Svg, escapeXml, isCode128B } from "@/lib/barcode/code128";

export type FullLabelFormatKey = "thermal_50x25" | "thermal_60x40" | "thermal_100x50" | "a4_65" | "a4_44" | "a4_24";

export interface FullLabelFormat {
  key: FullLabelFormatKey;
  label: string;
  kind: "thermal" | "a4";
  /** Tamaño de cada etiqueta en mm. */
  width: number;
  height: number;
  /** Sólo A4: columnas, filas y márgenes de la hoja (mm). */
  cols?: number;
  rows?: number;
  marginTop?: number;
  marginLeft?: number;
  gapX?: number;
  gapY?: number;
}

export const FULL_LABEL_FORMATS: Record<FullLabelFormatKey, FullLabelFormat> = {
  thermal_50x25: { key: "thermal_50x25", label: "Rollo térmico 50 x 25 mm", kind: "thermal", width: 50, height: 25 },
  thermal_60x40: { key: "thermal_60x40", label: "Rollo térmico 60 x 40 mm", kind: "thermal", width: 60, height: 40 },
  thermal_100x50: { key: "thermal_100x50", label: "Rollo térmico 100 x 50 mm (bultos)", kind: "thermal", width: 100, height: 50 },
  a4_65: {
    key: "a4_65", label: "Hoja A4, 65 etiquetas (38,1 x 21,2 mm)", kind: "a4", width: 38.1, height: 21.2,
    cols: 5, rows: 13, marginTop: 10.7, marginLeft: 4.7, gapX: 2.5, gapY: 0,
  },
  a4_44: {
    key: "a4_44", label: "Hoja A4, 44 etiquetas (48,5 x 25,4 mm)", kind: "a4", width: 48.5, height: 25.4,
    cols: 4, rows: 11, marginTop: 8.8, marginLeft: 8, gapX: 0, gapY: 0,
  },
  a4_24: {
    key: "a4_24", label: "Hoja A4, 24 etiquetas (70 x 37 mm)", kind: "a4", width: 70, height: 37,
    cols: 3, rows: 8, marginTop: 0.5, marginLeft: 0, gapX: 0, gapY: 0,
  },
};

export function labelFormat(key: string | null | undefined): FullLabelFormat {
  return FULL_LABEL_FORMATS[(key ?? "") as FullLabelFormatKey] ?? FULL_LABEL_FORMATS.thermal_50x25;
}

/** Etiquetas por hoja (1 en rollo). */
export function labelsPerSheet(f: FullLabelFormat): number {
  return f.kind === "a4" ? (f.cols ?? 1) * (f.rows ?? 1) : 1;
}

export interface UnitLabel {
  inventoryId: string;
  title: string;
  variation: string | null;
  sku: string | null;
}

export interface BoxLabel {
  mlInboundId: string;
  index: number;
  total: number;
  account: string;
  origin: string;
  number: number | string;
  date: string;
}

export const MAX_UNIT_LABELS = 5000;

/**
 * Una etiqueta por unidad. Las líneas sin código de inventario válido no se
 * imprimen (se devuelven aparte para avisar).
 */
export function expandUnitLabels(
  lines: Array<{ inventory_id: string | null; title: string; variation_label?: string | null; sku?: string | null; qty: number }>,
): { labels: UnitLabel[]; skipped: string[]; truncated: boolean } {
  const labels: UnitLabel[] = [];
  const skipped: string[] = [];
  let truncated = false;
  for (const l of lines) {
    const inv = (l.inventory_id ?? "").trim().toUpperCase();
    const qty = Math.max(0, Math.floor(Number(l.qty) || 0));
    if (!/^[A-Z0-9]{4,30}$/.test(inv) || !isCode128B(inv)) {
      if (qty > 0) skipped.push(l.title);
      continue;
    }
    for (let i = 0; i < qty; i++) {
      if (labels.length >= MAX_UNIT_LABELS) {
        truncated = true;
        break;
      }
      labels.push({ inventoryId: inv, title: l.title, variation: l.variation_label ?? null, sku: l.sku ?? null });
    }
  }
  return { labels, skipped, truncated };
}

export function boxLabels(b: Omit<BoxLabel, "index" | "total">, boxes: number): BoxLabel[] {
  const n = Math.min(Math.max(1, Math.floor(boxes) || 1), 999);
  return Array.from({ length: n }, (_, i) => ({ ...b, index: i + 1, total: n }));
}

/** Título acortado para que entre en la etiqueta (por tamaño). */
export function shortTitle(title: string, f: FullLabelFormat): string {
  const max = Math.round(f.width * (f.height >= 30 ? 2.2 : 1.5));
  const t = title.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function unitInner(l: UnitLabel, f: FullLabelFormat): string {
  const pad = Math.min(2, f.height * 0.06);
  const barH = Math.max(7, Math.round(f.height * 0.42 * 10) / 10);
  const barW = Math.round((f.width - pad * 2) * 10) / 10;
  const fs = Math.max(1.9, Math.min(3.2, f.height * 0.1));
  return (
    `<div class="u" style="padding:${pad}mm">` +
    `<div class="t" style="font-size:${fs}mm">${escapeXml(shortTitle(l.title, f))}</div>` +
    (l.variation ? `<div class="v" style="font-size:${fs * 0.9}mm">${escapeXml(l.variation)}</div>` : "") +
    `<div class="b">${code128Svg(l.inventoryId, { width: barW, height: barH })}</div>` +
    `<div class="c" style="font-size:${fs * 1.15}mm">${escapeXml(l.inventoryId)}</div>` +
    `</div>`
  );
}

function boxInner(b: BoxLabel, f: FullLabelFormat): string {
  const pad = Math.min(3, f.height * 0.06);
  const fs = Math.max(2.4, Math.min(5, f.height * 0.09));
  const barW = Math.round((f.width - pad * 2) * 10) / 10;
  const barH = Math.max(8, Math.round(f.height * 0.3 * 10) / 10);
  return (
    `<div class="u" style="padding:${pad}mm">` +
    `<div class="t" style="font-size:${fs}mm">Envío a Full · ML ${escapeXml(b.mlInboundId)}</div>` +
    `<div class="big" style="font-size:${fs * 1.8}mm">Bulto ${b.index} de ${b.total}</div>` +
    `<div class="b">${code128Svg(b.mlInboundId, { width: barW, height: barH })}</div>` +
    `<div class="v" style="font-size:${fs * 0.8}mm">${escapeXml(b.account)} · ${escapeXml(b.origin)} · N° ${escapeXml(String(b.number))} · ${escapeXml(b.date)}</div>` +
    `</div>`
  );
}

/** Reparte etiquetas en hojas (A4) o una por hoja (rollo). */
export function paginate<T>(items: T[], f: FullLabelFormat): T[][] {
  const per = labelsPerSheet(f);
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += per) pages.push(items.slice(i, i + per));
  return pages;
}

const BASE_CSS =
  "*{box-sizing:border-box;margin:0;padding:0}html,body{background:#fff;color:#000;font-family:Arial,Helvetica,sans-serif}" +
  ".sheet{position:relative;overflow:hidden;page-break-after:always;break-after:page}" +
  ".sheet:last-child{page-break-after:auto;break-after:auto}" +
  ".cell{position:absolute;overflow:hidden}" +
  ".u{width:100%;height:100%;display:flex;flex-direction:column;justify-content:space-between;align-items:center;text-align:center}" +
  ".t{font-weight:700;line-height:1.1;max-height:2.3em;overflow:hidden;width:100%}" +
  ".v{line-height:1.1;width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
  ".b{line-height:0}.b svg{display:block}" +
  ".c{font-family:'Courier New',monospace;font-weight:700;letter-spacing:.08em;line-height:1}" +
  ".big{font-weight:800;line-height:1}";

/**
 * Documento HTML imprimible. `kind` elige el contenido (unidades o bultos).
 * Rollo: @page del tamaño de la etiqueta. A4: @page A4 y grilla absoluta en mm.
 */
export function buildLabelsHtml(
  input: { kind: "units"; labels: UnitLabel[] } | { kind: "boxes"; labels: BoxLabel[] },
  f: FullLabelFormat,
  title = "Etiquetas para Full",
): string {
  const pageW = f.kind === "a4" ? 210 : f.width;
  const pageH = f.kind === "a4" ? 297 : f.height;
  const cells = input.kind === "units"
    ? input.labels.map((l) => unitInner(l, f))
    : input.labels.map((b) => boxInner(b, f));
  const pages = paginate(cells, f);
  const body = pages
    .map((page) => {
      const items = page
        .map((html, i) => {
          if (f.kind !== "a4") return `<div class="cell" style="left:0;top:0;width:${f.width}mm;height:${f.height}mm">${html}</div>`;
          const col = i % (f.cols ?? 1);
          const row = Math.floor(i / (f.cols ?? 1));
          const left = (f.marginLeft ?? 0) + col * (f.width + (f.gapX ?? 0));
          const top = (f.marginTop ?? 0) + row * (f.height + (f.gapY ?? 0));
          return `<div class="cell" style="left:${round2(left)}mm;top:${round2(top)}mm;width:${f.width}mm;height:${f.height}mm">${html}</div>`;
        })
        .join("");
      return `<div class="sheet" style="width:${pageW}mm;height:${pageH}mm">${items}</div>`;
    })
    .join("");
  return (
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${escapeXml(title)}</title>` +
    `<style>@page{size:${pageW}mm ${pageH}mm;margin:0}${BASE_CSS}</style></head>` +
    `<body>${body}<script>window.onload=function(){setTimeout(function(){window.print()},250)}</script></body></html>`
  );
}

const round2 = (n: number) => Math.round(n * 100) / 100;
