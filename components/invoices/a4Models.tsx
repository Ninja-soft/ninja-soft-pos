// Modelos A4 de comprobante (ADR-112, ADR-119). Todos dibujan la misma vista
// (lib/invoices/view.ts) y cubren los campos legales de cada tipo: lo que
// cambia es el diseño. Sin hooks (ver parts.tsx).
//
// Paginación (ADR-119): con muchos renglones InvoiceDocument parte el detalle
// en varias hojas y cada modelo recibe `page`. Encabezado, emisor, receptor y
// la tabla van en todas; totales, transparencia, pagos, leyendas y el pie
// fiscal (QR y CAE), sólo en la última; las demás cierran con "Continúa en la
// hoja siguiente" y "Hoja N de M".
import type { CSSProperties, ReactNode } from "react";
import type { ResolvedInvoiceStyle } from "@/lib/invoices/style";
import {
  A4_H,
  A4_W,
  ArcaMark,
  CopyMark,
  FONT_SANS,
  HAIR,
  HeadLabel,
  INK,
  KeyValueGrid,
  Legends,
  LetterBox,
  LinesTable,
  Logo,
  LogoRow,
  MUTED,
  NUM,
  NinjaSeal,
  NonFiscalNote,
  PAPER,
  PageMark,
  QrImage,
  SOFT,
  SaleBarcode,
  SectionTitle,
  TotalsRows,
  TransparencyBlock,
  bandColor,
  bandInk,
  fs,
  headColor,
  invoiceVars,
  lastPage,
  legalAttr,
  ownLogo,
  rad,
  sepLine,
  sp,
  type ModelProps,
} from "./parts";

function Sheet({
  s,
  children,
  pad,
  font = FONT_SANS,
  style,
}: {
  s: ResolvedInvoiceStyle;
  children: ReactNode;
  /** Márgenes de la hoja: arriba, costados (fijo) y abajo. */
  pad?: [number, number, number];
  font?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      data-invoice-page
      style={{
        ...invoiceVars(s),
        width: A4_W,
        minHeight: A4_H,
        boxSizing: "border-box",
        background: PAPER,
        color: INK,
        fontFamily: s.fontFamily ?? font,
        fontSize: fs(10.5),
        lineHeight: 1.35,
        display: "flex",
        flexDirection: "column",
        position: "relative",
        overflow: "hidden",
        padding: pad ? `${sp(pad[0])} ${pad[1]}px ${sp(pad[2])}` : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Nombre del emisor (nombre de fantasía arriba si lo hay). */
function IssuerName({
  view,
  size = 15,
  color = INK,
  sub = MUTED,
  align,
}: {
  view: ModelProps["view"];
  size?: number;
  color?: string;
  sub?: string;
  align?: "center";
}) {
  return (
    <div data-legal="emisor_razon_social" style={{ textAlign: align }}>
      {view.tradeName && (
        <div
          style={{
            fontSize: fs(size + 3),
            fontWeight: 800,
            color,
            lineHeight: 1.15,
          }}
        >
          {view.tradeName}
        </div>
      )}
      <div
        style={{
          fontSize: fs(view.tradeName ? size - 3 : size),
          fontWeight: view.tradeName ? 600 : 800,
          color: view.tradeName ? sub : color,
          lineHeight: 1.2,
        }}
      >
        {view.issuerName}
      </div>
    </div>
  );
}

function IssuerLines({
  view,
  color = MUTED,
  fontSize = 10,
  keys,
  align,
}: {
  view: ModelProps["view"];
  color?: string;
  fontSize?: number;
  keys?: string[];
  align?: "center" | "right";
}) {
  const rows = keys
    ? view.issuerRows.filter((r) => keys.includes(r.legal ?? r.label))
    : view.issuerRows;
  return (
    <div
      style={{
        fontSize: fs(fontSize),
        color,
        lineHeight: 1.5,
        textAlign: align,
      }}
    >
      {rows.map((r, i) => (
        <div key={i} {...legalAttr(r)}>
          <span style={{ fontWeight: 600 }}>{r.label}:</span> {r.value}
        </div>
      ))}
    </div>
  );
}

function DocTitle({
  view,
  style: s,
  align = "right",
  size = 17,
}: {
  view: ModelProps["view"];
  style: ResolvedInvoiceStyle;
  align?: "left" | "right" | "center";
  size?: number;
}) {
  return (
    <div style={{ textAlign: align }}>
      <div data-legal="tipo">
        <HeadLabel style={s} size={size}>
          {view.label}
        </HeadLabel>
      </div>
      <div
        data-legal="numero"
        style={{
          fontSize: fs(size - 3),
          fontWeight: 700,
          color: INK,
          marginTop: 2,
          ...NUM,
        }}
      >
        N° {view.numberText}
      </div>
      <div
        data-legal="fecha"
        style={{ fontSize: fs(10.5), color: MUTED, marginTop: 3 }}
      >
        Fecha de emisión: <b style={{ color: INK }}>{view.dateText}</b>
        {view.timeText ? ` ${view.timeText}` : ""}
      </div>
    </div>
  );
}

function Payments({ doc, view, color }: ModelProps & { color: string }) {
  if (!doc.payments?.length) return null;
  return (
    <div>
      {doc.payments.map((p, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: fs(10.5),
            padding: `${sp(3)} 0`,
          }}
        >
          <span
            style={{
              fontWeight: 700,
              color,
              textTransform: "uppercase",
              letterSpacing: 0.3,
            }}
          >
            {p.label}
          </span>
          <span style={{ ...NUM, fontWeight: 700 }}>
            {view.money(p.amount)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Pie fiscal: QR + ARCA + CAE (o QR + leyenda de no fiscal). */
function FiscalFooter({
  doc,
  view,
  style: s,
  variant,
  narrow = false,
}: ModelProps & { variant: "card" | "plain" | "band"; narrow?: boolean }) {
  const authBox =
    view.authRows.length > 0 ? (
      <div
        style={{
          minWidth: narrow ? 200 : 250,
          padding: variant === "plain" ? "4px 0" : `${sp(12)} 16px`,
          background:
            variant === "card"
              ? SOFT
              : variant === "band"
                ? s.accentSoft
                : undefined,
          // Borde completo fino (sin barra lateral).
          border:
            variant === "plain"
              ? undefined
              : `1px solid ${variant === "card" ? HAIR : s.accent}`,
          borderRadius: rad(4),
        }}
      >
        {view.authRows.map((r, i) => (
          <div
            key={i}
            {...legalAttr(r)}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 24,
              padding: `${sp(4)} 0`,
              borderBottom: i === 0 ? sepLine(1, HAIR, "dashed") : undefined,
            }}
          >
            <span
              style={{
                fontSize: fs(9),
                fontWeight: 700,
                letterSpacing: 1,
                color: MUTED,
                textTransform: "uppercase",
              }}
            >
              {r.label}
            </span>
            <span style={{ ...NUM, fontSize: fs(13), fontWeight: 800 }}>
              {r.value}
            </span>
          </div>
        ))}
      </div>
    ) : null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 24,
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", gap: narrow ? 12 : 18 }}
      >
        <QrImage view={view} size={narrow ? 100 : 112} />
        {doc.authorization ? (
          <ArcaMark compact={narrow} />
        ) : (
          <div style={{ maxWidth: 260, fontSize: fs(10), color: MUTED }}>
            {doc.fiscal ? (
              "Factura sin CAE todavía."
            ) : (
              <NonFiscalNote
                style={{ color: INK, fontSize: fs(10.5), marginBottom: 4 }}
              />
            )}
            <div>QR con los datos de la operación.</div>
          </div>
        )}
      </div>
      {authBox}
    </div>
  );
}

function NotesBox({
  view,
  color,
}: {
  view: ModelProps["view"];
  color: string;
}) {
  if (!view.legends.length) return null;
  return (
    <div
      style={{
        border: `1px solid ${color}`,
        borderRadius: rad(3),
        padding: `${sp(10)} 14px`,
      }}
    >
      <div
        style={{
          fontSize: fs(9),
          fontWeight: 800,
          letterSpacing: 2,
          color,
          marginBottom: 4,
        }}
      >
        NOTAS
      </div>
      <Legends view={view} fontSize={10} color={INK} />
    </div>
  );
}

/** Pie común: barcode de la venta, agradecimiento y sello. */
function FooterNote({
  doc,
  view,
  style: s,
  align = "center",
}: ModelProps & { align?: "center" | "split" }) {
  const seal = s.showSeal ? (
    <NinjaSeal size={13} align={align === "split" ? "right" : "center"} />
  ) : null;
  if (align === "split") {
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 16,
          marginTop: sp(14),
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <SaleBarcode doc={doc} align="left" height={28} />
          {view.footer && (
            <span style={{ fontSize: fs(10.5), color: MUTED }}>
              {view.footer}
            </span>
          )}
        </div>
        {seal}
      </div>
    );
  }
  return (
    <>
      {doc.saleCode && (
        <div style={{ marginTop: sp(12) }}>
          <SaleBarcode doc={doc} height={28} />
        </div>
      )}
      {view.footer && (
        <div
          style={{
            textAlign: "center",
            fontSize: fs(10.5),
            color: MUTED,
            marginTop: sp(12),
          }}
        >
          {view.footer}
        </div>
      )}
      {seal && <div style={{ marginTop: sp(10) }}>{seal}</div>}
    </>
  );
}

const hasPayments = (doc: ModelProps["doc"]) =>
  Boolean(doc.payments && doc.payments.length > 0);

/** Miniatura de la foto del producto en la tabla (opción "Mostrar foto del producto"). */
export const PHOTO_THUMB = 34;
const photoSize = (s: ResolvedInvoiceStyle) =>
  s.showPhotos ? PHOTO_THUMB : undefined;

// ---------------------------------------------------------------------------
// 1. Clásico: el lenguaje de la referencia (logo, letra al centro, bloques con
//    título y cuadradito de color, cabecera de tabla oscura, CAE en caja).
// ---------------------------------------------------------------------------
export function A4Clasico({ doc, view, style: s, page }: ModelProps) {
  const last = lastPage(page);
  return (
    <Sheet s={s} pad={[40, 44, 28]}>
      <LogoRow style={s} maxH={62} maxW={230} />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto 1fr",
          alignItems: "start",
          gap: 20,
        }}
      >
        <div>
          {ownLogo(s) && (
            <Logo
              url={s.logoUrl}
              wordmark={s.logoIsDefault}
              maxH={62}
              maxW={230}
              style={{ marginBottom: 12 }}
            />
          )}
          <IssuerName view={view} />
          <IssuerLines
            view={view}
            keys={["emisor_domicilio", "emisor_iva", "Teléfono", "Email"]}
          />
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
          }}
        >
          <LetterBox doc={doc} size={66} />
          <CopyMark view={view} />
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 6,
          }}
        >
          <DocTitle view={view} style={s} />
          <IssuerLines
            view={view}
            keys={["emisor_cuit", "emisor_iibb", "emisor_inicio"]}
            align="right"
          />
        </div>
      </div>

      <div
        style={{ borderTop: sepLine(3, INK), margin: `${sp(18)} 0 ${sp(14)}` }}
      />

      <SectionTitle color={s.accent}>Información del cliente</SectionTitle>
      <KeyValueGrid rows={[...view.receiverRows, ...view.docRows]} />

      <div style={{ marginTop: sp(16) }}>
        <SectionTitle color={s.accent}>Conceptos</SectionTitle>
        <LinesTable
          doc={doc}
          view={view}
          photo={photoSize(s)}
          head={INK}
          headInk="#ffffff"
        />
      </div>

      {last && (
        <>
          <div style={{ marginTop: sp(14) }}>
            <SectionTitle color={s.accent}>Totales</SectionTitle>
            <div style={{ marginLeft: "auto", width: 340 }}>
              <TotalsRows
                view={view}
                rowStyle={{
                  background: SOFT,
                  padding: `${sp(6)} 12px`,
                  marginBottom: 2,
                }}
              />
              <div
                data-legal="total"
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  background: "#eef0f3",
                  padding: `${sp(9)} 12px`,
                  borderRadius: rad(2),
                }}
              >
                <span
                  style={{
                    fontSize: fs(10),
                    fontWeight: 800,
                    letterSpacing: 1.5,
                    color: MUTED,
                  }}
                >
                  TOTAL
                </span>
                <span style={{ ...NUM, fontSize: fs(16), fontWeight: 800 }}>
                  {view.totalRow.value}
                </span>
              </div>
            </div>
          </div>

          {view.transparency && (
            <TransparencyBlock view={view} style={{ marginTop: sp(14) }} />
          )}

          {hasPayments(doc) && (
            <div style={{ marginTop: sp(14) }}>
              <SectionTitle color={s.accent}>Medios de pago</SectionTitle>
              <Payments doc={doc} view={view} style={s} color={headColor(s)} />
            </div>
          )}

          {view.legends.length > 0 && (
            <div style={{ marginTop: sp(14) }}>
              <NotesBox view={view} color={headColor(s)} />
            </div>
          )}
        </>
      )}

      <div style={{ marginTop: "auto", paddingTop: sp(18) }}>
        {last && (
          <>
            <SectionTitle color={s.accent}>
              Información del comprobante
            </SectionTitle>
            <FiscalFooter doc={doc} view={view} style={s} variant="card" />
            <FooterNote doc={doc} view={view} style={s} />
          </>
        )}
        <PageMark page={page} />
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// 2. Moderno: letra en color, tarjetas suaves, tabla con cabecera de color y
//    caja de total llena.
// ---------------------------------------------------------------------------
export function A4Moderno({ doc, view, style: s, page }: ModelProps) {
  const last = lastPage(page);
  const card: CSSProperties = {
    background: s.accentSoft,
    borderRadius: rad(10),
    padding: `${sp(14)} 16px`,
  };
  const cap: CSSProperties = {
    fontSize: fs(9),
    fontWeight: 800,
    letterSpacing: 2,
    color: headColor(s),
    marginBottom: sp(8),
  };
  return (
    <Sheet s={s} pad={[40, 44, 28]}>
      <LogoRow style={s} maxH={58} maxW={220} />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 24,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {ownLogo(s) && (
            <Logo
              url={s.logoUrl}
              wordmark={s.logoIsDefault}
              maxH={58}
              maxW={220}
            />
          )}
          <IssuerName view={view} size={14} />
        </div>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
          <div style={{ textAlign: "right" }}>
            <HeadLabel style={s} size={30} weight={900}>
              {view.title}
            </HeadLabel>
            <div
              data-legal="tipo"
              style={{ fontSize: fs(11), color: MUTED, marginTop: 4 }}
            >
              {view.label}
            </div>
            <div
              data-legal="numero"
              style={{
                fontSize: fs(15),
                fontWeight: 800,
                marginTop: 6,
                ...NUM,
              }}
            >
              N° {view.numberText}
            </div>
            <div
              data-legal="fecha"
              style={{ fontSize: fs(10.5), color: MUTED, marginTop: 2 }}
            >
              {view.dateText} {view.timeText}
            </div>
            <div style={{ marginTop: 4 }}>
              <CopyMark view={view} color={headColor(s)} />
            </div>
          </div>
          <LetterBox
            doc={doc}
            size={64}
            fill={bandColor(s)}
            ink={bandInk(s)}
            border={bandColor(s)}
          />
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 14,
          marginTop: sp(22),
        }}
      >
        <div style={card}>
          <div style={cap}>EMISOR</div>
          <KeyValueGrid
            rows={view.issuerRows}
            cols={1}
            labelWidth={118}
            fontSize={10}
          />
        </div>
        <div style={card}>
          <div style={cap}>CLIENTE</div>
          <KeyValueGrid
            rows={[...view.receiverRows, ...view.docRows]}
            cols={1}
            labelWidth={118}
            fontSize={10}
          />
        </div>
      </div>

      <div
        style={{
          marginTop: sp(20),
          borderRadius: rad(10),
          overflow: "hidden",
          border: `1px solid ${HAIR}`,
        }}
      >
        <LinesTable
          doc={doc}
          view={view}
          photo={photoSize(s)}
          head={bandColor(s)}
          headInk={bandInk(s)}
          zebra={s.accentSoft}
          rowBorder="transparent"
        />
      </div>

      {last && (
        <div
          style={{
            display: "flex",
            gap: 18,
            marginTop: sp(18),
            alignItems: "flex-start",
          }}
        >
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              gap: sp(12),
            }}
          >
            {hasPayments(doc) && (
              <div>
                <div style={{ ...cap, marginBottom: 4 }}>MEDIOS DE PAGO</div>
                <Payments doc={doc} view={view} style={s} color={INK} />
              </div>
            )}
            {view.transparency && (
              <TransparencyBlock view={view} titleColor={headColor(s)} />
            )}
            <Legends view={view} />
          </div>
          <div style={{ width: 300 }}>
            <TotalsRows
              view={view}
              rowStyle={{
                padding: `${sp(5)} 4px`,
                borderBottom: sepLine(1, HAIR),
              }}
            />
            <div
              data-legal="total"
              style={{
                marginTop: 8,
                background: bandColor(s),
                color: bandInk(s),
                borderRadius: rad(10),
                padding: `${sp(12)} 16px`,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span
                style={{ fontSize: fs(11), fontWeight: 800, letterSpacing: 2 }}
              >
                TOTAL
              </span>
              <span style={{ ...NUM, fontSize: fs(20), fontWeight: 900 }}>
                {view.totalRow.value}
              </span>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: "auto", paddingTop: sp(22) }}>
        {last && (
          <>
            <div style={{ borderTop: sepLine(1, HAIR), paddingTop: sp(16) }}>
              <FiscalFooter doc={doc} view={view} style={s} variant="band" />
            </div>
            <FooterNote doc={doc} view={view} style={s} align="split" />
          </>
        )}
        <PageMark page={page} />
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// 3. Minimal: tipografía, filetes finos y el color sólo en el total.
// ---------------------------------------------------------------------------
export function A4Minimal({ doc, view, style: s, page }: ModelProps) {
  const last = lastPage(page);
  const label: CSSProperties = {
    fontSize: fs(8.5),
    letterSpacing: 2,
    textTransform: "uppercase",
    color: MUTED,
    marginBottom: 6,
  };
  return (
    <Sheet s={s} pad={[52, 56, 30]}>
      <LogoRow style={s} maxH={48} maxW={200} mb={18} />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
        }}
      >
        <div>
          {ownLogo(s) && (
            <Logo
              url={s.logoUrl}
              wordmark={s.logoIsDefault}
              maxH={48}
              maxW={200}
              style={{ marginBottom: 18 }}
            />
          )}
          <div
            style={{
              fontSize: fs(34),
              fontWeight: 300,
              letterSpacing: -0.5,
              lineHeight: 1,
            }}
          >
            {view.title.toLowerCase()}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ textAlign: "right", fontSize: fs(10.5) }}>
            <div data-legal="tipo">
              <HeadLabel
                style={{
                  ...s,
                  headerStyle:
                    s.headerStyle === "color" ? "neutral" : s.headerStyle,
                }}
                size={10.5}
                weight={700}
              >
                {view.label}
              </HeadLabel>
            </div>
            <div data-legal="numero" style={{ ...NUM }}>
              N° {view.numberText}
            </div>
            <div data-legal="fecha" style={{ color: MUTED }}>
              {view.dateText} {view.timeText}
            </div>
            <CopyMark view={view} />
          </div>
          <LetterBox doc={doc} size={54} border="#bfc3cc" />
        </div>
      </div>

      <div
        style={{ borderTop: sepLine(1, INK), margin: `${sp(26)} 0 ${sp(22)}` }}
      />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 36 }}>
        <div>
          <div style={label}>De</div>
          <IssuerName view={view} size={13} />
          <div style={{ marginTop: 6 }}>
            <IssuerLines view={view} fontSize={9.5} />
          </div>
        </div>
        <div>
          <div style={label}>Para</div>
          <KeyValueGrid
            rows={[...view.receiverRows, ...view.docRows]}
            cols={1}
            labelWidth={112}
            fontSize={10}
          />
        </div>
      </div>

      <div style={{ marginTop: sp(30) }}>
        <LinesTable
          doc={doc}
          view={view}
          photo={photoSize(s)}
          head="transparent"
          headInk={MUTED}
          descStrong={false}
          cellPad={[6, 8]}
          headStyle={{ borderBottom: sepLine(1, INK) }}
        />
      </div>

      {last && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 30,
            marginTop: sp(20),
          }}
        >
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              gap: sp(12),
            }}
          >
            {view.transparency && (
              <TransparencyBlock view={view} fontSize={9.5} />
            )}
            {hasPayments(doc) && (
              <div>
                <div style={label}>Pagos</div>
                <Payments doc={doc} view={view} style={s} color={INK} />
              </div>
            )}
            <Legends view={view} />
          </div>
          <div style={{ width: 280 }}>
            <TotalsRows view={view} />
            <div
              data-legal="total"
              style={{
                borderTop: sepLine(1, INK),
                marginTop: 6,
                paddingTop: sp(10),
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
              }}
            >
              <span style={{ fontSize: fs(9), letterSpacing: 2, color: MUTED }}>
                TOTAL
              </span>
              <span
                style={{
                  ...NUM,
                  fontSize: fs(24),
                  fontWeight: 300,
                  color: headColor(s),
                }}
              >
                {view.totalRow.value}
              </span>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: "auto", paddingTop: sp(24) }}>
        {last && (
          <>
            <div
              style={{ borderTop: sepLine(1, HAIR), marginBottom: sp(16) }}
            />
            <FiscalFooter doc={doc} view={view} style={s} variant="plain" />
            <FooterNote doc={doc} view={view} style={s} align="split" />
          </>
        )}
        <PageMark page={page} />
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// 4. Corporativo: banda de color de punta a punta con logo y datos.
// ---------------------------------------------------------------------------
export function A4Corporativo({ doc, view, style: s, page }: ModelProps) {
  const last = lastPage(page);
  const onBand = bandInk(s);
  const cap: CSSProperties = {
    fontSize: fs(9),
    fontWeight: 800,
    letterSpacing: 2,
    color: headColor(s),
    marginBottom: 6,
  };
  return (
    <Sheet s={s}>
      <div
        style={{
          background: bandColor(s),
          color: onBand,
          padding: `${sp(30)} 44px ${sp(26)}`,
        }}
      >
        <LogoRow style={s} maxH={44} maxW={200} onAccent />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 20,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {ownLogo(s) && s.logoUrl && (
              // Placa blanca: el logo (propio o el de Ninja POS) se lee sobre cualquier color.
              <div
                style={{
                  background: PAPER,
                  borderRadius: rad(6),
                  padding: "8px 12px",
                  alignSelf: "flex-start",
                }}
              >
                <Logo
                  url={s.logoUrl}
                  wordmark={s.logoIsDefault}
                  maxH={48}
                  maxW={200}
                />
              </div>
            )}
            <IssuerName view={view} size={15} color={onBand} sub={onBand} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ textAlign: "right" }}>
              <div
                data-legal="tipo"
                style={{
                  fontSize: fs(22),
                  fontWeight: 900,
                  letterSpacing: 0.5,
                }}
              >
                {view.label.toUpperCase()}
              </div>
              <div
                data-legal="numero"
                style={{ fontSize: fs(14), fontWeight: 700, ...NUM }}
              >
                N° {view.numberText}
              </div>
              <div
                data-legal="fecha"
                style={{ fontSize: fs(10.5), opacity: 0.9 }}
              >
                Fecha {view.dateText} {view.timeText}
              </div>
            </div>
            <LetterBox
              doc={doc}
              size={66}
              fill={PAPER}
              ink={headColor(s)}
              border={PAPER}
            />
          </div>
        </div>
      </div>
      <div
        style={{
          background: INK,
          color: "#fff",
          padding: `${sp(7)} 44px`,
          display: "flex",
          justifyContent: "space-between",
          fontSize: fs(9.5),
        }}
      >
        <span>
          {view.issuerRows
            .filter(
              (r) =>
                r.legal === "emisor_cuit" ||
                r.legal === "emisor_iibb" ||
                r.legal === "emisor_inicio",
            )
            .map((r, i) => (
              <span key={i} {...legalAttr(r)} style={{ marginRight: 18 }}>
                <b>{r.label}:</b> {r.value}
              </span>
            ))}
        </span>
        <CopyMark view={view} color="#fff" />
      </div>

      <div
        style={{
          padding: `${sp(22)} 44px ${sp(28)}`,
          display: "flex",
          flexDirection: "column",
          flex: 1,
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 0,
            border: `1px solid ${HAIR}`,
            borderRadius: rad(4),
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: `${sp(12)} 14px`,
              borderRight: `1px solid ${HAIR}`,
            }}
          >
            <div style={cap}>DATOS DEL EMISOR</div>
            <IssuerLines
              view={view}
              keys={["emisor_domicilio", "emisor_iva", "Teléfono", "Email"]}
              color={INK}
            />
          </div>
          <div style={{ padding: `${sp(12)} 14px` }}>
            <div style={cap}>DATOS DEL CLIENTE</div>
            <KeyValueGrid
              rows={view.receiverRows}
              cols={1}
              labelWidth={150}
              fontSize={10}
            />
          </div>
        </div>
        {view.docRows.length > 0 && (
          <div
            style={{
              background: s.accentSoft,
              padding: `${sp(8)} 14px`,
              marginTop: 6,
              borderRadius: rad(4),
            }}
          >
            <KeyValueGrid
              rows={view.docRows}
              cols={2}
              labelWidth={110}
              fontSize={10}
            />
          </div>
        )}

        <div style={{ marginTop: sp(18) }}>
          <LinesTable
            doc={doc}
            view={view}
            photo={photoSize(s)}
            head="#eceef2"
            headInk={INK}
            headStyle={{ borderBottom: `2px solid ${bandColor(s)}` }}
          />
        </div>

        {last && (
          <div
            style={{
              display: "flex",
              gap: 22,
              marginTop: sp(16),
              alignItems: "flex-start",
            }}
          >
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                gap: sp(12),
              }}
            >
              {hasPayments(doc) && (
                <div>
                  <div style={{ ...cap, marginBottom: 4 }}>MEDIOS DE PAGO</div>
                  <Payments doc={doc} view={view} style={s} color={INK} />
                </div>
              )}
              {view.transparency && (
                <TransparencyBlock view={view} titleColor={headColor(s)} />
              )}
              <Legends view={view} />
            </div>
            <div
              style={{
                width: 310,
                border: `1px solid ${HAIR}`,
                borderRadius: rad(4),
                overflow: "hidden",
              }}
            >
              <div style={{ padding: `${sp(6)} 12px` }}>
                <TotalsRows view={view} />
              </div>
              <div
                data-legal="total"
                style={{
                  background: INK,
                  color: "#fff",
                  padding: `${sp(11)} 12px`,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span
                  style={{
                    fontSize: fs(10),
                    fontWeight: 800,
                    letterSpacing: 2,
                  }}
                >
                  TOTAL
                </span>
                <span style={{ ...NUM, fontSize: fs(18), fontWeight: 900 }}>
                  {view.totalRow.value}
                </span>
              </div>
            </div>
          </div>
        )}

        <div style={{ marginTop: "auto", paddingTop: sp(22) }}>
          {last && (
            <>
              <FiscalFooter doc={doc} view={view} style={s} variant="card" />
              <FooterNote doc={doc} view={view} style={s} />
            </>
          )}
          <PageMark page={page} />
        </div>
      </div>
      <div style={{ background: bandColor(s), height: 10 }} />
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// 5. Ejecutivo: columna lateral con emisor, cliente y pagos.
// ---------------------------------------------------------------------------
export function A4Ejecutivo({ doc, view, style: s, page }: ModelProps) {
  const last = lastPage(page);
  const side: CSSProperties = {
    fontSize: fs(8.5),
    fontWeight: 800,
    letterSpacing: 2,
    color: headColor(s),
    margin: `${sp(18)} 0 6px`,
  };
  return (
    <Sheet s={s} style={{ flexDirection: "row" }}>
      <div
        style={{
          width: 236,
          background: s.accentSoft,
          padding: `${sp(36)} 22px ${sp(24)}`,
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <LogoRow style={s} maxH={56} maxW={190} mb={14} />
        {ownLogo(s) && (
          <Logo
            url={s.logoUrl}
            wordmark={s.logoIsDefault}
            maxH={56}
            maxW={190}
            style={{ marginBottom: 14 }}
          />
        )}
        <IssuerName view={view} size={13} />
        <div style={side}>EMISOR</div>
        <IssuerLines view={view} fontSize={9.5} color={INK} />
        <div style={side}>CLIENTE</div>
        <KeyValueGrid rows={view.receiverRows} stacked fontSize={10} />
        {view.docRows.length > 0 && (
          <>
            <div style={side}>OPERACIÓN</div>
            <KeyValueGrid rows={view.docRows} stacked fontSize={10} />
          </>
        )}
        {last && hasPayments(doc) && (
          <>
            <div style={side}>MEDIOS DE PAGO</div>
            <Payments doc={doc} view={view} style={s} color={INK} />
          </>
        )}
        <div style={{ marginTop: "auto", paddingTop: sp(18) }}>
          {s.showSeal && <NinjaSeal size={12} align="left" />}
        </div>
      </div>

      <div
        style={{
          flex: 1,
          padding: `${sp(36)} 36px ${sp(26)}`,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
          }}
        >
          <div>
            <div
              style={{
                fontSize: fs(9),
                letterSpacing: 2.5,
                color: MUTED,
                fontWeight: 700,
              }}
            >
              {view.title}
            </div>
            <div data-legal="tipo" style={{ marginTop: 2 }}>
              <HeadLabel style={s} size={24} weight={900}>
                {view.label}
              </HeadLabel>
            </div>
            <div
              data-legal="numero"
              style={{
                fontSize: fs(14),
                fontWeight: 700,
                marginTop: 4,
                ...NUM,
              }}
            >
              N° {view.numberText}
            </div>
            <div
              data-legal="fecha"
              style={{ fontSize: fs(10.5), color: MUTED, marginTop: 2 }}
            >
              Emitida el {view.dateText} {view.timeText}
            </div>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 6,
            }}
          >
            <LetterBox doc={doc} size={60} />
            <CopyMark view={view} />
          </div>
        </div>

        <div style={{ marginTop: sp(22) }}>
          <LinesTable
            doc={doc}
            view={view}
            photo={photoSize(s)}
            head={INK}
            headInk="#fff"
            fontSize={10}
            compact
          />
        </div>

        {last && (
          <>
            <div style={{ marginLeft: "auto", width: 290, marginTop: sp(14) }}>
              <TotalsRows
                view={view}
                rowStyle={{ borderBottom: sepLine(1, HAIR) }}
              />
              <div
                data-legal="total"
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginTop: 8,
                  padding: `${sp(10)} 0`,
                  borderTop: `2px solid ${bandColor(s)}`,
                }}
              >
                <span
                  style={{
                    fontSize: fs(10),
                    fontWeight: 800,
                    letterSpacing: 2,
                  }}
                >
                  TOTAL
                </span>
                <span
                  style={{
                    ...NUM,
                    fontSize: fs(20),
                    fontWeight: 900,
                    color: headColor(s),
                  }}
                >
                  {view.totalRow.value}
                </span>
              </div>
            </div>

            {view.transparency && (
              <TransparencyBlock
                view={view}
                titleColor={headColor(s)}
                style={{ marginTop: sp(12) }}
              />
            )}
            <div style={{ marginTop: sp(12) }}>
              <Legends view={view} />
            </div>
          </>
        )}

        <div style={{ marginTop: "auto", paddingTop: sp(20) }}>
          {last && (
            <>
              <FiscalFooter
                doc={doc}
                view={view}
                style={s}
                variant="band"
                narrow
              />
              {doc.saleCode && (
                <div style={{ marginTop: sp(12) }}>
                  <SaleBarcode doc={doc} align="left" height={28} />
                </div>
              )}
              {view.footer && (
                <div
                  style={{
                    fontSize: fs(10.5),
                    color: MUTED,
                    marginTop: sp(12),
                  }}
                >
                  {view.footer}
                </div>
              )}
            </>
          )}
          <PageMark page={page} />
        </div>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// 6. Elegante: encabezado centrado, filetes dobles y versalitas.
// ---------------------------------------------------------------------------
export function A4Elegante({ doc, view, style: s, page }: ModelProps) {
  const last = lastPage(page);
  const SERIF = "Georgia, 'Times New Roman', Times, serif";
  const caps: CSSProperties = {
    fontSize: fs(9),
    letterSpacing: 3,
    textTransform: "uppercase",
    color: MUTED,
    fontWeight: 600,
  };
  const double = (
    <div style={{ margin: `${sp(16)} 0` }}>
      <div style={{ borderTop: sepLine(1, INK) }} />
      <div style={{ borderTop: sepLine(1, INK), marginTop: 3 }} />
    </div>
  );
  return (
    <Sheet s={s} pad={[44, 52, 30]} font={SERIF}>
      <LogoRow style={s} maxH={56} maxW={210} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: sp(8),
          textAlign: "center",
        }}
      >
        {ownLogo(s) && (
          <Logo
            url={s.logoUrl}
            wordmark={s.logoIsDefault}
            maxH={56}
            maxW={210}
          />
        )}
        <IssuerName view={view} size={17} align="center" />
        <IssuerLines
          view={view}
          keys={["emisor_domicilio", "Teléfono", "Email"]}
          align="center"
          fontSize={9.5}
        />
      </div>

      {double}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto 1fr",
          alignItems: "center",
          gap: 18,
        }}
      >
        <IssuerLines
          view={view}
          keys={["emisor_cuit", "emisor_iibb", "emisor_inicio", "emisor_iva"]}
          fontSize={9.5}
        />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
          }}
        >
          <LetterBox doc={doc} size={58} />
          <CopyMark view={view} />
        </div>
        <div style={{ textAlign: "right" }}>
          <div data-legal="tipo">
            <HeadLabel style={s} size={18} weight={700} upper>
              {view.label}
            </HeadLabel>
          </div>
          <div
            data-legal="numero"
            style={{ fontSize: fs(13), fontWeight: 700, marginTop: 3, ...NUM }}
          >
            N° {view.numberText}
          </div>
          <div
            data-legal="fecha"
            style={{ fontSize: fs(10), color: MUTED, marginTop: 2 }}
          >
            {view.dateText} {view.timeText}
          </div>
        </div>
      </div>

      {double}

      <div style={caps}>Señores</div>
      <div style={{ marginTop: sp(6) }}>
        <KeyValueGrid
          rows={[...view.receiverRows, ...view.docRows]}
          labelWidth={124}
          fontSize={10.5}
        />
      </div>

      <div style={{ marginTop: sp(20) }}>
        <LinesTable
          doc={doc}
          view={view}
          photo={photoSize(s)}
          head="transparent"
          headInk={INK}
          descStrong={false}
          headStyle={{
            borderTop: sepLine(1, INK),
            borderBottom: sepLine(1, INK),
            letterSpacing: 2,
          }}
        />
      </div>

      {last && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 30,
            marginTop: sp(18),
          }}
        >
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              gap: sp(12),
            }}
          >
            {view.transparency && (
              <TransparencyBlock
                view={view}
                titleColor={headColor(s)}
                fontSize={9.5}
              />
            )}
            {hasPayments(doc) && (
              <div>
                <div style={caps}>Forma de pago</div>
                <Payments doc={doc} view={view} style={s} color={INK} />
              </div>
            )}
            <Legends view={view} />
          </div>
          <div style={{ width: 290 }}>
            <TotalsRows
              view={view}
              rowStyle={{ borderBottom: sepLine(1, HAIR, "dotted") }}
            />
            <div
              data-legal="total"
              style={{
                marginTop: 8,
                padding: `${sp(10)} 0`,
                borderTop: sepLine(1, INK),
                borderBottom: sepLine(3, INK, "solid"),
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
              }}
            >
              <span style={{ ...caps, color: INK }}>Total</span>
              <span
                style={{
                  ...NUM,
                  fontSize: fs(21),
                  fontWeight: 700,
                  color: headColor(s),
                }}
              >
                {view.totalRow.value}
              </span>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: "auto", paddingTop: sp(22) }}>
        {last && (
          <>
            {double}
            <FiscalFooter doc={doc} view={view} style={s} variant="plain" />
            <FooterNote doc={doc} view={view} style={s} />
          </>
        )}
        <PageMark page={page} />
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// 7. Bloques de color: cada sección en una tarjeta con barra de título.
// ---------------------------------------------------------------------------
function Block({
  title,
  s,
  children,
  style,
}: {
  title: string;
  s: ResolvedInvoiceStyle;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        border: `1px solid ${HAIR}`,
        borderRadius: rad(8),
        overflow: "hidden",
        ...style,
      }}
    >
      <div
        style={{
          background: bandColor(s),
          color: bandInk(s),
          padding: `${sp(6)} 12px`,
          fontSize: fs(9),
          fontWeight: 800,
          letterSpacing: 2,
          textTransform: "uppercase",
        }}
      >
        {title}
      </div>
      <div style={{ padding: `${sp(10)} 12px` }}>{children}</div>
    </div>
  );
}

export function A4Bloques({ doc, view, style: s, page }: ModelProps) {
  const last = lastPage(page);
  return (
    <Sheet s={s} pad={[36, 40, 26]}>
      <LogoRow style={s} maxH={56} maxW={220} />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 18,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {ownLogo(s) && (
            <Logo
              url={s.logoUrl}
              wordmark={s.logoIsDefault}
              maxH={56}
              maxW={200}
            />
          )}
          <IssuerName view={view} size={15} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <DocTitle view={view} style={s} size={18} />
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 6,
            }}
          >
            <LetterBox
              doc={doc}
              size={60}
              fill={s.accentSoft}
              border={bandColor(s)}
            />
            <CopyMark view={view} />
          </div>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
          marginTop: sp(18),
        }}
      >
        <Block title="Emisor" s={s}>
          <KeyValueGrid
            rows={view.issuerRows}
            cols={1}
            labelWidth={122}
            fontSize={9.5}
          />
        </Block>
        <Block title="Cliente" s={s}>
          <KeyValueGrid
            rows={[...view.receiverRows, ...view.docRows]}
            cols={1}
            labelWidth={122}
            fontSize={9.5}
          />
        </Block>
      </div>

      <Block title="Detalle" s={s} style={{ marginTop: sp(12) }}>
        <div style={{ margin: "-4px -12px" }}>
          <LinesTable
            doc={doc}
            view={view}
            photo={photoSize(s)}
            head={SOFT}
            headInk={INK}
            zebra={s.accentSoft}
            rowBorder="transparent"
          />
        </div>
      </Block>

      {last && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 300px",
            gap: 12,
            marginTop: sp(12),
            alignItems: "start",
          }}
        >
          <div
            style={{ display: "flex", flexDirection: "column", gap: sp(12) }}
          >
            {hasPayments(doc) && (
              <Block title="Medios de pago" s={s}>
                <Payments doc={doc} view={view} style={s} color={INK} />
              </Block>
            )}
            {view.transparency && (
              <Block title="Transparencia fiscal" s={s}>
                <TransparencyBlock view={view} />
              </Block>
            )}
            {view.legends.length > 0 && (
              <Block title="Notas" s={s}>
                <Legends view={view} color={INK} />
              </Block>
            )}
          </div>
          <Block title="Totales" s={s}>
            <TotalsRows view={view} />
            <div
              data-legal="total"
              style={{
                marginTop: 6,
                background: s.accentSoft,
                borderRadius: rad(6),
                padding: `${sp(10)} 10px`,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span
                style={{ fontSize: fs(10), fontWeight: 800, letterSpacing: 2 }}
              >
                TOTAL
              </span>
              <span
                style={{
                  ...NUM,
                  fontSize: fs(19),
                  fontWeight: 900,
                  color: headColor(s),
                }}
              >
                {view.totalRow.value}
              </span>
            </div>
          </Block>
        </div>
      )}

      <div style={{ marginTop: "auto", paddingTop: sp(16) }}>
        {last && (
          <>
            <Block title="Comprobante electrónico" s={s}>
              <FiscalFooter doc={doc} view={view} style={s} variant="plain" />
            </Block>
            <FooterNote doc={doc} view={view} style={s} align="split" />
          </>
        )}
        <PageMark page={page} />
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// 8. Compacto de una hoja: encabezado bajo, datos en una franja y tabla densa.
// ---------------------------------------------------------------------------
export function A4Compacto({ doc, view, style: s, page }: ModelProps) {
  const last = lastPage(page);
  return (
    <Sheet s={s} pad={[26, 32, 20]} style={{ fontSize: fs(9.5) }}>
      <LogoRow style={s} maxH={40} maxW={170} mb={8} />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto 1fr",
          alignItems: "center",
          gap: 14,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            minWidth: 0,
          }}
        >
          {ownLogo(s) && (
            <Logo
              url={s.logoUrl}
              wordmark={s.logoIsDefault}
              maxH={40}
              maxW={150}
            />
          )}
          <IssuerName view={view} size={12.5} />
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 3,
          }}
        >
          <LetterBox doc={doc} size={46} />
          <CopyMark view={view} />
        </div>
        <div style={{ textAlign: "right" }}>
          <div data-legal="tipo">
            <HeadLabel style={s} size={14}>
              {view.label}
            </HeadLabel>
          </div>
          <div style={{ fontSize: fs(11), fontWeight: 700, ...NUM }}>
            <span data-legal="numero">N° {view.numberText}</span>
            <span data-legal="fecha" style={{ color: MUTED, fontWeight: 400 }}>
              {" "}
              · {view.dateText} {view.timeText}
            </span>
          </div>
        </div>
      </div>

      <div
        style={{
          marginTop: sp(10),
          background: SOFT,
          borderRadius: rad(4),
          padding: `${sp(8)} 12px`,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
        }}
      >
        <KeyValueGrid
          rows={view.issuerRows}
          cols={1}
          labelWidth={118}
          fontSize={9}
        />
        <KeyValueGrid
          rows={[...view.receiverRows, ...view.docRows]}
          cols={1}
          labelWidth={118}
          fontSize={9}
        />
      </div>

      <div style={{ marginTop: sp(10) }}>
        <LinesTable
          doc={doc}
          view={view}
          photo={photoSize(s)}
          head={bandColor(s)}
          headInk={bandInk(s)}
          fontSize={9.5}
          cellPad={[4, 8]}
          zebra={SOFT}
        />
      </div>

      {last && (
        <div
          style={{
            display: "flex",
            gap: 16,
            marginTop: sp(10),
            alignItems: "flex-start",
          }}
        >
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              gap: sp(8),
            }}
          >
            {hasPayments(doc) && (
              <Payments doc={doc} view={view} style={s} color={INK} />
            )}
            {view.transparency && (
              <TransparencyBlock
                view={view}
                titleColor={headColor(s)}
                fontSize={9}
              />
            )}
            <Legends view={view} fontSize={8.5} />
          </div>
          <div style={{ width: 260 }}>
            <TotalsRows
              view={view}
              fontSize={9.5}
              rowStyle={{ padding: `${sp(2)} 0` }}
            />
            <div
              data-legal="total"
              style={{
                marginTop: 4,
                borderTop: sepLine(2, INK),
                paddingTop: sp(6),
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
              }}
            >
              <span
                style={{
                  fontSize: fs(9.5),
                  fontWeight: 800,
                  letterSpacing: 1.5,
                }}
              >
                TOTAL
              </span>
              <span
                style={{
                  ...NUM,
                  fontSize: fs(16),
                  fontWeight: 900,
                  color: headColor(s),
                }}
              >
                {view.totalRow.value}
              </span>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: "auto", paddingTop: sp(12) }}>
        {last && (
          <>
            <div style={{ borderTop: sepLine(1, HAIR), paddingTop: sp(10) }}>
              <FiscalFooter
                doc={doc}
                view={view}
                style={s}
                variant="plain"
                narrow
              />
            </div>
            <FooterNote doc={doc} view={view} style={s} align="split" />
          </>
        )}
        <PageMark page={page} />
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// 9. Catálogo con fotos: renglones altos con la foto grande del producto.
// ---------------------------------------------------------------------------
export const CATALOG_PHOTO = 64;

export function A4Catalogo({ doc, view, style: s, page }: ModelProps) {
  const last = lastPage(page);
  const cap: CSSProperties = {
    fontSize: fs(9),
    fontWeight: 800,
    letterSpacing: 2,
    color: headColor(s),
    marginBottom: sp(6),
    textTransform: "uppercase",
  };
  return (
    <Sheet s={s} pad={[34, 40, 26]}>
      <LogoRow style={s} maxH={56} maxW={220} />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 18,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {ownLogo(s) && (
            <Logo
              url={s.logoUrl}
              wordmark={s.logoIsDefault}
              maxH={56}
              maxW={220}
            />
          )}
          <IssuerName view={view} size={15} />
          <IssuerLines
            view={view}
            keys={["emisor_domicilio", "emisor_iva", "Teléfono", "Email"]}
            fontSize={9.5}
          />
        </div>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: 4,
            }}
          >
            <DocTitle view={view} style={s} size={18} />
            <IssuerLines
              view={view}
              keys={["emisor_cuit", "emisor_iibb", "emisor_inicio"]}
              align="right"
              fontSize={9.5}
            />
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 6,
            }}
          >
            <LetterBox doc={doc} size={58} />
            <CopyMark view={view} />
          </div>
        </div>
      </div>

      <div
        style={{
          marginTop: sp(16),
          background: s.accentSoft,
          borderRadius: rad(8),
          padding: `${sp(10)} 14px`,
        }}
      >
        <div style={cap}>Cliente</div>
        <KeyValueGrid
          rows={[...view.receiverRows, ...view.docRows]}
          labelWidth={124}
          fontSize={10}
        />
      </div>

      <div style={{ marginTop: sp(16) }}>
        <LinesTable
          doc={doc}
          view={view}
          photo={CATALOG_PHOTO}
          head="transparent"
          headInk={MUTED}
          fontSize={11}
          cellPad={[10, 10]}
          headStyle={{ borderBottom: `2px solid ${bandColor(s)}` }}
        />
      </div>

      {last && (
        <div
          style={{
            display: "flex",
            gap: 20,
            marginTop: sp(16),
            alignItems: "flex-start",
          }}
        >
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              gap: sp(12),
            }}
          >
            {hasPayments(doc) && (
              <div>
                <div style={cap}>Medios de pago</div>
                <Payments doc={doc} view={view} style={s} color={INK} />
              </div>
            )}
            {view.transparency && (
              <TransparencyBlock view={view} titleColor={headColor(s)} />
            )}
            <Legends view={view} />
          </div>
          <div style={{ width: 300 }}>
            <TotalsRows
              view={view}
              rowStyle={{ borderBottom: sepLine(1, HAIR) }}
            />
            <div
              data-legal="total"
              style={{
                marginTop: 8,
                background: bandColor(s),
                color: bandInk(s),
                borderRadius: rad(8),
                padding: `${sp(11)} 14px`,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span
                style={{
                  fontSize: fs(10.5),
                  fontWeight: 800,
                  letterSpacing: 2,
                }}
              >
                TOTAL
              </span>
              <span style={{ ...NUM, fontSize: fs(19), fontWeight: 900 }}>
                {view.totalRow.value}
              </span>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: "auto", paddingTop: sp(18) }}>
        {last && (
          <>
            <div style={{ borderTop: sepLine(1, HAIR), paddingTop: sp(14) }}>
              <FiscalFooter doc={doc} view={view} style={s} variant="card" />
            </div>
            <FooterNote doc={doc} view={view} style={s} align="split" />
          </>
        )}
        <PageMark page={page} />
      </div>
    </Sheet>
  );
}
