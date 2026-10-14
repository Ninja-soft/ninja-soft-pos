// Modelos A4 de comprobante (ADR-112). Todos dibujan la misma vista
// (lib/invoices/view.ts) y cubren los campos legales de cada tipo: lo que
// cambia es el diseño. Sin hooks (ver parts.tsx).
import type { CSSProperties, ReactNode } from "react";
import {
  A4_H,
  A4_W,
  ArcaMark,
  CopyMark,
  FONT_SANS,
  HAIR,
  INK,
  KeyValueGrid,
  Legends,
  LetterBox,
  LinesTable,
  Logo,
  MUTED,
  NUM,
  NinjaSeal,
  NonFiscalNote,
  PAPER,
  QrImage,
  SectionTitle,
  TotalsRows,
  TransparencyBlock,
  legalAttr,
  type ModelProps,
} from "./parts";

function Sheet({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      data-invoice-page
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
        position: "relative",
        overflow: "hidden",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Nombre del emisor (nombre de fantasía arriba si lo hay). */
function IssuerName({ view, size = 15, color = INK, sub = MUTED }: { view: ModelProps["view"]; size?: number; color?: string; sub?: string }) {
  return (
    <div data-legal="emisor_razon_social">
      {view.tradeName && <div style={{ fontSize: size + 3, fontWeight: 800, color, lineHeight: 1.15 }}>{view.tradeName}</div>}
      <div style={{ fontSize: view.tradeName ? size - 3 : size, fontWeight: view.tradeName ? 600 : 800, color: view.tradeName ? sub : color, lineHeight: 1.2 }}>
        {view.issuerName}
      </div>
    </div>
  );
}

function IssuerLines({ view, color = MUTED, fontSize = 10, keys }: { view: ModelProps["view"]; color?: string; fontSize?: number; keys?: string[] }) {
  const rows = keys ? view.issuerRows.filter((r) => keys.includes(r.legal ?? r.label)) : view.issuerRows;
  return (
    <div style={{ fontSize, color, lineHeight: 1.5 }}>
      {rows.map((r, i) => (
        <div key={i} {...legalAttr(r)}>
          <span style={{ fontWeight: 600 }}>{r.label}:</span> {r.value}
        </div>
      ))}
    </div>
  );
}

function DocTitle({ view, color, align = "right", size = 17 }: { view: ModelProps["view"]; color: string; align?: "left" | "right"; size?: number }) {
  return (
    <div style={{ textAlign: align }}>
      <div data-legal="tipo" style={{ fontSize: size, fontWeight: 800, color, lineHeight: 1.15 }}>
        {view.label}
      </div>
      <div data-legal="numero" style={{ fontSize: size - 3, fontWeight: 700, color: INK, marginTop: 2, ...NUM }}>
        N° {view.numberText}
      </div>
      <div data-legal="fecha" style={{ fontSize: 10.5, color: MUTED, marginTop: 3 }}>
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
        <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, padding: "3px 0" }}>
          <span style={{ fontWeight: 700, color, textTransform: "uppercase", letterSpacing: 0.3 }}>{p.label}</span>
          <span style={{ ...NUM, fontWeight: 700 }}>{view.money(p.amount)}</span>
        </div>
      ))}
    </div>
  );
}

/** Pie fiscal: QR + ARCA + CAE (o QR + leyenda de no fiscal). */
function FiscalFooter({ doc, view, style: s, variant, narrow = false }: ModelProps & { variant: "card" | "plain" | "band"; narrow?: boolean }) {
  const authBox =
    view.authRows.length > 0 ? (
      <div
        style={{
          minWidth: narrow ? 200 : 250,
          padding: variant === "plain" ? "4px 0" : "12px 16px",
          background: variant === "card" ? "#f6f7f9" : variant === "band" ? s.accentSoft : undefined,
          borderLeft: variant === "plain" ? undefined : `3px solid ${s.accent}`,
          borderRadius: 2,
        }}
      >
        {view.authRows.map((r, i) => (
          <div key={i} {...legalAttr(r)} style={{ display: "flex", justifyContent: "space-between", gap: 24, padding: "4px 0", borderBottom: i === 0 ? `1px dashed ${HAIR}` : undefined }}>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, color: MUTED, textTransform: "uppercase" }}>{r.label}</span>
            <span style={{ ...NUM, fontSize: 13, fontWeight: 800 }}>{r.value}</span>
          </div>
        ))}
      </div>
    ) : null;
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: narrow ? 12 : 18 }}>
        <QrImage view={view} size={narrow ? 100 : 112} />
        {doc.authorization ? (
          <ArcaMark compact={narrow} />
        ) : (
          <div style={{ maxWidth: 260, fontSize: 10, color: MUTED }}>
            {doc.fiscal ? "Factura sin CAE todavía." : <NonFiscalNote style={{ color: INK, fontSize: 10.5, marginBottom: 4 }} />}
            <div>QR con los datos de la operación.</div>
          </div>
        )}
      </div>
      {authBox}
    </div>
  );
}

function NotesBox({ view, color, children }: { view: ModelProps["view"]; color: string; children?: ReactNode }) {
  if (!view.legends.length && !children) return null;
  return (
    <div style={{ border: `1px solid ${color}`, borderRadius: 3, padding: "10px 14px" }}>
      <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: 2, color, marginBottom: 4 }}>NOTAS</div>
      {children}
      <Legends view={view} fontSize={10} color={INK} />
    </div>
  );
}

function SealRow({ style: s, onDark = false }: { style: ModelProps["style"]; onDark?: boolean }) {
  if (!s.showSeal) return null;
  return <NinjaSeal onDark={onDark} size={13} />;
}

// ---------------------------------------------------------------------------
// 1. Clásico: el lenguaje de la referencia (logo, letra al centro, bloques con
//    título y cuadradito de color, cabecera de tabla oscura, CAE en caja).
// ---------------------------------------------------------------------------
export function A4Clasico({ doc, view, style: s }: ModelProps) {
  return (
    <Sheet style={{ padding: "40px 44px 28px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "start", gap: 20 }}>
        <div>
          <Logo url={s.logoUrl} wordmark={s.logoIsDefault} maxH={62} maxW={230} style={{ marginBottom: 12 }} />
          <IssuerName view={view} />
          <IssuerLines view={view} keys={["emisor_domicilio", "emisor_iva", "Teléfono"]} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
          <LetterBox doc={doc} size={66} />
          <CopyMark view={view} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          <DocTitle view={view} color={s.accentText} />
          <IssuerLines view={view} keys={["emisor_cuit", "emisor_iibb", "emisor_inicio"]} />
        </div>
      </div>

      <div style={{ height: 3, background: INK, margin: "18px 0 14px" }} />

      <SectionTitle color={s.accent}>Información del cliente</SectionTitle>
      <KeyValueGrid rows={[...view.receiverRows, ...view.docRows]} />

      <div style={{ marginTop: 16 }}>
        <SectionTitle color={s.accent}>Conceptos</SectionTitle>
        <LinesTable doc={doc} view={view} head={INK} headInk="#ffffff" />
      </div>

      <div style={{ marginTop: 14 }}>
        <SectionTitle color={s.accent}>Totales</SectionTitle>
        <div style={{ marginLeft: "auto", width: 340 }}>
          <TotalsRows view={view} rowStyle={{ background: "#f6f7f9", padding: "6px 12px", marginBottom: 2 }} />
          <div data-legal="total" style={{ display: "flex", justifyContent: "space-between", background: "#eef0f3", padding: "9px 12px" }}>
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: MUTED }}>TOTAL</span>
            <span style={{ ...NUM, fontSize: 16, fontWeight: 800 }}>{view.totalRow.value}</span>
          </div>
        </div>
      </div>

      {view.transparency && <TransparencyBlock view={view} style={{ marginTop: 14 }} />}

      {doc.payments && doc.payments.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <SectionTitle color={s.accent}>Medios de pago</SectionTitle>
          <Payments doc={doc} view={view} style={s} color={s.accentText} />
        </div>
      )}

      {view.legends.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <NotesBox view={view} color={s.accentText} />
        </div>
      )}

      <div style={{ marginTop: "auto", paddingTop: 18 }}>
        <SectionTitle color={s.accent}>Información del comprobante</SectionTitle>
        <FiscalFooter doc={doc} view={view} style={s} variant="card" />
        {view.footer && <div style={{ textAlign: "center", fontSize: 10.5, color: MUTED, marginTop: 14 }}>{view.footer}</div>}
        <div style={{ marginTop: 10 }}>
          <SealRow style={s} />
        </div>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// 2. Moderno: letra en color, tarjetas suaves, tabla con cabecera de color y
//    caja de total llena.
// ---------------------------------------------------------------------------
export function A4Moderno({ doc, view, style: s }: ModelProps) {
  const card: CSSProperties = { background: s.accentSoft, borderRadius: 10, padding: "14px 16px" };
  return (
    <Sheet style={{ padding: "40px 44px 28px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 24 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Logo url={s.logoUrl} wordmark={s.logoIsDefault} maxH={58} maxW={220} />
          <IssuerName view={view} size={14} />
        </div>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 30, fontWeight: 900, letterSpacing: -0.5, color: s.accentText, lineHeight: 1 }}>{view.title}</div>
            <div data-legal="tipo" style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
              {view.label}
            </div>
            <div data-legal="numero" style={{ fontSize: 15, fontWeight: 800, marginTop: 6, ...NUM }}>
              N° {view.numberText}
            </div>
            <div data-legal="fecha" style={{ fontSize: 10.5, color: MUTED, marginTop: 2 }}>
              {view.dateText} {view.timeText}
            </div>
            <div style={{ marginTop: 4 }}>
              <CopyMark view={view} color={s.accentText} />
            </div>
          </div>
          <LetterBox doc={doc} size={64} fill={s.accent} ink={s.accentInk} border={s.accent} />
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 22 }}>
        <div style={card}>
          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: 2, color: s.accentText, marginBottom: 8 }}>EMISOR</div>
          <KeyValueGrid rows={view.issuerRows} cols={1} labelWidth={118} fontSize={10} />
        </div>
        <div style={card}>
          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: 2, color: s.accentText, marginBottom: 8 }}>CLIENTE</div>
          <KeyValueGrid rows={[...view.receiverRows, ...view.docRows]} cols={1} labelWidth={118} fontSize={10} />
        </div>
      </div>

      <div style={{ marginTop: 20, borderRadius: 10, overflow: "hidden", border: `1px solid ${HAIR}` }}>
        <LinesTable doc={doc} view={view} head={s.accent} headInk={s.accentInk} zebra={s.accentSoft} rowBorder="transparent" />
      </div>

      <div style={{ display: "flex", gap: 18, marginTop: 18, alignItems: "flex-start" }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
          {doc.payments && doc.payments.length > 0 && (
            <div>
              <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: 2, color: s.accentText, marginBottom: 4 }}>MEDIOS DE PAGO</div>
              <Payments doc={doc} view={view} style={s} color={INK} />
            </div>
          )}
          {view.transparency && <TransparencyBlock view={view} titleColor={s.accentText} />}
          <Legends view={view} />
        </div>
        <div style={{ width: 300 }}>
          <TotalsRows view={view} rowStyle={{ padding: "5px 4px", borderBottom: `1px solid ${HAIR}` }} />
          <div
            data-legal="total"
            style={{ marginTop: 8, background: s.accent, color: s.accentInk, borderRadius: 10, padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}
          >
            <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 2 }}>TOTAL</span>
            <span style={{ ...NUM, fontSize: 20, fontWeight: 900 }}>{view.totalRow.value}</span>
          </div>
        </div>
      </div>

      <div style={{ marginTop: "auto", paddingTop: 22 }}>
        <div style={{ borderTop: `1px solid ${HAIR}`, paddingTop: 16 }}>
          <FiscalFooter doc={doc} view={view} style={s} variant="band" />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
          <span style={{ fontSize: 10.5, color: MUTED }}>{view.footer}</span>
          <SealRow style={s} />
        </div>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// 3. Minimal: tipografía, filetes finos y el color sólo en el total.
// ---------------------------------------------------------------------------
export function A4Minimal({ doc, view, style: s }: ModelProps) {
  const label: CSSProperties = { fontSize: 8.5, letterSpacing: 2, textTransform: "uppercase", color: MUTED, marginBottom: 6 };
  return (
    <Sheet style={{ padding: "52px 56px 30px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <Logo url={s.logoUrl} wordmark={s.logoIsDefault} maxH={48} maxW={200} style={{ marginBottom: 18 }} />
          <div style={{ fontSize: 34, fontWeight: 300, letterSpacing: -0.5, lineHeight: 1 }}>{view.title.toLowerCase()}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ textAlign: "right", fontSize: 10.5 }}>
            <div data-legal="tipo" style={{ fontWeight: 700 }}>
              {view.label}
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

      <div style={{ height: 1, background: INK, margin: "26px 0 22px" }} />

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
          <KeyValueGrid rows={[...view.receiverRows, ...view.docRows]} cols={1} labelWidth={112} fontSize={10} />
        </div>
      </div>

      <div style={{ marginTop: 30 }}>
        <LinesTable
          doc={doc}
          view={view}
          head="transparent"
          headInk={MUTED}
          descStrong={false}
          headStyle={{ borderBottom: `1px solid ${INK}`, padding: "6px 8px" }}
        />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", gap: 30, marginTop: 20 }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
          {view.transparency && <TransparencyBlock view={view} fontSize={9.5} />}
          {doc.payments && doc.payments.length > 0 && (
            <div>
              <div style={label}>Pagos</div>
              <Payments doc={doc} view={view} style={s} color={INK} />
            </div>
          )}
          <Legends view={view} />
        </div>
        <div style={{ width: 280 }}>
          <TotalsRows view={view} />
          <div data-legal="total" style={{ borderTop: `1px solid ${INK}`, marginTop: 6, paddingTop: 10, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ fontSize: 9, letterSpacing: 2, color: MUTED }}>TOTAL</span>
            <span style={{ ...NUM, fontSize: 24, fontWeight: 300, color: s.accentText }}>{view.totalRow.value}</span>
          </div>
        </div>
      </div>

      <div style={{ marginTop: "auto", paddingTop: 24 }}>
        <div style={{ height: 1, background: HAIR, marginBottom: 16 }} />
        <FiscalFooter doc={doc} view={view} style={s} variant="plain" />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
          <span style={{ fontSize: 10, color: MUTED }}>{view.footer}</span>
          <SealRow style={s} />
        </div>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// 4. Corporativo: banda de color de punta a punta con logo y datos.
// ---------------------------------------------------------------------------
export function A4Corporativo({ doc, view, style: s }: ModelProps) {
  const onBand = s.accentInk;
  return (
    <Sheet>
      <div style={{ background: s.accent, color: onBand, padding: "30px 44px 26px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 20 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {s.logoUrl && (
            // Placa blanca: el logo (propio o el de Ninja POS) se lee sobre cualquier color.
            <div style={{ background: PAPER, borderRadius: 6, padding: "8px 12px", alignSelf: "flex-start" }}>
              <Logo url={s.logoUrl} wordmark={s.logoIsDefault} maxH={48} maxW={200} />
            </div>
          )}
          <IssuerName view={view} size={15} color={onBand} sub={onBand} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ textAlign: "right" }}>
            <div data-legal="tipo" style={{ fontSize: 22, fontWeight: 900, letterSpacing: 0.5 }}>
              {view.label.toUpperCase()}
            </div>
            <div data-legal="numero" style={{ fontSize: 14, fontWeight: 700, ...NUM }}>
              N° {view.numberText}
            </div>
            <div data-legal="fecha" style={{ fontSize: 10.5, opacity: 0.9 }}>
              Fecha {view.dateText} {view.timeText}
            </div>
          </div>
          <LetterBox doc={doc} size={66} fill={PAPER} ink={s.accentText} border={PAPER} />
        </div>
      </div>
      <div style={{ background: INK, color: "#fff", padding: "7px 44px", display: "flex", justifyContent: "space-between", fontSize: 9.5 }}>
        <span>
          {view.issuerRows
            .filter((r) => r.legal === "emisor_cuit" || r.legal === "emisor_iibb" || r.legal === "emisor_inicio")
            .map((r, i) => (
              <span key={i} {...legalAttr(r)} style={{ marginRight: 18 }}>
                <b>{r.label}:</b> {r.value}
              </span>
            ))}
        </span>
        <CopyMark view={view} color="#fff" />
      </div>

      <div style={{ padding: "22px 44px 28px", display: "flex", flexDirection: "column", flex: 1 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0, border: `1px solid ${HAIR}` }}>
          <div style={{ padding: "12px 14px", borderRight: `1px solid ${HAIR}` }}>
            <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: 2, color: s.accentText, marginBottom: 6 }}>DATOS DEL EMISOR</div>
            <IssuerLines view={view} keys={["emisor_domicilio", "emisor_iva", "Teléfono", "Email"]} color={INK} />
          </div>
          <div style={{ padding: "12px 14px" }}>
            <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: 2, color: s.accentText, marginBottom: 6 }}>DATOS DEL CLIENTE</div>
            <KeyValueGrid rows={view.receiverRows} cols={1} labelWidth={150} fontSize={10} />
          </div>
        </div>
        {view.docRows.length > 0 && (
          <div style={{ background: s.accentSoft, padding: "8px 14px", borderLeft: `1px solid ${HAIR}`, borderRight: `1px solid ${HAIR}`, borderBottom: `1px solid ${HAIR}` }}>
            <KeyValueGrid rows={view.docRows} cols={2} labelWidth={110} fontSize={10} />
          </div>
        )}

        <div style={{ marginTop: 18 }}>
          <LinesTable doc={doc} view={view} head="#eceef2" headInk={INK} headStyle={{ borderBottom: `2px solid ${s.accent}` }} />
        </div>

        <div style={{ display: "flex", gap: 22, marginTop: 16, alignItems: "flex-start" }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
            {doc.payments && doc.payments.length > 0 && (
              <div>
                <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: 2, color: s.accentText, marginBottom: 4 }}>MEDIOS DE PAGO</div>
                <Payments doc={doc} view={view} style={s} color={INK} />
              </div>
            )}
            {view.transparency && <TransparencyBlock view={view} titleColor={s.accentText} />}
            <Legends view={view} />
          </div>
          <div style={{ width: 310, border: `1px solid ${HAIR}` }}>
            <div style={{ padding: "6px 12px" }}>
              <TotalsRows view={view} />
            </div>
            <div data-legal="total" style={{ background: INK, color: "#fff", padding: "11px 12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 2 }}>TOTAL</span>
              <span style={{ ...NUM, fontSize: 18, fontWeight: 900 }}>{view.totalRow.value}</span>
            </div>
          </div>
        </div>

        <div style={{ marginTop: "auto", paddingTop: 22 }}>
          <FiscalFooter doc={doc} view={view} style={s} variant="card" />
          {view.footer && <div style={{ textAlign: "center", fontSize: 10.5, color: MUTED, marginTop: 12 }}>{view.footer}</div>}
          {s.showSeal && (
            <div style={{ marginTop: 10 }}>
              <NinjaSeal size={13} />
            </div>
          )}
        </div>
      </div>
      <div style={{ background: s.accent, height: 10 }} />
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// 5. Ejecutivo: columna lateral con emisor, cliente y pagos.
// ---------------------------------------------------------------------------
export function A4Ejecutivo({ doc, view, style: s }: ModelProps) {
  const side: CSSProperties = { fontSize: 8.5, fontWeight: 800, letterSpacing: 2, color: s.accentText, margin: "18px 0 6px" };
  return (
    <Sheet style={{ flexDirection: "row" }}>
      <div style={{ width: 236, background: s.accentSoft, padding: "36px 22px 24px", boxSizing: "border-box", display: "flex", flexDirection: "column" }}>
        <Logo url={s.logoUrl} wordmark={s.logoIsDefault} maxH={56} maxW={190} style={{ marginBottom: 14 }} />
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
        {doc.payments && doc.payments.length > 0 && (
          <>
            <div style={side}>MEDIOS DE PAGO</div>
            <Payments doc={doc} view={view} style={s} color={INK} />
          </>
        )}
        <div style={{ marginTop: "auto", paddingTop: 18 }}>{s.showSeal && <NinjaSeal size={12} align="left" />}</div>
      </div>

      <div style={{ flex: 1, padding: "36px 36px 26px", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 9, letterSpacing: 2.5, color: MUTED, fontWeight: 700 }}>{view.title}</div>
            <div data-legal="tipo" style={{ fontSize: 24, fontWeight: 900, color: s.accentText, lineHeight: 1.1, marginTop: 2 }}>
              {view.label}
            </div>
            <div data-legal="numero" style={{ fontSize: 14, fontWeight: 700, marginTop: 4, ...NUM }}>
              N° {view.numberText}
            </div>
            <div data-legal="fecha" style={{ fontSize: 10.5, color: MUTED, marginTop: 2 }}>
              Emitida el {view.dateText} {view.timeText}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
            <LetterBox doc={doc} size={60} />
            <CopyMark view={view} />
          </div>
        </div>

        <div style={{ marginTop: 22 }}>
          <LinesTable doc={doc} view={view} head={INK} headInk="#fff" fontSize={10} compact />
        </div>

        <div style={{ marginLeft: "auto", width: 290, marginTop: 14 }}>
          <TotalsRows view={view} rowStyle={{ borderBottom: `1px solid ${HAIR}` }} />
          <div data-legal="total" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, padding: "10px 0", borderTop: `2px solid ${s.accent}` }}>
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 2 }}>TOTAL</span>
            <span style={{ ...NUM, fontSize: 20, fontWeight: 900, color: s.accentText }}>{view.totalRow.value}</span>
          </div>
        </div>

        {view.transparency && <TransparencyBlock view={view} titleColor={s.accentText} style={{ marginTop: 12 }} />}
        <div style={{ marginTop: 12 }}>
          <Legends view={view} />
        </div>

        <div style={{ marginTop: "auto", paddingTop: 20 }}>
          <FiscalFooter doc={doc} view={view} style={s} variant="band" narrow />
          {view.footer && <div style={{ fontSize: 10.5, color: MUTED, marginTop: 12 }}>{view.footer}</div>}
        </div>
      </div>
    </Sheet>
  );
}
