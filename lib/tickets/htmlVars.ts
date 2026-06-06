// H9b PR2 — Mapa de variables {{x}} para plantillas HTML del ticket.
// Toda data de tenant/venta va HTML-escapeada; las vars `*_html` ya traen
// HTML seguro pre-armado (filas de tabla con valores escapeados).
import type { TicketData } from "@/components/tickets/TicketRenderer";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { PAYMENT_METHOD_LABELS } from "@/lib/utils/paymentMethods";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Catálogo de variables disponibles para plantillas HTML (mostrar en el editor). */
export const HTML_TEMPLATE_VARS: { key: string; label: string }[] = [
  { key: "negocio", label: "Nombre del negocio" },
  { key: "logo_url", label: "URL del logo" },
  { key: "cuit", label: "CUIT" },
  { key: "direccion", label: "Dirección" },
  { key: "telefono", label: "Teléfono" },
  { key: "titulo", label: "Título del comprobante" },
  { key: "numero", label: "N° de comprobante" },
  { key: "fecha", label: "Fecha y hora" },
  { key: "cliente", label: "Nombre del cliente" },
  { key: "items_html", label: "Filas de ítems (HTML)" },
  { key: "subtotal", label: "Subtotal" },
  { key: "descuento", label: "Descuento" },
  { key: "total", label: "Total" },
  { key: "pagos_html", label: "Medios de pago (HTML)" },
  { key: "pie", label: "Pie del ticket" },
  { key: "leyenda", label: "Leyenda extra" },
  { key: "qr_url", label: "URL del QR" },
  { key: "anulada", label: "'ANULADA' si la venta fue anulada" },
];

export function buildHtmlVars(data: TicketData): Record<string, string> {
  const { sale, items, payments, customer, brand } = data;
  const itemsHtml = items
    .map(
      (it) =>
        `<tr><td>${esc(formatQty(it.quantity))}× ${esc(it.product_name)}</td><td style="text-align:right">${esc(formatCurrency(it.subtotal))}</td></tr>`,
    )
    .join("");
  const pagosHtml = payments
    .map(
      (p) =>
        `<tr><td>${esc(PAYMENT_METHOD_LABELS[p.method] ?? p.method)}</td><td style="text-align:right">${esc(formatCurrency(p.amount))}</td></tr>`,
    )
    .join("");
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${encodeURIComponent(
    `${brand?.legal_name || "NinjaPos"} | ${sale.numberLabel} | ${formatCurrency(sale.total)} | ${new Date(sale.created_at).toLocaleString("es-AR")}`,
  )}`;
  return {
    negocio: esc(brand?.legal_name || "NinjaSoft POS"),
    logo_url: esc(brand?.logo_url || ""),
    cuit: esc(brand?.cuit || ""),
    direccion: esc(brand?.address || ""),
    telefono: esc(brand?.phone || ""),
    titulo: esc(brand?.ticket_title || "Comprobante no fiscal"),
    numero: esc(sale.numberLabel),
    fecha: esc(new Date(sale.created_at).toLocaleString("es-AR")),
    cliente: esc(customer?.name || ""),
    items_html: itemsHtml,
    subtotal: esc(formatCurrency(sale.subtotal)),
    descuento: sale.discount_total > 0 ? esc(`-${formatCurrency(sale.discount_total)}`) : "",
    total: esc(formatCurrency(sale.total)),
    pagos_html: pagosHtml,
    pie: esc(brand?.ticket_footer || "¡Gracias por su compra!"),
    leyenda: esc(brand?.ticket_legend || ""),
    qr_url: qrUrl,
    anulada: sale.status === "voided" ? "ANULADA" : "",
  };
}
