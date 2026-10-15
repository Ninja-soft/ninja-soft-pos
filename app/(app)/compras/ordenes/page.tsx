"use client";

import { useMemo, useState } from "react";
import { ClipboardList, Download, PackagePlus, Plus, Search, Settings2 } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { EmptyState } from "@/components/ui/EmptyState";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { cn } from "@/lib/utils/cn";
import { exportXlsx } from "@/lib/utils/xlsx";
import {
  OPEN_ORDER_STATUSES,
  ORDER_STATUS_LABEL,
  formatOrderNumber,
  receivedPct,
  type OrderStatus,
} from "@/lib/purchases/orders";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useStores } from "@/modules/stock/hooks";
import { usePurchaseOrders, usePurchasesAccess, useSuppliers } from "@/modules/purchases/hooks";
import type { OrderDetail, OrderRow } from "@/modules/purchases/api";
import {
  ComprasLocked,
  ComprasTabs,
  Kpi,
  OrderStatusBadge,
  fmtDate,
  formatMoney,
  selectCls,
  storeName,
  supplierName,
  today,
} from "@/components/purchases/shared";
import { OrderWizardModal } from "@/components/purchases/OrderWizardModal";
import { OrderDetailModal } from "@/components/purchases/OrderDetailModal";
import { ReceiveModal } from "@/components/purchases/ReceiveModal";
import { PurchaseSettingsModal } from "@/components/purchases/PurchaseSettingsModal";

type Tab = "open" | "receive" | "history" | "all";

const TAB_STATUSES: Record<Tab, OrderStatus[] | null> = {
  open: OPEN_ORDER_STATUSES,
  receive: ["sent", "partially_received"],
  history: ["received", "cancelled"],
  all: null,
};

const isLate = (o: Pick<OrderRow, "expected_date" | "status">, d: string) =>
  Boolean(o.expected_date) &&
  o.expected_date! < d &&
  (o.status === "sent" || o.status === "partially_received");

// Órdenes de compra (F18 · H101, ADR-050).
export default function OrdenesCompraPage() {
  const access = usePurchasesAccess();
  const { data: me } = useMyTenant();
  const { data: stores = [] } = useStores();
  const [tab, setTab] = useState<Tab>("open");
  const [supplierFilter, setSupplierFilter] = useState("");
  const [storeFilter, setStoreFilter] = useState("");
  const [search, setSearch] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [wizard, setWizard] = useState<{ open: boolean; initial: OrderDetail | null }>({
    open: false,
    initial: null,
  });
  const [freeOpen, setFreeOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const enabled = access.enabled;
  const { data: suppliers = [] } = useSuppliers({ includeArchived: true }, enabled);
  const { data: open = [] } = usePurchaseOrders({ statuses: OPEN_ORDER_STATUSES }, enabled);
  const {
    data: rows = [],
    isLoading,
    isError,
    refetch,
  } = usePurchaseOrders(
    {
      statuses: TAB_STATUSES[tab],
      supplierId: supplierFilter || null,
      storeId: storeFilter || null,
      search,
    },
    enabled,
  );

  const d = today();
  const kpis = useMemo(
    () => ({
      draft: open.filter((o) => o.status === "draft").length,
      sent: open.filter((o) => o.status === "sent").length,
      partial: open.filter((o) => o.status === "partially_received").length,
      late: open.filter((o) => isLate(o, d)).length,
    }),
    [open, d],
  );

  const canManage = Boolean(me?.canManage);
  const canFree = access.settings.allow_free_receipts || me?.role === "owner";
  const multiStore = stores.length > 1;

  function exportList() {
    void exportXlsx("ordenes-de-compra", [
      {
        name: "Órdenes",
        title: "Órdenes de compra",
        columns: [
          { header: "Orden", key: "numero", width: 12 },
          { header: "Proveedor", key: "proveedor", width: 28 },
          { header: "Sucursal", key: "sucursal", width: 18 },
          { header: "Estado", key: "estado", width: 18 },
          { header: "Emitida", key: "emitida", width: 12 },
          { header: "Entrega esperada", key: "esperada", width: 14 },
          { header: "Moneda", key: "moneda", width: 8 },
          { header: "Neto", key: "neto", type: "number" },
          { header: "Total", key: "total", type: "number" },
          { header: "Unidades pedidas", key: "pedidas", type: "number" },
          { header: "Unidades recibidas", key: "recibidas", type: "number" },
        ],
        rows: rows.map((o) => ({
          numero: formatOrderNumber(o.number),
          proveedor: supplierName(suppliers, o.supplier_id),
          sucursal: storeName(stores, o.store_id),
          estado: ORDER_STATUS_LABEL[o.status],
          emitida: fmtDate(o.issue_date),
          esperada: o.expected_date ? fmtDate(o.expected_date) : "",
          moneda: o.currency,
          neto: o.net_total,
          total: o.total,
          pedidas: o.units_ordered,
          recibidas: o.units_received,
        })),
      },
    ]);
  }

  const header = (
    <PageHeader
      eyebrow="Compras"
      title="Órdenes de compra"
      icon={ClipboardList}
      description="Pedile mercadería a tus proveedores, seguí lo que falta llegar y recibilo por sucursal."
      actions={
        enabled ? (
          <>
            {canManage && (
              <Button onClick={() => setWizard({ open: true, initial: null })}>
                <Plus size={16} /> Nueva orden
              </Button>
            )}
            {canFree && (
              <Button variant="secondary" onClick={() => setFreeOpen(true)}>
                <PackagePlus size={16} /> Recepción sin orden
              </Button>
            )}
            <Button variant="secondary" onClick={exportList} disabled={rows.length === 0}>
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
        <ComprasLocked />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {header}
      <ComprasTabs />

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Borradores" value={kpis.draft} onClick={() => setTab("open")} />
        <Kpi label="Enviadas, esperando" value={kpis.sent} tone="brand" onClick={() => setTab("receive")} />
        <Kpi label="Recibidas en parte" value={kpis.partial} tone="warning" onClick={() => setTab("receive")} />
        <Kpi
          label="Atrasadas"
          value={kpis.late}
          tone={kpis.late > 0 ? "danger" : undefined}
          onClick={() => setTab("receive")}
        />
      </div>

      <div className="mt-6 flex flex-col gap-3 lg:flex-row lg:items-center">
        <Segmented<Tab> scrollOnMobile
          aria-label="Estado"
          value={tab}
          onChange={setTab}
          size="sm"
          options={[
            { value: "open", label: "Abiertas" },
            { value: "receive", label: "Por recibir" },
            { value: "history", label: "Historial" },
            { value: "all", label: "Todas" },
          ]}
        />
        <div className="flex flex-1 flex-wrap gap-2">
          <select
            aria-label="Proveedor"
            className={cn(selectCls, "h-10 lg:max-w-[14rem]")}
            value={supplierFilter}
            onChange={(e) => setSupplierFilter(e.target.value)}
          >
            <option value="" className="bg-popover text-popover-foreground">
              Todos los proveedores
            </option>
            {suppliers
              .filter((s) => !s.deleted_at)
              .map((s) => (
                <option key={s.id} value={s.id} className="bg-popover text-popover-foreground">
                  {s.name}
                </option>
              ))}
          </select>
          {multiStore && (
            <select
              aria-label="Sucursal"
              className={cn(selectCls, "h-10 lg:max-w-[12rem]")}
              value={storeFilter}
              onChange={(e) => setStoreFilter(e.target.value)}
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
          )}
          <div className="relative min-w-[9rem] flex-1 lg:max-w-[10rem]">
            <Search
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="N° de orden"
              inputMode="numeric"
              aria-label="Buscar por número"
              className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none focus:border-ninja-flameSoft"
            />
          </div>
        </div>
      </div>

      <div className="mt-4">
        <TableWrap>
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Orden</th>
                <th className="px-4 py-3">Proveedor</th>
                {multiStore && <th className="hidden px-4 py-3 md:table-cell">Sucursal</th>}
                <th className="px-4 py-3">Estado</th>
                <th className="hidden px-4 py-3 md:table-cell">Entrega</th>
                <th className="px-4 py-3 text-right">Total</th>
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
              {!isLoading && !isError && rows.length === 0 && enabled && (
                <TableStateRow colSpan={6}>
                  <EmptyState
                    compact
                    icon={ClipboardList}
                    title="Sin órdenes en esta vista"
                    description="Armá una orden nueva o pedile al sistema que sugiera qué comprar por stock bajo."
                  />
                </TableStateRow>
              )}
              {rows.map((o) => {
                const late = isLate(o, d);
                return (
                  <tr
                    key={o.id}
                    onClick={() => setDetailId(o.id)}
                    className="cursor-pointer transition hover:bg-muted/40"
                  >
                    <td className="px-4 py-3 font-mono font-semibold">{formatOrderNumber(o.number)}</td>
                    <td className="px-4 py-3">{supplierName(suppliers, o.supplier_id)}</td>
                    {multiStore && (
                      <td className="hidden px-4 py-3 md:table-cell">{storeName(stores, o.store_id)}</td>
                    )}
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <OrderStatusBadge status={o.status} />
                        {o.status === "partially_received" && (
                          <span className="text-xs text-muted-foreground">{receivedPct(o)} %</span>
                        )}
                      </div>
                    </td>
                    <td
                      className={cn(
                        "hidden px-4 py-3 md:table-cell",
                        late ? "font-medium text-danger" : "text-muted-foreground",
                      )}
                    >
                      {o.expected_date ? fmtDate(o.expected_date) : ""}
                      {late ? " · atrasada" : ""}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {formatMoney(o.total, o.currency)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      </div>

      <OrderDetailModal
        orderId={detailId}
        onOpenChange={(v) => !v && setDetailId(null)}
        onEdit={(o) => {
          setDetailId(null);
          setWizard({ open: true, initial: o });
        }}
      />
      <OrderWizardModal
        open={wizard.open}
        onOpenChange={(v) => setWizard((w) => ({ ...w, open: v }))}
        initial={wizard.initial}
        onSaved={(id) => setDetailId(id)}
      />
      <ReceiveModal open={freeOpen} onOpenChange={setFreeOpen} orderId={null} />
      <PurchaseSettingsModal open={settingsOpen} onOpenChange={setSettingsOpen} />
    </PageContainer>
  );
}
