"use client";

import { useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { exportXlsx } from "@/lib/utils/xlsx";
import { formatRemitoNumber } from "@/lib/stock/transfers";
import {
  inTransitByProduct,
  inTransitRows,
  inTransitSummary,
  type TransitDirection,
} from "@/lib/stock/inTransit";
import type { StoreRef } from "@/lib/stock/byStore";
import { useInTransitLines } from "@/modules/stock/hooks";
import { fmtDate, selectCls, storeName } from "./shared";

// Reporte de artículos en tránsito (F17 · H95 · ADR-080): qué mercadería está
// en camino entre sucursales, desde cuándo y cuánto vale a costo. Por traslado
// o por producto, filtrable por sucursal (llega / sale) y con XLSX.
type View = "items" | "products";

export function InTransitReportModal({
  open,
  onOpenChange,
  stores,
  currentStoreId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  stores: StoreRef[];
  currentStoreId: string | null;
}) {
  const { data: lines, isLoading, isError } = useInTransitLines(open);
  const [storeId, setStoreId] = useState<string>("");
  const [direction, setDirection] = useState<TransitDirection>("all");
  const [view, setView] = useState<View>("items");
  useEffect(() => {
    if (open) {
      setStoreId(currentStoreId ?? "");
      setDirection("all");
    }
  }, [open, currentStoreId]);

  const rows = useMemo(
    () => inTransitRows(lines ?? [], { storeId: storeId || null, direction }),
    [lines, storeId, direction],
  );
  const summary = useMemo(() => inTransitSummary(rows), [rows]);
  const byProduct = useMemo(() => inTransitByProduct(rows), [rows]);

  function exportReport() {
    void exportXlsx("articulos-en-transito", [
      {
        name: "En tránsito",
        title: storeId ? `Artículos en tránsito · ${storeName(stores, storeId)}` : "Artículos en tránsito",
        columns: [
          { header: "Remito", key: "remito", width: 12 },
          { header: "Origen", key: "origen", width: 18 },
          { header: "Destino", key: "destino", width: 18 },
          { header: "Despachado", key: "despachado", type: "date" },
          { header: "Días", key: "dias", type: "number" },
          { header: "Producto", key: "producto", width: 32 },
          { header: "SKU", key: "sku", width: 14 },
          { header: "Despachado (cant.)", key: "despachadoQty", type: "number" },
          { header: "Recibido", key: "recibido", type: "number" },
          { header: "En camino", key: "pendiente", type: "number" },
          { header: "Valor a costo", key: "valor", type: "money" },
        ],
        rows: rows.map((r) => ({
          remito: formatRemitoNumber(r.number),
          origen: storeName(stores, r.origin_store_id),
          destino: storeName(stores, r.dest_store_id),
          despachado: r.dispatched_at ? new Date(r.dispatched_at) : null,
          dias: r.days,
          producto: r.variant_label ? `${r.product_name} · ${r.variant_label}` : r.product_name,
          sku: r.sku ?? "",
          despachadoQty: r.qty_dispatched ?? 0,
          recibido: r.qty_received,
          pendiente: r.pending,
          valor: r.value,
        })),
      },
      {
        name: "Por producto",
        columns: [
          { header: "Producto", key: "producto", width: 32 },
          { header: "SKU", key: "sku", width: 14 },
          { header: "En camino", key: "pendiente", type: "number" },
          { header: "Valor a costo", key: "valor", type: "money" },
          { header: "Remitos", key: "remitos", width: 24 },
        ],
        rows: byProduct.map((p) => ({
          producto: p.variant_label ? `${p.product_name} · ${p.variant_label}` : p.product_name,
          sku: p.sku ?? "",
          pendiente: p.pending,
          valor: p.value,
          remitos: p.transfers.map(formatRemitoNumber).join(", "),
        })),
      },
    ]);
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Artículos en tránsito"
      description="Mercadería despachada que todavía no llegó a destino."
      className="max-w-3xl"
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">Sucursal</span>
            <select className={selectCls} value={storeId} onChange={(e) => setStoreId(e.target.value)}>
              <option value="" className="bg-popover text-popover-foreground">
                Todas las sucursales
              </option>
              {stores.map((s) => (
                <option key={s.id} value={s.id} className="bg-popover text-popover-foreground">
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          {storeId && (
            <div className="self-end">
              <Segmented<TransitDirection>
                aria-label="Dirección"
                value={direction}
                onChange={setDirection}
                options={[
                  { value: "all", label: "Todo" },
                  { value: "incoming", label: "Llega" },
                  { value: "outgoing", label: "Sale" },
                ]}
              />
            </div>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Fact label="Traslados" value={String(summary.transfers)} />
          <Fact label="Unidades en camino" value={formatQty(summary.units)} />
          <Fact
            label="Valor a costo"
            value={formatCurrency(summary.value)}
            sub={summary.uncosted > 0 ? `${summary.uncosted} sin costo` : undefined}
          />
          <Fact
            label="Más antiguo"
            value={summary.oldestDays == null ? "Sin datos" : `${summary.oldestDays} ${summary.oldestDays === 1 ? "día" : "días"}`}
          />
        </dl>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented<View>
            aria-label="Ver"
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: "items", label: "Por traslado" },
              { value: "products", label: "Por producto" },
            ]}
          />
          <Button variant="secondary" onClick={exportReport} disabled={rows.length === 0}>
            <Download size={16} /> XLSX
          </Button>
        </div>

        {isLoading ? (
          <SpinnerBlock />
        ) : isError ? (
          <p className="text-sm text-danger">No se pudo cargar el reporte.</p>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No hay mercadería en camino.</p>
        ) : view === "items" ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead className="text-left text-xs uppercase tracking-[0.12em] text-muted-foreground">
                <tr>
                  <th className="px-2 py-2">Remito</th>
                  <th className="px-2 py-2">Ruta</th>
                  <th className="px-2 py-2">Producto</th>
                  <th className="px-2 py-2 text-right">En camino</th>
                  <th className="px-2 py-2 text-right">Valor</th>
                  <th className="px-2 py-2 text-right">Despachado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={`${r.transfer_id}:${r.product_id}:${r.variant_id ?? ""}`}>
                    <td className="whitespace-nowrap px-2 py-2 font-medium">{formatRemitoNumber(r.number)}</td>
                    <td className="whitespace-nowrap px-2 py-2 text-muted-foreground">
                      {storeName(stores, r.origin_store_id)} a {storeName(stores, r.dest_store_id)}
                    </td>
                    <td className="px-2 py-2">
                      {r.product_name}
                      {r.variant_label && <span className="text-muted-foreground"> · {r.variant_label}</span>}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                      {formatQty(r.pending)} {r.unit}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                      {r.value == null ? "Sin costo" : formatCurrency(r.value)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right text-muted-foreground">
                      {r.dispatched_at ? fmtDate(r.dispatched_at) : ""}
                      {r.days != null && r.days > 0 && <span className="block text-xs">hace {r.days} d</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead className="text-left text-xs uppercase tracking-[0.12em] text-muted-foreground">
                <tr>
                  <th className="px-2 py-2">Producto</th>
                  <th className="px-2 py-2 text-right">En camino</th>
                  <th className="px-2 py-2 text-right">Valor</th>
                  <th className="px-2 py-2">Remitos</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {byProduct.map((p) => (
                  <tr key={p.key}>
                    <td className="px-2 py-2">
                      {p.product_name}
                      {p.variant_label && <span className="text-muted-foreground"> · {p.variant_label}</span>}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                      {formatQty(p.pending)} {p.unit}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                      {p.value == null ? "Sin costo" : formatCurrency(p.value)}
                    </td>
                    <td className="px-2 py-2 text-muted-foreground">
                      {p.transfers.map(formatRemitoNumber).join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md bg-muted/40 p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
      {sub && <dd className="text-xs text-muted-foreground">{sub}</dd>}
    </div>
  );
}
