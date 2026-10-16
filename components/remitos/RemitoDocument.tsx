// Remito de entrega o de envío en hoja A4 (ADR-136), con las piezas del motor
// de comprobantes (ADR-112, ADR-119): marca, tipografía, densidad, esquinas y
// separadores del negocio. Un remito no lleva totales de factura: emisor,
// receptor, domicilio de entrega, ítems (precios opcionales), bultos, valor
// declarado, transporte, COT y la firma de recepción. Con muchos ítems se
// parte en hojas (`data-invoice-page`): el PDF y la impresión salen del mismo
// nodo que la vista previa. Sin hooks.
import type { CSSProperties, ReactNode } from "react";
import type { ResolvedInvoiceStyle } from "@/lib/invoices/style";
import {
  A4_H,
  A4_W,
  FONT_SANS,
  HAIR,
  INK,
  Logo,
  MUTED,
  NUM,
  PAPER,
  PageMark,
  SOFT,
  fs,
  headColor,
  invoiceVars,
  rad,
  sepLine,
  sp,
} from "@/components/invoices/parts";
import {
  COT_JURISDICTION_SHORT,
  REMITO_KIND_LABEL,
  dateAr,
  ivaLabel,
  moneyAr,
  remitoNumberLabel,
  remitoTotals,
  type Remito,
} from "@/lib/remitos/logic";

/** Renglones por hoja (la primera tiene encabezado y bloques de datos). */
export const REMITO_ROWS_FIRST = 16;
export const REMITO_ROWS_NEXT = 30;

/** Cortes de los ítems por hoja: [desde, hasta). */
export function remitoPages(count: number): [number, number][] {
  if (count <= REMITO_ROWS_FIRST) return [[0, count]];
  const out: [number, number][] = [[0, REMITO_ROWS_FIRST]];
  for (let i = REMITO_ROWS_FIRST; i < count; i += REMITO_ROWS_NEXT) out.push([i, Math.min(count, i + REMITO_ROWS_NEXT)]);
  return out;
}

function Box({ title, children, s, style }: { title: string; children: ReactNode; s: ResolvedInvoiceStyle; style?: CSSProperties }) {
  return (
    <div style={{ border: sepLine(1, HAIR), borderRadius: rad(6), padding: `${sp(8)} 12px`, minWidth: 0, ...style }}>
      <div
        style={{
          fontSize: fs(8.5),
          fontWeight: 800,
          letterSpacing: 1.6,
          textTransform: "uppercase",
          color: headColor(s),
          marginBottom: sp(5),
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div style={{ display: "flex", gap: 8, fontSize: fs(10), minWidth: 0 }}>
      <span style={{ color: MUTED, flexShrink: 0, width: 92 }}>{label}</span>
      <span style={{ fontWeight: 600, overflowWrap: "anywhere", minWidth: 0 }}>{value}</span>
    </div>
  );
}

export function RemitoDocument({
  remito: r,
  style: s,
  logoUrl,
  printable,
  className,
  copyLabel,
}: {
  remito: Remito;
  style: ResolvedInvoiceStyle;
  /** Logo actual del negocio (si no, el de la foto del emisor). */
  logoUrl?: string | null;
  /** Reglas de impresión A4 (@page). Sólo en el nodo que se imprime. */
  printable?: boolean;
  className?: string;
  /** ADR-161: leyenda de la copia ("Original: cliente", "Duplicado: vuelve firmado"). */
  copyLabel?: string | null;
}) {
  const pages = remitoPages(r.items.length);
  const totals = remitoTotals(r.items);
  const logo = logoUrl ?? (s.logoIsDefault ? null : s.logoUrl) ?? r.issuer.logo_url ?? null;
  const issuerName = r.issuer.legal_name || r.issuer.trade_name || "Mi negocio";
  const trade = r.issuer.trade_name && r.issuer.trade_name !== issuerName ? r.issuer.trade_name : null;
  const number = remitoNumberLabel(r.pto_vta, r.number);
  const voided = r.status === "anulado";
  const prices = r.show_prices;

  return (
    <div
      data-invoice-a4
      data-remito
      className={className}
      style={{ display: "flex", flexDirection: "column", gap: 16, alignItems: "center" }}
    >
      {printable && (
        <style>{`@media print{@page{size:A4;margin:0}[data-invoice-page]{break-after:page;page-break-after:always}[data-invoice-page]:last-child{break-after:auto;page-break-after:auto}[data-invoice-a4]{gap:0!important}}`}</style>
      )}
      {pages.map(([from, to], p) => {
        const first = p === 0;
        const last = p === pages.length - 1;
        const page = pages.length > 1 ? { index: p, count: pages.length } : undefined;
        return (
          <div
            key={p}
            data-invoice-page
            style={{
              ...invoiceVars(s),
              width: A4_W,
              minHeight: A4_H,
              boxSizing: "border-box",
              background: PAPER,
              color: INK,
              fontFamily: s.fontFamily ?? FONT_SANS,
              fontSize: fs(10.5),
              lineHeight: 1.35,
              display: "flex",
              flexDirection: "column",
              position: "relative",
              overflow: "hidden",
              padding: `${sp(40)} 48px ${sp(28)}`,
            }}
          >
            {voided && (
              <div
                aria-hidden
                style={{
                  position: "absolute",
                  top: "40%",
                  left: 0,
                  right: 0,
                  textAlign: "center",
                  fontSize: 96,
                  fontWeight: 900,
                  color: "rgba(200,40,40,0.14)",
                  transform: "rotate(-18deg)",
                  pointerEvents: "none",
                }}
              >
                ANULADO
              </div>
            )}

            {/* Encabezado: emisor · letra R · tipo y número */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 16, alignItems: "start" }}>
              <div style={{ minWidth: 0 }}>
                {logo && <Logo url={logo} maxH={44} maxW={180} style={{ marginBottom: sp(8) }} />}
                {trade && <div style={{ fontSize: fs(15), fontWeight: 800 }}>{trade}</div>}
                <div style={{ fontSize: fs(trade ? 10.5 : 15), fontWeight: trade ? 600 : 800 }}>{issuerName}</div>
                <div style={{ fontSize: fs(9.5), color: MUTED, marginTop: sp(4) }}>
                  {[r.issuer.store_name, r.issuer.store_address || r.issuer.address].filter(Boolean).join(" · ")}
                </div>
                {r.issuer.phone && <div style={{ fontSize: fs(9.5), color: MUTED }}>Tel. {r.issuer.phone}</div>}
              </div>
              <div
                style={{
                  width: 64,
                  minHeight: 64,
                  border: `1.5px solid ${INK}`,
                  borderRadius: rad(3),
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "4px 2px",
                  boxSizing: "border-box",
                }}
              >
                <span style={{ fontSize: 36, fontWeight: 800, lineHeight: "40px" }}>R</span>
                <span style={{ fontSize: 7, textAlign: "center", lineHeight: 1.1, opacity: 0.85 }}>No fiscal</span>
              </div>
              <div style={{ textAlign: "right", minWidth: 0 }}>
                <div style={{ fontSize: fs(15), fontWeight: 800, color: headColor(s), textTransform: "uppercase" }}>
                  {REMITO_KIND_LABEL[r.kind]}
                </div>
                <div style={{ ...NUM, fontSize: fs(12), fontWeight: 700, marginTop: sp(2) }}>N° {number}</div>
                {copyLabel && (
                  <div style={{ fontSize: fs(9), fontWeight: 800, letterSpacing: 1.2, textTransform: "uppercase", marginTop: sp(2) }}>{copyLabel}</div>
                )}
                <div style={{ fontSize: fs(10), color: MUTED }}>Fecha {dateAr(r.issued_at)}</div>
                {r.sale?.number != null && <div style={{ fontSize: fs(10), color: MUTED }}>Venta #{r.sale.number}</div>}
                <div style={{ fontSize: fs(9), color: MUTED, marginTop: sp(4), lineHeight: 1.3 }}>
                  {r.issuer.cuit && <div>CUIT {r.issuer.cuit}</div>}
                  {r.issuer.iva_condition && <div>{ivaLabel(r.issuer.iva_condition)}</div>}
                  {r.issuer.iibb && <div>IIBB {r.issuer.iibb}</div>}
                  {r.issuer.activity_start && <div>Inicio de act. {dateAr(r.issuer.activity_start)}</div>}
                </div>
              </div>
            </div>
            <div style={{ borderTop: sepLine(1.5, INK), margin: `${sp(12)} 0` }} />

            {first && (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <Box title="Destinatario" s={s}>
                    <Row label="Nombre" value={r.receiver_name} />
                    <Row label="Documento" value={r.receiver_doc} />
                    <Row label="Condición IVA" value={ivaLabel(r.receiver_iva)} />
                    <Row label="Domicilio" value={r.receiver_address} />
                  </Box>
                  <Box title={r.kind === "envio" ? "Entrega en" : "Lugar de entrega"} s={s}>
                    <Row label="Domicilio" value={r.delivery_address ?? r.issuer.store_address ?? r.issuer.store_name} />
                    <Row label="Bultos" value={String(r.packages)} />
                    <Row label="Peso" value={r.weight_kg != null ? `${moneyAr(r.weight_kg)} kg` : null} />
                    <Row label="Valor declarado" value={`$ ${moneyAr(r.declared_value)}`} />
                  </Box>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "3fr 2fr", gap: 10, marginTop: sp(10) }}>
                  <Box title="Transporte" s={s}>
                    <Row label="Empresa" value={r.carrier_name ?? (r.kind === "entrega" ? "Retira el cliente" : null)} />
                    <Row label="CUIT" value={r.carrier_cuit} />
                    <Row label="Patente" value={r.vehicle_plate} />
                    <Row label="Chofer" value={r.driver_name} />
                  </Box>
                  <Box title="COT" s={s} style={{ background: r.cot_number ? SOFT : PAPER }}>
                    {r.cot_number ? (
                      <>
                        <div style={{ ...NUM, fontSize: fs(14), fontWeight: 800, letterSpacing: 0.5 }}>{r.cot_number}</div>
                        <div style={{ fontSize: fs(9.5), color: MUTED }}>
                          {r.cot_jurisdiction ? COT_JURISDICTION_SHORT[r.cot_jurisdiction] : ""}
                          {r.cot_valid_until ? ` · válido hasta ${dateAr(r.cot_valid_until)}` : ""}
                        </div>
                      </>
                    ) : (
                      <div style={{ fontSize: fs(10), color: MUTED }}>Sin COT</div>
                    )}
                  </Box>
                </div>
              </>
            )}

            {/* Ítems */}
            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: sp(12), fontSize: fs(10) }}>
              <thead>
                <tr style={{ textAlign: "left", color: MUTED, fontSize: fs(8.5), textTransform: "uppercase", letterSpacing: 0.8 }}>
                  <th style={{ padding: `${sp(5)} 6px`, borderBottom: sepLine(1, INK), width: 70 }}>Código</th>
                  <th style={{ padding: `${sp(5)} 6px`, borderBottom: sepLine(1, INK) }}>Descripción</th>
                  <th style={{ padding: `${sp(5)} 6px`, borderBottom: sepLine(1, INK), textAlign: "right", width: 70 }}>Cantidad</th>
                  <th style={{ padding: `${sp(5)} 6px`, borderBottom: sepLine(1, INK), width: 60 }}>Unidad</th>
                  {prices && (
                    <>
                      <th style={{ padding: `${sp(5)} 6px`, borderBottom: sepLine(1, INK), textAlign: "right", width: 90 }}>P. unitario</th>
                      <th style={{ padding: `${sp(5)} 6px`, borderBottom: sepLine(1, INK), textAlign: "right", width: 100 }}>Importe</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {r.items.slice(from, to).map((i) => (
                  <tr key={i.id}>
                    <td style={{ padding: `${sp(5)} 6px`, borderBottom: sepLine(1, HAIR), color: MUTED, ...NUM }}>{i.sku ?? ""}</td>
                    <td style={{ padding: `${sp(5)} 6px`, borderBottom: sepLine(1, HAIR), overflowWrap: "anywhere" }}>{i.description}</td>
                    <td style={{ padding: `${sp(5)} 6px`, borderBottom: sepLine(1, HAIR), textAlign: "right", fontWeight: 700, ...NUM }}>
                      {Number(i.qty).toLocaleString("es-AR", { maximumFractionDigits: 3 })}
                    </td>
                    <td style={{ padding: `${sp(5)} 6px`, borderBottom: sepLine(1, HAIR), color: MUTED }}>{i.unit}</td>
                    {prices && (
                      <>
                        <td style={{ padding: `${sp(5)} 6px`, borderBottom: sepLine(1, HAIR), textAlign: "right", ...NUM }}>
                          {i.unit_price != null ? `$ ${moneyAr(i.unit_price)}` : ""}
                        </td>
                        <td style={{ padding: `${sp(5)} 6px`, borderBottom: sepLine(1, HAIR), textAlign: "right", ...NUM }}>
                          {i.unit_price != null ? `$ ${moneyAr(i.unit_price * i.qty)}` : ""}
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>

            {last && (
              <>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 24, marginTop: sp(8), fontSize: fs(10.5) }}>
                  <span>
                    <span style={{ color: MUTED }}>Unidades </span>
                    <strong style={NUM}>{totals.units.toLocaleString("es-AR", { maximumFractionDigits: 3 })}</strong>
                  </span>
                  <span>
                    <span style={{ color: MUTED }}>Bultos </span>
                    <strong style={NUM}>{r.packages}</strong>
                  </span>
                  {prices && (
                    <span>
                      <span style={{ color: MUTED }}>Total </span>
                      <strong style={NUM}>$ {moneyAr(totals.value)}</strong>
                    </span>
                  )}
                </div>
                {(r.notes || r.legend) && (
                  <div style={{ marginTop: sp(10), fontSize: fs(9.5), color: MUTED }}>
                    {r.notes && <div>Observaciones: {r.notes}</div>}
                    {r.legend && <div>{r.legend}</div>}
                  </div>
                )}
                <div style={{ flex: 1 }} />
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "2fr 2fr 1.4fr 1.2fr",
                    gap: 14,
                    marginTop: sp(28),
                    fontSize: fs(9),
                    color: MUTED,
                    textAlign: "center",
                  }}
                >
                  {[
                    ["Firma de recepción", null],
                    ["Aclaración", r.received_name],
                    ["DNI", r.received_doc],
                    ["Fecha", r.received_at ? dateAr(r.received_at) : null],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <div style={{ minHeight: 30, fontSize: fs(10.5), color: INK, fontWeight: 600, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
                        {value ?? ""}
                      </div>
                      <div style={{ borderTop: sepLine(1, INK), paddingTop: 4 }}>{label}</div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: sp(14), fontSize: fs(8.5), color: MUTED, textAlign: "center" }}>
                  Remito interno. Documento no válido como factura.
                  {voided && r.void_reason ? ` Anulado: ${r.void_reason}.` : ""}
                </div>
              </>
            )}
            <PageMark page={page} />
          </div>
        );
      })}
    </div>
  );
}
