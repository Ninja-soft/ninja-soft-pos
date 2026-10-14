// Modelo de presupuesto (ADR-122) sobre el motor de comprobantes de ADR-112,
// SIN tocar sus modelos: la hoja A4 es propia (reusa las piezas de
// components/invoices/parts) y el ticket usa los modelos de ticket del motor
// con un InvoiceDoc no fiscal ("PRESUPUESTO", "Documento no válido como
// factura", validez y condiciones como leyendas). Sin hooks: sirve para la
// vista previa, la impresión y el PDF (html2canvas, [data-invoice-page]).
import type { CSSProperties, ReactNode } from "react";
import type { Quote, QuoteBrand, QuoteItem } from "@/lib/quotes/logic";
import { QUOTE_LEGEND, quoteNumberLabel, quoteToInvoiceDoc } from "@/lib/quotes/logic";
import type { ResolvedInvoiceStyle } from "@/lib/invoices/style";
import { invoiceView } from "@/lib/invoices/view";
import { fmtDate } from "@/lib/invoices/legal";
import { InvoiceDocument } from "@/components/invoices/InvoiceDocument";
import {
  A4_H,
  A4_W,
  FONT_SANS,
  HAIR,
  INK,
  KeyValueGrid,
  LinesTable,
  Logo,
  MUTED,
  NUM,
  NinjaSeal,
  NonFiscalNote,
  PAPER,
  SectionTitle,
  TotalsRows,
} from "@/components/invoices/parts";

export type QuoteFormat = "a4" | "80" | "58";

interface Props {
  quote: Quote;
  items: QuoteItem[];
  brand: QuoteBrand | null;
  style: ResolvedInvoiceStyle;
  format: QuoteFormat;
  /** Reglas de impresión A4 (@page). Sólo en el nodo que se imprime. */
  printable?: boolean;
  className?: string;
}

function Block({ title, color, children }: { title: string; color: string; children: ReactNode }) {
  return (
    <div style={{ marginTop: 14 }}>
      <SectionTitle color={color}>{title}</SectionTitle>
      {children}
    </div>
  );
}

const pre: CSSProperties = { whiteSpace: "pre-wrap", fontSize: 10.5, lineHeight: 1.5, color: INK, overflowWrap: "anywhere" };

/** Hoja A4 del presupuesto. */
export function QuoteA4({ quote: q, items, brand, style: s }: Omit<Props, "format" | "printable" | "className">) {
  const doc = quoteToInvoiceDoc(q, items, brand);
  const view = invoiceView(doc);
  const numberText = quoteNumberLabel(q.pto_vta, q.number);
  const accepted = q.accepted_at && (q.status === "accepted" || q.status === "converted");
  return (
    <div
      data-invoice-page
      data-quote-page
      style={{
        width: A4_W,
        minHeight: A4_H,
        boxSizing: "border-box",
        background: PAPER,
        color: INK,
        fontFamily: FONT_SANS,
        fontSize: 10.5,
        lineHeight: 1.35,
        display: "flex",
        flexDirection: "column",
        padding: "40px 44px 28px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 24 }}>
        <div style={{ minWidth: 0 }}>
          <Logo url={s.logoUrl} wordmark={s.logoIsDefault} maxH={62} maxW={230} style={{ marginBottom: 12 }} />
          <div style={{ fontSize: 15, fontWeight: 800 }}>{view.tradeName ?? view.issuerName}</div>
          {view.tradeName && <div style={{ fontSize: 11, color: MUTED, fontWeight: 600 }}>{view.issuerName}</div>}
          <div style={{ fontSize: 10, color: MUTED, lineHeight: 1.5, marginTop: 4 }}>
            {view.issuerRows
              .filter((r) => r.value && r.value !== "s/d")
              .map((r, i) => (
                <div key={i}>
                  <span style={{ fontWeight: 600 }}>{r.label}:</span> {r.value}
                </div>
              ))}
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: 28, fontWeight: 900, letterSpacing: 1, color: s.accentText, lineHeight: 1 }}>PRESUPUESTO</div>
          <div style={{ fontSize: 15, fontWeight: 800, marginTop: 6, ...NUM }}>N° {numberText}</div>
          {q.version > 1 && <div style={{ fontSize: 10.5, color: MUTED, marginTop: 2 }}>Revisión {q.version}</div>}
          <div style={{ fontSize: 10.5, color: MUTED, marginTop: 6 }}>
            Fecha: <b style={{ color: INK }}>{fmtDate(q.issue_date)}</b>
          </div>
          <div style={{ fontSize: 10.5, color: MUTED, marginTop: 2 }}>
            Válido hasta: <b style={{ color: INK }}>{fmtDate(q.valid_until)}</b>
          </div>
          <NonFiscalNote style={{ marginTop: 8, fontSize: 9.5, color: INK }} />
        </div>
      </div>

      <div style={{ height: 3, background: INK, margin: "18px 0 14px" }} />

      <SectionTitle color={s.accent}>Cliente</SectionTitle>
      <KeyValueGrid
        rows={[
          ...view.receiverRows.filter((r) => r.value && r.value !== "s/d"),
          ...(q.customer_phone ? [{ label: "Teléfono", value: q.customer_phone }] : []),
          ...(q.service_from
            ? [{ label: "Período del servicio", value: `${fmtDate(q.service_from)} al ${fmtDate(q.service_to ?? q.service_from)}` }]
            : []),
        ]}
      />

      <Block title="Detalle" color={s.accent}>
        <LinesTable doc={doc} view={view} head={INK} headInk="#ffffff" />
      </Block>

      <div style={{ marginTop: 14, marginLeft: "auto", width: 340 }}>
        <TotalsRows view={view} rowStyle={{ background: "#f6f7f9", padding: "6px 12px", marginBottom: 2 }} />
        <div style={{ display: "flex", justifyContent: "space-between", background: "#eef0f3", padding: "9px 12px" }}>
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: MUTED }}>TOTAL</span>
          <span style={{ ...NUM, fontSize: 16, fontWeight: 800 }}>{view.totalRow.value}</span>
        </div>
      </div>

      {q.terms?.trim() && (
        <Block title="Condiciones" color={s.accent}>
          <div style={pre}>{q.terms.trim()}</div>
        </Block>
      )}
      {q.notes?.trim() && (
        <Block title="Notas" color={s.accent}>
          <div style={pre}>{q.notes.trim()}</div>
        </Block>
      )}

      {(q.show_signature || accepted) && (
        <Block title="Aceptación" color={s.accent}>
          {accepted ? (
            <div style={{ fontSize: 11, fontWeight: 700 }}>
              Aceptado{q.accepted_by_name ? ` por ${q.accepted_by_name}` : ""} el {fmtDate(q.accepted_at)}
              {q.accepted_via === "link" ? " (aceptación en línea)" : ""}.
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 28, marginTop: 34 }}>
              {["Firma", "Aclaración", "Fecha"].map((l) => (
                <div key={l} style={{ borderTop: `1px solid ${INK}`, paddingTop: 4, fontSize: 9.5, color: MUTED, textAlign: "center" }}>
                  {l}
                </div>
              ))}
            </div>
          )}
        </Block>
      )}

      <div style={{ marginTop: "auto", paddingTop: 18, borderTop: `1px solid ${HAIR}` }}>
        <div style={{ textAlign: "center", fontSize: 10, color: MUTED, marginTop: 10 }}>
          {QUOTE_LEGEND} Precios en pesos argentinos sujetos a la validez indicada.
        </div>
        {s.showSeal && (
          <div style={{ marginTop: 10 }}>
            <NinjaSeal size={13} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Punto único de render: A4 propio o ticket del motor. */
export function QuoteDocument({ quote, items, brand, style, format, printable, className }: Props) {
  if (format === "a4") {
    return (
      <div data-invoice-a4 className={className} style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        {printable && <style>{`@media print{@page{size:A4;margin:0}}`}</style>}
        <QuoteA4 quote={quote} items={items} brand={brand} style={style} />
      </div>
    );
  }
  const doc = quoteToInvoiceDoc(quote, items, brand);
  // El ticket "Simple" del motor no tiene versión para presupuestos: Clásico.
  const model = style.ticketModel === "simple" ? "clasico" : style.ticketModel;
  return <InvoiceDocument doc={doc} style={{ ...style, legends: [] }} format={format} model={model} className={className} />;
}
