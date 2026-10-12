"use client";

// Detalle de una orden de compra (F18 · H101, ADR-050): acciones según estado
// y rol, líneas con lo recibido y lo pendiente, recepciones, historial, OC
// imprimible, envío por WhatsApp o mail, XLSX y carga de la factura.

import { useState } from "react";
import {
  Ban,
  Copy,
  Download,
  FileText,
  Lock,
  Mail,
  MessageCircle,
  PackageCheck,
  Pencil,
  Printer,
  Send,
  Undo2,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatQty } from "@/lib/utils/format";
import { exportXlsx } from "@/lib/utils/xlsx";
import { webPrintCopies } from "@/lib/print/webPrint";
import {
  formatDiscounts,
  formatOrderNumber,
  formatReceiptNumber,
  orderActions,
  orderShareText,
  pendingQty,
  purchaseErrorMessage,
  receivedPct,
  type OrderAction,
  type PurchaseRole,
} from "@/lib/purchases/orders";
import { SUPPLIER_IVA_LABEL, formatCuit, whatsappLink } from "@/lib/purchases/suppliers";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useStores } from "@/modules/stock/hooks";
import {
  usePurchaseMutations,
  usePurchaseOrder,
  usePurchasesAccess,
  useSuppliers,
} from "@/modules/purchases/hooks";
import type { OrderDetail, Supplier } from "@/modules/purchases/api";
import { ReceiveModal } from "./ReceiveModal";
import { ReceiptDetailModal } from "./ReceiptDetailModal";
import { InvoiceFormModal } from "./InvoiceFormModal";
import {
  Info,
  OrderStatusBadge,
  Timeline,
  fmtDate,
  formatMoney,
  storeName,
} from "./shared";

const ACTION_META: Record<
  OrderAction,
  { label: string; icon: typeof Send; primary?: boolean; danger?: boolean }
> = {
  edit: { label: "Editar", icon: Pencil },
  send: { label: "Marcar enviada", icon: Send, primary: true },
  reopen: { label: "Volver a borrador", icon: Undo2 },
  receive: { label: "Recibir", icon: PackageCheck, primary: true },
  close: { label: "Cerrar con faltante", icon: Lock },
  cancel: { label: "Cancelar", icon: Ban, danger: true },
};

export function OrderDetailModal({
  orderId,
  onOpenChange,
  onEdit,
}: {
  orderId: string | null;
  onOpenChange: (o: boolean) => void;
  onEdit: (o: OrderDetail) => void;
}) {
  const { toast } = useToast();
  const m = usePurchaseMutations();
  const access = usePurchasesAccess();
  const { data: me } = useMyTenant();
  const { data: o, isLoading } = usePurchaseOrder(orderId);
  const { data: stores = [] } = useStores();
  const { data: suppliers = [] } = useSuppliers({ includeArchived: true }, Boolean(orderId));
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [reasonFor, setReasonFor] = useState<"close" | "cancel" | null>(null);

  const supplier: Supplier | null = o ? (suppliers.find((s) => s.id === o.supplier_id) ?? null) : null;
  const role = (me?.role ?? "viewer") as PurchaseRole;
  const actions = o ? orderActions(o, role, access.settings.cashier_can_receive) : [];
  const busy = m.sendOrder.isPending || m.reopenOrder.isPending;

  async function run(msg: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      toast({ title: msg, variant: "success" });
      return true;
    } catch (e) {
      toast({ title: "No se pudo completar", description: purchaseErrorMessage(e), variant: "error" });
      return false;
    }
  }

  function onAction(a: OrderAction) {
    if (!o) return;
    if (a === "edit") onEdit(o);
    else if (a === "send") void run("Orden marcada como enviada", () => m.sendOrder.mutateAsync(o.id));
    else if (a === "reopen") void run("La orden volvió a borrador", () => m.reopenOrder.mutateAsync(o.id));
    else if (a === "receive") setReceiveOpen(true);
    else setReasonFor(a === "close" ? "close" : "cancel");
  }

  function shareText(): string {
    if (!o) return "";
    return orderShareText({
      number: o.number,
      businessName: me?.name ?? "",
      supplierName: supplier?.name ?? "",
      storeName: storeName(stores, o.store_id),
      expected_date: o.expected_date,
      currency: o.currency,
      notes: o.notes,
      items: o.items,
    });
  }

  function exportOrder() {
    if (!o) return;
    void exportXlsx(formatOrderNumber(o.number), [
      {
        name: "Orden de compra",
        title: `${formatOrderNumber(o.number)} · ${supplier?.name ?? ""}`,
        columns: [
          { header: "Producto", key: "producto", width: 32 },
          { header: "SKU", key: "sku", width: 14 },
          { header: "Cód. proveedor", key: "cod", width: 14 },
          { header: "Unidad", key: "unidad", width: 8 },
          { header: "Pedido", key: "pedido", type: "number" },
          { header: "Recibido", key: "recibido", type: "number" },
          { header: "Pendiente", key: "pendiente", type: "number" },
          { header: `Costo unitario (${o.currency})`, key: "costo", type: "number" },
          { header: "Descuentos", key: "desc", width: 12 },
          { header: "IVA %", key: "iva", type: "number" },
          { header: `Neto (${o.currency})`, key: "neto", type: "number" },
        ],
        rows: o.items.map((i) => ({
          producto: i.variant_label ? `${i.product_name} (${i.variant_label})` : i.product_name,
          sku: i.sku ?? "",
          cod: i.supplier_sku ?? "",
          unidad: i.unit,
          pedido: i.qty_ordered,
          recibido: i.qty_received,
          pendiente: pendingQty(i),
          costo: i.unit_cost,
          desc: formatDiscounts(i.discounts),
          iva: i.tax_rate,
          neto: i.line_net,
        })),
        totals: {
          pedido: o.units_ordered,
          recibido: o.units_received,
          neto: o.subtotal,
        },
      },
    ]);
  }

  const wa = o && supplier ? whatsappLink(supplier.whatsapp ?? supplier.phone, shareText()) : null;
  const mail =
    o && supplier?.email
      ? `mailto:${supplier.email}?subject=${encodeURIComponent(
          `Pedido ${formatOrderNumber(o.number)} de ${me?.name ?? ""}`,
        )}&body=${encodeURIComponent(shareText())}`
      : null;

  const canInvoice =
    Boolean(me?.canManage) && o != null && (o.status === "received" || o.status === "partially_received");

  return (
    <Modal
      open={Boolean(orderId)}
      onOpenChange={onOpenChange}
      title={o ? `Orden ${formatOrderNumber(o.number)}` : "Orden de compra"}
      description={o ? `${supplier?.name ?? ""} · entrega en ${storeName(stores, o.store_id)}` : undefined}
      className="sm:max-w-4xl"
    >
      {isLoading || !o ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Cargando...</p>
      ) : (
        <div className="space-y-5">
          <div className="no-print flex flex-wrap items-center gap-2">
            <OrderStatusBadge status={o.status} />
            {(o.status === "partially_received" || o.status === "received") && (
              <span className="text-xs text-muted-foreground">{receivedPct(o)} % recibido</span>
            )}
          </div>

          <div className="no-print flex flex-wrap gap-2">
            {actions.map((a) => {
              const meta = ACTION_META[a];
              const Icon = meta.icon;
              return (
                <Button
                  key={a}
                  size="sm"
                  variant={meta.primary ? "primary" : meta.danger ? "ghost" : "secondary"}
                  className={cn(meta.danger && "text-danger")}
                  loading={busy && meta.primary && a === "send"}
                  onClick={() => onAction(a)}
                >
                  <Icon size={15} /> {meta.label}
                </Button>
              );
            })}
            {canInvoice && (
              <Button size="sm" variant="secondary" onClick={() => setInvoiceOpen(true)}>
                <FileText size={15} /> Cargar factura
              </Button>
            )}
            <span className="flex-1" />
            <Button size="sm" variant="secondary" onClick={() => webPrintCopies(1)}>
              <Printer size={15} /> Imprimir
            </Button>
            <Button size="sm" variant="secondary" onClick={exportOrder}>
              <Download size={15} /> XLSX
            </Button>
          </div>

          {o.status !== "cancelled" && (
            <div className="no-print flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={!wa}
                title={wa ? undefined : "El proveedor no tiene teléfono cargado"}
                onClick={() => wa && window.open(wa, "_blank", "noopener")}
              >
                <MessageCircle size={15} /> WhatsApp
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!mail}
                title={mail ? undefined : "El proveedor no tiene email cargado"}
                onClick={() => {
                  if (mail) window.location.href = mail;
                }}
              >
                <Mail size={15} /> Email
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(shareText())
                    .then(() => toast({ title: "Pedido copiado", variant: "success" }))
                    .catch(() => toast({ title: "No se pudo copiar", variant: "error" }))
                }
              >
                <Copy size={15} /> Copiar texto
              </Button>
            </div>
          )}

          <dl className="no-print grid grid-cols-2 gap-3 rounded-xl bg-muted p-3.5 text-sm sm:grid-cols-4">
            <Info label="Emitida" value={fmtDate(o.issue_date)} />
            <Info label="Entrega esperada" value={o.expected_date ? fmtDate(o.expected_date) : "Sin fecha"} />
            <Info
              label="Plazo de pago"
              value={o.payment_terms_days ? `${o.payment_terms_days} días` : "Contado"}
            />
            <Info label="Total estimado" value={formatMoney(o.total, o.currency)} />
            {o.currency !== "ARS" && (
              <Info label="Moneda y tipo de cambio" value={`${o.currency} a ${formatMoney(o.fx_rate)}`} />
            )}
            {o.notes && <Info label="Notas" value={o.notes} wide />}
            {o.close_reason && <Info label="Cierre" value={o.close_reason} wide />}
            {o.cancel_reason && <Info label="Motivo de cancelación" value={o.cancel_reason} wide />}
          </dl>

          <div className="no-print overflow-x-auto rounded-xl ring-1 ring-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/60 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Producto</th>
                  <th className="px-3 py-2 text-right">Pedido</th>
                  <th className="px-3 py-2 text-right">Recibido</th>
                  <th className="px-3 py-2 text-right">Pendiente</th>
                  <th className="px-3 py-2 text-right">Costo</th>
                  <th className="px-3 py-2 text-right">Desc.</th>
                  <th className="px-3 py-2 text-right">Neto</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {o.items.map((i) => {
                  const pend = pendingQty(i);
                  return (
                    <tr key={i.id}>
                      <td className="px-3 py-2">
                        <div className="font-medium">
                          {i.product_name}
                          {i.variant_label ? ` (${i.variant_label})` : ""}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {[i.supplier_sku && `Cód. prov. ${i.supplier_sku}`, i.sku].filter(Boolean).join(" · ")}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">
                        {formatQty(i.qty_ordered)} {i.unit}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{formatQty(i.qty_received)}</td>
                      <td
                        className={cn(
                          "px-3 py-2 text-right font-mono tabular-nums",
                          pend > 0 && o.status !== "draft" && "text-warning",
                        )}
                      >
                        {formatQty(pend)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">
                        {formatMoney(i.unit_cost, o.currency)}
                      </td>
                      <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                        {i.discounts.length ? `${formatDiscounts(i.discounts)} %` : ""}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">
                        {formatMoney(i.line_net, o.currency)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="no-print ml-auto max-w-xs space-y-1 text-sm">
            <Row label="Subtotal" value={formatMoney(o.subtotal, o.currency)} />
            {o.discount_total > 0 && (
              <Row
                label={`Descuento ${String(o.discount_pct).replace(".", ",")} %`}
                value={`-${formatMoney(o.discount_total, o.currency)}`}
              />
            )}
            <Row label="Neto" value={formatMoney(o.net_total, o.currency)} />
            <Row label="IVA estimado" value={formatMoney(o.tax_total, o.currency)} />
            <Row label="Total" value={formatMoney(o.total, o.currency)} strong />
          </div>

          {o.receipts.length > 0 && (
            <div className="no-print">
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Recepciones
              </h4>
              <ul className="divide-y divide-border overflow-hidden rounded-xl ring-1 ring-border">
                {o.receipts.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setReceiptId(r.id)}
                      className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm transition hover:bg-muted"
                    >
                      <span>
                        <span className="font-mono font-semibold">{formatReceiptNumber(r.number)}</span>
                        <span className="text-muted-foreground">
                          {" "}
                          · {fmtDate(r.received_date)}
                          {r.remito_number ? ` · remito ${r.remito_number}` : ""}
                        </span>
                      </span>
                      <span className="font-mono tabular-nums">{formatQty(r.total_units)} u</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="no-print">
            <Timeline events={o.events} />
          </div>

          <OrderPrint o={o} supplier={supplier} businessName={me?.name ?? ""} store={storeName(stores, o.store_id)} />
        </div>
      )}

      <ReceiveModal
        open={receiveOpen}
        onOpenChange={setReceiveOpen}
        orderId={o?.id ?? null}
        onDone={(id) => setReceiptId(id)}
      />
      <ReceiptDetailModal receiptId={receiptId} onOpenChange={(v) => !v && setReceiptId(null)} />
      {o && (
        <InvoiceFormModal
          open={invoiceOpen}
          onOpenChange={setInvoiceOpen}
          supplierId={o.supplier_id}
          orderId={o.id}
          receiptIds={o.receipts.filter((r) => !r.invoice_id).map((r) => r.id)}
        />
      )}
      <ConfirmDialog
        open={reasonFor !== null}
        onOpenChange={(v) => !v && setReasonFor(null)}
        title={reasonFor === "close" ? "¿Cerrar la orden con faltante?" : "¿Cancelar la orden?"}
        description={
          reasonFor === "close"
            ? "Lo que falta recibir no se espera más. Lo recibido queda como está."
            : "La orden queda cancelada y no se puede recibir."
        }
        confirmLabel={reasonFor === "close" ? "Cerrar orden" : "Cancelar orden"}
        danger={reasonFor === "cancel"}
        withReason
        loading={m.closeOrder.isPending || m.cancelOrder.isPending}
        onConfirm={(reason) => {
          if (!o) return;
          const fn =
            reasonFor === "close"
              ? () => m.closeOrder.mutateAsync({ id: o.id, reason })
              : () => m.cancelOrder.mutateAsync({ id: o.id, reason });
          void run(reasonFor === "close" ? "Orden cerrada" : "Orden cancelada", fn).then((ok) => {
            if (ok) setReasonFor(null);
          });
        }}
      />
    </Modal>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn("flex justify-between gap-3", strong && "border-t border-border pt-1 font-semibold")}>
      <span className={cn(!strong && "text-muted-foreground")}>{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </div>
  );
}

// ── OC imprimible (sólo se ve al imprimir) ──────────────────────────────────

function OrderPrint({
  o,
  supplier,
  businessName,
  store,
}: {
  o: OrderDetail;
  supplier: Supplier | null;
  businessName: string;
  store: string;
}) {
  const cell = { padding: "2px 4px" } as const;
  return (
    <div className="remito-print hidden print:block">
      <div className="remito-page">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{businessName}</div>
            <div style={{ fontSize: 12 }}>Orden de compra</div>
            <div style={{ fontSize: 11 }}>Documento no válido como factura</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{formatOrderNumber(o.number)}</div>
            <div style={{ fontSize: 12 }}>Fecha: {fmtDate(o.issue_date)}</div>
            {o.expected_date && <div style={{ fontSize: 12 }}>Entrega: {fmtDate(o.expected_date)}</div>}
          </div>
        </div>
        <table style={{ width: "100%", marginTop: 12, fontSize: 12 }}>
          <tbody>
            <tr>
              <td>
                <b>Proveedor:</b> {supplier?.name ?? ""}
              </td>
              <td>
                <b>CUIT:</b> {supplier?.cuit ? formatCuit(supplier.cuit) : ""}
              </td>
            </tr>
            <tr>
              <td>
                <b>Condición IVA:</b> {supplier ? SUPPLIER_IVA_LABEL[supplier.iva_condition] : ""}
              </td>
              <td>
                <b>Entregar en:</b> {store}
              </td>
            </tr>
            <tr>
              <td>
                <b>Plazo de pago:</b> {o.payment_terms_days ? `${o.payment_terms_days} días` : "Contado"}
              </td>
              <td>
                <b>Moneda:</b> {o.currency}
              </td>
            </tr>
          </tbody>
        </table>
        <table
          className="remito-items"
          style={{ width: "100%", marginTop: 12, fontSize: 12, borderCollapse: "collapse" }}
        >
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Cód. prov.</th>
              <th style={{ textAlign: "left" }}>Producto</th>
              <th style={{ textAlign: "right" }}>Cantidad</th>
              <th style={{ textAlign: "right" }}>Costo unit.</th>
              <th style={{ textAlign: "right" }}>Desc.</th>
              <th style={{ textAlign: "right" }}>Neto</th>
            </tr>
          </thead>
          <tbody>
            {o.items.map((i) => (
              <tr key={i.id}>
                <td style={cell}>{i.supplier_sku ?? ""}</td>
                <td style={cell}>
                  {i.product_name}
                  {i.variant_label ? ` (${i.variant_label})` : ""}
                </td>
                <td style={{ ...cell, textAlign: "right" }}>
                  {formatQty(i.qty_ordered)} {i.unit}
                </td>
                <td style={{ ...cell, textAlign: "right" }}>{formatMoney(i.unit_cost, o.currency)}</td>
                <td style={{ ...cell, textAlign: "right" }}>
                  {i.discounts.length ? `${formatDiscounts(i.discounts)} %` : ""}
                </td>
                <td style={{ ...cell, textAlign: "right" }}>{formatMoney(i.line_net, o.currency)}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={5} style={{ ...cell, textAlign: "right" }}>
                Subtotal
              </td>
              <td style={{ ...cell, textAlign: "right" }}>{formatMoney(o.subtotal, o.currency)}</td>
            </tr>
            {o.discount_total > 0 && (
              <tr>
                <td colSpan={5} style={{ ...cell, textAlign: "right" }}>
                  Descuento {String(o.discount_pct).replace(".", ",")} %
                </td>
                <td style={{ ...cell, textAlign: "right" }}>-{formatMoney(o.discount_total, o.currency)}</td>
              </tr>
            )}
            <tr>
              <td colSpan={5} style={{ ...cell, textAlign: "right" }}>
                IVA estimado
              </td>
              <td style={{ ...cell, textAlign: "right" }}>{formatMoney(o.tax_total, o.currency)}</td>
            </tr>
            <tr>
              <td colSpan={5} style={{ ...cell, textAlign: "right" }}>
                <b>Total</b>
              </td>
              <td style={{ ...cell, textAlign: "right" }}>
                <b>{formatMoney(o.total, o.currency)}</b>
              </td>
            </tr>
          </tbody>
        </table>
        {o.notes && (
          <div style={{ marginTop: 12, fontSize: 12 }}>
            <b>Notas:</b> {o.notes}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 48, fontSize: 12 }}>
          <div style={{ borderTop: "1px solid #000", width: "40%", paddingTop: 4 }}>Autorizó (firma y aclaración)</div>
        </div>
      </div>
    </div>
  );
}
