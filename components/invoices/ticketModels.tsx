// Modelos de comprobante para impresora térmica 80 / 58 mm (ADR-112). Misma
// vista y mismos campos legales que el A4; el color se imprime en escala de
// grises en la térmica. Sin hooks (ver parts.tsx).
import type { CSSProperties, ReactNode } from "react";
import { fmtQty, fmtRate } from "@/lib/invoices/legal";
import {
  FONT_MONO,
  FONT_SANS,
  Legends,
  LetterBox,
  Logo,
  MUTED,
  NUM,
  NinjaSeal,
  NonFiscalNote,
  PAPER,
  QrImage,
  legalAttr,
  type ModelProps,
} from "./parts";

export interface TicketModelProps extends ModelProps {
  paper: "80" | "58";
}

const WIDTH = { "80": "80mm", "58": "58mm" } as const;

function Roll({ paper, children, font = FONT_SANS, style }: { paper: "80" | "58"; children: ReactNode; font?: string; style?: CSSProperties }) {
  return (
    <div
      data-invoice-ticket
      style={{
        width: WIDTH[paper],
        maxWidth: "100%",
        boxSizing: "border-box",
        background: PAPER,
        color: "#000",
        fontFamily: font,
        fontSize: paper === "58" ? 10 : 11,
        lineHeight: 1.35,
        padding: paper === "58" ? "10px 8px" : "14px 12px",
        margin: "0 auto",
      }}
    >
      {children}
    </div>
  );
}

function Sep({ color = "#000", style = "dashed", w = 1 }: { color?: string; style?: "dashed" | "solid"; w?: number }) {
  return <div style={{ borderTop: `${w}px ${style} ${color}`, margin: "7px 0" }} />;
}

function Row({ label, value, strong, legal, size }: { label: ReactNode; value: ReactNode; strong?: boolean; legal?: string; size?: number }) {
  return (
    <div data-legal={legal} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontWeight: strong ? 800 : 400, fontSize: size }}>
      <span style={{ minWidth: 0 }}>{label}</span>
      <span style={{ ...NUM }}>{value}</span>
    </div>
  );
}

function Items({ doc, view, compact }: ModelProps & { compact?: boolean }) {
  return (
    <div data-legal="detalle">
      {view.showIvaCol && (
        <div data-legal="alicuota" style={{ fontSize: "0.85em", color: MUTED, marginBottom: 3 }}>
          Cant. x precio unit. neto (alíc. IVA)
        </div>
      )}
      {doc.lines.map((l, i) =>
        compact ? (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
              {fmtQty(l.quantity)} x {l.description}
            </span>
            <span style={{ ...NUM }}>{view.money(l.subtotal)}</span>
          </div>
        ) : (
          <div key={i} style={{ marginBottom: 3 }}>
            <div style={{ fontWeight: 600 }}>{l.description}</div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
              <span style={{ color: "#333", ...NUM }}>
                {fmtQty(l.quantity)} {l.unit && l.unit !== "unidad" ? l.unit : "u."} x {view.money(l.unitPrice)}
                {l.discountPct ? ` (-${fmtRate(l.discountPct)})` : ""}
                {view.showIvaCol ? ` (${l.ivaRate != null ? fmtRate(l.ivaRate) : "IVA"})` : ""}
              </span>
              <span style={{ ...NUM, fontWeight: 600 }}>{view.money(l.subtotal)}</span>
            </div>
          </div>
        ),
      )}
    </div>
  );
}

function Totals({ view, totalSize, totalStyle }: { view: ModelProps["view"]; totalSize: number; totalStyle?: CSSProperties }) {
  return (
    <>
      {view.totalsRows.map((r, i) => (
        <Row key={i} label={r.label} value={r.value} legal={r.legal} />
      ))}
      <div data-legal="total" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontWeight: 900, fontSize: totalSize, marginTop: 4, ...totalStyle }}>
        <span>TOTAL</span>
        <span style={NUM}>{view.totalRow.value}</span>
      </div>
    </>
  );
}

function Transparency({ view }: { view: ModelProps["view"] }) {
  if (!view.transparency) return null;
  return (
    <div style={{ fontSize: "0.88em", marginTop: 6 }}>
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

function FiscalBlock({ doc, view, qr }: ModelProps & { qr: number }) {
  return (
    <div style={{ textAlign: "center" }}>
      {view.authRows.map((r, i) => (
        <Row key={i} label={r.label} value={r.value} legal={r.legal} strong />
      ))}
      <div style={{ display: "flex", justifyContent: "center", margin: "8px 0 4px" }}>
        <QrImage view={view} size={qr} />
      </div>
      {doc.authorization ? (
        <div style={{ fontSize: "0.82em", color: "#333" }}>Comprobante autorizado por ARCA</div>
      ) : !doc.fiscal ? (
        <NonFiscalNote style={{ fontSize: "0.9em" }} />
      ) : null}
    </div>
  );
}

function IssuerBlock({ view, align = "center", inline = false }: { view: ModelProps["view"]; align?: "center" | "left"; inline?: boolean }) {
  return (
    <div style={{ textAlign: align }}>
      <div data-legal="emisor_razon_social">
        {view.tradeName && <div style={{ fontWeight: 900, fontSize: "1.25em" }}>{view.tradeName}</div>}
        <div style={{ fontWeight: view.tradeName ? 600 : 900, fontSize: view.tradeName ? "1em" : "1.2em" }}>{view.issuerName}</div>
      </div>
      <div style={{ fontSize: "0.88em", color: "#222", lineHeight: 1.4 }}>
        {inline
          ? view.issuerRows.map((r, i) => (
              <span key={i} {...legalAttr(r)}>
                {i > 0 ? " · " : ""}
                {r.label === "Domicilio comercial" || r.label === "Condición frente al IVA" ? "" : `${shortLabel(r.label)} `}
                {r.value}
              </span>
            ))
          : view.issuerRows.map((r, i) => (
              <div key={i} {...legalAttr(r)}>
                {r.label === "Domicilio comercial" ? r.value : `${shortLabel(r.label)}: ${r.value}`}
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
          <span style={{ color: "#333" }}>{shortLabel(r.label)}:</span> <b>{r.value}</b>
        </div>
      ))}
    </div>
  );
}

function DocHead({ doc, view, box }: ModelProps & { box: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
      <LetterBox doc={doc} size={box} border="#000" ink="#000" />
      <div>
        <div data-legal="tipo" style={{ fontWeight: 900, fontSize: "1.15em" }}>
          {view.label}
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

// ---------------------------------------------------------------------------
// Clásico
// ---------------------------------------------------------------------------
export function TicketClasico({ doc, view, style: s, paper }: TicketModelProps) {
  return (
    <Roll paper={paper}>
      {s.logoUrl && (
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 6 }}>
          <Logo url={s.logoUrl} wordmark={s.logoIsDefault} maxH={paper === "58" ? 40 : 50} maxW={paper === "58" ? 150 : 200} />
        </div>
      )}
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
      {doc.payments && doc.payments.length > 0 && (
        <>
          <Sep />
          <PaymentsList doc={doc} view={view} style={s} />
        </>
      )}
      <Sep />
      <FiscalBlock doc={doc} view={view} style={s} qr={paper === "58" ? 104 : 124} />
      {view.legends.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <Legends view={view} fontSize={paper === "58" ? 8.5 : 9.5} color="#222" align="center" />
        </div>
      )}
      {view.footer && <div style={{ textAlign: "center", marginTop: 6, fontWeight: 600 }}>{view.footer}</div>}
      {s.showSeal && (
        <div style={{ marginTop: 8 }}>
          <NinjaSeal size={paper === "58" ? 10 : 11} />
        </div>
      )}
    </Roll>
  );
}

// ---------------------------------------------------------------------------
// Compacto: monoespaciado, una fila por ítem y datos condensados.
// ---------------------------------------------------------------------------
export function TicketCompacto({ doc, view, style: s, paper }: TicketModelProps) {
  return (
    <Roll paper={paper} font={FONT_MONO} style={{ fontSize: paper === "58" ? 9 : 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
        <div style={{ minWidth: 0 }}>
          {s.logoUrl && <Logo url={s.logoUrl} wordmark={s.logoIsDefault} maxH={34} maxW={130} style={{ marginBottom: 4 }} />}
        </div>
        <LetterBox doc={doc} size={paper === "58" ? 34 : 38} border="#000" ink="#000" />
      </div>
      <div style={{ marginTop: 4 }}>
        <IssuerBlock view={view} align="left" inline />
      </div>
      <Sep />
      <div data-legal="tipo" style={{ fontWeight: 800 }}>
        {view.label.toUpperCase()}
      </div>
      <Row label={<span data-legal="numero">N° {view.numberText}</span>} value={<span data-legal="fecha">{view.dateText} {view.timeText}</span>} />
      <Sep />
      <ReceiverBlock view={view} />
      <Sep />
      <Items doc={doc} view={view} style={s} compact />
      <Sep />
      <Totals view={view} totalSize={paper === "58" ? 12 : 14} />
      <Transparency view={view} />
      {doc.payments && doc.payments.length > 0 && (
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
      {view.legends.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <Legends view={view} fontSize={8.5} color="#222" />
        </div>
      )}
      {view.footer && <div style={{ marginTop: 4 }}>{view.footer}</div>}
      {s.showSeal && (
        <div style={{ marginTop: 6 }}>
          <NinjaSeal size={10} align="left" />
        </div>
      )}
    </Roll>
  );
}

// ---------------------------------------------------------------------------
// Destacado: encabezado invertido, total grande y separadores marcados.
// ---------------------------------------------------------------------------
export function TicketDestacado({ doc, view, style: s, paper }: TicketModelProps) {
  const band: CSSProperties = { background: s.accent, color: s.accentInk, margin: paper === "58" ? "-10px -8px 0" : "-14px -12px 0", padding: paper === "58" ? "10px 8px" : "14px 12px", textAlign: "center" };
  return (
    <Roll paper={paper}>
      <div style={band}>
        {s.logoUrl && (
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 6 }}>
            <div style={{ background: PAPER, borderRadius: 4, padding: "5px 9px" }}>
              <Logo url={s.logoUrl} wordmark={s.logoIsDefault} maxH={40} maxW={170} />
            </div>
          </div>
        )}
        <div data-legal="emisor_razon_social">
          {view.tradeName && <div style={{ fontWeight: 900, fontSize: "1.3em" }}>{view.tradeName}</div>}
          <div style={{ fontWeight: view.tradeName ? 600 : 900, fontSize: view.tradeName ? "1em" : "1.3em" }}>{view.issuerName}</div>
        </div>
      </div>
      <div style={{ fontSize: "0.88em", textAlign: "center", marginTop: 6 }}>
        {view.issuerRows.map((r, i) => (
          <div key={i} {...legalAttr(r)}>
            {r.label === "Domicilio comercial" ? r.value : `${shortLabel(r.label)}: ${r.value}`}
          </div>
        ))}
      </div>
      <Sep style="solid" w={2} color={s.accent} />
      <DocHead doc={doc} view={view} style={s} box={paper === "58" ? 42 : 50} />
      <Sep style="solid" w={2} color={s.accent} />
      <ReceiverBlock view={view} />
      <Sep />
      <Items doc={doc} view={view} style={s} />
      <Sep />
      <Totals
        view={view}
        totalSize={paper === "58" ? 16 : 20}
        totalStyle={{ background: s.accent, color: s.accentInk, padding: "6px 8px", borderRadius: 4, marginTop: 6 }}
      />
      <Transparency view={view} />
      {doc.payments && doc.payments.length > 0 && (
        <>
          <Sep />
          <PaymentsList doc={doc} view={view} style={s} />
        </>
      )}
      <Sep style="solid" w={2} color={s.accent} />
      <FiscalBlock doc={doc} view={view} style={s} qr={paper === "58" ? 110 : 132} />
      {view.legends.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <Legends view={view} fontSize={9} color="#222" align="center" />
        </div>
      )}
      {view.footer && <div style={{ textAlign: "center", marginTop: 6, fontWeight: 800, fontSize: "1.05em" }}>{view.footer}</div>}
      {s.showSeal && (
        <div style={{ marginTop: 8 }}>
          <NinjaSeal size={11} />
        </div>
      )}
    </Roll>
  );
}

