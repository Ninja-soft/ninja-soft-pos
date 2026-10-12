"use client";

import { useMemo, useState } from "react";
import { Boxes, Download } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { SearchField } from "@/components/ui/SearchField";
import { Switch } from "@/components/ui/Switch";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { cn } from "@/lib/utils/cn";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { exportXlsx } from "@/lib/utils/xlsx";
import { lotHealth, type LotHealth } from "@/lib/purchases/lots";
import { useStores } from "@/modules/stock/hooks";
import { useLotSales, useLots, usePurchasesAccess } from "@/modules/purchases/hooks";
import type { LotRow } from "@/modules/purchases/api";
import { ComprasLocked, ComprasTabs, fmtDate, fmtDateTime, selectCls, storeName, today } from "@/components/purchases/shared";

const HEALTH: Record<LotHealth, { label: string; tone: "danger" | "warning" | "success" | "neutral" }> = {
  expired: { label: "Vencido", tone: "danger" },
  expiring: { label: "Por vencer", tone: "warning" },
  ok: { label: "Vigente", tone: "success" },
  empty: { label: "Agotado", tone: "neutral" },
};

// Lotes, vencimientos y n° de despacho con trazabilidad hasta la venta
// (F18 · ADR-059).
export default function LotesPage() {
  const access = usePurchasesAccess();
  const { data: stores = [] } = useStores();
  const [storeId, setStoreId] = useState("");
  const [search, setSearch] = useState("");
  const [onlyAvailable, setOnlyAvailable] = useState(true);
  const [trace, setTrace] = useState<LotRow | null>(null);
  const now = today();

  const { data: lots = [], isLoading } = useLots(
    { storeId: storeId || null, search: search.trim() || null, onlyAvailable },
    access.enabled,
  );
  const shown = useMemo(() => lots.filter((l) => !l.voided_at || !onlyAvailable), [lots, onlyAvailable]);

  function exportList() {
    void exportXlsx("lotes", [
      {
        name: "Lotes",
        title: `Lotes al ${fmtDate(now)}`,
        columns: [
          { header: "Producto", key: "producto", width: 30 },
          { header: "SKU", key: "sku", width: 14 },
          { header: "Lote", key: "lote", width: 14 },
          { header: "N° de despacho", key: "despacho", width: 18 },
          { header: "Vencimiento", key: "vence", width: 12 },
          { header: "Sucursal", key: "sucursal", width: 18 },
          { header: "Recibido", key: "recibido", type: "number" },
          { header: "Disponible", key: "disponible", type: "number" },
          { header: "Costo unitario", key: "costo", type: "money" },
        ],
        rows: shown.map((l) => ({
          producto: l.product_name,
          sku: l.product_sku ?? "",
          lote: l.lot_code ?? "",
          despacho: l.dispatch_number ?? "",
          vence: l.expires_on ? fmtDate(l.expires_on) : "",
          sucursal: storeName(stores, l.store_id),
          recibido: l.qty_received,
          disponible: l.qty_available,
          costo: l.unit_cost,
        })),
      },
    ]);
  }

  const header = (
    <PageHeader
      eyebrow="Compras"
      title="Lotes y despachos"
      icon={Boxes}
      description="Saldo de cada lote por sucursal, vencimientos y n° de despacho, con las ventas que se llevó cada lote (se consumen por vencimiento y antigüedad)."
      actions={
        access.enabled ? (
          <Button variant="secondary" onClick={exportList} disabled={shown.length === 0}>
            <Download size={16} /> XLSX
          </Button>
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

      <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_14rem_auto]">
        <SearchField value={search} onValueChange={setSearch} placeholder="Lote o n° de despacho" />
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
        <label className="flex h-10 items-center gap-2 text-sm">
          <Switch checked={onlyAvailable} onCheckedChange={setOnlyAvailable} label="Con saldo" />
          Con saldo
        </label>
      </div>

      <div className="mt-4">
        <TableWrap>
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Producto</th>
                <th className="px-4 py-3">Lote</th>
                <th className="hidden px-4 py-3 md:table-cell">Vencimiento</th>
                <th className="hidden px-4 py-3 lg:table-cell">Sucursal</th>
                <th className="px-4 py-3 text-right">Disponible</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(isLoading || !access.ready) && <TableStateRow colSpan={5} loading />}
              {!isLoading && access.enabled && shown.length === 0 && (
                <TableStateRow colSpan={5}>
                  <EmptyState
                    compact
                    icon={Boxes}
                    title="Sin lotes en esta vista"
                    description="Los lotes se cargan al recibir mercadería (lote y vencimiento) o con el costeo de importación (n° de despacho)."
                  />
                </TableStateRow>
              )}
              {shown.map((l) => {
                const h = l.voided_at ? null : HEALTH[lotHealth(l, now)];
                return (
                  <tr key={l.id} onClick={() => setTrace(l)} className="cursor-pointer transition hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <div className="font-medium">{l.product_name}</div>
                      {l.product_sku && <div className="text-xs text-muted-foreground">{l.product_sku}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-mono">{l.lot_code || "Sin código"}</div>
                      {l.dispatch_number && (
                        <div className="font-mono text-xs text-muted-foreground">Despacho {l.dispatch_number}</div>
                      )}
                    </td>
                    <td className="hidden px-4 py-3 md:table-cell">
                      <div>{l.expires_on ? fmtDate(l.expires_on) : "Sin vencimiento"}</div>
                      <div className="mt-1">
                        {l.voided_at ? <Badge tone="danger">Anulado</Badge> : h && <Badge tone={h.tone}>{h.label}</Badge>}
                      </div>
                    </td>
                    <td className="hidden px-4 py-3 lg:table-cell">{storeName(stores, l.store_id)}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {formatQty(l.qty_available)}
                      <div className="text-xs text-muted-foreground">de {formatQty(l.qty_received)}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      </div>

      <LotTraceModal lot={trace} onOpenChange={(o) => !o && setTrace(null)} storeLabel={(id) => storeName(stores, id)} />
    </PageContainer>
  );
}

function LotTraceModal({
  lot,
  onOpenChange,
  storeLabel,
}: {
  lot: LotRow | null;
  onOpenChange: (o: boolean) => void;
  storeLabel: (id: string | null) => string;
}) {
  const { data: sales = [], isLoading } = useLotSales(lot?.id ?? null);
  const sold = sales.reduce((t, s) => t + s.qty, 0);
  return (
    <Modal
      open={Boolean(lot)}
      onOpenChange={onOpenChange}
      title={lot ? `Lote ${lot.lot_code || "sin código"}` : "Lote"}
      description={lot ? `${lot.product_name} · ${storeLabel(lot.store_id)}` : undefined}
      className="sm:max-w-2xl"
    >
      {lot && (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-3 rounded-md bg-muted p-3.5 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">Recibido</dt>
              <dd className="font-medium">{formatQty(lot.qty_received)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Vendido</dt>
              <dd className="font-medium">{formatQty(sold)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Disponible</dt>
              <dd className="font-medium">{formatQty(lot.qty_available)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Costo unitario</dt>
              <dd className="font-medium">{lot.unit_cost == null ? "" : formatCurrency(lot.unit_cost)}</dd>
            </div>
            {lot.dispatch_number && (
              <div className="col-span-2">
                <dt className="text-xs text-muted-foreground">N° de despacho</dt>
                <dd className="font-mono font-medium">{lot.dispatch_number}</dd>
              </div>
            )}
            {lot.expires_on && (
              <div>
                <dt className="text-xs text-muted-foreground">Vencimiento</dt>
                <dd className="font-medium">{fmtDate(lot.expires_on)}</dd>
              </div>
            )}
          </dl>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/60 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Venta</th>
                  <th className="px-3 py-2 text-left">Fecha</th>
                  <th className="px-3 py-2 text-right">Cantidad</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {isLoading && (
                  <tr>
                    <td colSpan={3} className="px-3 py-6 text-center text-muted-foreground">
                      Cargando...
                    </td>
                  </tr>
                )}
                {!isLoading && sales.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-3 py-6 text-center text-muted-foreground">
                      Todavía no se vendió nada de este lote.
                    </td>
                  </tr>
                )}
                {sales.map((s) => (
                  <tr key={s.sale_id} className={cn(s.sale_status === "voided" && "opacity-60")}>
                    <td className="px-3 py-2 font-mono">
                      {s.sale_number ? `#${s.sale_number}` : s.sale_id.slice(0, 8)}
                      {s.sale_status === "voided" && <span className="ml-2 text-xs text-danger">anulada</span>}
                    </td>
                    <td className="px-3 py-2">{fmtDateTime(s.sold_at)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatQty(s.qty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}
