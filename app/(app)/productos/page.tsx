"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  History,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { useToast } from "@/components/ui/Toast";
import { Isotype } from "@/components/brand/Logo";
import { ProductFormModal } from "@/components/products/ProductFormModal";
import { StockAdjustModal } from "@/components/products/StockAdjustModal";
import { StockHistoryModal } from "@/components/products/StockHistoryModal";
import { ImportCsvModal } from "@/components/products/ImportCsvModal";
import { useProducts, useProductMutations } from "@/modules/products/hooks";
import type { Product } from "@/modules/products/api";
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
    <div className="app-bg min-h-screen text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link href="/dashboard" className="flex items-center gap-3">
            <Isotype className="h-7 w-auto" />
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              <ArrowLeft size={15} /> Panel
            </span>
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Eyebrow>Catálogo</Eyebrow>
            <Display className="mt-3 text-3xl md:text-4xl">Productos</Display>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setImportOpen(true)}>
              <Upload size={16} /> Importar CSV
            </Button>
            <Button onClick={openNew}>
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

        <div className="mt-6 overflow-hidden rounded-ninjaLg border border-border bg-card">
          <table className="w-full text-sm">
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
                          className="rounded-ninjaSm p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                        >
                          <SlidersHorizontal size={16} />
                        </button>
                        <button
                          onClick={() => openHistory(p)}
                          title="Historial de stock"
                          className="rounded-ninjaSm p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                        >
                          <History size={16} />
                        </button>
                        <button
                          onClick={() => openEdit(p)}
                          title="Editar"
                          className="rounded-ninjaSm p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          onClick={() => onDelete(p)}
                          title="Eliminar"
                          className="rounded-ninjaSm p-2 text-muted-foreground transition hover:bg-red-400/15 hover:text-red-300"
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
      </main>

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
      <ImportCsvModal open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}
