// Adaptador venta del POS -> InvoiceDoc (ADR-112). PURO.
//
// Toma los mismos datos que ya arma el detalle de la venta para el ticket
// (TicketData: venta, ítems, pagos, cliente, marca y factura de ARCA) y los
// lleva al modelo neutro del motor. Con la factura autorizada (CAE o CAEA) el
// comprobante es fiscal; sin ella (o pendiente) es un comprobante no fiscal
// claramente marcado. No inventa datos: lo que falta queda vacío.

import type { SampleTicketData as TicketData } from "@/lib/tickets/sample";
import { fiscalApproved } from "@/lib/arca/ticket";
import { ticketPromoLabel, ticketPromoLines } from "@/lib/promotions/ticket";
import { ticketLocationText } from "@/lib/tickets/location";
import { PAYMENT_METHOD_LABELS } from "@/lib/utils/paymentMethods";
import { formatCurrency } from "@/lib/utils/format";
import { serviceLineBlocks, unitLabel } from "@/lib/catalog/mode";
import { discriminatesIva, docTypeLabel } from "./legal";
import type { InvoiceAmountRow, InvoiceClass, InvoiceCopy, InvoiceDoc, InvoiceLetter, InvoiceLine } from "./types";

const r2 = (x: number) => Math.round(x * 100) / 100;

export interface FromTicketOptions {
  copy?: InvoiceCopy | null;
  tradeName?: string | null;
  legends?: string[];
  showPayments?: boolean;
  showInternalRef?: boolean;
  /** Comprobante asociado (NC/ND). */
  associated?: InvoiceDoc["associated"];
}

function classOf(label: string): InvoiceClass {
  const l = label.toLowerCase();
  if (l.includes("crédito") || l.includes("credito")) return "nota_credito";
  if (l.includes("débito") || l.includes("debito")) return "nota_debito";
  return "factura";
}

/** "Contado" salvo que se haya cobrado a cuenta corriente. */
export function saleConditionOf(methods: string[]): string {
  if (methods.includes("account")) return methods.length > 1 ? "Contado y cuenta corriente" : "Cuenta corriente";
  return "Contado";
}

export function invoiceFromTicket(data: TicketData, opts: FromTicketOptions = {}): InvoiceDoc {
  const { sale, items, payments, customer, brand } = data;
  const f = fiscalApproved(sale.fiscal) ? sale.fiscal : null;
  const pending = sale.fiscal != null && !f;
  const letter: InvoiceLetter = (f?.letter as InvoiceLetter | null) ?? "X";
  const fiscal = f != null && letter !== "X";
  const discriminates = fiscal && discriminatesIva(letter);

  // Descuentos: una fila por promoción y el resto como "Descuento".
  const promo = ticketPromoLines(sale.discount_total, sale.promotions);
  const discountsGross: InvoiceAmountRow[] = [
    ...promo.promos.filter((p) => p.kind === "discount").map((p) => ({ label: ticketPromoLabel(p), amount: p.amount })),
    ...(promo.otherDiscount > 0 ? [{ label: "Descuento", amount: promo.otherDiscount }] : []),
  ];

  // Factura A: precios netos de IVA (factor sobre el bruto) e IVA discriminado.
  const ivaLines = sale.ivaLines ?? [];
  const ivaSum = ivaLines.reduce((a, l) => a + l.amount, 0);
  const internals = sale.transparency?.others ?? 0;
  const gross = sale.subtotal - sale.discount_total;
  const factor = discriminates && gross > 0 && ivaSum > 0 ? Math.max(0, 1 - (ivaSum + internals) / gross) : 1;
  const singleRate = ivaLines.length === 1 ? ivaLines[0]!.rate : null;

  const lines: InvoiceLine[] = items.map((it, i) => {
    // ADR-116: unidad del servicio y texto debajo del nombre.
    const detailLines = serviceLineBlocks({
      detail: it.line_detail,
      clarifications: it.line_clarifications,
      note: it.line_note,
    });
    return {
      code: String(i + 1).padStart(3, "0"),
      description: it.product_name,
      quantity: it.quantity,
      unit: it.unit_label ? unitLabel(it.unit_label) : "unidad",
      unitPrice: r2(it.unit_price * factor),
      ivaRate: discriminates ? singleRate : null,
      subtotal: r2(it.subtotal * factor),
      ...(detailLines.length > 0 ? { detailLines } : {}),
    };
  });
  const subtotal = r2(lines.reduce((a, l) => a + l.subtotal, 0));
  const discounts = discountsGross.map((d) => ({ ...d, amount: r2(d.amount * factor) }));

  const otherTaxes: InvoiceAmountRow[] = [
    ...(discriminates && internals > 0 ? [{ label: "Impuestos internos", amount: internals }] : []),
    ...(sale.perceptions ?? []).map((p) => ({ label: p.name, amount: p.amount })),
  ];

  const methods = payments.map((p) => p.method);
  const numberParts = f?.numero?.split("-") ?? [];

  const receiverDocType = f?.docTipo != null && f.docTipo !== 99 ? docTypeLabel(f.docTipo) : customer?.document_type ?? null;
  const receiverDocNumber = f?.docNro && f.docNro !== "0" ? f.docNro : customer?.document_number ?? null;

  const dateIso = f?.cbteFch ?? sale.created_at;

  // ADR-116: concepto (el de ARCA si hay factura; si no, por los renglones:
  // los de servicio traen unidad) y período del servicio. Una factura de
  // servicios vieja sin período: el que se informó a ARCA (su fecha).
  const hasServices = items.some((it) => Boolean(it.unit_label));
  const hasGoods = items.some((it) => !it.unit_label);
  const concepto =
    (f?.concepto as 1 | 2 | 3 | null | undefined) ?? (hasServices ? (hasGoods ? 3 : 2) : null);
  const isServiceDoc = concepto === 2 || concepto === 3;
  const servicePeriod = sale.service_from
    ? { from: sale.service_from, to: sale.service_to ?? sale.service_from }
    : isServiceDoc && f
      ? { from: dateIso, to: dateIso }
      : null;
  const paymentDue = sale.payment_due ?? (isServiceDoc && f ? dateIso : null);

  const transparency = !fiscal
    ? null
    : letter === "B"
      ? sale.transparency ?? null
      : letter === "C"
        ? { iva: 0, others: sale.transparency?.others ?? 0 }
        : null;

  return {
    fiscal,
    letter,
    cbteClass: fiscal ? classOf(f!.cbteLabel) : "no_fiscal",
    cbteCode: fiscal ? f!.codigo : null,
    label: fiscal ? f!.cbteLabel : brand?.ticket_title?.trim() || "Comprobante no fiscal",
    ptoVta: fiscal ? numberParts[0] ?? f!.ptoVta ?? "" : "",
    number: fiscal ? numberParts[1] ?? "" : sale.numberLabel,
    date: dateIso,
    concepto,
    servicePeriod: isServiceDoc ? servicePeriod : null,
    paymentDue: isServiceDoc ? paymentDue : null,
    saleCondition: saleConditionOf(methods),
    currency: { code: "ARS" },
    issuer: {
      name: brand?.legal_name?.trim() || "Mi negocio",
      tradeName: opts.tradeName ?? null,
      cuit: brand?.cuit ?? null,
      iibb: brand?.iibb ?? null,
      activityStart: brand?.activity_start ?? null,
      ivaCondition: brand?.iva_condition ?? null,
      address: brand?.address ?? null,
      phone: brand?.phone ?? null,
    },
    receiver: {
      name: customer?.name?.trim() || "Consumidor Final",
      ivaCondition: customer?.iva_condition ?? "consumidor_final",
      docType: receiverDocType,
      docNumber: receiverDocNumber,
      address: customer?.address ?? null,
      email: customer?.email ?? null,
    },
    lines,
    totals: {
      subtotal,
      discounts,
      netTaxed: discriminates ? r2(ivaLines.reduce((a, l) => a + l.base, 0)) : null,
      iva: discriminates ? ivaLines.filter((l) => l.amount > 0 || l.base > 0) : [],
      otherTaxes,
      total: sale.total,
    },
    transparency,
    authorization: f?.cae ? { type: f.emissionType, code: f.cae, due: f.caeVto ?? "" } : null,
    qrUrl: f?.qrUrl ?? null,
    qrFallbackText: `${brand?.legal_name || "NinjaPos"} | ${sale.numberLabel} | ${formatCurrency(sale.total)} | ${new Date(sale.created_at).toLocaleString("es-AR")}`,
    associated: opts.associated ?? [],
    payments:
      opts.showPayments === false
        ? []
        : payments.map((p) => ({ label: PAYMENT_METHOD_LABELS[p.method] ?? p.method, amount: p.amount })),
    footer: brand?.ticket_footer?.trim() || "¡Gracias por su compra!",
    legends: [...(brand?.ticket_legend?.trim() ? [brand.ticket_legend.trim()] : []), ...(opts.legends ?? [])],
    internalRef: opts.showInternalRef === false ? null : fiscal ? sale.numberLabel : null,
    branchText: ticketLocationText(data.location) ?? null,
    voided: sale.status === "voided",
    homologacion: f?.homologacion ?? false,
    pendingAuthorization: pending,
    copy: opts.copy ?? null,
  };
}
