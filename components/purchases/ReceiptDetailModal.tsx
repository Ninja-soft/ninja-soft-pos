"use client";

// Detalle de una recepción de mercadería (F18 · H101 + H102, ADR-050):
// líneas con diferencias y costos, historial, remito imprimible, XLSX, carga
// de la factura del proveedor y costeo de importación (modo profesional).

import { useState } from "react";
import { Calculator, Download, FileText, Printer } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { exportXlsx } from "@/lib/utils/xlsx";
import { webPrintCopies } from "@/lib/print/webPrint";
import {
  RECEIPT_DIFFERENCE_LABEL,
  formatOrderNumber,
  formatReceiptNumber,
  receiptDifference,
} from "@/lib/purchases/orders";
import { formatInvoiceNumber } from "@/lib/purchases/invoices";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useStores } from "@/modules/stock/hooks";
import {
  usePurchaseOrder,
  usePurchasesAccess,
  useReceipt,
  useSupplierInvoices,
  useSuppliers,
} from "@/modules/purchases/hooks";
import type { ReceiptDetail } from "@/modules/purchases/api";
import {
  Info,
  Timeline,
  fmtDate,
  formatMoney,
  storeName,
  supplierName,
} from "./shared";
import { InvoiceFormModal } from "./InvoiceFormModal";
import { LandedCostModal } from "./LandedCostModal";

export function ReceiptDetailModal({
  receiptId,
  onOpenChange,
}: {
  receiptId: string | null;
  onOpenChange: (o: boolean) => void;
}) {
  const { data: r, isLoading } = useReceipt(receiptId);
  const { data: me } = useMyTenant();
  const access = usePurchasesAccess();
  const { data: stores = [] } = useStores();
  const { data: suppliers = [] } = useSuppliers({ includeArchived: true }, Boolean(receiptId));
  const { data: order } = usePurchaseOrder(r?.order_id ?? null);
  const { data: invoices = [] } = useSupplierInvoices(
    { supplierId: r?.supplier_id ?? null, includeVoided: true },
    Boolean(r?.invoice_id),
  );
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [costingOpen, setCostingOpen] = useState(false);

  const canManage = Boolean(me?.canManage);
  const invoice = r?.invoice_id ? invoices.find((i) => i.id === r.invoice_id) : null;
  const foreign = Boolean(r && r.currency !== "ARS");
  const landed = Boolean(r?.items.some((i) => i.landed_unit_cost != null));

  function exportReceipt(rc: ReceiptDetail) {
    void exportXlsx(formatReceiptNumber(rc.number), [
      {
        name: "Recepción",
        title: `Recepción ${formatReceiptNumber(rc.number)} · ${supplierName(suppliers, rc.supplier_id)}`,
        columns: [
          { header: "Producto", key: "producto", width: 32 },
          { header: "SKU", key: "sku", width: 14 },
          { header: "Esperado", key: "esperado", type: "number" },
          { header: "Recibido", key: "recibido", type: "number" },
          { header: "Diferencia", key: "diferencia", type: "number" },
          { header: "Motivo", key: "motivo", width: 18 },
          { header: `Costo unitario (${rc.currency})`, key: "costo", type: "number" },
          { header: "Costo unitario $", key: "costo_ars", type: "money" },
          { header: "Puesto en depósito $", key: "landed", type: "money" },
          { header: "Subtotal $", key: "subtotal", type: "money" },
          { header: "Lote", key: "lote", width: 14 },
          { header: "Vencimiento", key: "vence", width: 12 },
        ],
        rows: rc.items.map((i) => ({
          producto: i.variant_label ? `${i.product_name} (${i.variant_label})` : i.product_name,
          sku: i.sku ?? "",
          esperado: i.qty_expected,
          recibido: i.qty,
          diferencia: i.qty_expected == null ? null : receiptDifference(i.qty_expected, i.qty),
          motivo: i.difference_reason ? RECEIPT_DIFFERENCE_LABEL[i.difference_reason] : "",
          costo: i.unit_cost,
          costo_ars: i.unit_cost_ars,
          landed: i.landed_unit_cost,
          subtotal: i.qty * i.valued_unit_cost,
          lote: i.lot_code ?? "",
          vence: i.expires_on ? fmtDate(i.expires_on) : "",
        })),
        totals: {
          recibido: rc.items.reduce((t, i) => t + i.qty, 0),
          subtotal: rc.items.reduce((t, i) => t + i.qty * i.valued_unit_cost, 0),
        },
      },
    ]);
  }

  return (
    <Modal
      open={Boolean(receiptId)}
      onOpenChange={onOpenChange}
      title={r ? `Recepción ${formatReceiptNumber(r.number)}` : "Recepción"}
      description={r ? `${supplierName(suppliers, r.supplier_id)} · ${storeName(stores, r.store_id)}` : undefined}
      className="sm:max-w-4xl"
    >
      {isLoading || !r ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Cargando...</p>
      ) : (
        <div className="space-y-5">
          <div className="no-print flex flex-wrap gap-2">
            {canManage && !r.invoice_id && r.supplier_id && (
              <Button size="sm" onClick={() => setInvoiceOpen(true)}>
                <FileText size={15} /> Cargar factura
              </Button>
            )}
            {canManage && access.importEnabled && access.pro && (
              <Button size="sm" variant={landed ? "secondary" : "primary"} onClick={() => setCostingOpen(true)}>
                <Calculator size={15} /> Costeo de importación
              </Button>
            )}
            <span className="flex-1" />
            <Button size="sm" variant="secondary" onClick={() => webPrintCopies(1)}>
              <Printer size={15} /> Remito
            </Button>
            <Button size="sm" variant="secondary" onClick={() => exportReceipt(r)}>
              <Download size={15} /> XLSX
            </Button>
          </div>

          <dl className="grid grid-cols-2 gap-3 rounded-xl bg-muted p-3.5 text-sm sm:grid-cols-4">
            <Info label="Fecha" value={fmtDate(r.received_date)} />
            <Info label="Sucursal" value={storeName(stores, r.store_id)} />
            <Info
              label="Orden de compra"
              value={r.order_id ? (order ? formatOrderNumber(order.number) : "Con OC") : "Sin orden"}
            />
            <Info label="Remito del proveedor" value={r.remito_number || "Sin indicar"} />
            {foreign && <Info label="Moneda y tipo de cambio" value={`${r.currency} a ${formatCurrency(r.fx_rate)}`} />}
            <Info label="Unidades" value={formatQty(r.total_units)} />
            <Info label="Valor a costo" value={formatCurrency(r.total_cost)} />
            {r.landed_total != null && (
              <Info label="Costo puesto en depósito" value={formatCurrency(r.landed_total)} />
            )}
            {r.dispatch_number && <Info label="N° de despacho" value={r.dispatch_number} />}
            <Info
              label="Factura"
              value={
                r.invoice_id ? (
                  invoice ? (
                    formatInvoiceNumber(invoice.letter, invoice.point_of_sale, invoice.number)
                  ) : (
                    <Badge tone="success">Facturada</Badge>
                  )
                ) : (
                  <Badge tone="neutral">Sin facturar</Badge>
                )
              }
            />
            {r.notes && <Info label="Notas" value={r.notes} wide />}
          </dl>

          <div className="overflow-x-auto rounded-xl ring-1 ring-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/60 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Producto</th>
                  <th className="px-3 py-2 text-right">Esperado</th>
                  <th className="px-3 py-2 text-right">Recibido</th>
                  <th className="px-3 py-2 text-left">Diferencia</th>
                  <th className="px-3 py-2 text-right">Costo unit.</th>
                  {foreign && <th className="px-3 py-2 text-right">Costo $</th>}
                  {landed && <th className="px-3 py-2 text-right">Puesto en depósito</th>}
                  <th className="px-3 py-2 text-left">Lote</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {r.items.map((i) => {
                  const diff = receiptDifference(i.qty_expected, i.qty);
                  return (
                    <tr key={i.id}>
                      <td className="px-3 py-2">
                        <div className="font-medium">
                          {i.product_name}
                          {i.variant_label ? ` (${i.variant_label})` : ""}
                        </div>
                        {i.sku && <div className="text-xs text-muted-foreground">{i.sku}</div>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {i.qty_expected == null ? "" : formatQty(i.qty_expected)}
                      </td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">
                        {formatQty(i.qty)} {i.unit}
                      </td>
                      <td className="px-3 py-2">
                        {diff !== 0 ? (
                          <span className={diff < 0 ? "text-danger" : "text-warning"}>
                            {diff > 0 ? "+" : ""}
                            {formatQty(diff)}
                            {i.difference_reason ? ` ${RECEIPT_DIFFERENCE_LABEL[i.difference_reason]}` : ""}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Ok</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatMoney(i.unit_cost, r.currency)}</td>
                      {foreign && (
                        <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(i.unit_cost_ars)}</td>
                      )}
                      {landed && (
                        <td className="px-3 py-2 text-right tabular-nums">
                          {i.landed_unit_cost == null ? "" : formatCurrency(i.landed_unit_cost)}
                        </td>
                      )}
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {[i.lot_code, i.expires_on ? `vence ${fmtDate(i.expires_on)}` : null]
                          .filter(Boolean)
                          .join(" · ")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Timeline events={r.events} />

          <ReceiptPrint
            r={r}
            businessName={me?.name ?? ""}
            supplier={supplierName(suppliers, r.supplier_id)}
            store={storeName(stores, r.store_id)}
            orderLabel={r.order_id && order ? formatOrderNumber(order.number) : ""}
          />

          <InvoiceFormModal
            open={invoiceOpen}
            onOpenChange={setInvoiceOpen}
            supplierId={r.supplier_id}
            receiptIds={[r.id]}
            orderId={r.order_id}
          />
          <LandedCostModal receipt={r} open={costingOpen} onOpenChange={setCostingOpen} />
        </div>
      )}
    </Modal>
  );
}

// ── Remito de recepción imprimible (sólo se ve al imprimir) ─────────────────

function ReceiptPrint({
  r,
  businessName,
  supplier,
  store,
  orderLabel,
}: {
  r: ReceiptDetail;
  businessName: string;
  supplier: string;
  store: string;
  orderLabel: string;
}) {
  const total = r.items.reduce((t, i) => t + i.qty, 0);
  return (
    <div className="remito-print hidden print:block">
      <div className="remito-page">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{businessName}</div>
            <div style={{ fontSize: 12 }}>Constancia de recepción de mercadería</div>
            <div style={{ fontSize: 11 }}>Documento no válido como factura</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{formatReceiptNumber(r.number)}</div>
            <div style={{ fontSize: 12 }}>Fecha: {fmtDate(r.received_date)}</div>
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
                <b>Remito del proveedor:</b> {r.remito_number || ""}
              </td>
              <td>
                <b>Orden de compra:</b> {orderLabel}
              </td>
            </tr>
            {r.dispatch_number && (
              <tr>
                <td colSpan={2}>
                  <b>N° de despacho:</b> {r.dispatch_number}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <table
          className="remito-items"
          style={{ width: "100%", marginTop: 12, fontSize: 12, borderCollapse: "collapse" }}
        >
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Producto</th>
              <th style={{ textAlign: "left" }}>SKU</th>
              <th style={{ textAlign: "right" }}>Esperado</th>
              <th style={{ textAlign: "right" }}>Recibido</th>
              <th style={{ textAlign: "left" }}>Diferencia</th>
              <th style={{ textAlign: "left" }}>Lote</th>
            </tr>
          </thead>
          <tbody>
            {r.items.map((i) => {
              const diff = receiptDifference(i.qty_expected, i.qty);
              return (
                <tr key={i.id}>
                  <td>{i.variant_label ? `${i.product_name} (${i.variant_label})` : i.product_name}</td>
                  <td>{i.sku ?? ""}</td>
                  <td style={{ textAlign: "right" }}>{i.qty_expected == null ? "" : formatQty(i.qty_expected)}</td>
                  <td style={{ textAlign: "right" }}>
                    {formatQty(i.qty)} {i.unit}
                  </td>
                  <td>
                    {diff
                      ? `${diff > 0 ? "+" : ""}${formatQty(diff)} ${
                          i.difference_reason ? RECEIPT_DIFFERENCE_LABEL[i.difference_reason] : ""
                        }`
                      : ""}
                  </td>
                  <td>{i.lot_code ?? ""}</td>
                </tr>
              );
            })}
            <tr>
              <td colSpan={3}>
                <b>Total</b>
              </td>
              <td style={{ textAlign: "right" }}>
                <b>{formatQty(total)}</b>
              </td>
              <td colSpan={2} />
            </tr>
          </tbody>
        </table>
        {r.notes && <div style={{ marginTop: 8, fontSize: 12 }}>Notas: {r.notes}</div>}
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 48, fontSize: 12 }}>
          <div style={{ borderTop: "1px solid #000", width: "40%", paddingTop: 4 }}>
            Entregó (firma y aclaración)
          </div>
          <div style={{ borderTop: "1px solid #000", width: "40%", paddingTop: 4 }}>
            Recibió (firma y aclaración)
          </div>
        </div>
      </div>
    </div>
  );
}
