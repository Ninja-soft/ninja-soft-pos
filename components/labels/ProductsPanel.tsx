"use client";

import { useMemo, useState } from "react";
import { ListChecks, Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { NoData } from "@/components/ui/NoData";
import { Checkbox } from "@/components/ui/Checkbox";
import { Disclosure } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/ui/EmptyState";
import { SearchField } from "@/components/ui/SearchField";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { TableStateRow } from "@/components/ui/Table";
import { selectCls } from "@/components/stock/transfers/shared";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { clampCopies, parseNetContent, type LabelCatalogRow, type QtyMode } from "@/lib/labels/items";
import type { Category } from "@/modules/products/api";
import { CategoryTreePicker } from "./CategoryTreePicker";

export type Scope = "stock" | "all" | "pick";

export interface RowOverride {
  copies?: number;
  prevPrice?: number | null;
}

export interface ProductsPanelProps {
  scope: Scope;
  onScope: (s: Scope) => void;
  stores: { id: string; name: string }[];
  storeId: string | null;
  onStore: (id: string | null) => void;
  warehouses: { id: string; name: string; kind: string }[];
  warehouseId: string | null;
  onWarehouse: (id: string | null) => void;
  categories: Category[];
  categoryIds: string[];
  onCategories: (ids: string[]) => void;
  brands: { id: string; name: string }[];
  brandIds: string[];
  onBrands: (ids: string[]) => void;
  search: string;
  onSearch: (s: string) => void;
  includeVariants: boolean;
  onIncludeVariants: (v: boolean) => void;
  qtyMode: QtyMode;
  onQtyMode: (m: QtyMode) => void;
  fixedQty: number;
  onFixedQty: (n: number) => void;
  rows: LabelCatalogRow[];
  loading: boolean;
  error: boolean;
  /** Modo "elegir": resultados de la búsqueda para sumar. */
  searchResults: LabelCatalogRow[];
  searchLoading: boolean;
  pickedIds: string[];
  onPick: (productId: string) => void;
  onUnpick: (productId: string) => void;
  excluded: Set<string>;
  onToggleRow: (key: string) => void;
  onToggleAll: (on: boolean) => void;
  overrides: Record<string, RowOverride>;
  onOverride: (key: string, o: RowOverride) => void;
  copiesOf: (row: LabelCatalogRow) => number;
  priceOf: (row: LabelCatalogRow) => number;
  showPrev: boolean;
  showContent: boolean;
  onSaveContent: (productId: string, text: string) => void;
  canEditProducts: boolean;
}

export const rowKey = (r: Pick<LabelCatalogRow, "product_id" | "variant_id">) => `${r.product_id}:${r.variant_id ?? ""}`;

const PAGE = 80;

export function ProductsPanel(p: ProductsPanelProps) {
  const [visible, setVisible] = useState(PAGE);
  const selectedCount = useMemo(() => p.rows.filter((r) => !p.excluded.has(rowKey(r))).length, [p.rows, p.excluded]);
  const filtersOn = p.categoryIds.length + p.brandIds.length + (p.search && p.scope !== "pick" ? 1 : 0);
  const allOn = selectedCount === p.rows.length && p.rows.length > 0;

  return (
    <div className="space-y-4">
      <Segmented<Scope>
        aria-label="Qué etiquetar"
        value={p.scope}
        onChange={(v) => {
          p.onScope(v);
          setVisible(PAGE);
        }}
        fill
        options={[
          { value: "stock", label: "Con stock" },
          { value: "all", label: "Todo" },
          { value: "pick", label: "Elegir" },
        ]}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-muted-foreground">Sucursal</span>
          <select
            className={selectCls}
            value={p.storeId ?? ""}
            onChange={(e) => p.onStore(e.target.value || null)}
            aria-label="Sucursal"
          >
            <option value="">Todas las sucursales</option>
            {p.stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-muted-foreground">Depósito</span>
          <select
            className={selectCls}
            value={p.warehouseId ?? ""}
            onChange={(e) => p.onWarehouse(e.target.value || null)}
            disabled={!p.storeId || p.warehouses.length === 0}
            aria-label="Depósito"
          >
            <option value="">{p.storeId ? "Toda la sucursal" : "Elegí una sucursal"}</option>
            {p.warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
                {w.kind === "principal" ? " (salón)" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="-mt-1 text-xs text-muted-foreground">
        El precio sale de la lista de la sucursal elegida (o de mostrador) y el stock, de la sucursal o el depósito.
      </p>

      {p.scope === "pick" ? (
        <div className="space-y-2">
          <SearchField
            value={p.search}
            onValueChange={p.onSearch}
            loading={p.searchLoading}
            placeholder="Buscá por nombre, PLU, SKU o código para sumar"
          />
          {p.search.trim().length >= 2 && (
            <div className="slim-scrollbar max-h-60 divide-y divide-border overflow-y-auto rounded-lg border border-border">
              {p.searchResults.length === 0 && !p.searchLoading && (
                <p className="px-3 py-3 text-sm text-muted-foreground">Sin resultados para esa búsqueda.</p>
              )}
              {dedupeProducts(p.searchResults).map((r) => {
                const picked = p.pickedIds.includes(r.product_id);
                return (
                  <button
                    key={r.product_id}
                    type="button"
                    onClick={() => (picked ? p.onUnpick(r.product_id) : p.onPick(r.product_id))}
                    className="flex min-h-[44px] w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted/50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{r.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {[r.brand, r.sku, r.barcode].filter(Boolean).join(" · ") || "Sin código"}
                      </span>
                    </span>
                    {picked ? (
                      <Badge tone="success">Sumado</Badge>
                    ) : (
                      <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-ninja-flameSoft">
                        <Plus size={14} /> Sumar
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <Disclosure
          title={
            <span className="flex items-center gap-2">
              Filtros {filtersOn > 0 && <Badge tone="brand">{filtersOn}</Badge>}
            </span>
          }
          defaultOpen={filtersOn > 0}
        >
          <div className="space-y-4 pt-1">
            <SearchField value={p.search} onValueChange={p.onSearch} placeholder="Nombre, PLU, SKU o código" />
            <CategoryTreePicker categories={p.categories} value={p.categoryIds} onChange={p.onCategories} />
            {p.brands.length > 0 && (
              <div>
                <div className="mb-1.5 flex items-center justify-between px-1">
                  <span className="text-xs font-semibold text-muted-foreground">Marcas</span>
                  {p.brandIds.length > 0 && (
                    <button type="button" onClick={() => p.onBrands([])} className="text-xs font-semibold text-ninja-flameSoft hover:underline">
                      Limpiar ({p.brandIds.length})
                    </button>
                  )}
                </div>
                <div className="slim-scrollbar flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                  {p.brands.map((b) => {
                    const on = p.brandIds.includes(b.id);
                    return (
                      <button
                        key={b.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => p.onBrands(on ? p.brandIds.filter((x) => x !== b.id) : [...p.brandIds, b.id])}
                        className={cn(
                          "min-h-[32px] rounded-md border px-2.5 text-xs font-semibold transition",
                          on ? "border-foreground bg-foreground text-background" : "border-border bg-background text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {b.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </Disclosure>
      )}

      <div className="grid gap-3 rounded-lg border border-border bg-muted/30 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-semibold">Cantidad por producto</span>
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            Una por variante
            <Switch checked={p.includeVariants} onCheckedChange={p.onIncludeVariants} label="Una etiqueta por variante" />
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<QtyMode>
            aria-label="Cantidad de etiquetas"
            size="sm"
            value={p.qtyMode}
            onChange={p.onQtyMode}
            options={[
              { value: "one", label: "Una" },
              { value: "stock", label: "Igual al stock" },
              { value: "fixed", label: "Fija" },
            ]}
          />
          {p.qtyMode === "fixed" && (
            <input
              type="number"
              min={1}
              max={500}
              inputMode="numeric"
              value={p.fixedQty}
              onChange={(e) => p.onFixedQty(clampCopies(Number(e.target.value)) || 1)}
              aria-label="Etiquetas por producto"
              className="h-9 w-20 rounded-lg border border-input bg-background px-2 text-right text-sm outline-none focus:border-ninja-flameSoft"
            />
          )}
        </div>
        {p.qtyMode === "stock" && (
          <p className="text-xs text-muted-foreground">Los que se venden por peso o con decimales redondean para arriba. Sin stock, no salen.</p>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-2">
          <label className="flex items-center gap-2 text-sm font-semibold">
            <Checkbox
              checked={allOn ? true : selectedCount > 0 ? "indeterminate" : false}
              onCheckedChange={(v) => p.onToggleAll(v)}
              disabled={p.rows.length === 0}
              aria-label="Marcar todos"
            />
            {p.rows.length === 0 ? "Productos" : `${selectedCount} de ${p.rows.length} productos`}
          </label>
          {p.rows.length >= 3000 && <Badge tone="warning">Se muestran los primeros 3000</Badge>}
        </div>
        <div className="slim-scrollbar max-h-[460px] overflow-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="sticky top-0 z-[1] bg-card text-left text-xs uppercase tracking-[0.12em] text-muted-foreground">
              <tr>
                <th className="w-10 px-3 py-2" />
                <th className="px-2 py-2">Producto</th>
                <th className="px-2 py-2 text-right">Stock</th>
                <th className="px-2 py-2 text-right">Precio</th>
                {p.showPrev && <th className="px-2 py-2 text-right">Antes</th>}
                {p.showContent && <th className="px-2 py-2">Contenido</th>}
                <th className="px-3 py-2 text-right">Etiq.</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {p.loading && p.rows.length === 0 && <TableStateRow colSpan={7} loading />}
              {p.error && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-sm text-danger">
                    No pudimos traer los productos. Probá de nuevo en un rato.
                  </td>
                </tr>
              )}
              {!p.loading && !p.error && p.rows.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <EmptyState
                      compact
                      icon={ListChecks}
                      title={p.scope === "pick" ? "Sumá productos con el buscador" : "Nada para etiquetar con estos filtros"}
                      description={p.scope === "stock" ? "Probá con Todo o con otra sucursal." : undefined}
                    />
                  </td>
                </tr>
              )}
              {p.rows.slice(0, visible).map((r) => {
                const key = rowKey(r);
                const on = !p.excluded.has(key);
                const copies = p.copiesOf(r);
                const ov = p.overrides[key];
                return (
                  <tr key={key} className={cn("align-middle", !on && "opacity-50")}>
                    <td className="px-3 py-1.5">
                      <Checkbox checked={on} onCheckedChange={() => p.onToggleRow(key)} aria-label={`Etiquetar ${r.name}`} />
                    </td>
                    <td className="max-w-[170px] px-2 py-1.5 sm:max-w-[240px]">
                      <div className="truncate font-medium">{r.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {[r.variant_label, r.brand, r.plu ? `PLU ${r.plu}` : null, r.barcode || r.sku].filter(Boolean).join(" · ") || "Sin código"}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                      {r.stock == null ? <NoData /> : Number(r.stock).toLocaleString("es-AR", { maximumFractionDigits: 3 })}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{formatCurrency(p.priceOf(r))}</td>
                    {p.showPrev && (
                      <td className="px-2 py-1.5 text-right">
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          inputMode="decimal"
                          placeholder="Sin"
                          value={ov?.prevPrice ?? ""}
                          onChange={(e) => p.onOverride(key, { ...ov, prevPrice: e.target.value === "" ? null : Number(e.target.value) })}
                          aria-label={`Precio anterior de ${r.name}`}
                          className="h-8 w-24 rounded-md border border-input bg-background px-2 text-right text-sm outline-none focus:border-ninja-flameSoft"
                        />
                      </td>
                    )}
                    {p.showContent && (
                      <td className="px-2 py-1.5">
                        <ContentCell row={r} disabled={!p.canEditProducts} onSave={(t) => p.onSaveContent(r.product_id, t)} />
                      </td>
                    )}
                    <td className="px-3 py-1.5 text-right">
                      <input
                        type="number"
                        min={0}
                        max={500}
                        inputMode="numeric"
                        disabled={!on}
                        value={ov?.copies ?? copies}
                        onChange={(e) => p.onOverride(key, { ...ov, copies: clampCopies(Number(e.target.value)) })}
                        aria-label={`Etiquetas de ${r.name}`}
                        className="h-8 w-14 rounded-md border border-input bg-background px-2 text-right text-sm outline-none focus:border-ninja-flameSoft disabled:opacity-40"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {p.rows.length > visible && (
          <button
            type="button"
            onClick={() => setVisible((v) => v + PAGE * 2)}
            className="block min-h-[44px] w-full border-t border-border text-sm font-semibold text-ninja-flameSoft hover:bg-muted/40"
          >
            Ver más ({p.rows.length - visible} restantes, igual se imprimen)
          </button>
        )}
      </div>
      {p.scope === "pick" && p.pickedIds.length > 0 && (
        <button type="button" onClick={() => p.pickedIds.forEach(p.onUnpick)} className="flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-foreground">
          <X size={13} /> Vaciar la selección
        </button>
      )}
    </div>
  );
}

function dedupeProducts(rows: LabelCatalogRow[]): LabelCatalogRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.product_id) ? false : (seen.add(r.product_id), true)));
}

function ContentCell({ row, disabled, onSave }: { row: LabelCatalogRow; disabled: boolean; onSave: (text: string) => void }) {
  const current = row.net_content ? `${String(row.net_content).replace(".", ",")} ${row.net_content_unit ?? ""}`.trim() : "";
  const guessed = !current ? parseNetContent(row.name) : null;
  const [text, setText] = useState(current);
  return (
    <input
      value={text}
      disabled={disabled}
      placeholder={guessed ? `${String(guessed.qty).replace(".", ",")} ${guessed.unit}` : "ej. 900 ml"}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text.trim() !== current) onSave(text);
      }}
      aria-label={`Contenido neto de ${row.name}`}
      title={guessed ? "Tomado del nombre. Escribilo para fijarlo." : "Contenido neto para el precio por kg o litro"}
      className="h-8 w-20 rounded-md border border-input bg-background px-2 text-sm outline-none placeholder:text-muted-foreground/70 focus:border-ninja-flameSoft disabled:opacity-50"
    />
  );
}
