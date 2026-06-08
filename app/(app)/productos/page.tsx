"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Download,
  FolderTree,
  History,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Tag,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Pagination } from "@/components/ui/Pagination";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { InfoHint } from "@/components/ui/InfoHint";
import { useToast } from "@/components/ui/Toast";
import { GatedButton } from "@/components/saas/GatedAction";
import { ProductFormModal } from "@/components/products/ProductFormModal";
import { StockAdjustModal } from "@/components/products/StockAdjustModal";
import { StockHistoryModal } from "@/components/products/StockHistoryModal";
import { ImportProductsModal } from "@/components/products/ImportProductsModal";
import { BrandsModal } from "@/components/products/BrandsModal";
import { CategoriesModal } from "@/components/products/CategoriesModal";
import { WarrantyPlansModal } from "@/components/products/WarrantyPlansModal";
import {
  useProductsPaged,
  useProductMutations,
  useCategories,
  useBrands,
  usePluSettings,
} from "@/modules/products/hooks";
import { FirstProductPluPrompt } from "@/components/products/FirstProductPluPrompt";
import type { Product } from "@/modules/products/api";
import {
  useCatalogHintsActive,
  useCatalogPriceReferences,
} from "@/modules/catalog/hooks";
import { CatalogPriceArrow } from "@/components/catalog/CatalogPriceArrow";
import { usePageSize } from "@/hooks/usePageSize";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { createClient } from "@/lib/supabase/client";
import { exportXlsx } from "@/lib/utils/xlsx";
import { formatCurrency, formatQty } from "@/lib/utils/format";

export default function ProductosPage() {
  const pageSize = usePageSize();
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [brandsOpen, setBrandsOpen] = useState(false);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [warrantyOpen, setWarrantyOpen] = useState(false);
  const [pluPromptOpen, setPluPromptOpen] = useState(false);
  const [categoryId, setCategoryId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Product | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);
  const { toast } = useToast();
  const debouncedSearch = useDebouncedValue(search, 350);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, categoryId, brandId, pageSize]);

  const { data: categories } = useCategories();
  const { data: brands } = useBrands();
  const { data, isLoading, isError, isPlaceholderData, refetch } = useProductsPaged({
    page,
    pageSize,
    search: debouncedSearch,
    categoryId: categoryId || null,
    brandId: brandId || null,
  });
  const products = data?.rows ?? [];
  const total = data?.total ?? 0;
  const { remove } = useProductMutations();
  const { data: pluSettings } = usePluSettings();
  const noFilters = !debouncedSearch && !categoryId && !brandId;

  // Comparación de precios vs catálogo de referencia: sólo si el tenant compró
  // un catálogo y tiene la sugerencia activada. Las referencias de los EANs
  // visibles se traen en batch (sin N+1).
  const { active: hintsActive } = useCatalogHintsActive();
  const visibleEans = useMemo(
    () =>
      (data?.rows ?? [])
        .map((p) => (p.barcode ?? "").trim())
        .filter((b): b is string => b.length > 0),
    [data],
  );
  const { data: priceRefs } = useCatalogPriceReferences(
    visibleEans,
    hintsActive,
  );

  function openNew() {
    setSelected(null);
    // Primer producto del tenant y todavía no se decidió el PLU → preguntamos
    // (modal Tailwind) si lo quiere activar antes de abrir el alta. Una sola vez.
    if (
      noFilters &&
      total === 0 &&
      pluSettings &&
      !pluSettings.decided
    ) {
      setPluPromptOpen(true);
      return;
    }
    setFormOpen(true);
  }
  function openEdit(p: Product) {
    setSelected(p);
    setFormOpen(true);
  }
  function openAdjust(p: Product) {
    setSelected(p);
    setAdjustOpen(true);
  }
  function openHistory(p: Product) {
    setSelected(p);
    setHistoryOpen(true);
  }
  async function exportBase() {
    const supabase = createClient();
    const { data } = await supabase
      .from("products")
      .select("name, sku, barcode, price, cost, stock, stock_min, unit, categories(name)")
      .is("deleted_at", null)
      .order("name", { ascending: true });
    const rows = (data ?? []).map((p) => ({
      name: p.name,
      sku: p.sku ?? "",
      barcode: p.barcode ?? "",
      price: p.price,
      cost: p.cost ?? "",
      stock: p.stock,
      stock_min: p.stock_min ?? "",
      unit: p.unit,
      category:
        (p.categories as unknown as { name: string } | null)?.name ?? "",
    }));
    await exportXlsx("productos", [
      {
        name: "Productos",
        title: "Base de productos • NinjaPos",
        columns: [
          { header: "name", key: "name" },
          { header: "sku", key: "sku" },
          { header: "barcode", key: "barcode" },
          { header: "price", key: "price", type: "money" },
          { header: "cost", key: "cost", type: "money" },
          { header: "stock", key: "stock", type: "number" },
          { header: "stock_min", key: "stock_min", type: "number" },
          { header: "unit", key: "unit" },
          { header: "category", key: "category" },
        ],
        rows,
      },
    ]);
  }

  async function onDelete(p: Product) {
    setDeleteTarget(p);
  }

  async function confirmDelete(_reason?: string) {
    if (!deleteTarget) return;
    try {
      await remove.mutateAsync(deleteTarget.id);
      toast({ title: "Producto eliminado", variant: "success" });
    } catch {
      toast({ title: "No se pudo eliminar", variant: "error" });
    } finally {
      setDeleteTarget(null);
    }
  }

  return (
    <>
<div className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Eyebrow>Catálogo</Eyebrow>
            <Display className="mt-3 flex items-center gap-2 text-3xl md:text-4xl">
              Productos
              <InfoHint section="productos" size={18} />
            </Display>
          </div>
          <div className="-mx-6 flex gap-2 overflow-x-auto px-6 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <GatedButton
              feature="export_xlsx"
              featureLabel="Exportar a Excel"
              variant="secondary"
              className="shrink-0"
              onClick={exportBase}
            >
              <Download size={16} /> Exportar XLSX
            </GatedButton>
            <GatedButton
              feature="importacion_excel"
              featureLabel="Importación desde Excel"
              variant="secondary"
              className="shrink-0"
              onClick={() => setImportOpen(true)}
            >
              <Upload size={16} /> Importar XLSX
            </GatedButton>
            <Button variant="secondary" className="shrink-0" onClick={() => setCategoriesOpen(true)}>
              <FolderTree size={16} /> Categorías
            </Button>
            <Button variant="secondary" className="shrink-0" onClick={() => setBrandsOpen(true)}>
              <Tag size={16} /> Marcas
            </Button>
            <GatedButton
              feature="garantias"
              featureLabel="Garantías"
              variant="secondary"
              className="shrink-0"
              onClick={() => setWarrantyOpen(true)}
            >
              <ShieldCheck size={16} /> Garantías
            </GatedButton>
            <Button className="shrink-0" onClick={openNew}>
              <Plus size={16} /> Nuevo producto
            </Button>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-md">
            <Search
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nombre, SKU o código…"
              className="h-11 w-full rounded-lg border border-input bg-background pl-9 pr-4 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15"
            />
          </div>
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="h-11 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
          >
            <option value="">Todas las categorías</option>
            {(categories ?? []).map((c) => (
              <option key={c.id} value={c.id} className="bg-ninja-deepViolet">
                {c.name}
              </option>
            ))}
          </select>
          <select
            value={brandId}
            onChange={(e) => setBrandId(e.target.value)}
            className="h-11 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
          >
            <option value="">Todas las marcas</option>
            {(brands ?? []).map((b) => (
              <option key={b.id} value={b.id} className="bg-ninja-deepViolet">
                {b.name}
              </option>
            ))}
          </select>
        </div>

        <div className="mt-6 overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-muted text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Producto</th>
                <th className="px-4 py-3">Categoría</th>
                <th className="px-4 py-3 text-right">Precio</th>
                <th className="px-4 py-3 text-right">Stock</th>
                <th className="px-4 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border text-foreground">
              {isLoading && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                    Cargando productos…
                  </td>
                </tr>
              )}
              {isError && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-red-300">
                    Error al cargar.{" "}
                    <button onClick={() => refetch()} className="underline">
                      Reintentar
                    </button>
                  </td>
                </tr>
              )}
              {!isLoading && !isError && products.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                    {search || categoryId || brandId
                      ? "Sin resultados para el filtro."
                      : "No hay productos todavía. Creá el primero con “Nuevo producto”."}
                  </td>
                </tr>
              )}
              {products.map((p) => {
                const low =
                  (p.stock_min ?? 0) > 0 && p.stock <= (p.stock_min ?? 0);
                return (
                  <tr key={p.id} className="transition hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground">{p.name}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        {p.plu && (
                          <span className="inline-flex items-center rounded bg-ninja-flame/10 px-1.5 py-0.5 font-mono text-xs font-semibold text-ninja-flameSoft">
                            PLU {p.plu}
                          </span>
                        )}
                        {p.sku && (
                          <span className="font-mono text-xs text-muted-foreground">
                            {p.sku}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {p.categories?.name ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="inline-flex items-center justify-end gap-1.5">
                        {formatCurrency(p.price)}
                        {hintsActive && p.barcode && (
                          <CatalogPriceArrow
                            myPrice={Number(p.price)}
                            reference={priceRefs?.get(p.barcode.trim())}
                          />
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={low ? "font-semibold text-[#FFD21F]" : ""}>
                        {formatQty(p.stock)} {p.unit}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <button
                          onClick={() => openAdjust(p)}
                          title="Ajustar stock"
                          className="rounded-md p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                        >
                          <SlidersHorizontal size={16} />
                        </button>
                        <button
                          onClick={() => openHistory(p)}
                          title="Historial de stock"
                          className="rounded-md p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                        >
                          <History size={16} />
                        </button>
                        <button
                          onClick={() => openEdit(p)}
                          title="Editar"
                          className="rounded-md p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          onClick={() => onDelete(p)}
                          title="Eliminar"
                          className="rounded-md p-2 text-muted-foreground transition hover:bg-red-400/15 hover:text-red-300"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          loading={isPlaceholderData}
        />
      </div>

      <ProductFormModal
        open={formOpen}
        onOpenChange={setFormOpen}
        product={selected}
      />
      <StockAdjustModal
        open={adjustOpen}
        onOpenChange={setAdjustOpen}
        product={selected}
      />
      <StockHistoryModal
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        product={selected}
      />
      <FirstProductPluPrompt
        open={pluPromptOpen}
        onOpenChange={setPluPromptOpen}
        onResolved={() => {
          setSelected(null);
          setFormOpen(true);
        }}
      />
      <ImportProductsModal open={importOpen} onOpenChange={setImportOpen} />
      <BrandsModal open={brandsOpen} onOpenChange={setBrandsOpen} />
      <CategoriesModal open={categoriesOpen} onOpenChange={setCategoriesOpen} />
      <WarrantyPlansModal open={warrantyOpen} onOpenChange={setWarrantyOpen} />
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="Eliminar producto"
        description={`¿Eliminar "${deleteTarget?.name}"? Esta es una baja lógica (se puede recuperar).`}
        confirmLabel="Eliminar"
        danger
        loading={remove.isPending}
        onConfirm={() => confirmDelete()}
      />
    </>
  );
}
