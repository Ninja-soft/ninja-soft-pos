// lib/tax/retentionCertificate.ts
//
// Certificado de retención (F18 · H106, ADR-079). `certificateContent` es
// PURO (arma secciones y renglones desde la retención registrada, con la foto
// del agente y del sujeto tomada al pagar) y `openRetentionCertificate` lo
// dibuja en PDF A4 con jsPDF (carga perezosa, mismo estilo que el estado de
// cuenta), para descargar o imprimir.
import { formatCurrency } from "@/lib/utils/format";
import { amountInWords } from "@/lib/purchases/paymentOrders";
import { formatPaymentNumber } from "@/lib/purchases/orders";
import { jurisdictionName } from "./catalog";
import { GANANCIAS_CONDITION_LABEL, type GananciasCondition, type RetTax } from "./retentions";

export interface CertificateRow {
  id: string;
  tax: RetTax;
  jurisdiction: string | null;
  date: string;
  payment_number: number;
  payment_total: number;
  concept_code: string | null;
  concept_name: string | null;
  condition: string | null;
  payment_base: number;
  prior_base: number;
  accumulated_base: number;
  non_taxable_min: number;
  taxable_base: number;
  month_total: number;
  prior_withheld: number;
  rate: number | null;
  rate_source: string | null;
  exemption_pct: number;
  amount: number;
  certificate: string | null;
  sicore_regime_code: string | null;
  status: "issued" | "voided";
  agent_snapshot: {
    name?: string | null;
    cuit?: string | null;
    address?: string | null;
    iibb_number?: string | null;
    agent_number?: string | null;
  };
  subject_snapshot: {
    name?: string | null;
    cuit?: string | null;
    address?: string | null;
    city?: string | null;
    province?: string | null;
    iva_condition?: string | null;
    ganancias_condition?: string | null;
  };
}

export interface CertificateSection {
  title: string;
  rows: [string, string][];
}

export interface CertificateContent {
  title: string;
  subtitle: string;
  number: string;
  date: string;
  voided: boolean;
  sections: CertificateSection[];
  amount: string;
  amountWords: string;
  footer: string;
}

const TAX_TITLE: Record<RetTax, string> = {
  ganancias: "Impuesto a las Ganancias",
  iva: "Impuesto al Valor Agregado",
  iibb: "Impuesto sobre los Ingresos Brutos",
  suss: "Sistema Único de la Seguridad Social (SUSS)",
};

const IVA_LABEL: Record<string, string> = {
  responsable_inscripto: "Responsable inscripto",
  monotributo: "Monotributista",
  exento: "Exento",
  no_responsable: "No responsable",
  consumidor_final: "Consumidor final",
  no_alcanzado: "No alcanzado",
  exterior: "Del exterior",
};

export function formatCuit(cuit: string | null | undefined): string {
  const d = String(cuit ?? "").replace(/\D/g, "");
  return d.length === 11 ? `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}` : d || "Sin CUIT";
}

function fmtDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

const pctTxt = (n: number) => `${n.toLocaleString("es-AR", { maximumFractionDigits: 4 })} %`;

export function certificateContent(r: CertificateRow): CertificateContent {
  const a = r.agent_snapshot ?? {};
  const s = r.subject_snapshot ?? {};
  const regime =
    r.tax === "iibb"
      ? `Ingresos Brutos ${jurisdictionName(r.jurisdiction)}`
      : r.concept_name
        ? `${r.concept_code ? `${r.concept_code} · ` : ""}${r.concept_name}`
        : TAX_TITLE[r.tax];
  const calc: [string, string][] = [];
  if (r.tax === "ganancias") {
    calc.push(["Base de este pago (sin IVA)", formatCurrency(r.payment_base)]);
    if (r.prior_base > 0) calc.push(["Pagos anteriores del mes por el concepto", formatCurrency(r.prior_base)]);
    calc.push(["Acumulado del mes", formatCurrency(r.accumulated_base)]);
    calc.push(["Mínimo no sujeto a retención", formatCurrency(r.non_taxable_min)]);
    calc.push(["Importe sujeto a retención", formatCurrency(r.taxable_base)]);
    calc.push([
      "Alícuota",
      r.rate_source === "scale" ? "Escala RG 830 Anexo VIII" : pctTxt(r.rate ?? 0),
    ]);
    calc.push(["Retención del mes", formatCurrency(r.month_total)]);
    if (r.prior_withheld > 0) calc.push(["Retenido antes en el mes", `- ${formatCurrency(r.prior_withheld)}`]);
  } else {
    calc.push(["Base de cálculo", formatCurrency(r.payment_base)]);
    calc.push(["Alícuota", pctTxt(r.rate ?? 0)]);
  }
  if (r.exemption_pct > 0) calc.push(["Exclusión (certificado)", pctTxt(r.exemption_pct)]);

  const subjCond: string[] = [];
  if (s.iva_condition) subjCond.push(`IVA: ${IVA_LABEL[s.iva_condition] ?? s.iva_condition}`);
  if (r.tax === "ganancias") {
    const g = (r.condition ?? s.ganancias_condition) as GananciasCondition | null;
    if (g) subjCond.push(GANANCIAS_CONDITION_LABEL[g] ?? g);
  }

  return {
    title: "Certificado de retención",
    subtitle: TAX_TITLE[r.tax],
    number: r.certificate ?? "Sin número",
    date: fmtDate(r.date),
    voided: r.status === "voided",
    sections: [
      {
        title: "Agente de retención",
        rows: [
          ["Razón social", a.name ?? ""],
          ["CUIT", formatCuit(a.cuit)],
          ["Domicilio", a.address ?? ""],
          ...(a.agent_number ? ([["N° de agente", a.agent_number]] as [string, string][]) : []),
          ...(r.tax === "iibb" && a.iibb_number ? ([["N° de Ingresos Brutos", a.iibb_number]] as [string, string][]) : []),
        ],
      },
      {
        title: "Sujeto retenido",
        rows: [
          ["Razón social", s.name ?? ""],
          ["CUIT", formatCuit(s.cuit)],
          ["Domicilio", [s.address, s.city, s.province].filter(Boolean).join(", ")],
          ["Condición", subjCond.join(" · ")],
        ],
      },
      {
        title: "Operación",
        rows: [
          ["Comprobante", `Orden de pago ${formatPaymentNumber(r.payment_number)}`],
          ["Importe del pago", formatCurrency(r.payment_total)],
          ["Régimen", regime],
          ...(r.sicore_regime_code && r.tax !== "iibb"
            ? ([["Código de régimen", r.sicore_regime_code]] as [string, string][])
            : []),
        ],
      },
      { title: "Cálculo", rows: calc },
    ],
    amount: formatCurrency(r.amount),
    amountWords: `Son pesos ${amountInWords(r.amount)}.`,
    footer:
      "El agente de retención certifica haber retenido el importe indicado. El sujeto retenido puede computarlo en su declaración jurada.",
  };
}

/** Dibuja el certificado en PDF y lo descarga o lo abre para imprimir. */
export async function openRetentionCertificate(row: CertificateRow, mode: "download" | "print"): Promise<void> {
  const c = certificateContent(row);
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const W = 210;
  const M = 16;
  let y = 20;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text(c.title, M, y);
  doc.setFontSize(12);
  doc.text(c.number, W - M, y, { align: "right" });
  y += 6;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(c.subtitle, M, y);
  doc.text(`Fecha: ${c.date}`, W - M, y, { align: "right" });
  if (c.voided) {
    y += 7;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("ANULADO", M, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
  }
  y += 4;
  doc.setDrawColor(200, 200, 205);
  doc.line(M, y, W - M, y);
  y += 7;

  for (const s of c.sections) {
    doc.setFillColor(243, 243, 245);
    doc.rect(M, y - 4.5, W - 2 * M, 6.5, "F");
    doc.setFont("helvetica", "bold");
    doc.text(s.title, M + 2, y);
    doc.setFont("helvetica", "normal");
    y += 7;
    for (const [k, v] of s.rows) {
      doc.setTextColor(100, 100, 110);
      doc.text(k, M + 2, y);
      doc.setTextColor(20, 20, 25);
      const lines = doc.splitTextToSize(v || "-", W - 2 * M - 72) as string[];
      doc.text(lines, M + 72, y);
      y += 5.5 * Math.max(1, lines.length);
    }
    y += 3;
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text("Importe retenido", M + 2, y);
  doc.text(c.amount, W - M - 2, y, { align: "right" });
  y += 6;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(c.amountWords, M + 2, y);
  y += 26;

  doc.setDrawColor(20, 20, 25);
  doc.line(M + 2, y, M + 82, y);
  doc.line(W - M - 82, y, W - M - 2, y);
  y += 5;
  doc.setFontSize(9);
  doc.text("Firma del agente de retención", M + 2, y);
  doc.text("Aclaración y cargo", W - M - 82, y);
  y += 12;
  doc.setTextColor(100, 100, 110);
  doc.text(doc.splitTextToSize(c.footer, W - 2 * M) as string[], M, y);

  const fileName = `certificado-${(row.certificate ?? row.id).toLowerCase()}.pdf`;
  if (mode === "download") {
    doc.save(fileName);
    return;
  }
  doc.autoPrint();
  window.open(doc.output("bloburl"), "_blank", "noopener");
}
