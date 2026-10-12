"use client";

import { memo, forwardRef } from "react";
import { Banknote, PackageSearch, ScanBarcode, Search, Star } from "lucide-react";
import type { Category, Product } from "@/modules/products/api";
import type { PosLayout } from "@/lib/pos/layout";
import { tileMinWidth } from "@/lib/pos/layout";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils/cn";
import { CategoryChips } from "../ui/CategoryBar";
import { ProductTile } from "../ui/ProductTile";
import { QuickKeysGrid } from "../ui/QuickKeysGrid";
import type { ResolvedQuickKey } from "./types";

// Panel de productos del POS: búsqueda/escáner, rubros, teclas rápidas,
// frecuentes y la grilla. La forma de los tiles sale del diseño elegido.

export const PosSearch = forwardRef<
  HTMLInputElement,
  {
    value: string;
    onChange: (v: string) => void;
    onScan: () => void;
    placeholder?: string;
    big?: boolean;
    onEnter?: () => void;
  }
>(function PosSearch({ value, onChange, onScan, placeholder, big, onEnter }, ref) {
  return (
    <div className="relative">
      <Search
        size={big ? 20 : 17}
        className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground"
      />
      <input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onEnter?.()}
        placeholder={placeholder ?? "Buscar por nombre, PLU, SKU o código"}
        autoFocus
        aria-label="Buscar producto"
        className={cn(
          "w-full rounded-2xl bg-card pl-11 pr-14 text-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none transition placeholder:text-muted-foreground focus:shadow-[inset_0_0_0_2px_var(--pos-from)]",
          big ? "h-16 text-lg font-semibold" : "h-12 text-[15px]",
        )}
      />
      <kbd className="pointer-events-none absolute right-14 top-1/2 hidden -translate-y-1/2 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] font-bold text-muted-foreground xl:block">
        F2
      </kbd>
      <button
        type="button"
        onClick={onScan}
        aria-label="Escanear código con la cámara"
        title="Escanear código"
        className="absolute right-1.5 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-xl text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        <ScanBarcode size={20} />
      </button>
    </div>
  );
});

export const ProductGrid = memo(function ProductGrid({
  products,
  loading,
  layout,
  onPick,
}: {
  products: Product[] | undefined;
  loading?: boolean;
  layout: PosLayout;
  onPick: (p: Product) => void;
}) {
  if (!products && loading) return <SpinnerBlock />;
  if (products && products.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-14 text-center">
        <PackageSearch size={30} className="text-muted-foreground" />
        <p className="text-sm font-bold">Sin resultados</p>
        <p className="text-xs text-muted-foreground">Probá con otro nombre, PLU o código.</p>
      </div>
    );
  }
  const photo = layout.preset === "boutique";
  const min = tileMinWidth(layout.tileSize, layout.preset);
  const gap = layout.density === "compact" ? 8 : layout.density === "spacious" ? 14 : 10;
  const tileH = layout.tileSize === "s" ? 84 : layout.tileSize === "m" ? 96 : 118;
  const template =
    layout.columns === "auto"
      ? `repeat(auto-fill, minmax(${min}px, 1fr))`
      : `repeat(${layout.columns}, minmax(0, 1fr))`;
  return (
    <div
      className={cn("grid", layout.columns !== "auto" && "max-sm:!grid-cols-2")}
      style={{ gridTemplateColumns: template, gap, ["--tile-h" as string]: `${tileH}px` }}
    >
      {products?.map((p) => (
        <ProductTile
          key={p.id}
          product={p}
          variant={photo ? "photo" : "text"}
          showImage={layout.showImages}
          showStock={layout.showStock}
          onPick={onPick}
        />
      ))}
    </div>
  );
});

export function ProductPane({
  layout,
  search,
  onSearch,
  onScan,
  searchRef,
  canFreeSale,
  onFreeSale,
  menuBar,
  categories,
  categoryFilter,
  onCategory,
  quickKeys,
  quickKeysTitle,
  frequent,
  categoryPath,
  products,
  loading,
  onPickProduct,
  onQuickUnits,
  onQuickWeight,
  hideSearch,
}: {
  layout: PosLayout;
  search: string;
  onSearch: (v: string) => void;
  onScan: () => void;
  searchRef?: React.Ref<HTMLInputElement>;
  canFreeSale: boolean;
  onFreeSale: () => void;
  menuBar?: React.ReactNode;
  categories: Category[];
  categoryFilter: string | null;
  onCategory: (id: string | null) => void;
  quickKeys: ResolvedQuickKey[];
  quickKeysTitle: string;
  frequent: Product[] | undefined;
  categoryPath: string | null;
  products: Product[] | undefined;
  loading?: boolean;
  onPickProduct: (p: Product) => void;
  onQuickUnits: (p: Product, q: number) => void;
  onQuickWeight: (p: Product, kg: number) => void;
  hideSearch?: boolean;
}) {
  const browsing = !search.trim();
  const showQuick = browsing && !categoryFilter && quickKeys.length > 0;
  const showFrequent = browsing && !categoryFilter && (frequent?.length ?? 0) > 0;
  const min = tileMinWidth(layout.tileSize, "mostrador");
  return (
    <div className="space-y-4">
      {!hideSearch && (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <PosSearch ref={searchRef} value={search} onChange={onSearch} onScan={onScan} />
          </div>
          {canFreeSale && (
            <button
              type="button"
              onClick={onFreeSale}
              className="flex h-12 shrink-0 items-center gap-2 rounded-2xl bg-card px-3.5 text-[13px] font-bold shadow-[inset_0_0_0_1px_var(--border)] transition hover:bg-muted"
              title="Venta libre (monto manual)"
            >
              <Banknote size={17} />
              <span className="hidden sm:inline">Monto libre</span>
            </button>
          )}
        </div>
      )}
      {browsing && menuBar}
      {browsing && layout.categoryBar === "top" && categories.length > 0 && (
        <CategoryChips categories={categories} selected={categoryFilter} onSelect={onCategory} />
      )}
      {showQuick && (
        <QuickKeysGrid
          keys={quickKeys}
          title={quickKeysTitle}
          minWidth={Math.max(130, min + 10)}
          onTap={onPickProduct}
          onQuickUnits={onQuickUnits}
          onQuickWeight={onQuickWeight}
        />
      )}
      {showFrequent && (
        <section aria-label="Frecuentes">
          <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            <Star size={12} /> Frecuentes
          </h2>
          <ProductGrid products={frequent} layout={{ ...layout, columns: "auto" }} onPick={onPickProduct} />
        </section>
      )}
      <section aria-label="Productos">
        {(showQuick || showFrequent || categoryPath) && (
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {categoryPath ?? (browsing ? "Todos los productos" : "Resultados")}
          </h2>
        )}
        <ProductGrid products={products} loading={loading} layout={layout} onPick={onPickProduct} />
      </section>
    </div>
  );
}
