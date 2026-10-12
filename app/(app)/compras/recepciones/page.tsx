"use client";

import { useMemo, useState } from "react";
import { Download, PackageCheck, Plus, Settings2 } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Switch } from "@/components/ui/Switch";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { cn } from "@/lib/utils/cn";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { exportXlsx } from "@/lib/utils/xlsx";
import { formatOrderNumber, formatReceiptNumber } from "@/lib/purchases/orders";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useStores } from "@/modules/stock/hooks";
import {
  usePurchaseOrders,
  usePurchasesAccess,
  useReceipts,
  useSuppliers,
} from "@/modules/purchases/hooks";
import {
  ComprasLocked,
  ComprasTabs,
  fmtDate,
  inputCls,
  selectCls,
  storeName,
  supplierName,
} from "@/components/purchases/shared";
import { ReceiveModal } from "@/components/purchases/ReceiveModal";
import { ReceiptDetailModal } from "@/components/purchases/ReceiptDetailModal";
import { PurchaseSettingsModal } from "@/components/purchases/PurchaseSettingsModal";

// Recepciones de mercadería (F18 · H101, ADR-050).
export default function RecepcionesPage() {
  const access = usePurchasesAccess();
  const { data: me } = useMyTenant();
  const canManage = Boolean(me?.canManage);
  const { data: stores = [] } = useStores();
  const { data: suppliers = [] } = useSuppliers({ includeArchived: true }, access.enabled);
  const { data: orders = [] } = usePurchaseOrders({}, access.enabled);

  const [supplierId, setSupplierId] = useState("");
  const [storeId, setStoreId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [uninvoiced, setUninvoiced] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const {
    data: rows = [],
    isLoading,
    isError,
    refetch,
  } = useReceipts(
    {
      supplierId: supplierId || null,
      storeId: storeId || null,
      from: from || null,
      to: to || null,
    },
    access.enabled,
  );

  const list = useMemo(
    () => (uninvoiced ? rows.filter((r) => !r.invoice_id) : rows),
    [rows, uninvoiced],
  );
  const orderNumber = useMemo(() => new Map(orders.map((o) => [o.id, o.number])), [orders]);
  const ocLabel = (id: string | null) =>
    id ? (orderNumber.has(id) ? formatOrderNumber(orderNumber.get(id)!) : "Con OC") : "Libre";

  function exportList() {
    void exportXlsx("recepciones", [
      {
        name: "Recepciones",
        title: "Recepciones de mercadería",
        columns: [
          { header: "Recepción", key: "numero", width: 12 },
          { header: "Fecha", key: "fecha", width: 12 },
          { header: "Proveedor", key: "proveedor", width: 26 },
          { header: "Sucursal", key: "sucursal", width: 18 },
          { header: "OC", key: "oc", width: 12 },
          { header: "Remito", key: "remito", width: 16 },
          { header: "Unidades", key: "unidades", type: "number" },
          { header: "Valor a costo", key: "valor", type: "money" },
          { header: "Costo puesto en depósito", key: "landed", type: "money" },
          { header: "N° de despacho", key: "despacho", width: 18 },
          { header: "Facturada", key: "facturada", width: 10 },
        ],
        rows: list.map((r) => ({
          numero: formatReceiptNumber(r.number),
          fecha: fmtDate(r.received_date),
          proveedor: supplierName(suppliers, r.supplier_id),
          sucursal: storeName(stores, r.store_id),
          oc: ocLabel(r.order_id),
          remito: r.remito_number ?? "",
          unidades: r.total_units,
          valor: r.total_cost,
          landed: r.landed_total,
          despacho: r.dispatch_number ?? "",
          facturada: r.invoice_id ? "Sí" : "No",
        })),
        totals: {
          unidades: list.reduce((t, r) => t + r.total_units, 0),
          valor: list.reduce((t, r) => t + r.total_cost, 0),
        },
      },
    ]);
  }

  const header = (
    <PageHeader
      eyebrow="Compras"
      title="Recepciones"
      icon={PackageCheck}
      description="La mercadería que entró a cada sucursal, con sus diferencias, costos y el comprobante del proveedor."
      actions={
        access.enabled ? (
          <>
            <Button onClick={() => setReceiveOpen(true)}>
              <Plus size={16} /> Recepción sin orden
            </Button>
            <Button variant="secondary" onClick={exportList} disabled={list.length === 0}>
              <Download size={16} /> XLSX
            </Button>
            {canManage && (
              <Button variant="ghost" onClick={() => setSettingsOpen(true)}>
                <Settings2 size={16} /> Configuración
              </Button>
            )}
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

  return (
    <PageContainer>
      {header}
      <ComprasTabs />

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
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
        <select
          aria-label="Sucursal"
          className={cn(selectCls, "h-10")}
          value={storeId}
          onChange={(e) => setStoreId(e.target.value)}
        >
          <option value="" className="bg-popover text-popover-foreground">
            Todas las sucursales
          </option>
          {stores.map((s) => (
            <option key={s.id} value={s.id} className="bg-popover text-popover-foreground">
              {s.name}
            </option>
          ))}
        </select>
        <input
          type="date"
          aria-label="Desde"
          className={inputCls}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <input
          type="date"
          aria-label="Hasta"
          className={inputCls}
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        <label className="flex h-10 items-center gap-2 text-sm">
          <Switch checked={uninvoiced} onCheckedChange={setUninvoiced} label="Sin facturar" />
          Sin facturar
        </label>
      </div>

      <div className="mt-4">
        <TableWrap>
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Recepción</th>
                <th className="px-4 py-3">Proveedor</th>
                <th className="hidden px-4 py-3 md:table-cell">Sucursal</th>
                <th className="hidden px-4 py-3 lg:table-cell">OC / Remito</th>
                <th className="px-4 py-3 text-right">Unidades</th>
                <th className="px-4 py-3 text-right">Valor</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(isLoading || !access.ready) && <TableStateRow colSpan={6} loading />}
              {isError && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-danger">
                    Error al cargar.{" "}
                    <button onClick={() => refetch()} className="underline">
                      Reintentar
                    </button>
                  </td>
                </tr>
              )}
              {!isLoading && !isError && access.enabled && list.length === 0 && (
                <TableStateRow colSpan={6}>
                  <EmptyState
                    compact
                    icon={PackageCheck}
                    title="Sin recepciones en esta vista"
                    description="Recibí una orden de compra desde Órdenes o cargá una recepción sin orden."
                  />
                </TableStateRow>
              )}
              {list.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setDetailId(r.id)}
                  className="cursor-pointer transition hover:bg-muted/40"
                >
                  <td className="px-4 py-3">
                    <div className="font-mono font-semibold">{formatReceiptNumber(r.number)}</div>
                    <div className="text-xs text-muted-foreground">{fmtDate(r.received_date)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div>{supplierName(suppliers, r.supplier_id)}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {r.invoice_id ? (
                        <Badge tone="success">Facturada</Badge>
                      ) : (
                        <Badge tone="neutral">Sin facturar</Badge>
                      )}
                      {r.landed_total != null && <Badge tone="brand">Costeado</Badge>}
                    </div>
                  </td>
                  <td className="hidden px-4 py-3 md:table-cell">{storeName(stores, r.store_id)}</td>
                  <td className="hidden px-4 py-3 lg:table-cell">
                    <div>{ocLabel(r.order_id)}</div>
                    {r.remito_number && (
                      <div className="text-xs text-muted-foreground">Remito {r.remito_number}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">
                    {formatQty(r.total_units)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">
                    {formatCurrency(r.landed_total ?? r.total_cost)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </div>

      <ReceiveModal
        open={receiveOpen}
        onOpenChange={setReceiveOpen}
        orderId={null}
        onDone={(id) => setDetailId(id)}
      />
      <ReceiptDetailModal receiptId={detailId} onOpenChange={(o) => !o && setDetailId(null)} />
      <PurchaseSettingsModal open={settingsOpen} onOpenChange={setSettingsOpen} />
    </PageContainer>
  );
}
