// Dibujo de etiquetas como HTML imprimible (ADR-148 · H24 etiquetas PRO).
//
// Una sola fuente para la vista previa y la impresión: el mismo documento se
// muestra en un iframe (modo "preview", con zoom) y se imprime desde un iframe
// oculto (modo "print"). Así lo que se ve es lo que sale.
//
// Por qué antes salía mal: la hoja de etiquetas era un `.ticket-print` con
// `position: fixed; inset: 0` y grilla de tarjetas `flex` con
// `justify-content: space-between`. Al imprimir, la grilla ocupaba el alto de
// la hoja, las filas se estiraban y cada tarjeta repartía nombre, precio, PLU
// y código a lo largo de la página. Ahora cada etiqueta es una caja de tamaño
// fijo en mm, posicionada en mm dentro de una página de tamaño exacto
// (`@page size`), con salto de página por fila de rollo o por hoja.

import { encodeQr, qrSvgPath } from "@/lib/qr/qrcode";
import { escapeXml } from "@/lib/barcode/code128";
import { codeHtml, resolveCode } from "./barcodeSvg";
import { FONT_OPTIONS, inkOn, type LabelDesign } from "./designs";
import { formatPrice, formatPriceParts, type LabelItem } from "./items";
import { cellPositions, paginateLabels, round2, type MediaConfig } from "./media";

export interface RenderContext {
  businessName?: string | null;
  logoUrl?: string | null;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const mm = (n: number) => `${round2(n)}mm`;
const esc = (s: string | null | undefined) => escapeXml(String(s ?? ""));

/** Medidas derivadas del tamaño de la etiqueta (mm). Exportado para tests. */
export function labelMetrics(w: number, h: number, d: Pick<LabelDesign, "nameScale" | "priceScale">) {
  const pad = round2(clamp(Math.min(w, h) * 0.06, 0.8, 4));
  const s = Math.min(h / 25, w / 50);
  return {
    pad,
    innerW: round2(w - pad * 2),
    innerH: round2(h - pad * 2),
    nameFs: round2(clamp(2.7 * s, 1.7, 9) * d.nameScale),
    priceFs: round2(clamp(7.6 * s, 3.4, 34) * d.priceScale),
    smallFs: round2(clamp(1.9 * s, 1.35, 5)),
    codeH: round2(clamp(7 * s, 4.2, 24)),
    gap: round2(clamp(0.7 * s, 0.3, 2.5)),
  };
}

function priceHtml(n: number, fs: number, d: LabelDesign, cls = "pr"): string {
  const p = formatPriceParts(n, d.decimals);
  return (
    `<div class="${cls}" style="font-size:${mm(fs)}"><span class="cur">$</span>${esc(p.int)}` +
    (p.dec ? `<span class="dec">${p.dec}</span>` : "") +
    `</div>`
  );
}

function qrHtml(url: string, size: number): string {
  try {
    const qr = encodeQr(url, "M");
    const dim = qr.size + 2;
    return (
      `<svg class="qr" width="${mm(size)}" height="${mm(size)}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="QR a la ficha del producto">` +
      `<rect width="${dim}" height="${dim}" fill="#fff"/><path d="${qrSvgPath(qr, 1)}" fill="#000"/></svg>`
    );
  } catch {
    return "";
  }
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

function borderCss(d: LabelDesign): string {
  switch (d.border) {
    case "none":
      return "border:0";
    case "thick":
      return "border:0.6mm solid #000;border-radius:0.6mm";
    case "rounded":
      return "border:0.3mm solid #000;border-radius:2.2mm";
    case "dashed":
      return "border:0.3mm dashed #000;border-radius:0.6mm";
    default:
      return "border:0.25mm solid #000;border-radius:0.8mm";
  }
}

/**
 * HTML de UNA etiqueta de `w` × `h` mm. Todo el contenido entra en la caja:
 * si los datos elegidos no caben, se achican tipografías y código en
 * proporción (nunca se estira ni se sale de la etiqueta).
 */
export function renderLabel(item: LabelItem, d: LabelDesign, w: number, h: number, ctx: RenderContext = {}): string {
  const m = labelMetrics(w, h, d);
  const show = d.show;
  const name = d.uppercase ? item.name.toLocaleUpperCase("es-AR") : item.name;
  const code = show.barcode ? resolveCode(item.barcode, item.sku, d.symbology) : null;
  const qrOn = show.qr && !!item.qrUrl && d.layout !== "solo_codigo";
  const align = d.align === "left" ? "flex-start" : d.align === "right" ? "flex-end" : "center";
  const accent = d.accent;
  const ink = inkOn(accent);

  // Columna lateral: QR (todas) o foto (modelo "foto").
  const photo = d.layout === "foto" && show.image;
  let sideW = 0;
  if (photo) sideW = round2(Math.min(m.innerH, m.innerW * 0.38));
  else if (qrOn) sideW = round2(clamp(Math.min(m.innerH * 0.62, m.innerW * 0.32), 7, 40));
  const colW = round2(m.innerW - (sideW ? sideW + m.gap * 1.5 : 0));

  // Bandas y extras de arriba (fuera del ajuste de tamaño).
  let topH = 0;
  let top = "";
  if (d.layout === "oferta") {
    const bandH = round2(clamp(m.smallFs * 2.3, 3, 14));
    topH += bandH + m.gap;
    top += `<div class="band" style="height:${mm(bandH)};font-size:${mm(bandH * 0.62)};background:${accent};color:${ink};margin:-${mm(m.pad)} -${mm(m.pad)} ${mm(m.gap)}">${esc(d.offerText || "OFERTA")}</div>`;
  }
  if (d.layout === "colgante") {
    const hole = round2(clamp(w * 0.12, 2.5, 5));
    topH += hole + m.gap;
    top += `<div class="hole" style="width:${mm(hole)};height:${mm(hole)};margin-bottom:${mm(m.gap)}"></div>`;
  }
  if (d.layout === "logo" && (show.logo || ctx.businessName)) {
    const lh = round2(clamp(m.smallFs * 2.6, 3.2, 16));
    topH += lh + m.gap + 0.6;
    const logo = show.logo && ctx.logoUrl ? `<img class="logo" src="${esc(ctx.logoUrl)}" alt="" style="height:${mm(lh)};max-width:${mm(colW * 0.45)}"/>` : "";
    const bn = ctx.businessName ? `<span class="bn" style="font-size:${mm(m.smallFs * 1.1)}">${esc(ctx.businessName)}</span>` : "";
    top += `<div class="head" style="height:${mm(lh)};justify-content:${align}">${logo}${bn}</div>` +
      `<div class="rule" style="background:${accent};margin:${mm(m.gap * 0.5)} 0 ${mm(m.gap * 0.5)}"></div>`;
  }

  // Bloques del cuerpo con su alto estimado para el ajuste.
  type Block = { html: (k: number) => string; h: (k: number) => number };
  const blocks: Block[] = [];
  const lines = (fs: number, n: number) => fs * 1.12 * n;
  const nameLines = d.layout === "precio_grande" || d.layout === "solo_codigo" ? 1 : 2;

  if (show.brand && item.brand && d.layout !== "solo_codigo") {
    blocks.push({
      html: (k) => `<div class="brand" style="font-size:${mm(m.smallFs * k)}">${esc(item.brand)}</div>`,
      h: (k) => lines(m.smallFs * k, 1),
    });
  }
  if (show.name) {
    const nf = d.layout === "solo_codigo" ? m.smallFs * 1.1 : d.layout === "precio_grande" ? m.nameFs * 0.85 : m.nameFs;
    blocks.push({
      html: (k) =>
        `<div class="nm${d.layout === "minimal" ? " nm-light" : ""}" style="font-size:${mm(nf * k)};-webkit-line-clamp:${nameLines};max-height:${mm(nf * k * 1.22 * nameLines)}">${esc(name)}</div>`,
      h: (k) => nf * k * 1.22 * Math.min(nameLines, Math.ceil((name.length * nf * k * (d.uppercase ? 0.68 : 0.56)) / colW)),
    });
  }
  if (show.variant && item.variant) {
    blocks.push({
      html: (k) => `<div class="var" style="font-size:${mm(m.smallFs * k)}">${esc(item.variant)}</div>`,
      h: (k) => lines(m.smallFs * k, 1),
    });
  }
  if (d.layout === "minimal" && (show.name || show.brand)) {
    blocks.push({ html: () => `<div class="hair" style="width:${mm(Math.min(colW, 12))}"></div>`, h: () => 0.5 });
  }
  if (show.prevPrice && item.prevPrice && item.prevPrice > item.price && d.layout !== "solo_codigo") {
    const off = Math.round((1 - item.price / item.prevPrice) * 100);
    blocks.push({
      html: (k) =>
        `<div class="prev" style="font-size:${mm(m.smallFs * 1.25 * k)};justify-content:${align}"><s>${esc(formatPrice(item.prevPrice!, d.decimals))}</s>` +
        (off > 0 ? `<span class="off" style="background:${accent};color:${ink}">-${off}%</span>` : "") +
        `</div>`,
      h: (k) => lines(m.smallFs * 1.25 * k, 1) + 0.4,
    });
  }
  if (show.price && d.layout !== "solo_codigo") {
    const pf = d.layout === "precio_grande" ? m.priceFs * 1.45 : d.layout === "minimal" ? m.priceFs * 0.9 : m.priceFs;
    // Ancho del precio en "em" (dígitos ≈ 0,6 em, $ y centavos más chicos):
    // si no entra a lo ancho, se achica para no recortar los últimos dígitos.
    const parts = formatPriceParts(item.price, d.decimals);
    const em = parts.int.length * 0.6 + 0.35 + (parts.dec ? 0.55 : 0);
    const fit = (k: number) => Math.min(pf * k, colW / em);
    blocks.push({ html: (k) => priceHtml(item.price, fit(k), d), h: (k) => fit(k) * 1.02 });
  }
  if (show.unitPrice && item.unitPrice && d.layout !== "solo_codigo") {
    blocks.push({
      html: (k) =>
        `<div class="up" style="font-size:${mm(m.smallFs * k)}">${esc(formatPrice(item.unitPrice!.value, "always"))} x ${esc(item.unitPrice!.per)}</div>`,
      h: (k) => lines(m.smallFs * k, 1),
    });
  }
  const chips: string[] = [];
  if (show.plu && item.plu) chips.push(`<span class="plu">PLU ${esc(item.plu)}</span>`);
  if (show.sku && item.sku && item.sku !== code?.value) chips.push(`<span class="sku">SKU ${esc(item.sku)}</span>`);
  if (show.date && item.date) chips.push(`<span class="dt">${esc(fmtDate(item.date))}</span>`);
  if (chips.length) {
    blocks.push({
      html: (k) => `<div class="meta" style="font-size:${mm(m.smallFs * k)};justify-content:${align}">${chips.join("")}</div>`,
      h: (k) => lines(m.smallFs * k, 1) + 0.8,
    });
  }
  if (code) {
    const big = d.layout === "solo_codigo";
    const ch = big ? Math.max(m.codeH, m.innerH * 0.62) : d.layout === "precio_grande" ? m.codeH * 0.75 : m.codeH;
    const cw = round2(Math.min(colW, big ? colW : Math.max(colW * 0.86, Math.min(colW, 30))));
    blocks.push({
      html: (k) => codeHtml(code, cw, round2(ch * k), round2(clamp(m.smallFs * 0.95 * k, 1.3, 4))),
      h: (k) => ch * k,
    });
  }
  if (d.footer) {
    blocks.push({
      html: (k) => `<div class="ft" style="font-size:${mm(m.smallFs * 0.85 * k)}">${esc(d.footer)}</div>`,
      h: (k) => lines(m.smallFs * 0.85 * k, 1),
    });
  }

  // Ajuste: si no entra, achica todo en proporción (con un piso legible).
  const avail = m.innerH - topH;
  // 6 % de margen de error sobre la estimación (anchos reales de cada fuente).
  const need = (k: number) => (blocks.reduce((a, b) => a + b.h(k), 0) + m.gap * k * Math.max(0, blocks.length - 1)) * 1.06;
  // Etiquetas altas (colgantes, carteles verticales) agrandan el contenido
  // para no dejar la mitad en blanco; el resto sólo achica.
  const grow = h > w * 1.2 ? 1.8 : 1;
  let k = clamp(avail / need(1), 0.45, grow);
  if (k > 1) k = Math.max(1, k * 0.92);
  const body = blocks.map((b) => b.html(k)).join("");

  const side = photo
    ? `<div class="side" style="width:${mm(sideW)};height:${mm(Math.min(sideW, m.innerH))}">` +
      (item.imageUrl ? `<img class="ph" src="${esc(item.imageUrl)}" alt=""/>` : `<div class="ph ph-empty"></div>`) +
      `</div>`
    : qrOn
      ? `<div class="side" style="width:${mm(sideW)}">${qrHtml(item.qrUrl!, sideW)}</div>`
      : "";

  const font = FONT_OPTIONS.find((f) => f.key === d.font)?.stack ?? FONT_OPTIONS[0]!.stack;
  return (
    `<div class="lb lay-${d.layout}" style="width:${mm(w)};height:${mm(h)};padding:${mm(m.pad)};${borderCss(d)};font-family:${esc(font)};text-align:${d.align}">` +
    top +
    `<div class="row" style="gap:${mm(m.gap * 1.5)};height:${mm(m.innerH - topH)}">` +
    (photo ? side : "") +
    `<div class="col" style="width:${mm(colW)};gap:${mm(m.gap * k)};align-items:${align}">${body}</div>` +
    (photo ? "" : side) +
    `</div></div>`
  );
}

const FONT_HREF: Record<string, string> = {
  sans: "family=Inter:wght@400;600;700;800;900",
  condensed: "family=Roboto+Condensed:wght@400;700;800;900",
  rounded: "family=Nunito:wght@400;700;800;900",
  serif: "family=Playfair+Display:wght@400;700;800;900",
  mono: "family=JetBrains+Mono:wght@400;700;800",
};

export const LABEL_CSS =
  "*{box-sizing:border-box;margin:0;padding:0}" +
  "html,body{background:#fff;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}" +
  ".sheet{position:relative;overflow:hidden;background:#fff}" +
  ".cell{position:absolute;overflow:hidden}" +
  ".lb{position:relative;overflow:hidden;display:flex;flex-direction:column;align-items:stretch;color:#000;background:#fff}" +
  ".row{display:flex;flex-direction:row;align-items:center;min-height:0}" +
  ".col{display:flex;flex-direction:column;justify-content:center;justify-content:safe center;min-width:0;height:100%;overflow:hidden}" +
  ".col>*{max-width:100%;flex:0 0 auto}" +
  ".side{flex:0 0 auto;display:flex;align-items:center;justify-content:center}" +
  ".nm{font-weight:800;line-height:1.22;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;word-break:break-word;letter-spacing:.01em}" +
  ".nm-light{font-weight:600}" +
  ".brand{font-weight:700;letter-spacing:.12em;text-transform:uppercase;line-height:1.12;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.8}" +
  ".var{font-weight:600;line-height:1.12;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
  ".pr{font-weight:900;line-height:1;letter-spacing:-.02em;white-space:nowrap;font-variant-numeric:tabular-nums}" +
  ".pr .cur{font-size:.5em;font-weight:800;vertical-align:.62em;margin-right:.08em}" +
  ".pr .dec{font-size:.45em;font-weight:800;vertical-align:.78em;margin-left:.04em}" +
  ".prev{display:flex;align-items:center;gap:.5em;line-height:1.12;white-space:nowrap}" +
  ".prev s{font-weight:600;text-decoration-thickness:.12em}" +
  ".off{font-weight:800;padding:0 .35em;border-radius:.25em;line-height:1.3}" +
  ".up{font-weight:600;line-height:1.12;white-space:nowrap}" +
  ".meta{display:flex;flex-wrap:wrap;gap:.4em .7em;line-height:1.12;align-items:center}" +
  ".plu{font-family:'JetBrains Mono','Courier New',monospace;font-weight:800;letter-spacing:.14em;border:.22mm solid #000;border-radius:.6mm;padding:.05em .35em}" +
  ".sku,.dt{font-family:'JetBrains Mono','Courier New',monospace;font-weight:600}" +
  ".ft{font-weight:600;line-height:1.12;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.85}" +
  ".band{display:flex;align-items:center;justify-content:center;font-weight:900;letter-spacing:.14em;flex:0 0 auto;line-height:1}" +
  ".hole{border:.3mm solid #000;border-radius:50%;align-self:center;flex:0 0 auto}" +
  ".head{display:flex;align-items:center;gap:1.2mm;flex:0 0 auto;overflow:hidden}" +
  ".logo{object-fit:contain;display:block}" +
  ".bn{font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
  ".rule{height:.6mm;flex:0 0 auto}" +
  ".hair{height:.25mm;background:#000;opacity:.5}" +
  ".bc{position:relative;line-height:0;background:#fff}.bc svg{display:block}" +
  ".bc-t{font-family:'JetBrains Mono','Courier New',monospace;font-weight:600;letter-spacing:.08em;text-align:center;white-space:nowrap;overflow:hidden}" +
  ".bc-ean{position:absolute;left:0;right:0;bottom:0;font-family:'JetBrains Mono','Courier New',monospace;font-weight:600}" +
  ".bc-ean span{position:absolute;top:0;text-align:center;background:#fff;letter-spacing:.06em}" +
  ".qr{display:block}" +
  ".ph{width:100%;height:100%;object-fit:contain;display:block}" +
  ".ph-empty{border:.25mm dashed #999}" +
  ".cut{position:absolute;background:#000}" +
  ".cut-box{position:absolute;border:.15mm dashed #9a9a9a;pointer-events:none}";

export interface DocumentOptions {
  items: LabelItem[];
  design: LabelDesign;
  media: MediaConfig;
  /** Etiquetas a saltear en la primera hoja (sólo hojas). */
  skip?: number;
  ctx?: RenderContext;
  mode: "print" | "preview";
  /** Vista previa: zoom (1 = tamaño real). */
  zoom?: number;
  /** Vista previa: máximo de páginas a dibujar. */
  maxPages?: number;
  title?: string;
}

function cutMarks(media: MediaConfig): string {
  if (media.kind !== "sheet" || !media.cutMarks) return "";
  const out: string[] = [];
  const len = 3;
  const xs = new Set<number>();
  const ys = new Set<number>();
  for (const c of cellPositions(media)) {
    xs.add(round2(c.x));
    xs.add(round2(c.x + c.w));
    ys.add(round2(c.y));
    ys.add(round2(c.y + c.h));
    out.push(`<div class="cut-box" style="left:${mm(c.x)};top:${mm(c.y)};width:${mm(c.w)};height:${mm(c.h)}"></div>`);
  }
  // Marcas en los márgenes del papel (fuera de las etiquetas).
  const top = Math.min(media.marginY, len);
  const left = Math.min(media.marginX, len);
  for (const x of xs) {
    if (top > 0.5) {
      out.push(`<div class="cut" style="left:${mm(x - 0.1)};top:${mm(media.marginY - top)};width:.2mm;height:${mm(top - 0.4)}"></div>`);
      out.push(`<div class="cut" style="left:${mm(x - 0.1)};top:${mm(media.pageH - media.marginY + 0.4)};width:.2mm;height:${mm(top - 0.4)}"></div>`);
    }
  }
  for (const y of ys) {
    if (left > 0.5) {
      out.push(`<div class="cut" style="top:${mm(y - 0.1)};left:${mm(media.marginX - left)};height:.2mm;width:${mm(left - 0.4)}"></div>`);
      out.push(`<div class="cut" style="top:${mm(y - 0.1)};left:${mm(media.pageW - media.marginX + 0.4)};height:.2mm;width:${mm(left - 0.4)}"></div>`);
    }
  }
  return out.join("");
}

/** Cantidad de páginas que va a tener la impresión. */
export function pageCount(itemCount: number, media: MediaConfig, skip = 0): number {
  if (itemCount <= 0) return 0;
  return paginateLabels(new Array(itemCount).fill(0), media, skip).length;
}

/**
 * Documento HTML completo. En modo "print" lleva `@page` del tamaño exacto
 * (rollo: una fila por página; hoja: A4/Carta) y salto de página por página.
 */
export function buildLabelDocument(o: DocumentOptions): string {
  const { media, design } = o;
  const cells = cellPositions(media);
  const all = paginateLabels(o.items, media, o.skip ?? 0);
  const pages = o.maxPages ? all.slice(0, o.maxPages) : all;
  const marks = cutMarks(media);
  const body = pages
    .map((page) => {
      const items = page
        .map((it, i) => {
          if (!it) return "";
          const c = cells[i]!;
          return `<div class="cell" style="left:${mm(c.x)};top:${mm(c.y)};width:${mm(c.w)};height:${mm(c.h)}">${renderLabel(it, design, c.w, c.h, o.ctx)}</div>`;
        })
        .join("");
      return `<div class="sheet" style="width:${mm(media.pageW)};height:${mm(media.pageH)}">${marks}${items}</div>`;
    })
    .join("");

  const fontHref = FONT_HREF[design.font] ?? FONT_HREF.sans;
  const preview = o.mode === "preview";
  const zoom = clamp(o.zoom ?? 1, 0.2, 8);
  const css =
    LABEL_CSS +
    (preview
      ? `html,body{background:transparent}body{padding:12px}.pages{zoom:${zoom};display:flex;flex-direction:column;align-items:center;gap:${media.kind === "thermal" ? "3mm" : "6mm"}}` +
        `.sheet{outline:1px solid #b9b4c9}`
      : `@page{size:${mm(media.pageW)} ${mm(media.pageH)};margin:0}html,body{width:${mm(media.pageW)}}` +
        `.sheet{break-after:page;page-break-after:always}.sheet:last-child{break-after:auto;page-break-after:auto}`);
  return (
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(o.title ?? "Etiquetas")}</title>` +
    `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` +
    `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${fontHref}&family=JetBrains+Mono:wght@600;800&display=block">` +
    `<style>${css}</style></head><body><div class="pages">${body}</div></body></html>`
  );
}
