"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, FileText, Receipt, ShieldAlert, Upload } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { selectCls } from "@/components/stock/transfers/shared";
import { formatCurrency } from "@/lib/utils/format";
import {
  INVOICE_STATUS_LABELS,
  invoiceStatusTone,
  mlErrorMessage,
  orderNet,
  orderStatusLabel,
  orderStatusTone,
} from "@/lib/mercadolibre/labels";
import { useMlMutations, useMlOrders, type MlOrder } from "@/modules/mercadolibre/hooks";

function when(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
}

/** Un carrito (pack) es una sola venta del POS: se agrupan sus órdenes. */
function groupByPack(orders: MlOrder[]): MlOrder[][] {
  const map = new Map<string, MlOrder[]>();
  for (const o of orders) {
    const k = `${o.account_id}:${o.pack_key}`;
    map.set(k, [...(map.get(k) ?? []), o]);
  }
  return [...map.values()];
}

export function MlOrdersTab({ accountId }: { accountId: string }) {
  const { toast } = useToast();
  const { data: orders = [], isLoading } = useMlOrders(accountId);
  const { invoice, retryUpload } = useMlMutations();
  const [filter, setFilter] = useState("");

  const packs = useMemo(() => {
    const groups = groupByPack(orders);
    return groups.filter((g) => {
      if (!filter) return true;
      if (filter === "review") return g.some((o) => o.needs_review || o.fraud_risk);
      if (filter === "invoice") return g.some((o) => ["pending", "error"].includes(o.invoice_status));
      return g.some((o) => o.status === filter);
    });
  }, [orders, filter]);

  if (isLoading) return <SpinnerBlock className="py-16" />;

  return (
    <div className="space-y-4">
      <select className={`${selectCls} sm:w-72`} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtrar ventas">
        <option value="">Todas las ventas</option>
        <option value="paid">Pagadas</option>
        <option value="payment_required">Esperando pago</option>
        <option value="cancelled">Canceladas</option>
        <option value="review">Para revisar</option>
        <option value="invoice">Para facturar</option>
      </select>

      {packs.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title="Todavía no hay ventas de Mercado Libre"
          description="Cada orden pagada entra sola como venta del POS con su comisión, descuenta el stock y queda lista para facturar."
        />
      ) : (
        <div className="divide-y divide-border rounded-xl bg-card">
          {packs.map((g) => {
            const first = g[0]!;
            const total = g.reduce((s, o) => s + Number(o.total_amount || 0), 0);
            const fee = g.reduce((s, o) => s + Number(o.sale_fee_total || 0), 0);
            const ship = first.shipping_cost;
            const fraud = g.some((o) => o.fraud_risk);
            const review = g.find((o) => o.needs_review)?.needs_review;
            const saleOrder = g.find((o) => o.sale_id) ?? null;
            const inv = first.invoice_status;
            return (
              <div key={`${first.account_id}:${first.pack_key}`} className="space-y-2 px-4 py-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium">
                        {first.pack_id ? `Carrito ${first.pack_key}` : `Orden ${first.ml_order_id}`}
                      </span>
                      <Badge tone={orderStatusTone(first.status)}>{orderStatusLabel(first.status)}</Badge>
                      {fraud && (
                        <Badge tone="danger">
                          <ShieldAlert size={12} /> Riesgo de fraude
                        </Badge>
                      )}
                      <Badge tone={invoiceStatusTone(inv)}>{INVOICE_STATUS_LABELS[inv] ?? inv}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {when(first.date_created)} · {first.buyer_nickname ?? "Comprador"} · {g.length > 1 ? `${g.length} órdenes` : "1 orden"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {g.flatMap((o) => o.lines ?? []).map((l) => `${l.quantity ?? 1} x ${l.title ?? l.ml_item_id ?? ""}`).join(" · ")}
                    </p>
                  </div>
                  <div className="shrink-0 text-left text-sm sm:text-right">
                    <p className="font-semibold">{formatCurrency(total)}</p>
                    <p className="text-xs text-muted-foreground">Comisión {formatCurrency(fee)}</p>
                    {ship != null && <p className="text-xs text-muted-foreground">Envío {formatCurrency(ship)}</p>}
                    <p className="text-xs">Neto {formatCurrency(orderNet(total, fee, ship))}</p>
                  </div>
                </div>
                {review && (
                  <Callout tone={fraud ? "danger" : "warning"} icon={AlertTriangle}>
                    {review}
                  </Callout>
                )}
                <div className="flex flex-wrap gap-2">
                  {saleOrder?.sale_id && (
                    <Link href="/ventas" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">
                      <Receipt size={12} /> Venta {saleOrder.sales?.number ? `#${saleOrder.sales.number}` : "en el POS"}
                    </Link>
                  )}
                  {saleOrder && !fraud && ["pending", "none", "error"].includes(inv) && (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={invoice.isPending && invoice.variables === saleOrder.id}
                      onClick={() =>
                        invoice.mutate(saleOrder.id, {
                          onSuccess: () => toast({ title: "Factura en la cola de ARCA", variant: "success" }),
                          onError: (e) => toast({ title: "No se pudo facturar", description: mlErrorMessage(e), variant: "error" }),
                        })
                      }
                    >
                      <FileText size={15} /> Facturar
                    </Button>
                  )}
                  {saleOrder && inv === "approved" && (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={retryUpload.isPending && retryUpload.variables === saleOrder.id}
                      onClick={() =>
                        retryUpload.mutate(saleOrder.id, {
                          onSuccess: () => toast({ title: "Subida de la factura en la cola", variant: "success" }),
                          onError: (e) => toast({ title: "No se pudo", description: mlErrorMessage(e), variant: "error" }),
                        })
                      }
                    >
                      <Upload size={15} /> Subir factura a ML
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
