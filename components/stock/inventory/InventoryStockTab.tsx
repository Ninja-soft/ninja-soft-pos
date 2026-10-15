"use client";

// Stock actual de la sucursal (ADR-137): una fila por producto o variante con
// la foto, los códigos, el stock y el desglose por depósito. Mobile-first: en
// el celular cada fila es una tarjeta compacta; el botón Ajustar abre el alta
// del ajuste con el producto ya elegido.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PackageSearch, SlidersHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination } from "@/components/ui/Pagination";
import { SearchField } from "@/components/ui/SearchField";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { ProductThumb } from "@/components/products/ProductThumb";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { isLow, type StockSheetRow } from "@/lib/stock/inventorySheet";
import { useInventorySheet } from "@/modules/stock/adjustments";
import { useWarehouses } from "@/modules/stock/warehouses";

const PAGE_SIZE = 40;

export function InventoryStockTab({
  storeId,
  canAdjust,
  showCost,
  withWarehouses,
  onAdjust,
}: {
  storeId: string | null;
  canAdjust: boolean;
  showCost: boolean;
  withWarehouses: boolean;
  onAdjust: (row: StockSheetRow) => void;
}) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [onlyWithStock, setOnlyWithStock] = useState(false);
  const [page, setPage] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setPage(0), [debounced, onlyWithStock, storeId]);

  const { data: rows = [], isLoading, isFetching, isError } = useInventorySheet({
    storeId,
    search: debounced,
    onlyWithStock,
    page,
    pageSize: PAGE_SIZE,
  });
  const { data: warehouses = [] } = useWarehouses(withWarehouses ? storeId : null);
  const whName = useMemo(() => new Map(warehouses.map((w) => [w.id, w.name])), [warehouses]);
  const total = rows[0]?.total_count ?? 0;
  const filtered = debounced.trim() !== "" || onlyWithStock;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <SearchField
          value={search}
          onValueChange={setSearch}
          loading={isFetching && !isLoading}
          placeholder="Buscá por nombre, SKU o código de barras"
          aria-label="Buscar producto"
          className="sm:max-w-md"
        />
        <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-muted-foreground sm:ml-2">
          <Checkbox checked={onlyWithStock} onCheckedChange={setOnlyWithStock} aria-label="Sólo con stock" />
          Sólo con stock
        </label>
      </div>

      {isLoading ? (
        <SpinnerBlock label="Cargando stock" />
      ) : isError ? (
        <EmptyState
          compact
          icon={PackageSearch}
          title="No pudimos cargar el stock"
          description="Revisá la conexión y probá de nuevo."
        />
      ) : rows.length === 0 ? (
        filtered ? (
          <EmptyState
            compact
            icon={PackageSearch}
            title="No hay productos con ese filtro"
            description="Probá con otra búsqueda o sacá el filtro de stock."
            action={
              <Button variant="secondary" size="sm" onClick={() => { setSearch(""); setOnlyWithStock(false); }}>
                Ver todos
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={PackageSearch}
            title="Acá vas a ver el stock de cada producto"
            description="Todavía no hay productos que controlen stock. Cargalos en Productos o importalos desde Excel."
            action={
              <Link
                href="/productos"
                className="inline-flex h-11 items-center rounded-lg bg-[var(--pos-solid)] px-5 text-sm font-semibold text-white"
              >
                Ir a Productos
              </Link>
            }
          />
        )
      ) : (
        <>
          <ul className="divide-y divide-border overflow-hidden rounded-lg bg-card ring-1 ring-border">
            {rows.map((r) => {
              const low = isLow(r);
              const extra = Object.entries(r.by_warehouse).filter(([, q]) => q !== 0);
              return (
                <li key={`${r.product_id}:${r.variant_id ?? ""}`} className="flex items-start gap-3 p-3">
                  <ProductThumb src={r.image_url} size={48} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {r.product_name}
                      {r.variant_label ? <span className="text-muted-foreground"> · {r.variant_label}</span> : null}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {[r.sku, r.barcode, r.category_name].filter(Boolean).join(" · ") || "Sin código"}
                      {showCost && r.cost != null ? ` · costo ${formatCurrency(r.cost)}` : ""}
                    </p>
                    {(extra.length > 0 || r.location) && (
                      <p className="mt-1 flex flex-wrap gap-1">
                        {r.principal_qty != null && extra.length > 0 && (
                          <Badge tone="neutral">Salón {formatQty(r.principal_qty)}</Badge>
                        )}
                        {extra.map(([id, q]) => (
                          <Badge key={id} tone="neutral">
                            {whName.get(id) ?? "Depósito"} {formatQty(q)}
                          </Badge>
                        ))}
                        {r.location && <Badge tone="neutral">{r.location}</Badge>}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <p className="text-right">
                      <span
                        className={
                          r.store_qty < 0
                            ? "text-lg font-bold tabular-nums text-danger"
                            : "text-lg font-bold tabular-nums"
                        }
                      >
                        {formatQty(r.store_qty)}
                      </span>
                      <span className="ml-1 text-xs text-muted-foreground">{r.unit}</span>
                    </p>
                    {r.store_qty < 0 ? (
                      <Badge tone="danger">Negativo</Badge>
                    ) : low ? (
                      <Badge tone="warning">Bajo el mínimo</Badge>
                    ) : null}
                    {canAdjust && (
                      <Button variant="secondary" size="sm" onClick={() => onAdjust(r)} aria-label={`Ajustar ${r.product_name}`}>
                        <SlidersHorizontal size={14} /> Ajustar
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <Pagination
            page={page + 1}
            pageSize={PAGE_SIZE}
            total={total}
            loading={isFetching}
            onPageChange={(p) => setPage(p - 1)}
          />
        </>
      )}
    </div>
  );
}
