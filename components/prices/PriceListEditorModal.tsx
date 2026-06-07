"use client";

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { useProducts, useVariants } from "@/modules/products/hooks";
import { variantLabel, variantPrice, type Product } from "@/modules/products/api";
import { usePriceListItems, usePriceItemMutations } from "@/modules/prices/hooks";
import { resolvePrice, type PriceItemLike } from "@/lib/prices/resolve";
import type { PriceList, PriceListItem } from "@/modules/prices/api";
import { formatCurrency } from "@/lib/utils/format";

// Edición de precios puntuales de una lista. Tabla con búsqueda; cada fila
// (producto y, si tiene variantes, cada variante) muestra el precio base y el
// resuelto por la lista, con un input de precio puntual editable. Vacío = sin
// precio puntual (usa ajuste/base). Se guarda en blur.
export function PriceListEditorModal({
  list,
  tenantId,
  open,
  onOpenChange,
}: {
  list: PriceList | null;
  tenantId: string | null | undefined;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  const { data: products } = useProducts(search);
  const { data: items } = usePriceListItems(list?.id ?? null, open && !!list);

  // Índice de items por (productId|variantId) para lookup rápido.
  const itemsByKey = useMemo(() => {
    const m = new Map<string, PriceListItem>();
    for (const it of items ?? []) {
      m.set(`${it.product_id}:${it.variant_id ?? ""}`, it);
    }
    return m;
  }, [items]);

  const itemsLike: PriceItemLike[] = useMemo(
    () =>
      (items ?? []).map((i) => ({
        product_id: i.product_id,
        variant_id: i.variant_id,
        price: Number(i.price),
      })),
    [items],
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={list ? `Precios • ${list.name}` : "Precios"}
      className="max-w-3xl"
    >
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Dejá el precio vacío para usar el ajuste de la lista (o el precio base).
          Cargá un valor para fijar un precio puntual a ese producto o variante.
        </p>
        <div className="relative">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar producto por nombre, SKU o código…"
            className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none focus:border-ninja-flameSoft"
          />
        </div>

        <div className="max-h-[55vh] space-y-1 overflow-y-auto">
          {(products ?? []).slice(0, 50).map((p) => (
            <ProductRows
              key={p.id}
              product={p}
              list={list}
              tenantId={tenantId}
              itemsByKey={itemsByKey}
              itemsLike={itemsLike}
            />
          ))}
          {(products ?? []).length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Sin productos.
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}

function ProductRows({
  product,
  list,
  tenantId,
  itemsByKey,
  itemsLike,
}: {
  product: Product;
  list: PriceList | null;
  tenantId: string | null | undefined;
  itemsByKey: Map<string, PriceListItem>;
  itemsLike: PriceItemLike[];
}) {
  const hasVariants = Boolean(product.has_variants);
  const { data: variants } = useVariants(product.id, hasVariants);

  return (
    <div className="rounded-lg border border-border">
      {!hasVariants ? (
        <PriceRow
          label={product.name}
          sub={product.sku ?? undefined}
          basePrice={Number(product.price)}
          productId={product.id}
          variantId={null}
          list={list}
          tenantId={tenantId}
          itemsByKey={itemsByKey}
          itemsLike={itemsLike}
        />
      ) : (
        <>
          <div className="border-b border-border px-3 py-2 text-sm font-medium">
            {product.name}
            <span className="ml-2 text-xs text-muted-foreground">
              {(variants ?? []).length} variantes
            </span>
          </div>
          {(variants ?? []).map((v) => (
            <PriceRow
              key={v.id}
              label={variantLabel(v)}
              sub={v.sku ?? undefined}
              basePrice={variantPrice(v, Number(product.price))}
              productId={product.id}
              variantId={v.id}
              list={list}
              tenantId={tenantId}
              itemsByKey={itemsByKey}
              itemsLike={itemsLike}
              indent
            />
          ))}
          {(variants ?? []).length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              Sin variantes cargadas.
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PriceRow({
  label,
  sub,
  basePrice,
  productId,
  variantId,
  list,
  tenantId,
  itemsByKey,
  itemsLike,
  indent,
}: {
  label: string;
  sub?: string;
  basePrice: number;
  productId: string;
  variantId: string | null;
  list: PriceList | null;
  tenantId: string | null | undefined;
  itemsByKey: Map<string, PriceListItem>;
  itemsLike: PriceItemLike[];
  indent?: boolean;
}) {
  const { toast } = useToast();
  const item = itemsByKey.get(`${productId}:${variantId ?? ""}`);
  const { upsert, remove } = usePriceItemMutations(tenantId, list?.id ?? "");

  // Valor del input: vacío si no hay precio puntual.
  const [value, setValue] = useState<string>(item ? String(item.price) : "");
  useEffect(() => {
    setValue(item ? String(item.price) : "");
  }, [item]);

  const resolved = resolvePrice(
    basePrice,
    productId,
    variantId,
    list ? { adjustment_pct: list.adjustment_pct } : null,
    itemsLike,
  );

  function save() {
    const trimmed = value.trim();
    // Vacío → borra el item puntual (si existía).
    if (trimmed === "") {
      if (item) {
        remove.mutate(item.id, {
          onError: () => toast({ title: "No se pudo guardar", variant: "error" }),
        });
      }
      return;
    }
    const num = Number(trimmed);
    if (!Number.isFinite(num) || num < 0) {
      toast({ title: "Precio inválido", variant: "error" });
      setValue(item ? String(item.price) : "");
      return;
    }
    // Sin cambios respecto al item actual: no hace nada.
    if (item && Number(item.price) === num) return;
    upsert.mutate(
      { productId, variantId, price: num },
      { onError: () => toast({ title: "No se pudo guardar", variant: "error" }) },
    );
  }

  return (
    <div
      className={`flex items-center justify-between gap-3 px-3 py-2 text-sm ${
        indent ? "pl-6" : ""
      }`}
    >
      <span className="min-w-0">
        <span className="block truncate font-medium">{label}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {sub ? `${sub} · ` : ""}base {formatCurrency(basePrice)}
          {!item && resolved !== basePrice ? ` · lista ${formatCurrency(resolved)}` : ""}
        </span>
      </span>
      <input
        type="number"
        step="0.01"
        min="0"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        placeholder={formatCurrency(resolved)}
        className="h-9 w-28 shrink-0 rounded-md border border-input bg-background px-2 text-right text-sm outline-none focus:border-ninja-flameSoft"
      />
    </div>
  );
}
