// Estado de cuenta en PDF (jsPDF, carga perezosa). Tabla simple A4 con saldo
// inicial, movimientos con saldo corrido y saldo final.
import { formatCurrency } from "@/lib/utils/format";

export interface StatementPdfRow {
  date: string;
  concept: string;
  due: string;
  debit: number | null;
  credit: number | null;
  running: number;
}

export async function downloadStatementPdf(input: {
  business: string;
  customer: string;
  from: string;
  to: string;
  opening: number;
  balance: number;
  overdue: number;
  rows: StatementPdfRow[];
  fileName: string;
}): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const W = 210;
  const M = 14;
  let y = 18;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text("Estado de cuenta corriente", M, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  y += 6;
  if (input.business) {
    doc.text(input.business, M, y);
    y += 5;
  }
  doc.text(`Cliente: ${input.customer}`, M, y);
  y += 5;
  doc.text(`Período: ${input.from} al ${input.to}`, M, y);
  y += 5;
  doc.text(
    `Saldo: ${formatCurrency(input.balance)}   Vencido: ${formatCurrency(input.overdue)}`,
    M,
    y,
  );
  y += 8;

  const cols = [
    { h: "Fecha", x: M, w: 22 },
    { h: "Concepto", x: M + 22, w: 66 },
    { h: "Vence", x: M + 88, w: 20 },
    { h: "Débito", x: M + 108, w: 24, right: true },
    { h: "Crédito", x: M + 132, w: 24, right: true },
    { h: "Saldo", x: M + 156, w: 26, right: true },
  ];
  const header = () => {
    doc.setFillColor(243, 243, 245);
    doc.rect(M, y - 4, W - 2 * M, 6, "F");
    doc.setFont("helvetica", "bold");
    for (const c of cols) doc.text(c.h, c.right ? c.x + c.w : c.x, y, { align: c.right ? "right" : "left" });
    doc.setFont("helvetica", "normal");
    y += 6;
  };
  header();

  const line = (cells: string[]) => {
    if (y > 280) {
      doc.addPage();
      y = 18;
      header();
    }
    cols.forEach((c, i) => {
      const txt = doc.splitTextToSize(cells[i] ?? "", c.w - 1)[0] ?? "";
      doc.text(txt, c.right ? c.x + c.w : c.x, y, { align: c.right ? "right" : "left" });
    });
    y += 5;
  };

  line(["", "Saldo inicial", "", "", "", formatCurrency(input.opening)]);
  for (const r of input.rows) {
    line([
      r.date,
      r.concept,
      r.due,
      r.debit != null ? formatCurrency(r.debit) : "",
      r.credit != null ? formatCurrency(r.credit) : "",
      formatCurrency(r.running),
    ]);
  }
  y += 2;
  doc.setFont("helvetica", "bold");
  line(["", "Saldo final", "", "", "", formatCurrency(input.rows.at(-1)?.running ?? input.opening)]);

  doc.save(input.fileName);
}
