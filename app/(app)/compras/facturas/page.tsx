"use client";

import { useMemo, useState } from "react";
import { Ban, Banknote, Download, FileText, HandCoins, Plus, Receipt } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Segmented } from "@/components/ui/Segmented";
import { EmptyState } from "@/components/ui/EmptyState";
import { Switch } from "@/components/ui/Switch";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { exportXlsx } from "@/lib/utils/xlsx";
import {
  INVOICE_KIND_LABEL,
  formatInvoiceNumber,
  paymentMethodLabel,
} from "@/lib/purchases/invoices";
import { formatPaymentNumber, purchaseErrorMessage } from "@/lib/purchases/orders";
import { AGING_BUCKETS, AGING_LABEL, agingBySupplier, type AgingBucket } from "@/lib/purchases/aging";
import { formatCuit } from "@/lib/purchases/suppliers";
import { useMyTenant } from "@/modules/tenants/hooks";
import {
  usePaymentAllocations,
  usePurchaseMutations,
  usePurchasesAccess,
  useSupplierBalances,
  useSupplierEntries,
  useSupplierInvoices,
  useSupplierPayments,
  useSuppliers,
} from "@/modules/purchases/hooks";
import type { InvoiceRow } from "@/modules/purchases/api";
import {
  ComprasLocked,
  ComprasTabs,
  fmtDate,
  formatMoney,
  inputCls,
  selectCls,
  supplierName,
  today,
} from "@/components/purchases/shared";
import { InvoiceFormModal } from "@/components/purchases/InvoiceFormModal";
import { PaymentFormModal } from "@/components/purchases/PaymentFormModal";
import { PaymentOrderModal } from "@/components/purchases/PaymentOrderModal";
import { PaymentOrderDetailModal } from "@/components/purchases/PaymentOrderDetailModal";

type Tab = "invoices" | "payments" | "balances";

const sign = (i: Pick<InvoiceRow, "kind">) => (i.kind === "credit_note" ? -1 : 1);

// Comprobantes de proveedor, pagos y saldos (F18 · H101, ADR-050).
export default function FacturasPage() {
  const { toast } = useToast();
  const access = usePurchasesAccess();
  const { data: me } = useMyTenant();
  const canManage = Boolean(me?.canManage);
  const m = usePurchaseMutations();
  const [tab, setTab] = useState<Tab>("invoices");
  const [supplierId, setSupplierId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [includeVoided, setIncludeVoided] = useState(false);
  const [invoiceModal, setInvoiceModal] = useState<{ open: boolean; invoice: InvoiceRow | null }>({
    open: false,
    invoice: null,
  });
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [orderOpen, setOrderOpen] = useState(false);
  const [paymentDetail, setPaymentDetail] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<{ type: "invoice" | "payment"; id: string } | null>(null);

  const filters = {
    supplierId: supplierId || null,
    from: from || null,
    to: to || null,
    includeVoided,
  };
  const { data: suppliers = [] } = useSuppliers({ includeArchived: true }, access.enabled);
  const invoicesQ = useSupplierInvoices(filters, access.enabled && tab === "invoices");
  const paymentsQ = useSupplierPayments(filters, access.enabled && tab === "payments");
  const { data: balances = [] } = useSupplierBalances(access.enabled && tab === "balances");
  const entriesQ = useSupplierEntries(null, access.enabled && tab === "balances");
  const { data: allocations = [] } = usePaymentAllocations(access.enabled && tab === "balances");

  const invoices = invoicesQ.data ?? [];
  const payments = paymentsQ.data ?? [];
  const now = today();

  const agingRows = useMemo(() => {
    const by = agingBySupplier(entriesQ.data ?? [], now, allocations);
    return balances
      .filter((b) => Math.abs(b.balance_ars) > 0.004 || by.has(b.supplier_id))
      .filter((b) => !supplierId || b.supplier_id === supplierId)
      .map((b) => ({ b, aging: by.get(b.supplier_id) }))
      .filter((r) => Math.abs(r.b.balance_ars) > 0.004)
      .sort((a, c) => c.b.balance_ars - a.b.balance_ars);
  }, [balances, entriesQ.data, allocations, now, supplierId]);

  const agingTotals = useMemo(() => {
    const t: Record<AgingBucket | "balance", number> = {
      balance: 0,
      current: 0,
      d1_30: 0,
      d31_60: 0,
      d61_90: 0,
      d90_plus: 0,
    };
    for (const r of agingRows) {
      t.balance += r.b.balance_ars;
      for (const k of AGING_BUCKETS) t[k] += r.aging?.buckets[k] ?? 0;
    }
    return t;
  }, [agingRows]);

  const cuitOf = (id: string) => formatCuit(suppliers.find((s) => s.id === id)?.cuit ?? "");

  function exportTab() {
    if (tab === "invoices") {
      const netAt = (i: InvoiceRow, rate: number) =>
        sign(i) * i.vat_lines.filter((l) => Number(l.rate) === rate).reduce((t, l) => t + Number(l.net), 0);
      void exportXlsx("libro-de-compras", [
        {
          name: "Comprobantes",
          title: "Comprobantes de compra",
          columns: [
            { header: "Fecha", key: "fecha", width: 12 },
            { header: "Tipo", key: "tipo", width: 16 },
            { header: "Letra", key: "letra", width: 6 },
            { header: "PV", key: "pv", type: "number" },
            { header: "Número", key: "numero", type: "number" },
            { header: "Proveedor", key: "proveedor", width: 28 },
            { header: "CUIT", key: "cuit", width: 15 },
            { header: "Neto 21 %", key: "n21", type: "money" },
            { header: "Neto 10,5 %", key: "n105", type: "money" },
            { header: "Neto 27 %", key: "n27", type: "money" },
            { header: "Neto otras alícuotas", key: "notros", type: "money" },
            { header: "IVA", key: "iva", type: "money" },
            { header: "Exento", key: "exento", type: "money" },
            { header: "No gravado", key: "nograv", type: "money" },
            { header: "Percepciones y otros", key: "otros", type: "money" },
            { header: "Total", key: "total", type: "money" },
            { header: "Moneda", key: "moneda", width: 8 },
            { header: "Tipo de cambio", key: "tc", type: "number" },
            { header: "Estado", key: "estado", width: 10 },
          ],
          rows: invoices.map((i) => {
            const n21 = netAt(i, 21);
            const n105 = netAt(i, 10.5);
            const n27 = netAt(i, 27);
            return {
              fecha: fmtDate(i.issue_date),
              tipo: INVOICE_KIND_LABEL[i.kind],
              letra: i.letter,
              pv: i.point_of_sale,
              numero: i.number,
              proveedor: supplierName(suppliers, i.supplier_id),
              cuit: cuitOf(i.supplier_id),
              n21,
              n105,
              n27,
              notros: sign(i) * i.net_total - n21 - n105 - n27,
              iva: sign(i) * i.vat_total,
              exento: sign(i) * i.exempt_amount,
              nograv: sign(i) * i.non_taxed_amount,
              otros: sign(i) * i.other_taxes_total,
              total: sign(i) * i.total,
              moneda: i.currency,
              tc: i.fx_rate,
              estado: i.status === "voided" ? "Anulado" : "Vigente",
            };
          }),
        },
      ]);
    } else if (tab === "payments") {
      void exportXlsx("pagos-a-proveedores", [
        {
          name: "Pagos",
          title: "Pagos a proveedores",
          columns: [
            { header: "N°", key: "numero", width: 12 },
            { header: "Fecha", key: "fecha", width: 12 },
            { header: "Proveedor", key: "proveedor", width: 28 },
            { header: "CUIT", key: "cuit", width: 15 },
            { header: "Medio", key: "medio", width: 14 },
            { header: "Referencia", key: "ref", width: 20 },
            { header: "Neto pagado", key: "neto", type: "money" },
            { header: "Retenciones", key: "ret", type: "money" },
            { header: "Total aplicado", key: "total", type: "money" },
            { header: "Moneda", key: "moneda", width: 8 },
            { header: "Tipo de cambio", key: "tc", type: "number" },
            { header: "Estado", key: "estado", width: 10 },
          ],
          rows: payments.map((p) => ({
            numero: formatPaymentNumber(p.number),
            fecha: fmtDate(p.paid_date),
            proveedor: supplierName(suppliers, p.supplier_id),
            cuit: cuitOf(p.supplier_id),
            medio: paymentMethodLabel(p.method),
            ref: p.reference ?? "",
            neto: p.net_paid,
            ret: p.withholdings_total,
            total: p.amount,
            moneda: p.currency,
            tc: p.fx_rate,
            estado: p.status === "voided" ? "Anulado" : "Vigente",
          })),
        },
      ]);
    } else {
      void exportXlsx("saldos-proveedores", [
        {
          name: "Saldos",
          title: `Saldos y antigüedad de deuda al ${fmtDate(now)}`,
          columns: [
            { header: "Proveedor", key: "proveedor", width: 28 },
            { header: "CUIT", key: "cuit", width: 15 },
            { header: "Saldo", key: "saldo", type: "money" },
            ...AGING_BUCKETS.map((k) => ({ header: AGING_LABEL[k], key: k, type: "money" as const })),
          ],
          rows: agingRows.map((r) => ({
            proveedor: supplierName(suppliers, r.b.supplier_id),
            cuit: cuitOf(r.b.supplier_id),
            saldo: r.b.balance_ars,
            ...Object.fromEntries(AGING_BUCKETS.map((k) => [k, r.aging?.buckets[k] ?? 0])),
          })),
          totals: { saldo: agingTotals.balance, ...Object.fromEntries(AGING_BUCKETS.map((k) => [k, agingTotals[k]])) },
        },
      ]);
    }
  }

  async function doVoid(reason: string) {
    if (!voiding) return;
    try {
      if (voiding.type === "invoice") await m.voidInvoice.mutateAsync({ id: voiding.id, reason });
      else await m.voidPayment.mutateAsync({ id: voiding.id, reason });
      toast({ title: voiding.type === "invoice" ? "Comprobante anulado" : "Pago anulado", variant: "success" });
      setVoiding(null);
    } catch (e) {
      toast({ title: "No se pudo anular", description: purchaseErrorMessage(e), variant: "error" });
    }
  }

  const header = (
    <PageHeader
      eyebrow="Compras"
      title="Facturas y pagos"
      icon={Receipt}
      description="Comprobantes de compra, pagos a proveedores y cuánto le debés a cada uno, con la antigüedad de la deuda."
      actions={
        access.enabled ? (
          <>
            {canManage && (
              <Button onClick={() => setInvoiceModal({ open: true, invoice: null })}>
                <Plus size={16} /> Cargar comprobante
              </Button>
            )}
            {canManage && (
              <Button variant="secondary" onClick={() => setOrderOpen(true)}>
                <HandCoins size={16} /> Orden de pago
              </Button>
            )}
            {canManage && (
              <Button variant="secondary" onClick={() => setPaymentOpen(true)}>
                <Banknote size={16} /> Pago simple
              </Button>
            )}
            <Button variant="secondary" onClick={exportTab}>
              <Download size={16} /> XLSX
            </Button>
          </>
        ) : undefined
      }
    />
  );

  if (access.locked) {
    return (
      <PageContainer>
        {header}
        <ComprasTabs />
        <ComprasLocked />
      </PageContainer>
    );
  }

  const loading = !access.ready || (tab === "invoices" ? invoicesQ.isLoading : tab === "payments" ? paymentsQ.isLoading : entriesQ.isLoading);

  return (
    <PageContainer>
      {header}
      <ComprasTabs />

      <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center">
        <Segmented<Tab>
          aria-label="Vista"
          value={tab}
          onChange={setTab}
          size="sm"
          options={[
            { value: "invoices", label: "Comprobantes" },
            { value: "payments", label: "Pagos" },
            { value: "balances", label: "Saldos" },
          ]}
        />
        <div className="grid flex-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <select
            aria-label="Proveedor"
            className={cn(selectCls, "h-10")}
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
          >
            <option value="" className="bg-popover text-popover-foreground">
              Todos los proveedores
            </option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id} className="bg-popover text-popover-foreground">
                {s.name}
              </option>
            ))}
          </select>
          {tab !== "balances" && (
            <>
              <input type="date" aria-label="Desde" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} />
              <input type="date" aria-label="Hasta" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} />
              <label className="flex h-10 items-center gap-2 text-sm">
                <Switch checked={includeVoided} onCheckedChange={setIncludeVoided} label="Incluir anulados" />
                Incluir anulados
              </label>
            </>
          )}
        </div>
      </div>

      <div className="mt-4">
        <TableWrap>
          {tab === "invoices" && (
            <table className="w-full text-sm">
              <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Comprobante</th>
                  <th className="px-4 py-3">Proveedor</th>
                  <th className="hidden px-4 py-3 md:table-cell">Vence</th>
                  <th className="hidden px-4 py-3 text-right lg:table-cell">Neto</th>
                  <th className="hidden px-4 py-3 text-right lg:table-cell">IVA</th>
                  <th className="hidden px-4 py-3 text-right lg:table-cell">Otros</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-2 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {loading && <TableStateRow colSpan={8} loading />}
                {!loading && invoices.length === 0 && (
                  <TableStateRow colSpan={8}>
                    <EmptyState
                      compact
                      icon={FileText}
                      title="Sin comprobantes en esta vista"
                      description="Cargá la factura del proveedor desde acá o desde la recepción que factura."
                    />
                  </TableStateRow>
                )}
                {invoices.map((i) => {
                  const voided = i.status === "voided";
                  const overdue = !voided && i.kind !== "credit_note" && i.due_date != null && i.due_date < now;
                  return (
                    <tr
                      key={i.id}
                      onClick={() => !voided && canManage && setInvoiceModal({ open: true, invoice: i })}
                      className={cn("transition hover:bg-muted/40", !voided && canManage && "cursor-pointer", voided && "opacity-60")}
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium">
                          {INVOICE_KIND_LABEL[i.kind]} {formatInvoiceNumber(i.letter, i.point_of_sale, i.number)}
                        </div>
                        <div className="text-xs text-muted-foreground">{fmtDate(i.issue_date)}</div>
                      </td>
                      <td className="px-4 py-3">
                        {supplierName(suppliers, i.supplier_id)}
                        {voided && (
                          <div className="mt-1">
                            <Badge tone="danger">Anulado</Badge>
                          </div>
                        )}
                      </td>
                      <td className={cn("hidden px-4 py-3 md:table-cell", overdue && "font-semibold text-danger")}>
                        {i.due_date ? fmtDate(i.due_date) : ""}
                      </td>
                      <td className="hidden px-4 py-3 text-right tabular-nums lg:table-cell">
                        {formatMoney(sign(i) * i.net_total, i.currency)}
                      </td>
                      <td className="hidden px-4 py-3 text-right tabular-nums lg:table-cell">
                        {formatMoney(sign(i) * i.vat_total, i.currency)}
                      </td>
                      <td className="hidden px-4 py-3 text-right tabular-nums lg:table-cell">
                        {formatMoney(sign(i) * (i.other_taxes_total + i.exempt_amount + i.non_taxed_amount), i.currency)}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold tabular-nums">
                        {formatMoney(sign(i) * i.total, i.currency)}
                      </td>
                      <td className="px-2 py-3 text-right">
                        {!voided && canManage && (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label="Anular comprobante"
                            className="text-danger"
                            onClick={(e) => {
                              e.stopPropagation();
                              setVoiding({ type: "invoice", id: i.id });
                            }}
                          >
                            <Ban size={14} />
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {tab === "payments" && (
            <table className="w-full text-sm">
              <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Pago</th>
                  <th className="px-4 py-3">Proveedor</th>
                  <th className="hidden px-4 py-3 md:table-cell">Medio</th>
                  <th className="hidden px-4 py-3 text-right lg:table-cell">Neto pagado</th>
                  <th className="hidden px-4 py-3 text-right lg:table-cell">Retenciones</th>
                  <th className="px-4 py-3 text-right">Aplicado</th>
                  <th className="px-2 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {loading && <TableStateRow colSpan={7} loading />}
                {!loading && payments.length === 0 && (
                  <TableStateRow colSpan={7}>
                    <EmptyState
                      compact
                      icon={Banknote}
                      title="Sin pagos en esta vista"
                      description="Registrá lo que le pagaste a cada proveedor para mantener su cuenta corriente al día."
                    />
                  </TableStateRow>
                )}
                {payments.map((p) => {
                  const voided = p.status === "voided";
                  return (
                    <tr
                      key={p.id}
                      onClick={() => setPaymentDetail(p.id)}
                      className={cn("cursor-pointer transition hover:bg-muted/40", voided && "opacity-60")}
                    >
                      <td className="px-4 py-3">
                        <div className="font-mono font-semibold">{formatPaymentNumber(p.number)}</div>
                        <div className="text-xs text-muted-foreground">{fmtDate(p.paid_date)}</div>
                      </td>
                      <td className="px-4 py-3">
                        {supplierName(suppliers, p.supplier_id)}
                        {voided && (
                          <div className="mt-1">
                            <Badge tone="danger">Anulado</Badge>
                          </div>
                        )}
                      </td>
                      <td className="hidden px-4 py-3 md:table-cell">
                        <div>{paymentMethodLabel(p.method)}</div>
                        {p.reference && <div className="text-xs text-muted-foreground">{p.reference}</div>}
                      </td>
                      <td className="hidden px-4 py-3 text-right tabular-nums lg:table-cell">
                        {formatMoney(p.net_paid, p.currency)}
                      </td>
                      <td className="hidden px-4 py-3 text-right tabular-nums lg:table-cell">
                        {formatMoney(p.withholdings_total, p.currency)}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold tabular-nums">
                        {formatMoney(p.amount, p.currency)}
                      </td>
                      <td className="px-2 py-3 text-right">
                        {!voided && canManage && (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label="Anular pago"
                            className="text-danger"
                            onClick={(e) => {
                              e.stopPropagation();
                              setVoiding({ type: "payment", id: p.id });
                            }}
                          >
                            <Ban size={14} />
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {tab === "balances" && (
            <table className="w-full text-sm">
              <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Proveedor</th>
                  <th className="px-4 py-3 text-right">Saldo</th>
                  {AGING_BUCKETS.map((k) => (
                    <th key={k} className="hidden px-4 py-3 text-right md:table-cell">
                      {AGING_LABEL[k]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {loading && <TableStateRow colSpan={7} loading />}
                {!loading && agingRows.length === 0 && (
                  <TableStateRow colSpan={7}>
                    <EmptyState
                      compact
                      icon={Receipt}
                      title="Sin saldos pendientes"
                      description="No le debés nada a ningún proveedor (o todavía no cargaste comprobantes)."
                    />
                  </TableStateRow>
                )}
                {agingRows.map(({ b, aging }) => (
                  <tr key={b.supplier_id}>
                    <td className="px-4 py-3">
                      <div className="font-medium">{supplierName(suppliers, b.supplier_id)}</div>
                      {b.oldest_due && (
                        <div className="text-xs text-muted-foreground">Vencimiento más viejo: {fmtDate(b.oldest_due)}</div>
                      )}
                    </td>
                    <td
                      className={cn(
                        "px-4 py-3 text-right font-semibold tabular-nums",
                        b.balance_ars > 0 ? "text-warning" : "text-success",
                      )}
                    >
                      {formatCurrency(b.balance_ars)}
                      {b.balance_ars < 0 && <div className="text-xs font-normal">a favor</div>}
                    </td>
                    {AGING_BUCKETS.map((k) => (
                      <td
                        key={k}
                        className={cn(
                          "hidden px-4 py-3 text-right tabular-nums md:table-cell",
                          k !== "current" && (aging?.buckets[k] ?? 0) > 0 && "text-danger",
                        )}
                      >
                        {(aging?.buckets[k] ?? 0) ? formatCurrency(aging?.buckets[k] ?? 0) : ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              {agingRows.length > 0 && (
                <tfoot className="bg-muted/40 font-semibold">
                  <tr>
                    <td className="px-4 py-3">Total</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatCurrency(agingTotals.balance)}</td>
                    {AGING_BUCKETS.map((k) => (
                      <td key={k} className="hidden px-4 py-3 text-right tabular-nums md:table-cell">
                        {formatCurrency(agingTotals[k])}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              )}
            </table>
          )}
        </TableWrap>
      </div>

      <InvoiceFormModal
        open={invoiceModal.open}
        onOpenChange={(o) => setInvoiceModal((s) => ({ ...s, open: o }))}
        invoice={invoiceModal.invoice}
        supplierId={null}
      />
      <PaymentFormModal open={paymentOpen} onOpenChange={setPaymentOpen} supplierId={null} />
      <PaymentOrderModal
        open={orderOpen}
        onOpenChange={setOrderOpen}
        supplierId={supplierId || null}
        onCreated={(id) => setPaymentDetail(id)}
      />
      <PaymentOrderDetailModal paymentId={paymentDetail} onOpenChange={(o) => !o && setPaymentDetail(null)} />
      <ConfirmDialog
        open={Boolean(voiding)}
        onOpenChange={(o) => !o && setVoiding(null)}
        title={voiding?.type === "invoice" ? "¿Anular el comprobante?" : "¿Anular el pago?"}
        description={
          voiding?.type === "payment"
            ? "Deja de contar en la cuenta corriente y libera la imputación. Si era una orden de pago, el efectivo vuelve a tu caja abierta, se revierten los movimientos de tesorería y los cheques vuelven a cartera o se anulan. Queda registrado con el motivo; no se borra."
            : "Deja de contar en la cuenta corriente del proveedor. Queda registrado con el motivo; no se borra."
        }
        confirmLabel="Anular"
        danger
        withReason
        reasonPlaceholder="Cargado por error, duplicado..."
        loading={m.voidInvoice.isPending || m.voidPayment.isPending}
        onConfirm={(reason) => void doVoid(reason)}
      />
    </PageContainer>
  );
}
