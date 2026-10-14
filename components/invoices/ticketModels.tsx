// Modelos de comprobante para impresora térmica 80 / 58 mm (ADR-112, ADR-119).
// Misma vista y mismos campos legales que el A4; el color se imprime en
// escala de grises en la térmica. Sin hooks (ver parts.tsx). Las medidas en
// `em` siguen al tamaño base del rollo, que ya trae el factor de letra.
import type { CSSProperties, ReactNode } from "react";
import { fmtQty, fmtRate } from "@/lib/invoices/legal";
import type { ResolvedInvoiceStyle } from "@/lib/invoices/style";
import {
  FONT_MONO,
  FONT_SANS,
  HeadLabel,
  Legends,
  LetterBox,
  LineDetail,
  Logo,
  LogoRow,
  MUTED,
  NUM,
  NinjaSeal,
  NonFiscalNote,
  PAPER,
  ProductThumb,
  QrImage,
  SaleBarcode,
  bandColor,
  bandInk,
  fs,
  invoiceVars,
  legalAttr,
  ownLogo,
  rad,
  sepLine,
  sp,
  type ModelProps,
} from "./parts";

export interface TicketModelProps extends ModelProps {
  paper: "80" | "58";
}

/** Ancho del rollo. */
export const ROLL_WIDTH = { "80": "80mm", "58": "58mm" } as const;

function Roll({
  s,
  paper,
  children,
  font = FONT_SANS,
  base,
}: {
  s: ResolvedInvoiceStyle;
  paper: "80" | "58";
  children: ReactNode;
  font?: string;
  /** Tamaño base del modelo (px) para 80 mm; 58 mm usa uno menos. */
  base?: number;
}) {
  const size = (base ?? 11) - (paper === "58" ? 1 : 0);
  return (
    <div
      data-invoice-ticket
      data-paper={paper}
      style={{
        ...invoiceVars(s),
        width: ROLL_WIDTH[paper],
        maxWidth: "100%",
        boxSizing: "border-box",
        background: PAPER,
        color: "#000",
        fontFamily: s.fontFamily ?? font,
        fontSize: fs(size),
        lineHeight: 1.35,
        padding: paper === "58" ? `${sp(10)} 8px` : `${sp(14)} 12px`,
        margin: "0 auto",
      }}
    >
      {children}
    </div>
  );
}

function Sep({
  color = "#000",
  dflt = "dashed",
  w = 1,
}: {
  color?: string;
  dflt?: "dashed" | "solid" | "dotted";
  w?: number;
}) {
  return (
    <div style={{ borderTop: sepLine(w, color, dflt), margin: `${sp(7)} 0` }} />
  );
}

function Row({
  label,
  value,
  strong,
  legal,
  size,
}: {
  label: ReactNode;
  value: ReactNode;
  strong?: boolean;
  legal?: string;
  size?: number;
}) {
  return (
    <div
      data-legal={legal}
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 8,
        fontWeight: strong ? 800 : 400,
        fontSize: fs(size),
      }}
    >
      <span style={{ minWidth: 0 }}>{label}</span>
      <span style={{ ...NUM }}>{value}</span>
    </div>
  );
}

/** Foto chica en monocromo del ticket (opción "fotos en el ticket"). */
export const TICKET_PHOTO = 28;

function Items({
  doc,
  view,
  style: s,
  compact,
}: ModelProps & { compact?: boolean }) {
  const photo = s.ticketPhotos;
  return (
    <div data-legal="detalle">
      {view.showIvaCol && (
        <div
          data-legal="alicuota"
          style={{ fontSize: "0.85em", color: MUTED, marginBottom: 3 }}
        >
          Cant. x precio unit. neto (alíc. IVA)
        </div>
      )}
      {doc.lines.map((l, i) =>
        compact ? (
          <div
            key={i}
            style={{
              display: photo ? "flex" : undefined,
              gap: 6,
              alignItems: "flex-start",
              marginBottom: photo ? 2 : 0,
            }}
          >
            {photo && (
              <ProductThumb url={l.imageMono} size={TICKET_PHOTO - 6} mono />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 6,
                }}
              >
                <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                  {fmtQty(l.quantity)} x {l.description}
                </span>
                <span style={{ ...NUM }}>{view.money(l.subtotal)}</span>
              </div>
              <LineDetail
                lines={l.detailLines}
                fontSize="0.85em"
                color="#333"
                style={{ marginTop: 1, marginBottom: 2 }}
              />
            </div>
          </div>
        ) : (
          <div
            key={i}
            style={{
              marginBottom: sp(3),
              display: photo ? "flex" : undefined,
              gap: 6,
              alignItems: "flex-start",
            }}
          >
            {photo && (
              <ProductThumb url={l.imageMono} size={TICKET_PHOTO} mono />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>
                {l.description}
              </div>
              <LineDetail
                lines={l.detailLines}
                fontSize="0.85em"
                color="#333"
                style={{ marginTop: 1, marginBottom: 1 }}
              />
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 6,
                }}
              >
                <span style={{ color: "#333", ...NUM }}>
                  {fmtQty(l.quantity)}{" "}
                  {l.unit && l.unit !== "unidad" ? l.unit : "u."} x{" "}
                  {view.money(l.unitPrice)}
                  {l.discountPct ? ` (-${fmtRate(l.discountPct)})` : ""}
                  {view.showIvaCol
                    ? ` (${l.ivaRate != null ? fmtRate(l.ivaRate) : "IVA"})`
                    : ""}
                </span>
                <span style={{ ...NUM, fontWeight: 600 }}>
                  {view.money(l.subtotal)}
                </span>
              </div>
            </div>
          </div>
        ),
      )}
    </div>
  );
}

function Totals({
  view,
  totalSize,
  totalStyle,
  light,
}: {
  view: ModelProps["view"];
  totalSize: number;
  totalStyle?: CSSProperties;
  light?: boolean;
}) {
  return (
    <>
      {view.totalsRows.map((r, i) => (
        <Row key={i} label={r.label} value={r.value} legal={r.legal} />
      ))}
      <div
        data-legal="total"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          fontWeight: light ? 400 : 900,
          fontSize: fs(totalSize),
          marginTop: 4,
          ...totalStyle,
        }}
      >
        <span
          style={
            light
              ? { fontSize: "0.5em", letterSpacing: 2, fontWeight: 700 }
              : undefined
          }
        >
          TOTAL
        </span>
        <span style={NUM}>{view.totalRow.value}</span>
      </div>
    </>
  );
}

function Transparency({ view }: { view: ModelProps["view"] }) {
  if (!view.transparency) return null;
  return (
    <div style={{ fontSize: "0.88em", marginTop: sp(6) }}>
      <div style={{ fontWeight: 700 }}>{view.transparency.title}</div>
      {view.transparency.rows.map((r, i) => (
        <Row key={i} label={r.label} value={r.value} legal={r.legal} />
      ))}
    </div>
  );
}

function PaymentsList({ doc, view }: ModelProps) {
  if (!doc.payments?.length) return null;
  return (
    <div>
      {doc.payments.map((p, i) => (
        <Row key={i} label={p.label} value={view.money(p.amount)} />
      ))}
    </div>
  );
}

function FiscalBlock({
  doc,
  view,
  qr,
  align = "center",
}: ModelProps & { qr: number; align?: "center" | "left" }) {
  return (
    <div style={{ textAlign: align }}>
      {view.authRows.map((r, i) => (
        <Row key={i} label={r.label} value={r.value} legal={r.legal} strong />
      ))}
      <div
        style={{
          display: "flex",
          justifyContent: align === "center" ? "center" : "flex-start",
          margin: `${sp(8)} 0 4px`,
        }}
      >
        <QrImage view={view} size={qr} />
      </div>
      {doc.authorization ? (
        <div style={{ fontSize: "0.82em", color: "#333" }}>
          Comprobante autorizado por ARCA
        </div>
      ) : !doc.fiscal ? (
        <NonFiscalNote style={{ fontSize: "0.9em" }} />
      ) : null}
    </div>
  );
}

function IssuerBlock({
  view,
  align = "center",
  inline = false,
}: {
  view: ModelProps["view"];
  align?: "center" | "left";
  inline?: boolean;
}) {
  return (
    <div style={{ textAlign: align }}>
      <div data-legal="emisor_razon_social">
        {view.tradeName && (
          <div style={{ fontWeight: 900, fontSize: "1.25em" }}>
            {view.tradeName}
          </div>
        )}
        <div
          style={{
            fontWeight: view.tradeName ? 600 : 900,
            fontSize: view.tradeName ? "1em" : "1.2em",
          }}
        >
          {view.issuerName}
        </div>
      </div>
      <div style={{ fontSize: "0.88em", color: "#222", lineHeight: 1.4 }}>
        {inline
          ? view.issuerRows.map((r, i) => (
              <span key={i} {...legalAttr(r)}>
                {i > 0 ? " · " : ""}
                {r.label === "Domicilio comercial" ||
                r.label === "Condición frente al IVA"
                  ? ""
                  : `${shortLabel(r.label)} `}
                {r.value}
              </span>
            ))
          : view.issuerRows.map((r, i) => (
              <div key={i} {...legalAttr(r)}>
                {r.label === "Domicilio comercial"
                  ? r.value
                  : `${shortLabel(r.label)}: ${r.value}`}
              </div>
            ))}
      </div>
    </div>
  );
}

function shortLabel(l: string) {
  if (l === "Ingresos Brutos") return "IIBB";
  if (l === "Inicio de actividades") return "Inicio act.";
  if (l === "Condición frente al IVA") return "IVA";
  return l;
}

function ReceiverBlock({ view }: { view: ModelProps["view"] }) {
  return (
    <div style={{ fontSize: "0.92em" }}>
      {[...view.receiverRows, ...view.docRows].map((r, i) => (
        <div key={i} {...legalAttr(r)}>
          <span style={{ color: "#333" }}>{shortLabel(r.label)}:</span>{" "}
          <b>{r.value}</b>
        </div>
      ))}
    </div>
  );
}

function DocHead({
  doc,
  view,
  style: s,
  box,
  align = "center",
}: ModelProps & { box: number; align?: "center" | "left" }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: align === "center" ? "center" : "flex-start",
        gap: 10,
      }}
    >
      <LetterBox doc={doc} size={box} border="#000" ink="#000" />
      <div>
        <div data-legal="tipo">
          <HeadLabel
            style={{
              ...s,
              headerStyle:
                s.headerStyle === "color" ? "neutral" : s.headerStyle,
            }}
            weight={900}
          >
            <span style={{ fontSize: "1.15em" }}>{view.label}</span>
          </HeadLabel>
        </div>
        <div data-legal="numero" style={{ ...NUM, fontWeight: 700 }}>
          N° {view.numberText}
        </div>
        <div data-legal="fecha" style={{ fontSize: "0.9em" }}>
          {view.dateText} {view.timeText}
        </div>
      </div>
    </div>
  );
}

/** Logo centrado del rollo (o en la posición elegida por el negocio). */
function TicketLogo({
  s,
  paper,
  maxH = 50,
  maxW = 200,
}: {
  s: ResolvedInvoiceStyle;
  paper: "80" | "58";
  maxH?: number;
  maxW?: number;
}) {
  const h = paper === "58" ? Math.round(maxH * 0.8) : maxH;
  const w = paper === "58" ? Math.round(maxW * 0.75) : maxW;
  if (!ownLogo(s)) return <LogoRow style={s} maxH={h} maxW={w} mb={6} />;
  if (!s.logoUrl) return null;
  return (
    <div
      style={{ display: "flex", justifyContent: "center", marginBottom: sp(6) }}
    >
      <Logo url={s.logoUrl} wordmark={s.logoIsDefault} maxH={h} maxW={w} />
    </div>
  );
}

function Closing({
  doc,
  view,
  style: s,
  paper,
  align = "center",
  footerWeight = 600,
}: TicketModelProps & { align?: "center" | "left"; footerWeight?: number }) {
  return (
    <>
      {view.legends.length > 0 && (
        <div style={{ marginTop: sp(6) }}>
          <Legends
            view={view}
            fontSize={paper === "58" ? 8.5 : 9.5}
            color="#222"
            align={align}
          />
        </div>
      )}
      {doc.saleCode && (
        <div style={{ marginTop: sp(8) }}>
          <SaleBarcode doc={doc} align={align} height={30} />
        </div>
      )}
      {view.footer && (
        <div
          style={{
            textAlign: align,
            marginTop: sp(6),
            fontWeight: footerWeight,
          }}
        >
          {view.footer}
        </div>
      )}
      {s.showSeal && (
        <div style={{ marginTop: sp(8) }}>
          <NinjaSeal size={paper === "58" ? 10 : 11} align={align} />
        </div>
      )}
    </>
  );
}

const hasPayments = (doc: ModelProps["doc"]) =>
  Boolean(doc.payments && doc.payments.length > 0);

// ---------------------------------------------------------------------------
// Clásico
// ---------------------------------------------------------------------------
export function TicketClasico(p: TicketModelProps) {
  const { doc, view, style: s, paper } = p;
  return (
    <Roll s={s} paper={paper}>
      <TicketLogo s={s} paper={paper} />
      <IssuerBlock view={view} />
      <Sep />
      <DocHead doc={doc} view={view} style={s} box={paper === "58" ? 40 : 46} />
      <Sep />
      <ReceiverBlock view={view} />
      <Sep />
      <Items doc={doc} view={view} style={s} />
      <Sep />
      <Totals view={view} totalSize={paper === "58" ? 14 : 16} />
      <Transparency view={view} />
      {hasPayments(doc) && (
        <>
          <Sep />
          <PaymentsList doc={doc} view={view} style={s} />
        </>
      )}
      <Sep />
      <FiscalBlock
        doc={doc}
        view={view}
        style={s}
        qr={paper === "58" ? 104 : 124}
      />
      <Closing {...p} />
    </Roll>
  );
}

// ---------------------------------------------------------------------------
// Compacto: monoespaciado, una fila por ítem y datos condensados.
// ---------------------------------------------------------------------------
export function TicketCompacto(p: TicketModelProps) {
  const { doc, view, style: s, paper } = p;
  return (
    <Roll s={s} paper={paper} font={FONT_MONO} base={10}>
      <LogoRow style={s} maxH={34} maxW={130} mb={4} />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          justifyContent: "space-between",
        }}
      >
        <div style={{ minWidth: 0 }}>
          {ownLogo(s) && s.logoUrl && (
            <Logo
              url={s.logoUrl}
              wordmark={s.logoIsDefault}
              maxH={34}
              maxW={130}
              style={{ marginBottom: 4 }}
            />
          )}
        </div>
        <LetterBox
          doc={doc}
          size={paper === "58" ? 34 : 38}
          border="#000"
          ink="#000"
        />
      </div>
      <div style={{ marginTop: 4 }}>
        <IssuerBlock view={view} align="left" inline />
      </div>
      <Sep />
      <div data-legal="tipo" style={{ fontWeight: 800 }}>
        {view.label.toUpperCase()}
      </div>
      <Row
        label={<span data-legal="numero">N° {view.numberText}</span>}
        value={
          <span data-legal="fecha">
            {view.dateText} {view.timeText}
          </span>
        }
      />
      <Sep />
      <ReceiverBlock view={view} />
      <Sep />
      <Items doc={doc} view={view} style={s} compact />
      <Sep />
      <Totals view={view} totalSize={paper === "58" ? 12 : 14} />
      <Transparency view={view} />
      {hasPayments(doc) && (
        <>
          <Sep />
          <PaymentsList doc={doc} view={view} style={s} />
        </>
      )}
      <Sep />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <QrImage view={view} size={paper === "58" ? 84 : 96} />
        <div style={{ flex: 1, minWidth: 0, fontSize: "0.92em" }}>
          {view.authRows.map((r, i) => (
            <div key={i} {...legalAttr(r)}>
              {r.label}
              <br />
              <b style={NUM}>{r.value}</b>
            </div>
          ))}
          {!doc.fiscal && <NonFiscalNote />}
        </div>
      </div>
      <Closing {...p} align="left" footerWeight={400} />
    </Roll>
  );
}

// ---------------------------------------------------------------------------
// Destacado: encabezado invertido, total grande y separadores marcados.
// ---------------------------------------------------------------------------
export function TicketDestacado(p: TicketModelProps) {
  const { doc, view, style: s, paper } = p;
  const band: CSSProperties = {
    background: bandColor(s),
    color: bandInk(s),
    margin:
      paper === "58"
        ? `calc(-1 * ${sp(10)}) -8px 0`
        : `calc(-1 * ${sp(14)}) -12px 0`,
    padding: paper === "58" ? `${sp(10)} 8px` : `${sp(14)} 12px`,
    textAlign: "center",
  };
  return (
    <Roll s={s} paper={paper}>
      <div style={band}>
        <LogoRow style={s} maxH={40} maxW={170} mb={6} onAccent />
        {ownLogo(s) && s.logoUrl && (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              marginBottom: 6,
            }}
          >
            <div
              style={{
                background: PAPER,
                borderRadius: rad(4),
                padding: "5px 9px",
              }}
            >
              <Logo
                url={s.logoUrl}
                wordmark={s.logoIsDefault}
                maxH={40}
                maxW={170}
              />
            </div>
          </div>
        )}
        <div data-legal="emisor_razon_social">
          {view.tradeName && (
            <div style={{ fontWeight: 900, fontSize: "1.3em" }}>
              {view.tradeName}
            </div>
          )}
          <div
            style={{
              fontWeight: view.tradeName ? 600 : 900,
              fontSize: view.tradeName ? "1em" : "1.3em",
            }}
          >
            {view.issuerName}
          </div>
        </div>
      </div>
      <div style={{ fontSize: "0.88em", textAlign: "center", marginTop: 6 }}>
        {view.issuerRows.map((r, i) => (
          <div key={i} {...legalAttr(r)}>
            {r.label === "Domicilio comercial"
              ? r.value
              : `${shortLabel(r.label)}: ${r.value}`}
          </div>
        ))}
      </div>
      <Sep dflt="solid" w={2} color={bandColor(s)} />
      <DocHead doc={doc} view={view} style={s} box={paper === "58" ? 42 : 50} />
      <Sep dflt="solid" w={2} color={bandColor(s)} />
      <ReceiverBlock view={view} />
      <Sep />
      <Items doc={doc} view={view} style={s} />
      <Sep />
      <Totals
        view={view}
        totalSize={paper === "58" ? 16 : 20}
        totalStyle={{
          background: bandColor(s),
          color: bandInk(s),
          padding: `${sp(6)} 8px`,
          borderRadius: rad(4),
          marginTop: 6,
        }}
      />
      <Transparency view={view} />
      {hasPayments(doc) && (
        <>
          <Sep />
          <PaymentsList doc={doc} view={view} style={s} />
        </>
      )}
      <Sep dflt="solid" w={2} color={bandColor(s)} />
      <FiscalBlock
        doc={doc}
        view={view}
        style={s}
        qr={paper === "58" ? 110 : 132}
      />
      <Closing {...p} footerWeight={800} />
    </Roll>
  );
}

// ---------------------------------------------------------------------------
// Moderno: secciones en recuadros, el tipo en una pastilla y el total en caja.
// ---------------------------------------------------------------------------
function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        border: "1px solid #000",
        borderRadius: rad(6),
        padding: `${sp(6)} 7px`,
        marginTop: sp(7),
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function TicketModerno(p: TicketModelProps) {
  const { doc, view, style: s, paper } = p;
  const cap: CSSProperties = {
    fontSize: "0.72em",
    fontWeight: 800,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    marginBottom: 3,
  };
  return (
    <Roll s={s} paper={paper}>
      <TicketLogo s={s} paper={paper} maxH={44} />
      <IssuerBlock view={view} />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginTop: sp(8),
        }}
      >
        <LetterBox
          doc={doc}
          size={paper === "58" ? 38 : 44}
          border="#000"
          ink="#000"
        />
        <div style={{ minWidth: 0 }}>
          <div data-legal="tipo">
            <HeadLabel
              style={{
                ...s,
                headerStyle:
                  s.headerStyle === "color" ? "filled" : s.headerStyle,
              }}
              weight={800}
            >
              <span style={{ fontSize: "1.05em" }}>{view.label}</span>
            </HeadLabel>
          </div>
          <div
            data-legal="numero"
            style={{ ...NUM, fontWeight: 700, marginTop: 2 }}
          >
            N° {view.numberText}
          </div>
          <div data-legal="fecha" style={{ fontSize: "0.88em" }}>
            {view.dateText} {view.timeText}
          </div>
        </div>
      </div>
      <Card>
        <div style={cap}>Cliente</div>
        <ReceiverBlock view={view} />
      </Card>
      <Card>
        <div style={cap}>Detalle</div>
        <Items doc={doc} view={view} style={s} />
      </Card>
      <Card>
        <Totals
          view={view}
          totalSize={paper === "58" ? 15 : 18}
          totalStyle={{
            border: "1.5px solid #000",
            borderRadius: rad(5),
            padding: `${sp(5)} 7px`,
            marginTop: 6,
          }}
        />
        <Transparency view={view} />
      </Card>
      {hasPayments(doc) && (
        <Card>
          <div style={cap}>Pagos</div>
          <PaymentsList doc={doc} view={view} style={s} />
        </Card>
      )}
      <Card style={{ paddingTop: sp(8), paddingBottom: sp(8) }}>
        <FiscalBlock
          doc={doc}
          view={view}
          style={s}
          qr={paper === "58" ? 104 : 120}
        />
      </Card>
      <Closing {...p} />
    </Roll>
  );
}

// ---------------------------------------------------------------------------
// Minimal: sin recuadros ni rellenos, alineado a la izquierda y mucho aire.
// ---------------------------------------------------------------------------
export function TicketMinimal(p: TicketModelProps) {
  const { doc, view, style: s, paper } = p;
  const gap = <div style={{ height: sp(10) }} />;
  return (
    <Roll s={s} paper={paper} base={10.5}>
      {!ownLogo(s) ? (
        <LogoRow style={s} maxH={36} maxW={150} mb={8} />
      ) : (
        s.logoUrl && (
          <Logo
            url={s.logoUrl}
            wordmark={s.logoIsDefault}
            maxH={36}
            maxW={150}
            style={{ marginBottom: 8 }}
          />
        )
      )}
      <IssuerBlock view={view} align="left" />
      {gap}
      <DocHead
        doc={doc}
        view={view}
        style={s}
        box={paper === "58" ? 34 : 38}
        align="left"
      />
      {gap}
      <ReceiverBlock view={view} />
      <Sep color="#888" dflt="solid" />
      <Items doc={doc} view={view} style={s} />
      <Sep color="#888" dflt="solid" />
      <Totals view={view} totalSize={paper === "58" ? 18 : 22} light />
      <Transparency view={view} />
      {hasPayments(doc) && (
        <>
          {gap}
          <PaymentsList doc={doc} view={view} style={s} />
        </>
      )}
      {gap}
      <FiscalBlock
        doc={doc}
        view={view}
        style={s}
        qr={paper === "58" ? 100 : 116}
        align="left"
      />
      <Closing {...p} align="left" footerWeight={400} />
    </Roll>
  );
}
