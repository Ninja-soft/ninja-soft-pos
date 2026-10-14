// Piezas compartidas de los modelos de comprobante (ADR-112). Sin hooks ni
// APIs del navegador: se renderizan igual en la app (vista previa, impresión,
// PDF/PNG con html2canvas) y en el servidor (renderToStaticMarkup) para la
// factura de la plataforma. Estilos inline para que el export no dependa del
// CSS de la app.
import type { CSSProperties, ReactNode } from "react";
import { qrSvgDataUrl } from "@/lib/qr/qrcode";
import type { InvoiceDoc } from "@/lib/invoices/types";
import type { InvoiceViewModel, ViewRow } from "@/lib/invoices/view";
import { NINJA_SEAL_TEXT, NINJA_SOFT_LOGO, type ResolvedInvoiceStyle } from "@/lib/invoices/style";
import { fmtQty, fmtRate, NON_FISCAL_LEGEND } from "@/lib/invoices/legal";

export interface ModelProps {
  doc: InvoiceDoc;
  view: InvoiceViewModel;
  style: ResolvedInvoiceStyle;
}

export const FONT_SANS = "var(--font-inter), Inter, 'Helvetica Neue', Arial, sans-serif";
export const FONT_MONO = "var(--font-jetbrains), 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace";
export const INK = "#1b1f2a";
export const MUTED = "#6b7080";
export const HAIR = "#e4e6eb";
export const PAPER = "#ffffff";
export const NUM: CSSProperties = { fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };

/** Medida de la hoja A4 a 96 dpi. */
export const A4_W = 794;
export const A4_H = 1123;

export function Logo({
  url,
  maxH,
  maxW,
  style,
  wordmark,
}: {
  url: string | null;
  maxH: number;
  maxW: number;
  style?: CSSProperties;
  /** Logo de Ninja POS (wordmark ancho, 4,2:1): más bajo para no dominar. */
  wordmark?: boolean;
}) {
  if (!url) return null;
  const h = wordmark ? Math.round(maxH * 0.62) : maxH;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      data-invoice-logo
      style={{ display: "block", maxHeight: h, maxWidth: maxW, width: "auto", height: "auto", objectFit: "contain", ...style }}
    />
  );
}

/** Recuadro con la letra y el código del comprobante (o "X" si no es fiscal). */
export function LetterBox({
  doc,
  size = 64,
  fill,
  ink,
  border = INK,
}: {
  doc: InvoiceDoc;
  size?: number;
  fill?: string;
  ink?: string;
  border?: string;
}) {
  const color = ink ?? INK;
  return (
    <div
      style={{
        width: size,
        minHeight: size,
        border: `1.5px solid ${border}`,
        background: fill ?? PAPER,
        color,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 3,
        boxSizing: "border-box",
        padding: "4px 2px",
        flexShrink: 0,
      }}
    >
      <span data-legal="letra" style={{ fontSize: size * 0.56, fontWeight: 800, lineHeight: 1, fontFamily: FONT_SANS }}>
        {doc.letter}
      </span>
      {doc.fiscal ? (
        <span
          data-legal="codigo"
          style={{ fontSize: size < 50 ? 7 : Math.max(8, size * 0.13), marginTop: 3, letterSpacing: 0.4, opacity: 0.85, textAlign: "center", lineHeight: 1.1, ...NUM }}
        >
          {size < 50 ? (
            <>
              COD.
              <br />
              {doc.cbteCode}
            </>
          ) : (
            `COD. ${doc.cbteCode}`
          )}
        </span>
      ) : (
        <span style={{ fontSize: Math.max(7, size * 0.11), marginTop: 3, textAlign: "center", lineHeight: 1.1, opacity: 0.85 }}>
          No fiscal
        </span>
      )}
    </div>
  );
}

export function QrImage({ view, size }: { view: InvoiceViewModel; size: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      data-legal="qr"
      src={qrSvgDataUrl(view.qrText, "M", 2)}
      alt="QR del comprobante"
      width={size}
      height={size}
      style={{ width: size, height: size, display: "block", flexShrink: 0 }}
    />
  );
}

/** Marca tipográfica de ARCA junto al QR fiscal. */
export function ArcaMark({ compact = false }: { compact?: boolean }) {
  return (
    <div style={{ color: "#3c3f45", lineHeight: 1.15 }}>
      <div style={{ fontSize: compact ? 18 : 30, fontWeight: 900, letterSpacing: 1, fontFamily: FONT_SANS }}>ARCA</div>
      <div style={{ fontSize: compact ? 6.5 : 8, letterSpacing: 0.2, textTransform: "uppercase" }}>
        Agencia de Recaudación
        <br />y Control Aduanero
      </div>
      <div style={{ fontSize: compact ? 7.5 : 9, marginTop: 4, fontWeight: 600 }}>Comprobante autorizado</div>
    </div>
  );
}

/** Sello "Un software de Ninja Soft" con el logo oficial. */
export function NinjaSeal({ onDark = false, size = 12, align = "center" }: { onDark?: boolean; size?: number; align?: "center" | "left" | "right" }) {
  return (
    <div
      data-seal="ninjasoft"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: align === "center" ? "center" : align === "left" ? "flex-start" : "flex-end",
        gap: 6,
        fontSize: size * 0.72,
        color: onDark ? "rgba(255,255,255,0.85)" : MUTED,
        letterSpacing: 0.2,
      }}
    >
      <span>{NINJA_SEAL_TEXT}</span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={onDark ? NINJA_SOFT_LOGO.onDark : NINJA_SOFT_LOGO.onLight} alt="Ninja Soft" style={{ height: size, width: "auto", display: "block" }} />
    </div>
  );
}

/** Marca de no fiscal (leyenda obligatoria). */
export function NonFiscalNote({ style }: { style?: CSSProperties }) {
  return (
    <div data-legal="no_fiscal" style={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, ...style }}>
      {NON_FISCAL_LEGEND}
    </div>
  );
}

export function legalAttr(r: ViewRow) {
  return r.legal ? { "data-legal": r.legal } : {};
}

/** Filas "Etiqueta: valor" en una grilla de dos columnas. */
export function KeyValueGrid({
  rows,
  cols = 2,
  labelColor = MUTED,
  fontSize = 10.5,
  labelWidth = 130,
  stacked = false,
}: {
  rows: ViewRow[];
  cols?: 1 | 2;
  labelColor?: string;
  fontSize?: number;
  labelWidth?: number;
  /** Etiqueta arriba del valor (columnas angostas). */
  stacked?: boolean;
}) {
  if (stacked) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize }}>
        {rows.map((r, i) => (
          <div key={i} {...legalAttr(r)} style={{ minWidth: 0 }}>
            <div style={{ color: labelColor, textTransform: "uppercase", fontSize: fontSize - 2.5, letterSpacing: 0.5 }}>{r.label}</div>
            <div style={{ fontWeight: r.strong ? 700 : 600, color: INK, overflowWrap: "anywhere" }}>{r.value}</div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: cols === 2 ? "1fr 1fr" : "1fr", columnGap: 24, rowGap: 5, fontSize }}>
      {rows.map((r, i) => (
        <div key={i} {...legalAttr(r)} style={{ display: "flex", gap: 8, minWidth: 0 }}>
          <span style={{ color: labelColor, width: labelWidth, flexShrink: 0, textTransform: "uppercase", fontSize: fontSize - 2, letterSpacing: 0.5, paddingTop: 1 }}>
            {r.label}
          </span>
          <span style={{ fontWeight: r.strong ? 700 : 600, color: INK, minWidth: 0, overflowWrap: "anywhere" }}>{r.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Tabla de renglones del comprobante (A4). */
export function LinesTable({
  doc,
  view,
  head,
  headInk,
  zebra,
  rowBorder = HAIR,
  descStrong = true,
  fontSize = 10.5,
  headStyle,
  compact = false,
}: {
  doc: InvoiceDoc;
  view: InvoiceViewModel;
  /** Columna angosta: sin código ni unidad aparte (la unidad va con la cantidad). */
  compact?: boolean;
  head: string;
  headInk: string;
  zebra?: string;
  rowBorder?: string;
  descStrong?: boolean;
  fontSize?: number;
  headStyle?: CSSProperties;
}) {
  const th: CSSProperties = {
    padding: "8px 10px",
    fontSize: fontSize - 2.5,
    letterSpacing: 0.7,
    textTransform: "uppercase",
    fontWeight: 700,
    color: headInk,
    background: head,
    textAlign: "right",
    whiteSpace: "nowrap",
    ...headStyle,
  };
  const td: CSSProperties = { padding: "8px 10px", textAlign: "right", verticalAlign: "top", borderBottom: `1px solid ${rowBorder}`, ...NUM };
  const showBonif = doc.lines.some((l) => l.discountPct);
  return (
    <table data-legal="detalle" style={{ width: "100%", borderCollapse: "collapse", fontSize, color: INK }}>
      <thead>
        <tr>
          {!compact && <th style={{ ...th, textAlign: "left", width: 46 }}>Cód.</th>}
          <th style={{ ...th, textAlign: "left" }}>Producto / Servicio</th>
          <th style={{ ...th, width: compact ? 64 : 46 }}>Cant.</th>
          {!compact && <th style={{ ...th, width: 54, textAlign: "left" }}>U. medida</th>}
          <th style={{ ...th, width: 86 }}>Precio unit.</th>
          {showBonif && <th style={{ ...th, width: 48 }}>% Bonif.</th>}
          {view.showIvaCol && (
            <th data-legal="alicuota" style={{ ...th, width: 52 }}>
              Alíc. IVA
            </th>
          )}
          <th style={{ ...th, width: 96 }}>Subtotal</th>
        </tr>
      </thead>
      <tbody>
        {doc.lines.map((l, i) => (
          <tr key={i} style={{ background: zebra && i % 2 === 1 ? zebra : undefined }}>
            {!compact && <td style={{ ...td, textAlign: "left", color: MUTED }}>{l.code ?? i + 1}</td>}
            <td style={{ ...td, textAlign: "left", fontWeight: descStrong ? 600 : 400, whiteSpace: "normal" }}>{l.description}</td>
            <td style={td}>
              {fmtQty(l.quantity)}
              {compact && <span style={{ color: MUTED }}> {l.unit === "unidad" || !l.unit ? "u." : l.unit}</span>}
            </td>
            {!compact && <td style={{ ...td, textAlign: "left", color: MUTED }}>{l.unit ?? "unidad"}</td>}
            <td style={td}>{view.money(l.unitPrice)}</td>
            {showBonif && <td style={td}>{l.discountPct ? fmtRate(l.discountPct) : "0 %"}</td>}
            {view.showIvaCol && <td style={td}>{l.ivaRate != null ? fmtRate(l.ivaRate) : "Varias"}</td>}
            <td style={{ ...td, fontWeight: 600 }}>{view.money(l.subtotal)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Filas de totales (sin el total). */
export function TotalsRows({
  view,
  fontSize = 10.5,
  labelColor = MUTED,
  rowStyle,
}: {
  view: InvoiceViewModel;
  fontSize?: number;
  labelColor?: string;
  rowStyle?: CSSProperties;
}) {
  return (
    <>
      {view.totalsRows.map((r, i) => (
        <div key={i} {...legalAttr(r)} style={{ display: "flex", justifyContent: "space-between", gap: 16, fontSize, padding: "4px 0", ...rowStyle }}>
          <span style={{ color: labelColor }}>{r.label}</span>
          <span style={{ ...NUM, fontWeight: 600, color: INK }}>{r.value}</span>
        </div>
      ))}
    </>
  );
}

/** Bloque Ley 27.743. */
export function TransparencyBlock({
  view,
  titleColor = INK,
  fontSize = 10,
  style,
}: {
  view: InvoiceViewModel;
  titleColor?: string;
  fontSize?: number;
  style?: CSSProperties;
}) {
  if (!view.transparency) return null;
  return (
    <div style={style}>
      <div style={{ fontSize: fontSize - 1, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: titleColor, marginBottom: 4 }}>
        {view.transparency.title}
      </div>
      {view.transparency.rows.map((r, i) => (
        <div key={i} {...legalAttr(r)} style={{ display: "flex", justifyContent: "space-between", fontSize, padding: "3px 0", borderBottom: `1px dashed ${HAIR}` }}>
          <span>{r.label}</span>
          <span style={{ ...NUM, fontWeight: 700 }}>{r.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Leyendas (obligatorias primero) y el pie. */
export function Legends({ view, fontSize = 9.5, color = MUTED, align = "left" }: { view: InvoiceViewModel; fontSize?: number; color?: string; align?: "left" | "center" }) {
  if (!view.legends.length) return null;
  return (
    <div style={{ fontSize, color, lineHeight: 1.45, textAlign: align }}>
      {view.legends.map((l, i) => (
        <div key={i} style={l === "ANULADA" ? { color: "#c62828", fontWeight: 800, fontSize: fontSize + 4, letterSpacing: 2 } : undefined}>
          {l}
        </div>
      ))}
    </div>
  );
}

export function CopyMark({ view, color = MUTED }: { view: InvoiceViewModel; color?: string }) {
  if (!view.copy) return null;
  return (
    <div data-legal="copia" style={{ fontSize: 9, fontWeight: 700, letterSpacing: 2, color }}>
      {view.copy}
    </div>
  );
}

/** Título de sección con el cuadradito de color (estilo de la referencia). */
export function SectionTitle({ children, color, line = HAIR }: { children: ReactNode; color: string; line?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, borderBottom: `1px solid ${line}`, paddingBottom: 5, marginBottom: 8 }}>
      <span style={{ width: 8, height: 8, background: color, borderRadius: 1.5, flexShrink: 0 }} />
      <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 2.2, textTransform: "uppercase", color: INK }}>{children}</span>
    </div>
  );
}
