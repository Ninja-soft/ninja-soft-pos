import { jsPDF } from "jspdf";
import { formatCurrency, formatQty } from "@/lib/utils/format";

// Comprobante A4 (no fiscal) descargable. Ver roadmap H9.
const METHOD_LABELS: Record<string, string> = {
  cash: "Efectivo",
  debit: "Débito",
  credit: "Crédito",
  transfer: "Transferencia",
  qr: "QR",
  other: "Otro",
};

export interface TicketPdfData {
  sale: {
    number: number;
    created_at: string;
    subtotal: number;
    discount_total: number;
    total: number;
    status: string;
  };
  items: { product_name: string; quantity: number; subtotal: number }[];
  payments: { method: string; amount: number }[];
  brand?: {
    legal_name?: string | null;
    cuit?: string | null;
    address?: string | null;
    phone?: string | null;
    ticket_footer?: string | null;
  } | null;
}

export function downloadTicketPdf(data: TicketPdfData): void {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const left = 20;
  let y = 20;

  doc.setFontSize(16).setFont("helvetica", "bold");
  doc.text(data.brand?.legal_name || "NinjaSoft POS", left, y);
  y += 6;

  doc.setFontSize(9).setFont("helvetica", "normal");
  const head: string[] = [];
  if (data.brand?.cuit) head.push(`CUIT ${data.brand.cuit}`);
  if (data.brand?.address) head.push(data.brand.address);
  if (data.brand?.phone) head.push(`Tel ${data.brand.phone}`);
  if (head.length) {
    doc.text(head.join("  ·  "), left, y);
    y += 5;
  }
  doc.text("Comprobante no fiscal", left, y);
  y += 8;

  doc.setDrawColor(200);
  doc.line(left, y, 190, y);
  y += 7;

  doc.setFontSize(10).setFont("helvetica", "bold");
  doc.text(`Venta #${data.sale.number}`, left, y);
  doc.text(
    new Date(data.sale.created_at).toLocaleString("es-AR"),
    190,
    y,
    { align: "right" },
  );
  y += 8;

  // Cabecera tabla.
  doc.setFontSize(9);
  doc.text("Cant.", left, y);
  doc.text("Producto", left + 18, y);
  doc.text("Subtotal", 190, y, { align: "right" });
  y += 2;
  doc.line(left, y, 190, y);
  y += 5;

  doc.setFont("helvetica", "normal");
  for (const it of data.items) {
    if (y > 270) {
      doc.addPage();
      y = 20;
    }
    doc.text(formatQty(it.quantity), left, y);
    doc.text(it.product_name.slice(0, 70), left + 18, y);
    doc.text(formatCurrency(it.subtotal), 190, y, { align: "right" });
    y += 6;
  }

  y += 2;
  doc.line(left, y, 190, y);
  y += 7;

  const totalsRight = (label: string, value: string, bold = false) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(bold ? 12 : 10);
    doc.text(label, 150, y, { align: "right" });
    doc.text(value, 190, y, { align: "right" });
    y += bold ? 8 : 6;
  };
  totalsRight("Subtotal", formatCurrency(data.sale.subtotal));
  if (data.sale.discount_total > 0)
    totalsRight("Descuento", `-${formatCurrency(data.sale.discount_total)}`);
  totalsRight("TOTAL", formatCurrency(data.sale.total), true);

  y += 2;
  doc.setFontSize(9).setFont("helvetica", "normal");
  for (const p of data.payments) {
    doc.text(
      `${METHOD_LABELS[p.method] ?? p.method}: ${formatCurrency(p.amount)}`,
      left,
      y,
    );
    y += 5;
  }

  if (data.sale.status === "voided") {
    y += 4;
    doc.setTextColor(200, 0, 0).setFont("helvetica", "bold");
    doc.text("** ANULADA **", left, y);
    doc.setTextColor(0, 0, 0);
    y += 6;
  }

  y += 6;
  doc.setFontSize(10).setFont("helvetica", "italic");
  doc.text(
    data.brand?.ticket_footer || "¡Gracias por su compra!",
    105,
    y,
    { align: "center" },
  );

  doc.save(`comprobante-${data.sale.number}.pdf`);
}
