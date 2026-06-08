// H9b PR2 — Mapa de variables {{x}} para plantillas HTML del ticket.
// Toda data de tenant/venta va HTML-escapeada; las vars `*_html` ya traen
// HTML seguro pre-armado (filas de tabla con valores escapeados).
//
// SAAS — Datos fiscales (factura legal AR): la app todavía NO integra
// facturación electrónica (AFIP/ARCA), así que CAE, vencimiento de CAE, punto
// de venta, número fiscal, letra de comprobante, Ingresos Brutos, inicio de
// actividades y el documento/condición IVA del receptor NO existen como dato
// real. Esas variables se exponen igual (para que la plantilla A4 legal quede
// armada) pero rinden el placeholder `—` hasta que exista la integración. No se
// inventan valores: ver FISCAL_PLACEHOLDER y los TODO de abajo.
import type { TicketData } from "@/components/tickets/TicketRenderer";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { PAYMENT_METHOD_LABELS } from "@/lib/utils/paymentMethods";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Placeholder neutro para datos fiscales aún no capturados (CAE, IIBB, etc.).
const FISCAL_PLACEHOLDER = "—";

// Etiquetas legibles de la condición frente al IVA (tenant_branding.iva_condition).
const IVA_CONDITION_LABELS: Record<string, string> = {
  monotributo: "Responsable Monotributo",
  responsable_inscripto: "Responsable Inscripto",
  exento: "IVA Exento",
  consumidor_final: "Consumidor Final",
};

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
  { key: "items_fiscal_html", label: "Filas de ítems fiscales: cód./desc./cant./precio/IVA/subtotal (HTML)" },
  { key: "subtotal", label: "Subtotal" },
  { key: "descuento", label: "Descuento" },
  { key: "total", label: "Total" },
  { key: "pagos_html", label: "Medios de pago (HTML)" },
  { key: "pie", label: "Pie del ticket" },
  { key: "leyenda", label: "Leyenda extra" },
  { key: "qr_url", label: "URL del QR" },
  { key: "anulada", label: "'ANULADA' si la venta fue anulada" },
  // --- Datos fiscales (factura legal AR) ---
  { key: "condicion_iva", label: "Condición IVA del emisor" },
  { key: "ingresos_brutos", label: "Ingresos Brutos del emisor (— si falta)" },
  { key: "inicio_actividades", label: "Inicio de actividades (— si falta)" },
  { key: "comprobante_tipo", label: "Tipo de comprobante (FACTURA / COMPROBANTE…)" },
  { key: "comprobante_letra", label: "Letra del comprobante (A/B/C, X si no fiscal)" },
  { key: "comprobante_cod", label: "Código numérico del tipo (ej. 006); — si no fiscal" },
  { key: "punto_venta", label: "Punto de venta (0001 por defecto)" },
  { key: "comprobante_nro", label: "Número fiscal del comprobante" },
  { key: "neto_gravado", label: "Importe neto gravado (— si IVA no discriminado)" },
  { key: "iva_total", label: "IVA total discriminado (— si no discriminado)" },
  { key: "cliente_doc", label: "CUIT/DNI del receptor (— si falta)" },
  { key: "cliente_iva", label: "Condición IVA del receptor" },
  { key: "cae", label: "CAE (— hasta integrar AFIP/ARCA)" },
  { key: "cae_vto", label: "Vencimiento del CAE (— hasta integrar AFIP/ARCA)" },
];

export function buildHtmlVars(data: TicketData): Record<string, string> {
  const { sale, items, payments, customer, brand } = data;
  const itemsHtml = items
    .map(
      (it) =>
        `<tr><td>${esc(formatQty(it.quantity))}× ${esc(it.product_name)}</td><td style="text-align:right">${esc(formatCurrency(it.subtotal))}</td></tr>`,
    )
    .join("");
  // Filas fiscales: código, descripción, cantidad, precio unit., % IVA, subtotal.
  // TODO(AFIP): `código` usa el índice de línea y `% IVA` queda en `—` porque el
  // ítem de venta todavía no guarda SKU ni alícuota por línea. Cantidad, precio
  // unitario y subtotal sí son reales.
  const itemsFiscalHtml = items
    .map(
      (it, i) =>
        `<tr>` +
        `<td style="padding:5px 8px;border-bottom:1px solid #e5e5e5">${String(i + 1).padStart(3, "0")}</td>` +
        `<td style="padding:5px 8px;border-bottom:1px solid #e5e5e5">${esc(it.product_name)}</td>` +
        `<td style="padding:5px 8px;border-bottom:1px solid #e5e5e5;text-align:right">${esc(formatQty(it.quantity))}</td>` +
        `<td style="padding:5px 8px;border-bottom:1px solid #e5e5e5;text-align:right">${esc(formatCurrency(it.unit_price))}</td>` +
        `<td style="padding:5px 8px;border-bottom:1px solid #e5e5e5;text-align:right">${FISCAL_PLACEHOLDER}</td>` +
        `<td style="padding:5px 8px;border-bottom:1px solid #e5e5e5;text-align:right">${esc(formatCurrency(it.subtotal))}</td>` +
        `</tr>`,
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

  // Condición IVA del emisor (si el branding la tiene cargada).
  const emisorIva = brand?.iva_condition
    ? IVA_CONDITION_LABELS[brand.iva_condition] ?? brand.iva_condition
    : FISCAL_PLACEHOLDER;

  return {
    negocio: esc(brand?.legal_name || "NinjaSoft POS"),
    logo_url: esc(brand?.logo_url || ""),
    cuit: esc(brand?.cuit || FISCAL_PLACEHOLDER),
    direccion: esc(brand?.address || ""),
    telefono: esc(brand?.phone || ""),
    titulo: esc(brand?.ticket_title || "Comprobante no fiscal"),
    numero: esc(sale.numberLabel),
    fecha: esc(new Date(sale.created_at).toLocaleString("es-AR")),
    cliente: esc(customer?.name || "Consumidor Final"),
    items_html: itemsHtml,
    items_fiscal_html: itemsFiscalHtml,
    subtotal: esc(formatCurrency(sale.subtotal)),
    descuento: sale.discount_total > 0 ? esc(`-${formatCurrency(sale.discount_total)}`) : "",
    total: esc(formatCurrency(sale.total)),
    pagos_html: pagosHtml,
    pie: esc(brand?.ticket_footer || "¡Gracias por su compra!"),
    leyenda: esc(brand?.ticket_legend || ""),
    qr_url: esc(qrUrl),
    anulada: sale.status === "voided" ? "ANULADA" : "",

    // --- Datos fiscales ---
    condicion_iva: esc(emisorIva),
    // TODO(AFIP): no existen como columnas todavía → placeholder honesto.
    ingresos_brutos: FISCAL_PLACEHOLDER,
    inicio_actividades: FISCAL_PLACEHOLDER,
    comprobante_tipo: esc(brand?.ticket_title || "Comprobante no fiscal"),
    // Sin facturación electrónica el comprobante no es fiscal: letra "X".
    comprobante_letra: "X",
    comprobante_cod: FISCAL_PLACEHOLDER,
    // Punto de venta por defecto hasta que exista configuración fiscal.
    punto_venta: "0001",
    comprobante_nro: esc(sale.numberLabel.replace(/^#/, "").padStart(8, "0")),
    // Sin alícuotas por línea no se puede discriminar IVA → placeholder.
    neto_gravado: FISCAL_PLACEHOLDER,
    iva_total: FISCAL_PLACEHOLDER,
    // El receptor todavía no guarda CUIT/DNI ni su condición IVA.
    cliente_doc: FISCAL_PLACEHOLDER,
    cliente_iva: "Consumidor Final",
    // CAE y su vencimiento los devuelve AFIP/ARCA al autorizar (no integrado).
    cae: FISCAL_PLACEHOLDER,
    cae_vto: FISCAL_PLACEHOLDER,
  };
}
