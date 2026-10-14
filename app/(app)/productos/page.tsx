"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import {
  Download,
  FolderTree,
  History,
  PackageMinus,
  PackagePlus,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  Tag,
  Trash2,
  Upload,
  Package,
  MessageSquareText,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Pagination } from "@/components/ui/Pagination";
import { InfoHint } from "@/components/ui/InfoHint";
import { useToast } from "@/components/ui/Toast";
import { GatedButton } from "@/components/saas/GatedAction";
import { RoleButton, RoleIconButton } from "@/components/permissions/RoleGate";
import { useRolePermissions } from "@/lib/permissions/useRole";
import { errorDescription } from "@/lib/permissions/errors";
import { ProductFormModal } from "@/components/products/ProductFormModal";
import { StockAdjustModal } from "@/components/products/StockAdjustModal";
import { MermaModal } from "@/components/products/MermaModal";
import { ProductionModal } from "@/components/products/ProductionModal";
import { StockHistoryModal } from "@/components/products/StockHistoryModal";
import { ImportProductsModal } from "@/components/products/ImportProductsModal";
import { BrandsModal } from "@/components/products/BrandsModal";
import { ClarificationsModal } from "@/components/services/ClarificationsModal";
import { useServiceTypes } from "@/modules/services/types";
import { useCatalogMode } from "@/modules/services/hooks";
import { CategoriesModal } from "@/components/products/CategoriesModal";
import { WarrantyPlansModal } from "@/components/products/WarrantyPlansModal";
import {
  useProductsPaged,
  useProductMutations,
  useCategories,
  useBrands,
  usePluSettings,
  useSetFavorite,
} from "@/modules/products/hooks";
import { FirstProductPluPrompt } from "@/components/products/FirstProductPluPrompt";
import { EmptyProductsPromo } from "@/components/products/EmptyProductsPromo";
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
import { PRODUCT_IMPORT_COLUMNS } from "@/modules/products/import";
import { formatCurrency } from "@/lib/utils/format";
import { marginCost, markupPct, productCosts } from "@/lib/purchases/costs";
import { usePurchaseSettings } from "@/modules/purchases/hooks";
import { NoData } from "@/components/ui/NoData";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { ProductThumb } from "@/components/products/ProductThumb";
import { productStockStatus } from "@/modules/products/stockStatus";
import { useBranchContext } from "@/modules/branches/hooks";
import { branchStockOf } from "@/lib/reports/branchScope";
import { cn } from "@/lib/utils/cn";
import {
  StoreStockChips,
  StoreStockInlineSummary,
  storeQuantities,
} from "@/components/stock/StoreStockInline";
import {
  useCurrentStoreId,
  useMultiStoreStock,
  useStockByStore,
} from "@/modules/stock/hooks";

export default function ProductosPage() {
  const pageSize = usePageSize();
  // Base de costo del negocio para el margen de la lista (F18 · H101, ADR-050).
  const { data: purchaseSettings } = usePurchaseSettings();
  const costBasis = purchaseSettings?.cost_basis ?? "last";
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [mermaOpen, setMermaOpen] = useState(false);
  const [productionOpen, setProductionOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [brandsOpen, setBrandsOpen] = useState(false);
  // ADR-116: negocio de servicios (vocabulario y aclaraciones predefinidas).
  const { mode: catalogMode, vocab } = useCatalogMode();
  const [clarificationsOpen, setClarificationsOpen] = useState(false);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [warrantyOpen, setWarrantyOpen] = useState(false);
  const [pluPromptOpen, setPluPromptOpen] = useState(false);
  const [categoryId, setCategoryId] = useState("");
  const [brandId, setBrandId] = useState("");
  // ADR-122: filtro por tipo de servicio (catálogo con servicios).
  const [serviceTypeId, setServiceTypeId] = useState("");
  const { data: serviceTypes = [] } = useServiceTypes(catalogMode !== "productos");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Product | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);
  const { toast } = useToast();
  // Permisos por rol (ADR-071): el cajero no toca catálogo ni stock; solo
  // lectura no escribe nada. La base lo rechaza igual (role_write_guard).
  const perms = useRolePermissions();
  const deniedCatalog = perms.denied("catalog:write");
  const deniedTaxonomy = perms.denied("catalog:taxonomy");
  const deniedImport = perms.denied("catalog:import");
  const deniedStock = perms.denied("stock:adjust");
  const deniedFavorite = perms.denied("catalog:write");
  const debouncedSearch = useDebouncedValue(search, 350);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, categoryId, brandId, serviceTypeId, pageSize]);

  const { data: categories } = useCategories();
  const { data: brands } = useBrands();
  const { data, isLoading, isError, isPlaceholderData, refetch } = useProductsPaged({
    page,
    pageSize,
    search: debouncedSearch,
    categoryId: categoryId || null,
    brandId: brandId || null,
    serviceTypeId: serviceTypeId || null,
  });
  const products = data?.rows ?? [];
  const total = data?.total ?? 0;
  const { remove } = useProductMutations();
  const setFavorite = useSetFavorite();
  const { data: pluSettings } = usePluSettings();
  const noFilters = !debouncedSearch && !categoryId && !brandId && !serviceTypeId;

  // Stock por sucursal (F17 · H94): sólo con 2+ sucursales y la feature. Con
  // una sola sucursal la lista queda como siempre.
  const multiStore = useMultiStoreStock();
  const currentStoreId = useCurrentStoreId();
  const { data: storeRows } = useStockByStore(
    (data?.rows ?? []).map((p) => p.id),
    multiStore.enabled,
  );
  const [expandedStock, setExpandedStock] = useState<string | null>(null);
  // Sucursal elegida en el chip del panel: con stock por sucursal, la columna
  // Stock muestra el de esa sucursal (y el total debajo). Con "Todas", el total.
  const { filterStoreId, filterStore } = useBranchContext();
  const branchStockId = multiStore.enabled ? filterStoreId : null;

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
  function openMerma(p: Product) {
    setSelected(p);
    setMermaOpen(true);
  }
  function openProduction(p: Product) {
    setSelected(p);
    setProductionOpen(true);
  }
  function openHistory(p: Product) {
    setSelected(p);
    setHistoryOpen(true);
  }
  async function exportBase() {
    const supabase = createClient();
    const { data } = await supabase
      .from("products")
      .select(
        "name, sku, barcode, price, cost, stock, stock_min, unit, tax_rate, track_stock, categories(name), brands(name)",
      )
      .is("deleted_at", null)
      .order("name", { ascending: true });
    // Mismas columnas que la plantilla/import → la base exportada se puede
    // reimportar tal cual.
    const rows = (data ?? []).map((p) => ({
      name: p.name,
      barcode: p.barcode ?? "",
      sku: p.sku ?? "",
      price: p.price,
      cost: p.cost ?? "",
      category: (p.categories as unknown as { name: string } | null)?.name ?? "",
      brand: (p.brands as unknown as { name: string } | null)?.name ?? "",
      tax_rate: (p as unknown as { tax_rate: number | null }).tax_rate ?? "",
      unit: p.unit,
      stock: p.stock,
      stock_min: p.stock_min ?? "",
      track_stock:
        (p as unknown as { track_stock: boolean | null }).track_stock === false
          ? "no"
          : "si",
    }));
    await exportXlsx("productos", [
      {
        name: "Productos",
        title: "Base de productos • NinjaPos",
        columns: PRODUCT_IMPORT_COLUMNS,
        rows,
      },
    ]);
  }

  async function onDelete(p: Product) {
    setDeleteTarget(p);
  }

  // Toggle del favorito (botón rápido del POS · H36) desde el listado.
  async function toggleFavorite(p: Product) {
    try {
      await setFavorite.mutateAsync({ id: p.id, is_favorite: !p.is_favorite });
      toast({
        title: p.is_favorite
          ? "Quitado de favoritos del POS"
          : "Agregado a favoritos del POS",
        variant: "success",
      });
    } catch (e) {
      toast({ title: "No se pudo actualizar el favorito", description: errorDescription(e), variant: "error" });
    }
  }

  async function confirmDelete(_reason?: string) {
    if (!deleteTarget) return;
    try {
      await remove.mutateAsync(deleteTarget.id);
      toast({ title: "Producto eliminado", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo eliminar", description: errorDescription(e), variant: "error" });
    } finally {
      setDeleteTarget(null);
    }
  }

  return (
    <>
      <div className="mx-auto w-full max-w-6xl px-4 pb-[calc(2.5rem+env(safe-area-inset-bottom))] pt-6 sm:px-6 sm:pt-8">
        <PageHeader
          eyebrow="Catálogo"
          title={vocab.title}
          icon={Package}
          help={<InfoHint section="productos" size={18} />}
          actions={
          <div className="flex min-w-0 flex-wrap gap-2">
            <GatedButton
              feature="export_xlsx"
              featureLabel="Exportar a Excel"
              variant="secondary"
              className="shrink-0"
              onClick={exportBase}
            >
              <Download size={16} /> Exportar XLSX
            </GatedButton>
            {deniedImport ? (
              <RoleButton denied={deniedImport} variant="secondary" className="shrink-0">
                <Upload size={16} /> Importar XLSX
              </RoleButton>
            ) : (
              <GatedButton
                feature="importacion_excel"
                featureLabel="Importación desde Excel"
                variant="secondary"
                className="shrink-0"
                onClick={() => setImportOpen(true)}
              >
                <Upload size={16} /> Importar XLSX
              </GatedButton>
            )}
            <RoleButton
              denied={deniedTaxonomy}
              variant="secondary"
              className="shrink-0"
              onClick={() => setCategoriesOpen(true)}
            >
              <FolderTree size={16} /> Categorías
            </RoleButton>
            <RoleButton
              denied={deniedTaxonomy}
              variant="secondary"
              className="shrink-0"
              onClick={() => setBrandsOpen(true)}
            >
              <Tag size={16} /> Marcas
            </RoleButton>
            {catalogMode !== "productos" && (
              <RoleButton
                denied={deniedTaxonomy}
                variant="secondary"
                className="shrink-0"
                onClick={() => setClarificationsOpen(true)}
              >
                <MessageSquareText size={16} /> Aclaraciones
              </RoleButton>
            )}
            <GatedButton
              feature="garantias"
              featureLabel="Garantías"
              variant="secondary"
              className="shrink-0"
              onClick={() => setWarrantyOpen(true)}
            >
              <ShieldCheck size={16} /> Garantías
            </GatedButton>
            <RoleButton denied={deniedCatalog} className="shrink-0" onClick={openNew} data-tour="productos-nuevo">
              <Plus size={16} /> {vocab.newLabel}
            </RoleButton>
          </div>
          }
        />

        <div className="mt-6 flex flex-wrap gap-2">
          <div className="relative min-w-0 basis-full sm:max-w-md sm:flex-1 sm:basis-auto">
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
            className="h-11 min-w-[11rem] flex-1 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft sm:flex-none"
          >
            <option value="">Todas las categorías</option>
            {(categories ?? []).map((c) => (
              <option key={c.id} value={c.id} className="bg-popover text-popover-foreground">
                {c.name}
              </option>
            ))}
          </select>
          <select
            value={brandId}
            onChange={(e) => setBrandId(e.target.value)}
            className="h-11 min-w-[11rem] flex-1 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft sm:flex-none"
          >
            <option value="">Todas las marcas</option>
            {(brands ?? []).map((b) => (
              <option key={b.id} value={b.id} className="bg-popover text-popover-foreground">
                {b.name}
              </option>
            ))}
          </select>
          {catalogMode !== "productos" && serviceTypes.length > 0 && (
            <select
              value={serviceTypeId}
              onChange={(e) => setServiceTypeId(e.target.value)}
              aria-label="Tipo de servicio"
              className="h-11 min-w-[11rem] flex-1 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft sm:flex-none"
            >
              <option value="">Todos los tipos</option>
              {serviceTypes.map((t) => (
                <option key={t.id} value={t.id} className="bg-popover text-popover-foreground">
                  {t.name}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Promo de Tiendita: solo cuando el tenant NO tiene ningún producto
            cargado (sin filtros activos y ya terminó de cargar sin error). */}
        {noFilters && !isLoading && !isError && total === 0 && (
          <EmptyProductsPromo />
        )}

        <TableWrap className="mt-6">
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
              {isLoading && <TableStateRow colSpan={5} loading />}
              {isError && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-danger">
                    Error al cargar.{" "}
                    <button onClick={() => refetch()} className="underline">
                      Reintentar
                    </button>
                  </td>
                </tr>
              )}
              {!isLoading && !isError && products.length === 0 && (
                <TableStateRow colSpan={5}>
                  {search || categoryId || brandId || serviceTypeId ? (
                    <EmptyState
                      compact
                      icon={Search}
                      title="Sin resultados"
                      description="Probá con otro nombre, SKU o categoría."
                    />
                  ) : (
                    <EmptyState
                      compact
                      icon={Package}
                      title={`Todavía no cargaste ${vocab.many}`}
                      description="Creá el primero y empezá a vender."
                      action={
                        deniedCatalog ? undefined : (
                          <Button size="sm" onClick={openNew}>
                            <Plus size={16} /> {vocab.newLabel}
                          </Button>
                        )
                      }
                    />
                  )}
                </TableStateRow>
              )}
              {products.map((p) => {
                const branchQty =
                  branchStockId && p.track_stock !== false
                    ? branchStockOf(storeRows ?? [], p, branchStockId)
                    : null;
                const stock = branchQty
                  ? productStockStatus({ ...p, stock: branchQty.qty, stock_min: branchQty.min })
                  : productStockStatus(p);
                const byStore =
                  multiStore.enabled && p.track_stock !== false
                    ? storeQuantities(p, multiStore.stores, storeRows ?? [], currentStoreId)
                    : null;
                const expanded = expandedStock === p.id;
                return (
                  <Fragment key={p.id}>
                    <tr className="transition hover:bg-muted/40">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <ProductThumb src={p.image_url} size={40} />
                          <div className="min-w-0">
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
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {p.categories?.name ?? <NoData />}
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
                        {(() => {
                          const m = markupPct(Number(p.price), marginCost(costBasis, productCosts(p)));
                          return m == null ? null : (
                            <span
                              className={cn(
                                "block text-[11px] tabular-nums",
                                m < 0 ? "text-danger" : "text-muted-foreground",
                              )}
                              title="Margen sobre el costo elegido en Configuración de compras"
                            >
                              Margen {String(m).replace(".", ",")} %
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span
                          className={cn(
                            "tabular-nums",
                            stock.tone === "untracked" && "whitespace-nowrap text-xs text-muted-foreground",
                            stock.tone === "low" && "font-semibold text-warning",
                            stock.tone === "out" && "font-semibold text-danger",
                          )}
                        >
                          {stock.label}
                        </span>
                        {branchQty && (
                          <div
                            className="text-[11px] text-muted-foreground"
                            title={`Stock en ${filterStore?.short_name || filterStore?.name || "la sucursal"}; debajo, el total del negocio`}
                          >
                            Total {productStockStatus(p).label}
                          </div>
                        )}
                        {byStore && (
                          <div>
                            <StoreStockInlineSummary
                              quantities={byStore}
                              expanded={expanded}
                              onToggle={() => setExpandedStock(expanded ? null : p.id)}
                            />
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <RoleIconButton
                            denied={deniedFavorite}
                            onClick={() => toggleFavorite(p)}
                            title={
                              p.is_favorite
                                ? "Quitar de favoritos del POS"
                                : "Marcar como favorito (botón rápido del POS)"
                            }
                            aria-pressed={p.is_favorite}
                            className={
                              p.is_favorite
                                ? "rounded-md p-2 text-ninja-flameSoft transition hover:bg-muted"
                                : "rounded-md p-2 text-muted-foreground transition hover:bg-muted hover:text-ninja-flameSoft"
                            }
                          >
                            <Star
                              size={16}
                              className={p.is_favorite ? "fill-ninja-flameSoft" : ""}
                            />
                          </RoleIconButton>
                          <RoleIconButton
                            denied={deniedStock}
                            onClick={() => openAdjust(p)}
                            title="Ajustar stock"
                            className="rounded-md p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                          >
                            <SlidersHorizontal size={16} />
                          </RoleIconButton>
                          <RoleIconButton
                            denied={deniedStock}
                            onClick={() => openMerma(p)}
                            title="Registrar merma"
                            className="rounded-md p-2 text-muted-foreground transition hover:bg-amber-400/15 hover:text-warning"
                          >
                            <PackageMinus size={16} />
                          </RoleIconButton>
                          <RoleIconButton
                            denied={deniedStock}
                            onClick={() => openProduction(p)}
                            title="Registrar producción"
                            className="rounded-md p-2 text-muted-foreground transition hover:bg-emerald-400/15 hover:text-success"
                          >
                            <PackagePlus size={16} />
                          </RoleIconButton>
                          <button
                            onClick={() => openHistory(p)}
                            title="Historial de stock"
                            className="rounded-md p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                          >
                            <History size={16} />
                          </button>
                          <RoleIconButton
                            denied={deniedCatalog}
                            onClick={() => openEdit(p)}
                            title="Editar"
                            className="rounded-md p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                          >
                            <Pencil size={16} />
                          </RoleIconButton>
                          <RoleIconButton
                            denied={deniedCatalog}
                            onClick={() => onDelete(p)}
                            title="Eliminar"
                            className="rounded-md p-2 text-muted-foreground transition hover:bg-red-400/15 hover:text-danger"
                          >
                            <Trash2 size={16} />
                          </RoleIconButton>
                        </div>
                      </td>
                    </tr>
                    {byStore && expanded && (
                      <tr className="bg-muted/30">
                        <td colSpan={5} className="px-4 py-3">
                          <StoreStockChips quantities={byStore} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </TableWrap>

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
      <MermaModal
        open={mermaOpen}
        onOpenChange={setMermaOpen}
        product={selected}
      />
      <ProductionModal
        open={productionOpen}
        onOpenChange={setProductionOpen}
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
      <ClarificationsModal open={clarificationsOpen} onOpenChange={setClarificationsOpen} />
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
