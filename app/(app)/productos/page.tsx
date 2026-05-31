"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Download,
  History,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { useToast } from "@/components/ui/Toast";
import { ProductFormModal } from "@/components/products/ProductFormModal";
import { StockAdjustModal } from "@/components/products/StockAdjustModal";
import { StockHistoryModal } from "@/components/products/StockHistoryModal";
import { ImportProductsModal } from "@/components/products/ImportProductsModal";
import { useProducts, useProductMutations } from "@/modules/products/hooks";
import type { Product } from "@/modules/products/api";
import { createClient } from "@/lib/supabase/client";
import { exportXlsx } from "@/lib/utils/xlsx";
import { formatCurrency, formatQty } from "@/lib/utils/format";

export default function ProductosPage() {
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [selected, setSelected] = useState<Product | null>(null);
  const { toast } = useToast();

  const { data: products, isLoading, isError, refetch } = useProducts(search);
  const { remove } = useProductMutations();

  function openNew() {
    setSelected(null);
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
        title: "Base de productos — NinjaPos",
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
    if (!window.confirm(`¿Eliminar "${p.name}"? (baja lógica)`)) return;
    try {
      await remove.mutateAsync(p.id);
      toast({ title: "Producto eliminado", variant: "success" });
    } catch {
      toast({ title: "No se pudo eliminar", variant: "error" });
    }
  }

  return (
    <>
<div className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Eyebrow>Catálogo</Eyebrow>
            <Display className="mt-3 text-3xl md:text-4xl">Productos</Display>
          </div>
          <div className="-mx-6 flex gap-2 overflow-x-auto px-6 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <Button variant="secondary" className="shrink-0" onClick={exportBase}>
              <Download size={16} /> Exportar XLSX
            </Button>
            <Button variant="secondary" className="shrink-0" onClick={() => setImportOpen(true)}>
              <Upload size={16} /> Importar XLSX
            </Button>
            <Button className="shrink-0" onClick={openNew}>
              <Plus size={16} /> Nuevo producto
            </Button>
          </div>
        </div>

        <div className="relative mt-6 max-w-md">
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
              {!isLoading && !isError && products?.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                    No hay productos todavía. Creá el primero con “Nuevo producto”.
                  </td>
                </tr>
              )}
              {products?.map((p) => {
                const low =
                  (p.stock_min ?? 0) > 0 && p.stock <= (p.stock_min ?? 0);
                return (
                  <tr key={p.id} className="transition hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground">{p.name}</div>
                      {p.sku && (
                        <div className="font-mono text-xs text-muted-foreground">
                          {p.sku}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {p.categories?.name ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {formatCurrency(p.price)}
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
      <ImportProductsModal open={importOpen} onOpenChange={setImportOpen} />
    </>
  );
}
