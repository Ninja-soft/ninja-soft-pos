// Piezas compartidas de los modelos de comprobante (ADR-112, ADR-119). Sin
// hooks ni APIs del navegador: se renderizan igual en la app (vista previa,
// impresión, PDF/PNG con html2canvas) y en el servidor (renderToStaticMarkup)
// para la factura de la plataforma. Estilos inline para que el export no
// dependa del CSS de la app.
//
// ADR-119: la personalización (tamaño de letra, densidad, esquinas y
// separadores) viaja como variables CSS en la raíz de cada hoja o rollo
// (`invoiceVars`) y cada medida la lee con fs() / sp() / rad() / sepLine().
// El navegador resuelve los calc() al calcular el estilo, así que la vista
// previa, la impresión y html2canvas (que lee el estilo calculado) dibujan
// exactamente lo mismo.
import type { CSSProperties, ReactNode } from "react";
import { qrSvgDataUrl } from "@/lib/qr/qrcode";
import type { InvoiceDoc } from "@/lib/invoices/types";
import type { InvoiceViewModel, ViewRow } from "@/lib/invoices/view";
import {
  NINJA_SEAL_TEXT,
  NINJA_SOFT_LOGO,
  type ResolvedInvoiceStyle,
} from "@/lib/invoices/style";
import { fmtQty, fmtRate, NON_FISCAL_LEGEND } from "@/lib/invoices/legal";
import { Barcode } from "@/components/products/Barcode";

/** Hoja de un comprobante A4 paginado (ADR-119). */
export interface InvoicePage {
  /** 0 = primera hoja. */
  index: number;
  count: number;
}

export interface ModelProps {
  doc: InvoiceDoc;
  view: InvoiceViewModel;
  style: ResolvedInvoiceStyle;
  /** Hoja actual cuando el comprobante ocupa más de una (A4). */
  page?: InvoicePage;
}

export const FONT_SANS =
  "var(--font-inter), Inter, 'Helvetica Neue', Arial, sans-serif";
export const FONT_MONO =
  "var(--font-jetbrains), 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace";
export const INK = "#1b1f2a";
export const MUTED = "#6b7080";
export const HAIR = "#e4e6eb";
export const PAPER = "#ffffff";
export const SOFT = "#f6f7f9";
export const NUM: CSSProperties = {
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
};

// ---------------------------------------------------------------------------
// Medidas personalizables (variables CSS de la raíz).
// ---------------------------------------------------------------------------

/** Tamaño de letra escalado por la opción "tamaño de letra". */
export function fs(n: number): string;
export function fs(n: number | undefined): string | undefined;
export function fs(n: number | undefined) {
  return n == null ? undefined : `calc(${n}px * var(--inv-fs, 1))`;
}
/** Espacio escalado por la densidad (compacta / normal / amplia). */
export const sp = (n: number) => `calc(${n}px * var(--inv-sp, 1))`;
/** Radio de esquina: 0 con la opción de bordes rectos. */
export const rad = (n: number) => `calc(${n}px * var(--inv-r, 1))`;
/**
 * Filete separador: estilo y grosor según la opción de separadores; con
 * "auto" queda el del modelo (`dflt`).
 */
export const sepLine = (
  w = 1,
  color = HAIR,
  dflt: "solid" | "dashed" | "dotted" = "solid",
) => `calc(${w}px * var(--inv-sep-w, 1)) var(--inv-sep, ${dflt}) ${color}`;

/** Variables CSS de la raíz de la hoja o el rollo. */
export function invoiceVars(s: ResolvedInvoiceStyle): CSSProperties {
  const v: Record<string, string> = {
    "--inv-fs": String(s.fontScale),
    "--inv-sp": String(s.density),
    "--inv-r": s.rounded ? "1" : "0",
  };
  if (s.separators === "none") v["--inv-sep-w"] = "0";
  if (s.separators === "dotted") v["--inv-sep"] = "dotted";
  if (s.separators === "solid") v["--inv-sep"] = "solid";
  return v as CSSProperties;
}

/** Color del título del comprobante según el estilo del encabezado. */
export const headColor = (s: ResolvedInvoiceStyle) =>
  s.headerStyle === "neutral" ? INK : s.accentText;
/** Fondo de las bandas de color según el estilo del encabezado. */
export const bandColor = (s: ResolvedInvoiceStyle) =>
  s.headerStyle === "neutral" ? INK : s.accent;
export const bandInk = (s: ResolvedInvoiceStyle) =>
  s.headerStyle === "neutral" ? "#ffffff" : s.accentInk;

/**
 * Tipo de comprobante ("Factura B") con el estilo del encabezado: en color,
 * neutro o dentro de una pastilla de color.
 */
export function HeadLabel({
  style: s,
  children,
  size,
  weight = 800,
  upper = false,
}: {
  style: ResolvedInvoiceStyle;
  children: ReactNode;
  size?: number;
  weight?: number;
  upper?: boolean;
}) {
  const text: CSSProperties = {
    fontSize: fs(size),
    fontWeight: weight,
    lineHeight: 1.15,
    textTransform: upper ? "uppercase" : undefined,
  };
  if (s.headerStyle === "filled") {
    return (
      <span
        style={{
          ...text,
          display: "inline-block",
          background: s.accent,
          color: s.accentInk,
          padding: `${sp(3)} ${sp(9)}`,
          borderRadius: rad(4),
        }}
      >
        {children}
      </span>
    );
  }
  return <span style={{ ...text, color: headColor(s) }}>{children}</span>;
}

/**
 * Texto debajo del nombre de un renglón (ADR-116): descripción ampliada del
 * servicio, aclaraciones predefinidas y aclaración libre. Más chico y gris,
 * con viñetas para las listas.
 */
export function LineDetail({
  lines,
  fontSize,
  color = MUTED,
  style,
}: {
  lines: InvoiceDoc["lines"][number]["detailLines"];
  fontSize?: number | string;
  color?: string;
  style?: CSSProperties;
}) {
  if (!lines || lines.length === 0) return null;
  return (
    <div
      data-service-detail=""
      style={{
        marginTop: 3,
        fontSize: typeof fontSize === "number" ? fs(fontSize) : fontSize,
        lineHeight: 1.4,
        color,
        fontWeight: 400,
        ...style,
      }}
    >
      {lines.map((l, i) =>
        l.bullet ? (
          <div key={i} style={{ display: "flex", gap: 5 }}>
            <span aria-hidden>•</span>
            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
              {l.text}
            </span>
          </div>
        ) : (
          <div key={i} style={{ overflowWrap: "anywhere" }}>
            {l.text}
          </div>
        ),
      )}
    </div>
  );
}

/** Medida de la hoja A4 a 96 dpi (210 x 297 mm). */
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
      style={{
        display: "block",
        maxHeight: h,
        maxWidth: maxW,
        width: "auto",
        height: "auto",
        objectFit: "contain",
        ...style,
      }}
    />
  );
}

/** ¿El modelo dibuja el logo en su lugar de siempre? (posición "auto"). */
export const ownLogo = (s: ResolvedInvoiceStyle) => s.logoPosition === "auto";

/**
 * Logo en una fila propia arriba de todo (posición izquierda, centro o
 * derecha elegida por el negocio). No dibuja nada con la posición "auto".
 */
export function LogoRow({
  style: s,
  maxH,
  maxW,
  onAccent = false,
  mb = 12,
}: {
  style: ResolvedInvoiceStyle;
  maxH: number;
  maxW: number;
  onAccent?: boolean;
  mb?: number;
}) {
  if (ownLogo(s) || !s.logoUrl) return null;
  const justify =
    s.logoPosition === "center"
      ? "center"
      : s.logoPosition === "right"
        ? "flex-end"
        : "flex-start";
  return (
    <div
      data-logo-row={s.logoPosition}
      style={{ display: "flex", justifyContent: justify, marginBottom: sp(mb) }}
    >
      {onAccent ? (
        <div
          style={{
            background: PAPER,
            borderRadius: rad(6),
            padding: "6px 10px",
          }}
        >
          <Logo
            url={s.logoUrl}
            wordmark={s.logoIsDefault}
            maxH={maxH}
            maxW={maxW}
          />
        </div>
      ) : (
        <Logo
          url={s.logoUrl}
          wordmark={s.logoIsDefault}
          maxH={maxH}
          maxW={maxW}
        />
      )}
    </div>
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
        borderRadius: rad(3),
        boxSizing: "border-box",
        padding: "4px 2px",
        flexShrink: 0,
      }}
    >
      <span
        data-legal="letra"
        style={{
          display: "block",
          fontSize: size * 0.56,
          fontWeight: 800,
          lineHeight: `${Math.round(size * 0.62)}px`,
        }}
      >
        {doc.letter}
      </span>
      {doc.fiscal ? (
        <span
          data-legal="codigo"
          style={{
            fontSize: size < 50 ? 7 : Math.max(8, size * 0.13),
            marginTop: 3,
            letterSpacing: 0.4,
            opacity: 0.85,
            textAlign: "center",
            lineHeight: 1.1,
            ...NUM,
          }}
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
        <span
          style={{
            fontSize: Math.max(7, size * 0.11),
            marginTop: 3,
            textAlign: "center",
            lineHeight: 1.1,
            opacity: 0.85,
          }}
        >
          No fiscal
        </span>
      )}
    </div>
  );
}

export function QrImage({
  view,
  size,
}: {
  view: InvoiceViewModel;
  size: number;
}) {
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

/** Código de barras con el número interno de la venta (opción del negocio). */
export function SaleBarcode({
  doc,
  height = 34,
  align = "center",
}: {
  doc: InvoiceDoc;
  height?: number;
  align?: "center" | "left";
}) {
  if (!doc.saleCode) return null;
  return (
    <div
      data-sale-barcode
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: align === "center" ? "center" : "flex-start",
        gap: 2,
      }}
    >
      <Barcode value={doc.saleCode} height={height} module={1.2} />
      <span
        style={{ fontSize: fs(8.5), letterSpacing: 1, color: MUTED, ...NUM }}
      >
        {doc.saleCode}
      </span>
    </div>
  );
}

/** Marca tipográfica de ARCA junto al QR fiscal. */
export function ArcaMark({ compact = false }: { compact?: boolean }) {
  return (
    <div style={{ color: "#3c3f45", lineHeight: 1.15 }}>
      <div
        style={{
          fontSize: compact ? 18 : 30,
          // Alto de línea en px: html2canvas (PDF) encima las líneas con alto relativo.
          lineHeight: compact ? "22px" : "36px",
          fontWeight: 900,
          letterSpacing: 1,
          fontFamily: FONT_SANS,
        }}
      >
        ARCA
      </div>
      <div
        style={{
          fontSize: compact ? 6.5 : 8,
          letterSpacing: 0.2,
          textTransform: "uppercase",
        }}
      >
        Agencia de Recaudación
        <br />y Control Aduanero
      </div>
      <div
        style={{ fontSize: compact ? 7.5 : 9, marginTop: 4, fontWeight: 600 }}
      >
        Comprobante autorizado
      </div>
    </div>
  );
}

/** Sello "Un software de Ninja Soft" con el logo oficial. */
export function NinjaSeal({
  onDark = false,
  size = 12,
  align = "center",
}: {
  onDark?: boolean;
  size?: number;
  align?: "center" | "left" | "right";
}) {
  return (
    <div
      data-seal="ninjasoft"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent:
          align === "center"
            ? "center"
            : align === "left"
              ? "flex-start"
              : "flex-end",
        gap: 6,
        fontSize: size * 0.72,
        color: onDark ? "rgba(255,255,255,0.85)" : MUTED,
        letterSpacing: 0.2,
      }}
    >
      <span>{NINJA_SEAL_TEXT}</span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={onDark ? NINJA_SOFT_LOGO.onDark : NINJA_SOFT_LOGO.onLight}
        alt="Ninja Soft"
        style={{ height: size, width: "auto", display: "block" }}
      />
    </div>
  );
}

/** Marca de no fiscal (leyenda obligatoria). */
export function NonFiscalNote({ style }: { style?: CSSProperties }) {
  return (
    <div
      data-legal="no_fiscal"
      style={{
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: 0.6,
        ...style,
      }}
    >
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
  cols?: 1 | 2 | 3;
  labelColor?: string;
  fontSize?: number;
  labelWidth?: number;
  /** Etiqueta arriba del valor (columnas angostas). */
  stacked?: boolean;
}) {
  if (stacked) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: sp(6),
          fontSize: fs(fontSize),
        }}
      >
        {rows.map((r, i) => (
          <div key={i} {...legalAttr(r)} style={{ minWidth: 0 }}>
            <div
              style={{
                color: labelColor,
                textTransform: "uppercase",
                fontSize: fs(fontSize - 2.5),
                letterSpacing: 0.5,
              }}
            >
              {r.label}
            </div>
            <div
              style={{
                fontWeight: r.strong ? 700 : 600,
                color: INK,
                overflowWrap: "anywhere",
              }}
            >
              {r.value}
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        columnGap: 24,
        rowGap: sp(5),
        fontSize: fs(fontSize),
      }}
    >
      {rows.map((r, i) => (
        <div
          key={i}
          {...legalAttr(r)}
          style={{ display: "flex", gap: 8, minWidth: 0 }}
        >
          <span
            style={{
              color: labelColor,
              width: labelWidth,
              flexShrink: 0,
              textTransform: "uppercase",
              fontSize: fs(fontSize - 2),
              letterSpacing: 0.5,
              paddingTop: 1,
            }}
          >
            {r.label}
          </span>
          <span
            style={{
              fontWeight: r.strong ? 700 : 600,
              color: INK,
              minWidth: 0,
              overflowWrap: "anywhere",
            }}
          >
            {r.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Foto del producto (ADR-119): cuadrada, tamaño fijo, recorte centrado y un
 * placeholder neutro si el producto no tiene foto. Sigue la opción de
 * esquinas redondeadas o rectas.
 */
export function ProductThumb({
  url,
  size,
  mono = false,
}: {
  url?: string | null;
  size: number;
  mono?: boolean;
}) {
  const box: CSSProperties = {
    width: size,
    height: size,
    flexShrink: 0,
    borderRadius: rad(Math.max(3, Math.round(size / 8))),
    overflow: "hidden",
    background: SOFT,
    border: `1px solid ${HAIR}`,
    boxSizing: "border-box",
  };
  if (!url) {
    return (
      <div
        data-product-photo="none"
        aria-hidden
        style={{
          ...box,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg
          width={size * 0.45}
          height={size * 0.45}
          viewBox="0 0 24 24"
          fill="none"
          stroke="#b8bcc6"
          strokeWidth={1.6}
        >
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="9" cy="10" r="2" />
          <path d="M21 17l-5-5-9 8" />
        </svg>
      </div>
    );
  }
  return (
    <div data-product-photo={mono ? "mono" : "color"} style={box}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt=""
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          display: "block",
        }}
      />
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
  cellPad = [8, 10],
  photo,
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
  /** Relleno vertical y horizontal de las celdas (se escala con la densidad). */
  cellPad?: [number, number];
  /** ADR-119: tamaño de la foto del producto a la izquierda del renglón (sin foto: no se muestra). */
  photo?: number;
}) {
  const pad = `${sp(cellPad[0])} ${cellPad[1]}px`;
  const th: CSSProperties = {
    padding: pad,
    fontSize: fs(fontSize - 2.5),
    letterSpacing: 0.7,
    textTransform: "uppercase",
    fontWeight: 700,
    color: headInk,
    background: head,
    textAlign: "right",
    whiteSpace: "nowrap",
    ...headStyle,
  };
  const td: CSSProperties = {
    padding: pad,
    textAlign: "right",
    verticalAlign: "top",
    borderBottom:
      rowBorder === "transparent" ? undefined : sepLine(1, rowBorder),
    ...NUM,
  };
  const showBonif = doc.lines.some((l) => l.discountPct);
  return (
    <table
      data-legal="detalle"
      style={{
        width: "100%",
        borderCollapse: "collapse",
        fontSize: fs(fontSize),
        color: INK,
      }}
    >
      <thead>
        <tr>
          {!compact && (
            <th style={{ ...th, textAlign: "left", width: 46 }}>Cód.</th>
          )}
          <th style={{ ...th, textAlign: "left" }}>Producto / Servicio</th>
          <th style={{ ...th, width: compact ? 64 : 46 }}>Cant.</th>
          {!compact && (
            <th style={{ ...th, width: 54, textAlign: "left" }}>U. medida</th>
          )}
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
          <tr
            key={i}
            style={{ background: zebra && i % 2 === 1 ? zebra : undefined }}
          >
            {!compact && (
              <td style={{ ...td, textAlign: "left", color: MUTED }}>
                {l.code ?? i + 1}
              </td>
            )}
            <td
              style={{
                ...td,
                textAlign: "left",
                fontWeight: descStrong ? 600 : 400,
                whiteSpace: "normal",
              }}
            >
              {photo ? (
                <div
                  style={{ display: "flex", gap: 10, alignItems: "flex-start" }}
                >
                  <ProductThumb url={l.imageUrl} size={photo} />
                  <div style={{ minWidth: 0, paddingTop: photo >= 48 ? 4 : 0 }}>
                    {l.description}
                    <LineDetail
                      lines={l.detailLines}
                      fontSize={fontSize - 1.5}
                    />
                  </div>
                </div>
              ) : (
                <>
                  {l.description}
                  <LineDetail lines={l.detailLines} fontSize={fontSize - 1.5} />
                </>
              )}
            </td>
            <td style={td}>
              {fmtQty(l.quantity)}
              {compact && (
                <span style={{ color: MUTED }}>
                  {" "}
                  {l.unit === "unidad" || !l.unit ? "u." : l.unit}
                </span>
              )}
            </td>
            {!compact && (
              <td style={{ ...td, textAlign: "left", color: MUTED }}>
                {l.unit ?? "unidad"}
              </td>
            )}
            <td style={td}>{view.money(l.unitPrice)}</td>
            {showBonif && (
              <td style={td}>
                {l.discountPct ? fmtRate(l.discountPct) : "0 %"}
              </td>
            )}
            {view.showIvaCol && (
              <td style={td}>
                {l.ivaRate != null ? fmtRate(l.ivaRate) : "Varias"}
              </td>
            )}
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
        <div
          key={i}
          {...legalAttr(r)}
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 16,
            fontSize: fs(fontSize),
            padding: `${sp(4)} 0`,
            ...rowStyle,
          }}
        >
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
      <div
        style={{
          fontSize: fs(fontSize - 1),
          fontWeight: 700,
          letterSpacing: 0.5,
          textTransform: "uppercase",
          color: titleColor,
          marginBottom: 4,
        }}
      >
        {view.transparency.title}
      </div>
      {view.transparency.rows.map((r, i) => (
        <div
          key={i}
          {...legalAttr(r)}
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: fs(fontSize),
            padding: `${sp(3)} 0`,
            borderBottom: sepLine(1, HAIR, "dashed"),
          }}
        >
          <span>{r.label}</span>
          <span style={{ ...NUM, fontWeight: 700 }}>{r.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Leyendas (obligatorias primero) y el pie. */
export function Legends({
  view,
  fontSize = 9.5,
  color = MUTED,
  align = "left",
}: {
  view: InvoiceViewModel;
  fontSize?: number;
  color?: string;
  align?: "left" | "center";
}) {
  if (!view.legends.length) return null;
  return (
    <div
      style={{
        fontSize: fs(fontSize),
        color,
        lineHeight: 1.45,
        textAlign: align,
      }}
    >
      {view.legends.map((l, i) => (
        <div
          key={i}
          style={
            l === "ANULADA"
              ? {
                  color: "#c62828",
                  fontWeight: 800,
                  fontSize: fs(fontSize + 4),
                  letterSpacing: 2,
                }
              : undefined
          }
        >
          {l}
        </div>
      ))}
    </div>
  );
}

export function CopyMark({
  view,
  color = MUTED,
}: {
  view: InvoiceViewModel;
  color?: string;
}) {
  if (!view.copy) return null;
  return (
    <div
      data-legal="copia"
      style={{ fontSize: fs(9), fontWeight: 700, letterSpacing: 2, color }}
    >
      {view.copy}
    </div>
  );
}

/** Título de sección con el cuadradito de color (estilo de la referencia). */
export function SectionTitle({
  children,
  color,
  line = HAIR,
}: {
  children: ReactNode;
  color: string;
  line?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        borderBottom: sepLine(1, line),
        paddingBottom: sp(5),
        marginBottom: sp(8),
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          background: color,
          borderRadius: rad(1.5),
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontSize: fs(9),
          fontWeight: 800,
          letterSpacing: 2.2,
          textTransform: "uppercase",
          color: INK,
        }}
      >
        {children}
      </span>
    </div>
  );
}

/** ¿Es la última hoja? (o el comprobante entra en una). */
export const lastPage = (p?: InvoicePage) => !p || p.index === p.count - 1;

/**
 * Pie de paginación de las hojas A4 (sólo con más de una hoja): "Hoja 1 de 2"
 * y, salvo en la última, "Continúa en la hoja siguiente".
 */
export function PageMark({
  page,
  color = MUTED,
}: {
  page?: InvoicePage;
  color?: string;
}) {
  if (!page || page.count < 2) return null;
  const last = lastPage(page);
  return (
    <div
      data-page-mark
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        fontSize: fs(9.5),
        color,
        marginTop: sp(10),
      }}
    >
      <span style={{ fontWeight: 600 }}>
        {last ? "" : "Continúa en la hoja siguiente."}
      </span>
      <span style={NUM}>
        Hoja {page.index + 1} de {page.count}
      </span>
    </div>
  );
}
