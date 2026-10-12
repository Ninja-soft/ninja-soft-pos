"use client";

// Detalle de una devolución a proveedor (F18 · ADR-059): líneas con el costo
// promedio antes y después, nota de crédito (vincular o desvincular),
// historial y constancia imprimible.

import { useState } from "react";
import { Link2, Printer, Unlink } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { webPrintCopies } from "@/lib/print/webPrint";
import { formatInvoiceNumber } from "@/lib/purchases/invoices";
import { formatReceiptNumber, purchaseErrorMessage } from "@/lib/purchases/orders";
import { RETURN_REASON_LABEL, formatReturnNumber } from "@/lib/purchases/returns";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useStores } from "@/modules/stock/hooks";
import {
  usePurchaseReturn,
  usePurchaseReturns,
  usePurchaseV2Mutations,
  useReceipts,
  useSupplierInvoices,
  useSuppliers,
} from "@/modules/purchases/hooks";
import type { ReturnDetail } from "@/modules/purchases/api";
import { Info, Timeline, fmtDate, selectCls, storeName, supplierName } from "./shared";

export function ReturnDetailModal({
  returnId,
  onOpenChange,
}: {
  returnId: string | null;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const { data: r, isLoading } = usePurchaseReturn(returnId);
  const { data: me } = useMyTenant();
  const canManage = Boolean(me?.canManage);
  const m = usePurchaseV2Mutations();
  const { data: stores = [] } = useStores();
  const { data: suppliers = [] } = useSuppliers({ includeArchived: true }, Boolean(returnId));
  const { data: invoices = [] } = useSupplierInvoices(
    { supplierId: r?.supplier_id ?? null, includeVoided: true },
    Boolean(r?.supplier_id),
  );
  const { data: siblings = [] } = usePurchaseReturns({ supplierId: r?.supplier_id ?? null }, Boolean(r?.supplier_id));
  const { data: receipts = [] } = useReceipts({ supplierId: r?.supplier_id ?? null }, Boolean(r?.receipt_id));
  const [pick, setPick] = useState("");

  const credit = r?.credit_invoice_id ? invoices.find((i) => i.id === r.credit_invoice_id) : null;
  const used = new Set(siblings.map((x) => x.credit_invoice_id).filter(Boolean));
  const linkable = invoices.filter((i) => i.kind === "credit_note" && i.status === "posted" && !used.has(i.id));
  const receipt = r?.receipt_id ? receipts.find((x) => x.id === r.receipt_id) : null;

  async function link(invoiceId: string | null) {
    if (!r) return;
    try {
      await m.linkReturnCredit.mutateAsync({ returnId: r.id, invoiceId });
      toast({ title: invoiceId ? "Nota de crédito vinculada" : "Nota de crédito desvinculada", variant: "success" });
      setPick("");
    } catch (e) {
      toast({ title: "No se pudo actualizar", description: purchaseErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={Boolean(returnId)}
      onOpenChange={onOpenChange}
      title={r ? `Devolución ${formatReturnNumber(r.number)}` : "Devolución"}
      description={r ? `${supplierName(suppliers, r.supplier_id)} · ${storeName(stores, r.store_id)}` : undefined}
      className="sm:max-w-3xl"
    >
      {isLoading || !r ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Cargando...</p>
      ) : (
        <div className="space-y-5">
          <div className="no-print flex flex-wrap items-center gap-2">
            {credit ? (
              <Badge tone="success">NC {formatInvoiceNumber(credit.letter, credit.point_of_sale, credit.number)}</Badge>
            ) : (
              <Badge tone="warning">NC pendiente</Badge>
            )}
            <span className="flex-1" />
            <Button size="sm" variant="secondary" onClick={() => webPrintCopies(1)}>
              <Printer size={15} /> Constancia
            </Button>
          </div>

          <dl className="grid grid-cols-2 gap-3 rounded-md bg-muted p-3.5 text-sm sm:grid-cols-4">
            <Info label="Fecha" value={fmtDate(r.return_date)} />
            <Info label="Motivo" value={RETURN_REASON_LABEL[r.reason]} />
            <Info label="Recepción" value={receipt ? formatReceiptNumber(receipt.number) : r.receipt_id ? "Con recepción" : "Libre"} />
            <Info label="Valor a costo" value={formatCurrency(r.total_cost)} />
            {r.notes && <Info label="Notas" value={r.notes} wide />}
          </dl>

          {canManage && (
            <div className="no-print rounded-md bg-muted/50 p-3 text-sm">
              {credit ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    La nota de crédito por {formatCurrency(credit.total * credit.fx_rate)} ya acredita en la cuenta
                    corriente del proveedor.
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => void link(null)} loading={m.linkReturnCredit.isPending}>
                    <Unlink size={14} /> Desvincular
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex-1">
                    {linkable.length
                      ? "Vinculá la nota de crédito que te mandó el proveedor:"
                      : "Cuando llegue la nota de crédito, cargala en Facturas y pagos y vinculala acá."}
                  </span>
                  {linkable.length > 0 && (
                    <>
                      <select
                        aria-label="Nota de crédito"
                        className={cn(selectCls, "h-9 w-auto")}
                        value={pick}
                        onChange={(e) => setPick(e.target.value)}
                      >
                        <option value="" className="bg-popover text-popover-foreground">
                          Elegí la NC
                        </option>
                        {linkable.map((i) => (
                          <option key={i.id} value={i.id} className="bg-popover text-popover-foreground">
                            {formatInvoiceNumber(i.letter, i.point_of_sale, i.number)} · {formatCurrency(i.total * i.fx_rate)}
                          </option>
                        ))}
                      </select>
                      <Button size="sm" disabled={!pick} onClick={() => void link(pick)} loading={m.linkReturnCredit.isPending}>
                        <Link2 size={14} /> Vincular
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/60 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Producto</th>
                  <th className="px-3 py-2 text-right">Cantidad</th>
                  <th className="px-3 py-2 text-right">Costo unit.</th>
                  <th className="hidden px-3 py-2 text-right sm:table-cell">Promedio antes</th>
                  <th className="hidden px-3 py-2 text-right sm:table-cell">Promedio después</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {r.items.map((i) => (
                  <tr key={i.id}>
                    <td className="px-3 py-2">
                      <div className="font-medium">
                        {i.product_name}
                        {i.variant_label ? ` (${i.variant_label})` : ""}
                      </div>
                      {i.sku && <div className="text-xs text-muted-foreground">{i.sku}</div>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatQty(i.qty)} {i.unit}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(i.unit_cost_ars)}</td>
                    <td className="hidden px-3 py-2 text-right tabular-nums text-muted-foreground sm:table-cell">
                      {i.avg_before == null ? "" : formatCurrency(i.avg_before)}
                    </td>
                    <td className="hidden px-3 py-2 text-right tabular-nums sm:table-cell">
                      {i.avg_after == null ? "" : formatCurrency(i.avg_after)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Timeline events={r.events} />

          <ReturnPrint
            r={r}
            businessName={me?.name ?? ""}
            supplier={supplierName(suppliers, r.supplier_id)}
            store={storeName(stores, r.store_id)}
            receiptLabel={receipt ? formatReceiptNumber(receipt.number) : ""}
          />
        </div>
      )}
    </Modal>
  );
}

function ReturnPrint({
  r,
  businessName,
  supplier,
  store,
  receiptLabel,
}: {
  r: ReturnDetail;
  businessName: string;
  supplier: string;
  store: string;
  receiptLabel: string;
}) {
  return (
    <div className="remito-print hidden print:block">
      <div className="remito-page">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{businessName}</div>
            <div style={{ fontSize: 12 }}>Constancia de devolución de mercadería al proveedor</div>
            <div style={{ fontSize: 11 }}>Documento no válido como factura</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{formatReturnNumber(r.number)}</div>
            <div style={{ fontSize: 12 }}>Fecha: {fmtDate(r.return_date)}</div>
          </div>
        </div>
        <table style={{ width: "100%", marginTop: 12, fontSize: 12 }}>
          <tbody>
            <tr>
              <td>
                <b>Proveedor:</b> {supplier}
              </td>
              <td>
                <b>Sucursal:</b> {store}
              </td>
            </tr>
            <tr>
              <td>
                <b>Motivo:</b> {RETURN_REASON_LABEL[r.reason]}
              </td>
              <td>
                <b>Recepción:</b> {receiptLabel}
              </td>
            </tr>
          </tbody>
        </table>
        <table className="remito-items" style={{ width: "100%", marginTop: 12, fontSize: 12, borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Producto</th>
              <th style={{ textAlign: "left" }}>SKU</th>
              <th style={{ textAlign: "right" }}>Cantidad</th>
            </tr>
          </thead>
          <tbody>
            {r.items.map((i) => (
              <tr key={i.id}>
                <td>{i.variant_label ? `${i.product_name} (${i.variant_label})` : i.product_name}</td>
                <td>{i.sku ?? ""}</td>
                <td style={{ textAlign: "right" }}>
                  {formatQty(i.qty)} {i.unit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {r.notes && <div style={{ marginTop: 8, fontSize: 12 }}>Notas: {r.notes}</div>}
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 48, fontSize: 12 }}>
          <div style={{ borderTop: "1px solid #000", width: "40%", paddingTop: 4 }}>Entregó (firma y aclaración)</div>
          <div style={{ borderTop: "1px solid #000", width: "40%", paddingTop: 4 }}>
            Recibió el proveedor (firma y aclaración)
          </div>
        </div>
      </div>
    </div>
  );
}
