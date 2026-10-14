// Vista lista para dibujar de un comprobante (ADR-112). PURO.
//
// Todos los modelos (A4 y ticket) dibujan ESTA vista: filas con etiqueta,
// valor y la clave legal que cubren. Así la lógica de "qué va según el tipo"
// vive en un solo lugar y los modelos sólo deciden el diseño.

import {
  currencyName,
  discriminatesIva,
  fmtCuit,
  fmtDate,
  fmtMoney,
  fmtRate,
  fmtTime,
  isForeignCurrency,
  ivaConditionLabel,
  mandatoryLegends,
  receiverIdRequired,
  showsTransparency,
  TRANSPARENCY_TITLE,
  type LegalField,
} from "./legal";
import type { InvoiceDoc } from "./types";

export interface ViewRow {
  label: string;
  value: string;
  legal?: LegalField;
  strong?: boolean;
}

export interface InvoiceViewModel {
  /** "FACTURA", "NOTA DE CRÉDITO", "COMPROBANTE NO FISCAL". */
  title: string;
  /** "Factura B". */
  label: string;
  /** "00003-00001837" o "#0001042". */
  numberText: string;
  dateText: string;
  timeText: string;
  issuerName: string;
  tradeName: string | null;
  issuerRows: ViewRow[];
  receiverRows: ViewRow[];
  /** Condición de venta, moneda, período, asociado, referencia interna. */
  docRows: ViewRow[];
  showIvaCol: boolean;
  totalsRows: ViewRow[];
  totalRow: ViewRow;
  transparency: { title: string; rows: ViewRow[] } | null;
  authRows: ViewRow[];
  legends: string[];
  footer: string | null;
  copy: string | null;
  qrText: string;
  money: (n: number) => string;
}

const MISSING = "s/d";

const TITLE: Record<InvoiceDoc["cbteClass"], string> = {
  factura: "Factura",
  nota_credito: "Nota de crédito",
  nota_debito: "Nota de débito",
  no_fiscal: "Comprobante no fiscal",
};

export function invoiceView(doc: InvoiceDoc): InvoiceViewModel {
  const money = (n: number) => fmtMoney(n, doc.currency.code);
  const fiscal = doc.fiscal;
  const disc = fiscal && discriminatesIva(doc.letter);

  const issuerRows: ViewRow[] = [
    { label: "Domicilio comercial", value: doc.issuer.address || MISSING, legal: "emisor_domicilio" },
    { label: "CUIT", value: fmtCuit(doc.issuer.cuit) || MISSING, legal: "emisor_cuit" },
  ];
  if (fiscal) {
    issuerRows.push(
      { label: "Ingresos Brutos", value: doc.issuer.iibb || MISSING, legal: "emisor_iibb" },
      { label: "Inicio de actividades", value: fmtDate(doc.issuer.activityStart) || MISSING, legal: "emisor_inicio" },
    );
  }
  issuerRows.push({ label: "Condición frente al IVA", value: doc.issuer.ivaCondition ? ivaConditionLabel(doc.issuer.ivaCondition) : MISSING, legal: "emisor_iva" });
  if (doc.issuer.phone) issuerRows.push({ label: "Teléfono", value: doc.issuer.phone });
  if (doc.issuer.email) issuerRows.push({ label: "Email", value: doc.issuer.email });

  const receiverRows: ViewRow[] = [{ label: "Cliente", value: doc.receiver.name || "Consumidor Final", legal: "receptor", strong: true }];
  const hasDoc = Boolean(doc.receiver.docNumber || doc.receiver.cuit);
  if (hasDoc || receiverIdRequired(doc)) {
    const t = doc.receiver.docType || (doc.receiver.cuit ? "CUIT" : "Documento");
    const n = doc.receiver.docNumber || doc.receiver.cuit || "";
    receiverRows.push({ label: t, value: (t === "CUIT" || t === "CUIL" ? fmtCuit(n) : n) || MISSING, legal: "receptor_doc" });
  }
  if (fiscal) receiverRows.push({ label: "Condición frente al IVA", value: ivaConditionLabel(doc.receiver.ivaCondition), legal: "receptor_iva" });
  if (doc.receiver.address || doc.letter === "A" || doc.letter === "M") {
    receiverRows.push({ label: "Domicilio", value: doc.receiver.address || MISSING, legal: "receptor_domicilio" });
  }
  if (doc.receiver.email) receiverRows.push({ label: "Email", value: doc.receiver.email });

  const docRows: ViewRow[] = [];
  if (fiscal) docRows.push({ label: "Condición de venta", value: doc.saleCondition, legal: "condicion_venta" });
  if (isForeignCurrency(doc)) {
    docRows.push({
      label: "Moneda",
      value: `${currencyName(doc.currency.code)}${doc.currency.rate ? ` · Cotización ${fmtMoney(doc.currency.rate, "ARS")}` : ""}`,
      legal: "moneda",
    });
  }
  if (doc.concepto === 2 || doc.concepto === 3) {
    const p = doc.servicePeriod;
    docRows.push({ label: "Período facturado", value: p ? `${fmtDate(p.from)} al ${fmtDate(p.to)}` : MISSING, legal: "periodo" });
    if (doc.paymentDue) docRows.push({ label: "Vencimiento del pago", value: fmtDate(doc.paymentDue) });
  }
  for (const a of doc.associated ?? []) {
    docRows.push({ label: "Comprobante asociado", value: `${a.label} N° ${a.number}${a.date ? ` del ${fmtDate(a.date)}` : ""}`, legal: "asociado" });
  }
  if (doc.internalRef) docRows.push({ label: "Venta", value: doc.internalRef });
  if (doc.branchText) docRows.push({ label: "Sucursal", value: doc.branchText });

  const totalsRows: ViewRow[] = [{ label: disc ? "Subtotal (neto)" : "Subtotal", value: money(doc.totals.subtotal), legal: "subtotal" }];
  for (const d of doc.totals.discounts) totalsRows.push({ label: d.label, value: `-${money(d.amount)}` });
  if (disc) {
    totalsRows.push({ label: "Importe neto gravado", value: money(doc.totals.netTaxed ?? 0) });
    if (doc.totals.netUntaxed) totalsRows.push({ label: "Importe no gravado", value: money(doc.totals.netUntaxed) });
    if (doc.totals.exempt) totalsRows.push({ label: "Importe exento", value: money(doc.totals.exempt) });
    const ivaRows = doc.totals.iva.length ? doc.totals.iva : [{ rate: 21, base: 0, amount: 0 }];
    for (const r of ivaRows) totalsRows.push({ label: `IVA ${fmtRate(r.rate)}`, value: money(r.amount), legal: "iva_discriminado" });
  }
  for (const t of doc.totals.otherTaxes) totalsRows.push({ label: t.label, value: money(t.amount), legal: "otros_tributos" });

  const transparency = showsTransparency(doc)
    ? {
        title: TRANSPARENCY_TITLE,
        rows: [
          { label: "IVA contenido", value: money(doc.transparency!.iva), legal: "transparencia" as const },
          // ADR-119: IVA contenido por alícuota (sólo B, opción del negocio).
          ...(doc.letter === "B"
            ? (doc.transparencyBreakdown ?? [])
                .filter((r) => r.amount > 0)
                .map((r) => ({ label: `IVA ${fmtRate(r.rate)} contenido`, value: money(r.amount) }))
            : []),
          { label: "Otros impuestos nacionales indirectos", value: money(doc.transparency!.others), legal: "transparencia" as const },
        ],
      }
    : null;

  const authRows: ViewRow[] = doc.authorization
    ? [
        { label: `${doc.authorization.type} N°`, value: doc.authorization.code, legal: "cae", strong: true },
        { label: `Vto. ${doc.authorization.type}`, value: fmtDate(doc.authorization.due), legal: "cae_vto", strong: true },
      ]
    : [];

  const title = fiscal ? TITLE[doc.cbteClass] : doc.label || TITLE.no_fiscal;

  return {
    title: title.toUpperCase(),
    label: doc.label,
    numberText: doc.ptoVta ? `${doc.ptoVta}-${doc.number}` : doc.number,
    dateText: fmtDate(doc.date),
    timeText: fmtTime(doc.date),
    issuerName: doc.issuer.name,
    tradeName: doc.issuer.tradeName?.trim() || null,
    issuerRows,
    receiverRows,
    docRows,
    showIvaCol: disc,
    totalsRows,
    totalRow: { label: "Total", value: money(doc.totals.total), legal: "total", strong: true },
    transparency,
    authRows,
    legends: [...mandatoryLegends(doc), ...(doc.voided ? ["ANULADA"] : []), ...(doc.legends ?? [])],
    footer: doc.footer ?? null,
    copy: doc.copy ?? null,
    qrText: doc.qrUrl || doc.qrFallbackText,
    money,
  };
}
