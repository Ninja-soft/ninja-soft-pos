"use client";

import { useMemo, useState } from "react";
import { Download, Plus, Undo2 } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Switch } from "@/components/ui/Switch";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { cn } from "@/lib/utils/cn";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { exportXlsx } from "@/lib/utils/xlsx";
import { RETURN_REASON_LABEL, formatReturnNumber } from "@/lib/purchases/returns";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useStores } from "@/modules/stock/hooks";
import { usePurchaseReturns, usePurchasesAccess, useSuppliers } from "@/modules/purchases/hooks";
import {
  ComprasLocked,
  ComprasTabs,
  fmtDate,
  inputCls,
  selectCls,
  storeName,
  supplierName,
} from "@/components/purchases/shared";
import { ReturnModal } from "@/components/purchases/ReturnModal";
import { ReturnDetailModal } from "@/components/purchases/ReturnDetailModal";

// Devoluciones a proveedor (F18 · ADR-059).
export default function DevolucionesProveedorPage() {
  const access = usePurchasesAccess();
  const { data: me } = useMyTenant();
  const canManage = Boolean(me?.canManage);
  const { data: stores = [] } = useStores();
  const { data: suppliers = [] } = useSuppliers({ includeArchived: true }, access.enabled);

  const [supplierId, setSupplierId] = useState("");
  const [storeId, setStoreId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [pendingNc, setPendingNc] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  const { data: rows = [], isLoading } = usePurchaseReturns(
    { supplierId: supplierId || null, storeId: storeId || null, from: from || null, to: to || null },
    access.enabled,
  );
  const list = useMemo(() => (pendingNc ? rows.filter((r) => !r.credit_invoice_id) : rows), [rows, pendingNc]);

  function exportList() {
    void exportXlsx("devoluciones-a-proveedor", [
      {
        name: "Devoluciones",
        title: "Devoluciones a proveedor",
        columns: [
          { header: "Devolución", key: "numero", width: 12 },
          { header: "Fecha", key: "fecha", width: 12 },
          { header: "Proveedor", key: "proveedor", width: 26 },
          { header: "Sucursal", key: "sucursal", width: 18 },
          { header: "Motivo", key: "motivo", width: 18 },
          { header: "Unidades", key: "unidades", type: "number" },
          { header: "Valor a costo", key: "valor", type: "money" },
          { header: "Nota de crédito", key: "nc", width: 14 },
        ],
        rows: list.map((r) => ({
          numero: formatReturnNumber(r.number),
          fecha: fmtDate(r.return_date),
          proveedor: supplierName(suppliers, r.supplier_id),
          sucursal: storeName(stores, r.store_id),
          motivo: RETURN_REASON_LABEL[r.reason],
          unidades: r.total_units,
          valor: r.total_cost,
          nc: r.credit_invoice_id ? "Vinculada" : "Pendiente",
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
      title="Devoluciones a proveedor"
      icon={Undo2}
      description="Mercadería que volvió al proveedor: sale del stock de la sucursal, baja el costo promedio y espera la nota de crédito."
      actions={
        access.enabled ? (
          <>
            {canManage && (
              <Button onClick={() => setNewOpen(true)}>
                <Plus size={16} /> Devolución sin recepción
              </Button>
            )}
            <Button variant="secondary" onClick={exportList} disabled={list.length === 0}>
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
        <input type="date" aria-label="Desde" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" aria-label="Hasta" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} />
        <label className="flex h-10 items-center gap-2 text-sm">
          <Switch checked={pendingNc} onCheckedChange={setPendingNc} label="NC pendiente" />
          NC pendiente
        </label>
      </div>

      <div className="mt-4">
        <TableWrap>
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Devolución</th>
                <th className="px-4 py-3">Proveedor</th>
                <th className="hidden px-4 py-3 md:table-cell">Sucursal</th>
                <th className="hidden px-4 py-3 lg:table-cell">Motivo</th>
                <th className="px-4 py-3 text-right">Unidades</th>
                <th className="px-4 py-3 text-right">Valor</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(isLoading || !access.ready) && <TableStateRow colSpan={6} loading />}
              {!isLoading && access.enabled && list.length === 0 && (
                <TableStateRow colSpan={6}>
                  <EmptyState
                    compact
                    icon={Undo2}
                    title="Sin devoluciones en esta vista"
                    description="Devolvé desde el detalle de una recepción o cargá una devolución sin recepción."
                  />
                </TableStateRow>
              )}
              {list.map((r) => (
                <tr key={r.id} onClick={() => setDetailId(r.id)} className="cursor-pointer transition hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <div className="font-mono font-semibold">{formatReturnNumber(r.number)}</div>
                    <div className="text-xs text-muted-foreground">{fmtDate(r.return_date)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div>{supplierName(suppliers, r.supplier_id)}</div>
                    <div className="mt-1">
                      {r.credit_invoice_id ? <Badge tone="success">NC vinculada</Badge> : <Badge tone="warning">NC pendiente</Badge>}
                    </div>
                  </td>
                  <td className="hidden px-4 py-3 md:table-cell">{storeName(stores, r.store_id)}</td>
                  <td className="hidden px-4 py-3 lg:table-cell">{RETURN_REASON_LABEL[r.reason]}</td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">{formatQty(r.total_units)}</td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">{formatCurrency(r.total_cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </div>

      <ReturnModal open={newOpen} onOpenChange={setNewOpen} receipt={null} onCreated={(id) => setDetailId(id)} />
      <ReturnDetailModal returnId={detailId} onOpenChange={(o) => !o && setDetailId(null)} />
    </PageContainer>
  );
}
