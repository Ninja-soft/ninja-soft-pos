"use client";

import { memo, forwardRef, useSyncExternalStore } from "react";
import { Banknote, PackageSearch, ScanBarcode, Search, Star } from "lucide-react";
import type { Category, Product } from "@/modules/products/api";
import type { PosLayout } from "@/lib/pos/layout";
import { tileMinWidth } from "@/lib/pos/layout";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/lib/utils/cn";
import { CategoryChips } from "../ui/CategoryBar";
import { ProductTile } from "../ui/ProductTile";
import { QuickKeysGrid } from "../ui/QuickKeysGrid";
import { POS_EYEBROW } from "../ui/posStyles";
import type { ResolvedQuickKey } from "./types";

// Panel de productos del POS: búsqueda/escáner, rubros, teclas rápidas,
// frecuentes y la grilla. La forma de los tiles sale del diseño elegido.

// Placeholder del buscador según el ancho: en teléfonos el largo se corta
// ("Buscar por nombre, PLU, SKU..."), así que va uno corto. En el servidor se
// asume desktop y el cliente lo corrige al hidratar (sin mismatch).
const SMALL_SCREEN = "(max-width: 639px)";
function subscribeSmall(cb: () => void) {
  const mq = window.matchMedia(SMALL_SCREEN);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
function useSmallScreen() {
  return useSyncExternalStore(
    subscribeSmall,
    () => window.matchMedia(SMALL_SCREEN).matches,
    () => false,
  );
}

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
  const small = useSmallScreen();
  return (
    <div className="relative">
      <Search
        size={big ? 20 : 18}
        aria-hidden
        className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground"
      />
      <input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onEnter?.()}
        placeholder={placeholder ?? (small ? "Buscar producto o código" : "Buscar por nombre, PLU, SKU o código")}
        autoFocus
        aria-label="Buscar producto"
        className={cn(
          "w-full rounded-lg border border-border bg-card pl-11 pr-14 text-foreground outline-none transition-colors placeholder:text-muted-foreground hover:border-[color-mix(in_srgb,var(--foreground)_18%,transparent)] focus:border-[color-mix(in_srgb,var(--foreground)_28%,transparent)] focus-visible:!outline-none 2xl:pr-24",
          big ? "h-14 text-base font-medium sm:text-lg" : "h-11 text-[15px]",
        )}
      />
      <kbd className="pointer-events-none absolute right-14 top-1/2 hidden -translate-y-1/2 rounded bg-fg-6 px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground 2xl:block">
        F2
      </kbd>
      <button
        type="button"
        onClick={onScan}
        aria-label="Escanear código con la cámara"
        title="Escanear código"
        className="absolute right-1 top-1/2 grid h-9 w-11 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground"
      >
        <ScanBarcode size={20} aria-hidden />
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
      <EmptyState
        icon={PackageSearch}
        title="Sin resultados"
        description="Probá con otro nombre, PLU o código."
      />
    );
  }
  const photo = layout.preset === "boutique";
  const min = tileMinWidth(layout.tileSize, layout.preset);
  const gap = layout.density === "compact" ? 8 : layout.density === "spacious" ? 12 : 10;
  const tileH = layout.tileSize === "s" ? 80 : layout.tileSize === "m" ? 92 : 112;
  const template =
    layout.columns === "auto"
      ? // min(): en el celular siempre entran al menos dos columnas.
        `repeat(auto-fill, minmax(min(${min}px, calc(50% - ${gap / 2}px)), 1fr))`
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
    <div className="space-y-5">
      {!hideSearch && (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <PosSearch ref={searchRef} value={search} onChange={onSearch} onScan={onScan} />
          </div>
          {canFreeSale && (
            <button
              type="button"
              onClick={onFreeSale}
              className="flex h-11 shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-fg-4 max-xl:w-11 max-xl:justify-center max-xl:px-0"
              title="Venta libre (monto manual)"
              aria-label="Monto libre"
            >
              <Banknote size={18} className="text-muted-foreground" aria-hidden />
              <span className="hidden xl:inline">Monto libre</span>
            </button>
          )}
        </div>
      )}
      {browsing && menuBar}
      {browsing && layout.categoryBar !== "hidden" && categories.length > 0 && (
        // Con el riel lateral (Boutique) las pestañas sólo aparecen donde el
        // riel no entra.
        <div className={cn(layout.categoryBar === "left" && "xl:hidden")}>
          <CategoryChips categories={categories} selected={categoryFilter} onSelect={onCategory} />
        </div>
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
          <h2 className={cn("mb-2 flex items-center gap-1.5", POS_EYEBROW)}>
            <Star size={12} aria-hidden /> Frecuentes
          </h2>
          <ProductGrid products={frequent} layout={{ ...layout, columns: "auto" }} onPick={onPickProduct} />
        </section>
      )}
      <section aria-label="Productos">
        {(showQuick || showFrequent || categoryPath) && (
          <h2 className={cn("mb-2", POS_EYEBROW)}>
            {categoryPath ?? (browsing ? "Todos los productos" : "Resultados")}
          </h2>
        )}
        <ProductGrid products={products} loading={loading} layout={layout} onPick={onPickProduct} />
      </section>
    </div>
  );
}
