// Hoja de ruta imprimible (ADR-161, R7): A4 apaisado con el camión, el
// repartidor, las paradas en orden con contacto, dirección, entregas,
// productos y remito, y columnas para la hora y la firma. Al final, la
// planilla de carga con el total de cada producto. Sin hooks: lo imprime el
// panel con printTicketIsolated desde un nodo fuera de pantalla.
import { formatDistance, ROUTE_STATUS_LABEL, VEHICLE_KIND_LABEL } from "@/lib/logistics/logic";
import { remitoNumberLabel } from "@/lib/remitos/logic";
import type { RouteDetail } from "@/modules/logistics/api";

const INK = "#111827";
const MUTED = "#6b7280";
const HAIR = "#d1d5db";

function dateAr(d: string | null | undefined): string {
  if (!d) return "";
  const [y, m, day] = d.slice(0, 10).split("-");
  return `${day}/${m}/${y}`;
}

/** Total de cada producto de la hoja (planilla de carga). */
export function loadSheet(detail: RouteDetail): { name: string; unit: string; qty: number }[] {
  const map = new Map<string, { name: string; unit: string; qty: number }>();
  for (const s of detail.stops) {
    for (const d of s.dispatches) {
      if (d.outcome === "quitado") continue;
      for (const i of d.items) {
        const unit = i.unit || "un";
        const k = `${i.sku ?? ""}|${i.name}|${unit}`;
        const cur = map.get(k) ?? { name: i.name, unit, qty: 0 };
        cur.qty += Number(i.qty) || 0;
        map.set(k, cur);
      }
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "es"));
}

const th: React.CSSProperties = { textAlign: "left", padding: "6px 6px", borderBottom: `1.5px solid ${INK}`, fontSize: 9, textTransform: "uppercase", letterSpacing: 0.6, color: MUTED };
const td: React.CSSProperties = { padding: "7px 6px", borderBottom: `1px solid ${HAIR}`, verticalAlign: "top", fontSize: 10.5 };

export function RouteSheetPrint({ detail, businessName }: { detail: RouteDetail; businessName?: string | null }) {
  const r = detail.route;
  const load = loadSheet(detail);
  const totalUnits = load.reduce((a, x) => a + x.qty, 0);
  return (
    <div data-route-sheet style={{ background: "#fff", color: INK, fontFamily: "Inter, Arial, sans-serif", width: 1123, padding: "28px 36px", boxSizing: "border-box" }}>
      <style>{`@media print{@page{size:A4 landscape;margin:8mm}[data-route-sheet]{width:auto!important;padding:0!important}[data-route-sheet] tr{break-inside:avoid}}`}</style>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 24 }}>
        <div>
          <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 1.4, fontWeight: 700 }}>{businessName ?? detail.store?.name ?? "Hoja de ruta"}</div>
          <div style={{ fontSize: 22, fontWeight: 800, marginTop: 2 }}>Hoja de ruta N° {r.number}</div>
          <div style={{ fontSize: 11, color: MUTED }}>
            {dateAr(r.service_date)} · {ROUTE_STATUS_LABEL[r.status]}
            {r.planned_distance_m ? ` · ${formatDistance(r.planned_distance_m)} estimados` : ""}
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "auto auto", columnGap: 14, rowGap: 2, fontSize: 11 }}>
          <span style={{ color: MUTED }}>Vehículo</span>
          <strong>
            {detail.vehicle ? `${detail.vehicle.name} · ${VEHICLE_KIND_LABEL[detail.vehicle.kind]}${detail.vehicle.plate ? ` · ${detail.vehicle.plate}` : ""}` : "Sin asignar"}
          </strong>
          <span style={{ color: MUTED }}>Repartidor</span>
          <strong>{detail.driver?.name ?? "Sin asignar"}</strong>
          {detail.helper && (
            <>
              <span style={{ color: MUTED }}>Acompañante</span>
              <strong>{detail.helper.name}</strong>
            </>
          )}
          <span style={{ color: MUTED }}>Sale de</span>
          <strong>{detail.origin ? `${detail.origin.name}${detail.origin.address_text ? ` · ${detail.origin.address_text}` : ""}` : (detail.store?.name ?? "")}</strong>
        </div>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 16 }}>
        <thead>
          <tr>
            <th style={{ ...th, width: 28 }}>N°</th>
            <th style={{ ...th, width: 180 }}>Recibe</th>
            <th style={th}>Dirección</th>
            <th style={th}>Lleva</th>
            <th style={{ ...th, width: 92 }}>Remito</th>
            <th style={{ ...th, width: 54 }}>Hora</th>
            <th style={{ ...th, width: 150 }}>Firma y aclaración</th>
          </tr>
        </thead>
        <tbody>
          {detail.stops.map((s) => (
            <tr key={s.id}>
              <td style={{ ...td, fontWeight: 800, fontSize: 13 }}>{s.seq}</td>
              <td style={td}>
                <div style={{ fontWeight: 700 }}>{s.contact_name ?? ""}</div>
                {s.contact_phone && <div style={{ color: MUTED }}>Tel. {s.contact_phone}</div>}
              </td>
              <td style={td}>
                <div>{s.address_text ?? ""}</div>
                {(s.ship_to?.between_streets || s.ship_to?.reference) && (
                  <div style={{ color: MUTED }}>{[s.ship_to?.between_streets, s.ship_to?.reference].filter(Boolean).join(" · ")}</div>
                )}
                {s.notes && <div style={{ color: MUTED, fontStyle: "italic" }}>{s.notes}</div>}
              </td>
              <td style={td}>
                {s.dispatches.map((d) => (
                  <div key={d.id} style={{ marginBottom: 3 }}>
                    <span style={{ color: MUTED }}>Entrega {d.number}{d.sale_number ? ` · venta ${d.sale_number}` : ""}: </span>
                    {d.items.map((i) => `${Number(i.qty).toLocaleString("es-AR", { maximumFractionDigits: 3 })} ${i.name}`).join(", ")}
                  </div>
                ))}
              </td>
              <td style={td}>
                {s.dispatches
                  .map((d) => (d.remito ? remitoNumberLabel(d.remito.pto_vta, d.remito.number) : null))
                  .filter(Boolean)
                  .join(", ")}
              </td>
              <td style={td} />
              <td style={td} />
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 22, breakInside: "avoid" }}>
        <div style={{ fontSize: 12, fontWeight: 800 }}>Planilla de carga</div>
        <div style={{ fontSize: 10, color: MUTED, marginBottom: 4 }}>
          {detail.stops.length} paradas · {totalUnits.toLocaleString("es-AR", { maximumFractionDigits: 3 })} unidades en total
        </div>
        <table style={{ width: 560, borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Producto</th>
              <th style={{ ...th, textAlign: "right", width: 90 }}>Cantidad</th>
              <th style={{ ...th, width: 60 }}>Cargado</th>
            </tr>
          </thead>
          <tbody>
            {load.map((l) => (
              <tr key={`${l.name}|${l.unit}`}>
                <td style={td}>{l.name}</td>
                <td style={{ ...td, textAlign: "right", fontWeight: 700 }}>
                  {l.qty.toLocaleString("es-AR", { maximumFractionDigits: 3 })} {l.unit}
                </td>
                <td style={td}>
                  <span style={{ display: "inline-block", width: 14, height: 14, border: `1.5px solid ${INK}`, borderRadius: 3 }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", gap: 40, marginTop: 34, fontSize: 10, color: MUTED }}>
        {["Controló la carga", "Repartidor", "Recibió la rendición"].map((l) => (
          <div key={l} style={{ width: 200, borderTop: `1px solid ${INK}`, paddingTop: 4, textAlign: "center" }}>
            {l}
          </div>
        ))}
      </div>
    </div>
  );
}
