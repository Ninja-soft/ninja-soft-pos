"use client";

// Stock por depósito de una sucursal (ADR-085, ADR-136). Pensado para muchos
// depósitos:
//   · Tabla (desde md): producto con su foto y los totales fijos a los
//     costados, los depósitos en el medio con scroll horizontal y un selector
//     de qué depósitos se ven.
//   · Por depósito: un depósito a la vez (Segmented con scroll en el celular).
//   · En el celular, la tabla pasa a tarjetas: cada producto con sus depósitos
//     como pastillas.

import { useEffect, useMemo, useState } from "react";
import { Columns3 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Segmented } from "@/components/ui/Segmented";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { Dropdown, DropdownContent, DropdownLabel, DropdownTrigger } from "@/components/ui/Dropdown";
import { ProductThumb } from "@/components/products/ProductThumb";
import { cn } from "@/lib/utils/cn";
import { formatQty } from "@/lib/utils/format";
import {
  defaultVisibleWarehouses,
  isSellable,
  qtyIn,
  salonStatus,
  sellableQty,
  type Warehouse,
  type WarehouseOverviewRow,
} from "@/lib/stock/warehouses";

export interface CountTarget {
  warehouse: Warehouse;
  productId: string;
  variantId: string | null;
  name: string;
  current: number;
}

type Mode = "table" | "single";

/** Con más de estos depósitos se ofrece elegir cuáles se ven. */
export const MANY_WAREHOUSES = 4;

const rowName = (r: WarehouseOverviewRow) => (r.variant_label ? `${r.product_name} (${r.variant_label})` : r.product_name);

export function WarehouseStockView({
  rows,
  warehouses,
  thumbs,
  loading,
  canManage,
  onCount,
}: {
  rows: WarehouseOverviewRow[];
  warehouses: Warehouse[];
  thumbs: Record<string, string>;
  loading: boolean;
  canManage: boolean;
  onCount: (t: CountTarget) => void;
}) {
  const many = warehouses.length > MANY_WAREHOUSES;
  const [mode, setMode] = useState<Mode>("table");
  const [visible, setVisible] = useState<string[]>(() => defaultVisibleWarehouses(warehouses, MANY_WAREHOUSES));
  const [single, setSingle] = useState<string>(warehouses[0]?.id ?? "");
  const idsKey = warehouses.map((w) => w.id).join(",");

  // Al cambiar de sucursal (otros depósitos), vuelve a los de por defecto.
  useEffect(() => {
    setVisible(defaultVisibleWarehouses(warehouses, MANY_WAREHOUSES));
    setSingle(warehouses[0]?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const shown = useMemo(() => warehouses.filter((w) => visible.includes(w.id)), [warehouses, visible]);
  const singleWh = warehouses.find((w) => w.id === single) ?? warehouses[0];
  const cols = shown.length + 4;

  function countable(w: Warehouse, r: WarehouseOverviewRow) {
    return canManage && w.kind !== "principal"
      ? () => onCount({ warehouse: w, productId: r.product_id, variantId: r.variant_id, name: rowName(r), current: qtyIn(r, w) })
      : undefined;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<Mode>
          aria-label="Cómo ver el stock"
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "table", label: "Todos los depósitos" },
            { value: "single", label: "Por depósito" },
          ]}
        />
        {mode === "table" && many && (
          <Dropdown>
            <DropdownTrigger asChild>
              <Button size="sm" variant="secondary" className="hidden md:inline-flex">
                <Columns3 size={15} /> Depósitos visibles ({shown.length} de {warehouses.length})
              </Button>
            </DropdownTrigger>
            <DropdownContent align="start" className="max-h-80 w-64 overflow-y-auto">
              <DropdownLabel>Columnas de la tabla</DropdownLabel>
              {warehouses.map((w) => {
                const on = visible.includes(w.id);
                return (
                  <label key={w.id} className="flex min-h-9 cursor-pointer items-center gap-2.5 rounded-md px-3 text-sm hover:bg-secondary/70">
                    <Checkbox
                      checked={on}
                      aria-label={w.name}
                      disabled={on && visible.length === 1}
                      onCheckedChange={(v) => setVisible((cur) => (v ? [...cur, w.id] : cur.filter((x) => x !== w.id)))}
                    />
                    <span className="min-w-0 flex-1 truncate">{w.name}</span>
                  </label>
                );
              })}
            </DropdownContent>
          </Dropdown>
        )}
      </div>

      {mode === "single" && singleWh && (
        <Segmented<string>
          scrollOnMobile
          aria-label="Depósito"
          size="sm"
          value={singleWh.id}
          onChange={setSingle}
          options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
        />
      )}

      {/* Celular: tarjetas. */}
      <ul className="space-y-2 md:hidden" aria-label="Stock por producto">
        {loading ? (
          <li className="py-6 text-center text-sm text-muted-foreground">Cargando stock…</li>
        ) : rows.length === 0 ? (
          <li className="py-6 text-center text-sm text-muted-foreground">Sin stock en esta sucursal.</li>
        ) : (
          rows.map((r) => {
            const list = mode === "single" && singleWh ? [singleWh] : warehouses;
            return (
              <li key={`${r.product_id}:${r.variant_id ?? ""}`} className="rounded-lg bg-card p-3 ring-1 ring-border">
                <div className="flex items-center gap-3">
                  <ProductThumb src={thumbs[r.product_id]} size={44} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{rowName(r)}</p>
                    {r.sku && <p className="truncate text-xs text-muted-foreground">{r.sku}</p>}
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold tabular-nums">{formatQty(r.store_qty)}</p>
                    <p className="text-[11px] text-muted-foreground">Sucursal</p>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {list.map((w) => {
                    const q = qtyIn(r, w);
                    if (w.kind !== "principal" && !q && mode === "table") return null;
                    const onClick = countable(w, r);
                    return (
                      <button
                        key={w.id}
                        type="button"
                        disabled={!onClick}
                        onClick={onClick}
                        className={cn(
                          "inline-flex min-h-8 items-center gap-1.5 rounded-md bg-muted px-2.5 text-xs disabled:cursor-default",
                          onClick && "hover:bg-fg-6",
                        )}
                      >
                        <span className="text-muted-foreground">{w.name}</span>
                        <span className={cn("font-semibold tabular-nums", q < 0 && "text-danger")}>{formatQty(q)}</span>
                      </button>
                    );
                  })}
                  {r.in_transit ? (
                    <span className="inline-flex min-h-8 items-center gap-1.5 rounded-md bg-muted px-2.5 text-xs">
                      <span className="text-muted-foreground">En tránsito</span>
                      <span className="font-semibold tabular-nums">{formatQty(r.in_transit)}</span>
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })
        )}
      </ul>

      {/* Desde md: tabla con producto y totales fijos. */}
      <TableWrap className="hidden md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="sticky left-0 z-10 min-w-[220px] bg-card px-3 py-2 font-medium">Producto</th>
              {mode === "single" && singleWh ? (
                <th className="px-3 py-2 text-right font-medium">{singleWh.name}</th>
              ) : (
                shown.map((w) => (
                  <th key={w.id} className="whitespace-nowrap px-3 py-2 text-right font-medium">
                    <span className="inline-flex items-center gap-1">
                      {w.name}
                      {!isSellable(w) && <span className="sr-only">(no se vende)</span>}
                    </span>
                  </th>
                ))
              )}
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">En tránsito</th>
              <th className="sticky right-[88px] z-10 whitespace-nowrap bg-card px-3 py-2 text-right font-medium">Vendible</th>
              <th className="sticky right-0 z-10 w-[88px] whitespace-nowrap bg-card px-3 py-2 text-right font-medium">Sucursal</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <TableStateRow colSpan={cols} loading />
            ) : rows.length === 0 ? (
              <TableStateRow colSpan={cols}>
                <span className="text-muted-foreground">Sin stock en esta sucursal.</span>
              </TableStateRow>
            ) : (
              rows.map((r) => {
                const st = salonStatus(r);
                const list = mode === "single" && singleWh ? [singleWh] : shown;
                return (
                  <tr key={`${r.product_id}:${r.variant_id ?? ""}`} className="border-b border-border last:border-0">
                    <td className="sticky left-0 z-[1] bg-card px-3 py-2">
                      <div className="flex items-center gap-3">
                        <ProductThumb src={thumbs[r.product_id]} size={36} />
                        <div className="min-w-0">
                          <p className="truncate font-medium">{rowName(r)}</p>
                          {r.sku && <p className="truncate text-xs text-muted-foreground">{r.sku}</p>}
                        </div>
                      </div>
                    </td>
                    {list.map((w) => {
                      const q = qtyIn(r, w);
                      const onClick = countable(w, r);
                      return (
                        <td key={w.id} className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                          {w.kind === "principal" ? (
                            <span className="inline-flex items-center gap-1.5">
                              {st !== "ok" && (
                                <Badge tone={st === "negative" ? "danger" : "warning"}>
                                  {st === "negative" ? "Reponer" : "Bajo mínimo"}
                                </Badge>
                              )}
                              <span className={cn(q < 0 && "text-danger")}>{formatQty(q)}</span>
                            </span>
                          ) : onClick ? (
                            <button type="button" className="min-h-9 rounded px-2 hover:bg-muted" title="Contar" onClick={onClick}>
                              {q ? formatQty(q) : "-"}
                            </button>
                          ) : q ? (
                            formatQty(q)
                          ) : (
                            "-"
                          )}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.in_transit ? formatQty(r.in_transit) : "-"}</td>
                    <td className="sticky right-[88px] z-[1] bg-card px-3 py-2 text-right tabular-nums">{formatQty(sellableQty(r, warehouses))}</td>
                    <td className="sticky right-0 z-[1] w-[88px] bg-card px-3 py-2 text-right font-medium tabular-nums">{formatQty(r.store_qty)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </TableWrap>
    </div>
  );
}
