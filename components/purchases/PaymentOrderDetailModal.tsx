"use client";

// Detalle de un pago u orden de pago (F18 · ADR-059): medios, imputación,
// retenciones con certificado, historial y orden de pago imprimible.

import { Printer } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { formatCurrency } from "@/lib/utils/format";
import { webPrintCopies } from "@/lib/print/webPrint";
import {
  WITHHOLDING_LABEL,
  formatInvoiceNumber,
  paymentMethodLabel,
  type WithholdingKind,
} from "@/lib/purchases/invoices";
import { formatPaymentNumber } from "@/lib/purchases/orders";
import { PAYMENT_LINE_METHOD_LABEL, amountInWords } from "@/lib/purchases/paymentOrders";
import { formatCuit } from "@/lib/purchases/suppliers";
import { useMyTenant } from "@/modules/tenants/hooks";
import { usePaymentOrder, useSupplierInvoices, useSuppliers, useTreasuryEnabled } from "@/modules/purchases/hooks";
import { useCheques, useTreasuryAccounts } from "@/modules/treasury/hooks";
import type { PaymentOrderDetail } from "@/modules/purchases/api";
import { PaymentRetentionCertificates } from "@/components/tax/RetentionCertificates";
import { Info, Timeline, fmtDate, formatMoney } from "./shared";

export function PaymentOrderDetailModal({
  paymentId,
  onOpenChange,
}: {
  paymentId: string | null;
  onOpenChange: (o: boolean) => void;
}) {
  const { data: p, isLoading } = usePaymentOrder(paymentId);
  const { data: me } = useMyTenant();
  const treasury = useTreasuryEnabled();
  const { data: suppliers = [] } = useSuppliers({ includeArchived: true }, Boolean(paymentId));
  const { data: invoices = [] } = useSupplierInvoices(
    { supplierId: p?.supplier_id ?? null, includeVoided: true },
    Boolean(p?.supplier_id),
  );
  const { data: accounts = [] } = useTreasuryAccounts({ includeArchived: true }, Boolean(paymentId) && treasury);
  const { data: cheques = [] } = useCheques({}, Boolean(paymentId) && treasury);

  const supplier = suppliers.find((s) => s.id === p?.supplier_id) ?? null;
  const invLabel = (id: string) => {
    const i = invoices.find((x) => x.id === id);
    return i ? `${i.kind === "debit_note" ? "ND" : "FC"} ${formatInvoiceNumber(i.letter, i.point_of_sale, i.number)}` : "Comprobante";
  };
  const lineDetail = (l: PaymentOrderDetail["lines"][number]) => {
    const parts: string[] = [];
    const acc = accounts.find((a) => a.id === l.treasury_account_id);
    if (acc) parts.push(acc.name);
    const ch = cheques.find((c) => c.id === l.cheque_id);
    if (ch) parts.push(`N° ${ch.number}${ch.bank_name ? ` ${ch.bank_name}` : ""}, paga ${fmtDate(ch.payment_date)}`);
    if (l.reference) parts.push(l.reference);
    if (l.method === "efectivo") parts.push("Caja propia");
    return parts.join(" · ");
  };
  const allocs = (p?.allocations ?? []).filter((a) => !a.released_at);
  const allocated = allocs.reduce((t, a) => t + a.amount, 0);

  return (
    <Modal
      open={Boolean(paymentId)}
      onOpenChange={onOpenChange}
      title={p ? `${p.kind === "order" ? "Orden de pago" : "Pago"} ${formatPaymentNumber(p.number)}` : "Pago"}
      description={supplier?.name}
      className="sm:max-w-3xl"
    >
      {isLoading || !p ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Cargando...</p>
      ) : (
        <div className="space-y-5">
          <div className="no-print flex flex-wrap items-center gap-2">
            {p.status === "voided" && <Badge tone="danger">Anulado: {p.void_reason}</Badge>}
            <span className="flex-1" />
            <Button size="sm" variant="secondary" onClick={() => webPrintCopies(1)}>
              <Printer size={15} /> Imprimir orden de pago
            </Button>
          </div>

          <dl className="grid grid-cols-2 gap-3 rounded-md bg-muted p-3.5 text-sm sm:grid-cols-4">
            <Info label="Fecha" value={fmtDate(p.paid_date)} />
            <Info label="Medio" value={paymentMethodLabel(p.method)} />
            <Info label="Neto pagado" value={formatMoney(p.net_paid, p.currency)} />
            <Info label="Retenciones" value={formatMoney(p.withholdings_total, p.currency)} />
            <Info label="Total aplicado" value={formatMoney(p.amount, p.currency)} />
            <Info label="Imputado" value={formatCurrency(allocated)} />
            <Info label="A cuenta" value={formatCurrency(Math.max(p.amount * p.fx_rate - allocated, 0))} />
            {p.notes && <Info label="Notas" value={p.notes} wide />}
          </dl>

          {p.lines.length > 0 && (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/60 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Medio</th>
                    <th className="px-3 py-2 text-left">Detalle</th>
                    <th className="px-3 py-2 text-right">Importe</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {p.lines.map((l) => (
                    <tr key={l.id}>
                      <td className="px-3 py-2 font-medium">{PAYMENT_LINE_METHOD_LABEL[l.method]}</td>
                      <td className="px-3 py-2 text-muted-foreground">{lineDetail(l)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {allocs.length > 0 && (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/60 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Comprobante imputado</th>
                    <th className="px-3 py-2 text-right">Importe</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {allocs.map((a) => (
                    <tr key={a.id}>
                      <td className="px-3 py-2">{invLabel(a.invoice_id)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(a.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {p.withholdings.length > 0 && (
            <ul className="space-y-1 text-sm">
              {p.withholdings.map((w, i) => (
                <li key={i} className="flex justify-between gap-2 rounded-md bg-muted/50 px-3 py-2">
                  <span>
                    {WITHHOLDING_LABEL[w.kind as WithholdingKind] ?? w.kind}
                    {w.certificate ? ` · certificado ${w.certificate}` : ""}
                  </span>
                  <span className="tabular-nums">{formatCurrency(Number(w.amount))}</span>
                </li>
              ))}
            </ul>
          )}

          <PaymentRetentionCertificates paymentId={p.id} />

          <Timeline events={p.events} />

          <PaymentOrderPrint
            p={p}
            businessName={me?.name ?? ""}
            supplierName={supplier?.name ?? ""}
            supplierCuit={supplier?.cuit ? formatCuit(supplier.cuit) : ""}
            lineDetail={lineDetail}
            invLabel={invLabel}
          />
        </div>
      )}
    </Modal>
  );
}

// ── Orden de pago imprimible (sólo se ve al imprimir) ───────────────────────

function PaymentOrderPrint({
  p,
  businessName,
  supplierName,
  supplierCuit,
  lineDetail,
  invLabel,
}: {
  p: PaymentOrderDetail;
  businessName: string;
  supplierName: string;
  supplierCuit: string;
  lineDetail: (l: PaymentOrderDetail["lines"][number]) => string;
  invLabel: (id: string) => string;
}) {
  const allocs = p.allocations.filter((a) => !a.released_at);
  const cell = { padding: "2px 4px" } as const;
  return (
    <div className="remito-print hidden print:block">
      <div className="remito-page">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{businessName}</div>
            <div style={{ fontSize: 12 }}>Orden de pago</div>
            <div style={{ fontSize: 11 }}>Documento no válido como factura</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{formatPaymentNumber(p.number)}</div>
            <div style={{ fontSize: 12 }}>Fecha: {fmtDate(p.paid_date)}</div>
            {p.status === "voided" && <div style={{ fontSize: 12, fontWeight: 700 }}>ANULADA</div>}
          </div>
        </div>
        <table style={{ width: "100%", marginTop: 12, fontSize: 12 }}>
          <tbody>
            <tr>
              <td>
                <b>Proveedor:</b> {supplierName}
              </td>
              <td>
                <b>CUIT:</b> {supplierCuit}
              </td>
            </tr>
          </tbody>
        </table>

        {allocs.length > 0 && (
          <table className="remito-items" style={{ width: "100%", marginTop: 12, fontSize: 12, borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", ...cell }}>Comprobantes que se cancelan</th>
                <th style={{ textAlign: "right", ...cell }}>Importe</th>
              </tr>
            </thead>
            <tbody>
              {allocs.map((a) => (
                <tr key={a.id}>
                  <td style={cell}>{invLabel(a.invoice_id)}</td>
                  <td style={{ textAlign: "right", ...cell }}>{formatCurrency(a.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <table className="remito-items" style={{ width: "100%", marginTop: 12, fontSize: 12, borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", ...cell }}>Medio de pago</th>
              <th style={{ textAlign: "left", ...cell }}>Detalle</th>
              <th style={{ textAlign: "right", ...cell }}>Importe</th>
            </tr>
          </thead>
          <tbody>
            {p.lines.length === 0 && (
              <tr>
                <td style={cell}>{paymentMethodLabel(p.method)}</td>
                <td style={cell}>{p.reference ?? ""}</td>
                <td style={{ textAlign: "right", ...cell }}>{formatMoney(p.net_paid, p.currency)}</td>
              </tr>
            )}
            {p.lines.map((l) => (
              <tr key={l.id}>
                <td style={cell}>{PAYMENT_LINE_METHOD_LABEL[l.method]}</td>
                <td style={cell}>{lineDetail(l)}</td>
                <td style={{ textAlign: "right", ...cell }}>{formatCurrency(l.amount)}</td>
              </tr>
            ))}
            {p.withholdings.map((w, i) => (
              <tr key={`w${i}`}>
                <td style={cell}>{WITHHOLDING_LABEL[w.kind as WithholdingKind] ?? w.kind}</td>
                <td style={cell}>{w.certificate ? `Certificado ${w.certificate}` : ""}</td>
                <td style={{ textAlign: "right", ...cell }}>{formatCurrency(Number(w.amount))}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={2} style={cell}>
                <b>Total</b>
              </td>
              <td style={{ textAlign: "right", ...cell }}>
                <b>{formatMoney(p.amount, p.currency)}</b>
              </td>
            </tr>
          </tbody>
        </table>
        <div style={{ marginTop: 8, fontSize: 12 }}>
          Son pesos {amountInWords(p.amount)}.
        </div>
        {p.notes && <div style={{ marginTop: 6, fontSize: 12 }}>Notas: {p.notes}</div>}
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 48, fontSize: 12 }}>
          <div style={{ borderTop: "1px solid #000", width: "40%", paddingTop: 4 }}>Autorizó (firma y aclaración)</div>
          <div style={{ borderTop: "1px solid #000", width: "40%", paddingTop: 4 }}>
            Recibí conforme (firma, aclaración y DNI)
          </div>
        </div>
      </div>
    </div>
  );
}
