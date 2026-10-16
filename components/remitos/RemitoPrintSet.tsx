// Remito con copias y modelo (ADR-161, R6): las copias (original, duplicado,
// triplicado) con su leyenda en el modelo elegido en Configuración ›
// Logística: A4 completo (el de siempre), medio A4 (dos por hoja con línea de
// corte), ticket de 80 mm o sólo los datos sobre un talonario preimpreso con
// corrimiento en milímetros. Sin hooks: lo imprime y lo pasa a PDF el mismo
// nodo, como RemitoDocument.
import type { ResolvedInvoiceStyle } from "@/lib/invoices/style";
import { A4_H, A4_W } from "@/components/invoices/parts";
import { RemitoDocument } from "@/components/remitos/RemitoDocument";
import { COT_JURISDICTION_SHORT, REMITO_KIND_LABEL, dateAr, moneyAr, remitoNumberLabel, remitoTotals, type Remito } from "@/lib/remitos/logic";
import type { RemitoModel } from "@/lib/logistics/logic";

export interface RemitoPrintOptions {
  copies: number;
  labels: readonly string[];
  model: RemitoModel;
  offsetXmm?: number;
  offsetYmm?: number;
}

/** Leyendas de las copias que salen (1 a 3). */
export function copyLabels(o: Pick<RemitoPrintOptions, "copies" | "labels">): string[] {
  const n = Math.max(1, Math.min(3, Math.trunc(o.copies) || 1));
  const def = ["Original", "Duplicado", "Triplicado"];
  return Array.from({ length: n }, (_, i) => (o.labels[i] ?? "").trim() || def[i]!);
}

const INK = "#111827";
const MUTED = "#6b7280";
const HAIR = "#d1d5db";
const MM = 96 / 25.4;
const qty = (n: number) => Number(n).toLocaleString("es-AR", { maximumFractionDigits: 3 });

/** Remito compacto: medio A4 o ticket de 80 mm. */
export function RemitoCompact({ remito: r, copyLabel, width, fontScale = 1 }: { remito: Remito; copyLabel: string; width: number; fontScale?: number }) {
  const f = (n: number) => n * fontScale;
  const totals = remitoTotals(r.items);
  const issuer = r.issuer.trade_name || r.issuer.legal_name || "Mi negocio";
  return (
    <div style={{ width, boxSizing: "border-box", padding: width > 400 ? "18px 28px" : "10px 8px", color: INK, background: "#fff", fontFamily: "Inter, Arial, sans-serif", fontSize: f(10) }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: f(13) }}>{issuer}</div>
          {r.issuer.cuit && <div style={{ color: MUTED }}>CUIT {r.issuer.cuit}</div>}
          <div style={{ color: MUTED }}>{[r.issuer.store_name, r.issuer.store_address].filter(Boolean).join(" · ")}</div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontWeight: 800, fontSize: f(11), textTransform: "uppercase" }}>{REMITO_KIND_LABEL[r.kind]}</div>
          <div style={{ fontWeight: 700 }}>N° {remitoNumberLabel(r.pto_vta, r.number)}</div>
          <div style={{ color: MUTED }}>{dateAr(r.issued_at)} · No fiscal</div>
          <div style={{ fontWeight: 800, fontSize: f(8.5), letterSpacing: 1, textTransform: "uppercase" }}>{copyLabel}</div>
        </div>
      </div>
      <div style={{ borderTop: `1px solid ${INK}`, margin: "6px 0" }} />
      <div>
        <strong>{r.receiver_name}</strong>
        {r.receiver_doc ? ` · ${r.receiver_doc}` : ""}
      </div>
      {r.delivery_address && <div>Entrega: {r.delivery_address}</div>}
      <div style={{ color: MUTED }}>
        {[
          `${r.packages} ${r.packages === 1 ? "bulto" : "bultos"}`,
          `Valor declarado $ ${moneyAr(r.declared_value)}`,
          r.vehicle_plate ? `Patente ${r.vehicle_plate}` : null,
          r.driver_name ? `Chofer ${r.driver_name}` : null,
          r.cot_number ? `COT ${r.cot_number}${r.cot_jurisdiction ? ` (${COT_JURISDICTION_SHORT[r.cot_jurisdiction]})` : ""}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 6 }}>
        <tbody>
          {r.items.map((i) => (
            <tr key={i.id}>
              <td style={{ padding: "2px 0", borderBottom: `1px solid ${HAIR}`, width: 46, fontWeight: 700 }}>{qty(i.qty)}</td>
              <td style={{ padding: "2px 4px", borderBottom: `1px solid ${HAIR}` }}>
                {i.description}
                {i.unit && i.unit !== "un" ? ` (${i.unit})` : ""}
              </td>
              {r.show_prices && (
                <td style={{ padding: "2px 0", borderBottom: `1px solid ${HAIR}`, textAlign: "right" }}>{i.unit_price != null ? `$ ${moneyAr(i.unit_price * i.qty)}` : ""}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ textAlign: "right", marginTop: 4 }}>
        Unidades <strong>{qty(totals.units)}</strong>
        {r.show_prices ? (
          <>
            {" "}
            · Total <strong>$ {moneyAr(totals.value)}</strong>
          </>
        ) : null}
      </div>
      {(r.notes || r.legend) && <div style={{ color: MUTED, marginTop: 4 }}>{[r.notes, r.legend].filter(Boolean).join(" · ")}</div>}
      <div style={{ display: "flex", gap: 10, marginTop: 22, color: MUTED, fontSize: f(8.5), textAlign: "center" }}>
        {["Firma", "Aclaración", "DNI"].map((l) => (
          <div key={l} style={{ flex: 1, borderTop: `1px solid ${INK}`, paddingTop: 2 }}>
            {l}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Sólo los datos, para imprimir sobre un talonario preimpreso. */
function RemitoPreprinted({ remito: r, offsetX, offsetY }: { remito: Remito; offsetX: number; offsetY: number }) {
  const base: React.CSSProperties = { position: "absolute", fontSize: 11, color: INK, fontFamily: "Inter, Arial, sans-serif" };
  const at = (xMm: number, yMm: number): React.CSSProperties => ({ ...base, left: (xMm + offsetX) * MM, top: (yMm + offsetY) * MM });
  return (
    <div data-invoice-page style={{ position: "relative", width: A4_W, height: A4_H, background: "#fff", overflow: "hidden" }}>
      <div style={at(140, 22)}>{dateAr(r.issued_at)}</div>
      <div style={at(25, 58)}>{r.receiver_name}</div>
      <div style={at(25, 64)}>{r.receiver_address ?? ""}</div>
      <div style={at(140, 58)}>{r.receiver_doc ?? ""}</div>
      <div style={at(25, 70)}>{r.delivery_address ?? ""}</div>
      {r.items.slice(0, 22).map((i, k) => (
        <div key={i.id} style={{ ...at(20, 92 + k * 6), display: "flex", gap: 12 }}>
          <span style={{ width: 18 * MM }}>{qty(i.qty)}</span>
          <span>{i.description}</span>
        </div>
      ))}
      <div style={at(25, 236)}>
        {[r.vehicle_plate ? `Patente ${r.vehicle_plate}` : null, r.driver_name, r.cot_number ? `COT ${r.cot_number}` : null].filter(Boolean).join(" · ")}
      </div>
      <div style={at(140, 236)}>
        {r.packages} bultos · $ {moneyAr(r.declared_value)}
      </div>
    </div>
  );
}

export function RemitoPrintSet({
  remito,
  style,
  options,
  printable,
}: {
  remito: Remito;
  style: ResolvedInvoiceStyle;
  options: RemitoPrintOptions;
  printable?: boolean;
}) {
  const labels = copyLabels(options);
  if (options.model === "ticket80") {
    return (
      <div data-remito-set>
        {printable && <style>{`@media print{@page{size:80mm auto;margin:0}}`}</style>}
        {labels.map((l, i) => (
          <div key={i} style={{ borderTop: i ? `1px dashed ${MUTED}` : undefined, breakInside: "avoid" }}>
            <RemitoCompact remito={remito} copyLabel={l} width={302} fontScale={0.95} />
          </div>
        ))}
      </div>
    );
  }
  if (options.model === "a4_medio") {
    const pages: string[][] = [];
    for (let i = 0; i < labels.length; i += 2) pages.push(labels.slice(i, i + 2));
    return (
      <div data-invoice-a4 data-remito-set style={{ display: "flex", flexDirection: "column", gap: 16, alignItems: "center" }}>
        {printable && (
          <style>{`@media print{@page{size:A4;margin:0}[data-invoice-page]{break-after:page;page-break-after:always}[data-invoice-page]:last-child{break-after:auto}[data-invoice-a4]{gap:0!important}}`}</style>
        )}
        {pages.map((pair, p) => (
          <div key={p} data-invoice-page style={{ width: A4_W, height: A4_H, background: "#fff", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {pair.map((l, k) => (
              <div key={k} style={{ height: A4_H / 2, overflow: "hidden", borderTop: k ? `1px dashed ${MUTED}` : undefined }}>
                <RemitoCompact remito={remito} copyLabel={l} width={A4_W} />
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }
  if (options.model === "preimpreso") {
    return (
      <div data-invoice-a4 data-remito-set style={{ display: "flex", flexDirection: "column", gap: 16, alignItems: "center" }}>
        {printable && <style>{`@media print{@page{size:A4;margin:0}[data-invoice-page]{break-after:page}[data-invoice-page]:last-child{break-after:auto}[data-invoice-a4]{gap:0!important}}`}</style>}
        {labels.map((l, i) => (
          <RemitoPreprinted key={i} remito={remito} offsetX={options.offsetXmm ?? 0} offsetY={options.offsetYmm ?? 0} />
        ))}
      </div>
    );
  }
  return (
    <div data-remito-set style={{ display: "flex", flexDirection: "column", gap: 16, alignItems: "center" }}>
      {printable && labels.length > 1 && (
        <style>{`@media print{[data-remito-set]{gap:0!important}[data-remito-set]>[data-invoice-a4]{break-after:page}[data-remito-set]>[data-invoice-a4]:last-child{break-after:auto}}`}</style>
      )}
      {labels.map((l, i) => (
        <RemitoDocument key={i} remito={remito} style={style} printable={printable && i === 0} copyLabel={labels.length > 1 ? l : null} />
      ))}
    </div>
  );
}
