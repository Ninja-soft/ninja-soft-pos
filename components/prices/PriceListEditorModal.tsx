"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { useProducts, useVariants } from "@/modules/products/hooks";
import { variantLabel, variantPrice, type Product } from "@/modules/products/api";
import { usePriceListItems, usePriceItemMutations } from "@/modules/prices/hooks";
import { resolvePrice, resolveUnitPrice, type PriceItemLike } from "@/lib/prices/resolve";
import { productCostsLike, worldWithList } from "@/lib/prices/listUsage";
import { priceProApi } from "@/modules/prices/proApi";
import type { PriceList, PriceListItem } from "@/modules/prices/api";
import {
  useCatalogHintsActive,
  useCatalogPriceReferences,
} from "@/modules/catalog/hooks";
import type { PriceReference } from "@/modules/catalog/priceReference";
import { CatalogPriceArrow } from "@/components/catalog/CatalogPriceArrow";
import { formatCurrency } from "@/lib/utils/format";

// Edición de precios puntuales de una lista. Tabla con búsqueda; cada fila
// (producto y, si tiene variantes, cada variante) muestra el precio base y el
// resuelto por la lista, con un input de precio puntual editable. Vacío = sin
// precio puntual (usa la regla de la lista). Se guarda en blur.
// ADR-151: el precio de la lista sale del mismo resolver que el POS (derivadas,
// sobre costo, en moneda, monto, redondeo, piso y listas netas); antes sólo
// aplicaba el %. En una lista en moneda extranjera el precio puntual va en esa
// moneda.
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

  // Productos efectivamente visibles (la lista se recorta a 50).
  const visibleProducts = useMemo(
    () => (products ?? []).slice(0, 50),
    [products],
  );

  // Comparación vs catálogo de referencia: sólo si el tenant compró un catálogo
  // y la sugerencia está activada. Referencias de los EANs visibles en batch.
  const { active: hintsActive } = useCatalogHintsActive();
  const visibleEans = useMemo(
    () =>
      visibleProducts
        .map((p) => (p.barcode ?? "").trim())
        .filter((b): b is string => b.length > 0),
    [visibleProducts],
  );
  const { data: priceRefs } = useCatalogPriceReferences(
    visibleEans,
    hintsActive && open,
  );

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

  // Foto de precios del negocio (la misma del POS) para calcular la lista.
  const snap = useQuery({
    queryKey: ["price-pro", "snapshot", null, null],
    queryFn: () => priceProApi.snapshot(null, null),
    enabled: open && Boolean(list),
    staleTime: 60_000,
  });
  const world = useMemo(() => {
    if (!snap.data || !list) return null;
    const costs = Object.fromEntries(
      visibleProducts.map((p) => [p.id, productCostsLike(p as unknown as Record<string, unknown>)]),
    );
    return worldWithList(snap.data, list.id, itemsLike, costs);
  }, [snap.data, list, itemsLike, visibleProducts]);
  const resolveFor = useCallback(
    (productId: string, variantId: string | null, productBase: number, base: number) => {
      if (!world || !list) {
        return resolvePrice(base, productId, variantId, list ? { adjustment_pct: list.adjustment_pct } : null, itemsLike);
      }
      return resolveUnitPrice(world, {
        productId,
        variantId,
        basePrice: productBase,
        variantPrice: variantId ? base : null,
        listId: list.id,
        termId: "none",
      }).price;
    },
    [world, list, itemsLike],
  );
  const listInfo = list as (PriceList & { kind?: string | null; currency?: string | null }) | null;
  const currency = listInfo?.kind === "currency" ? (listInfo.currency ?? "USD") : null;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={list ? `Precios • ${list.name}` : "Precios"}
      className="max-w-3xl"
    >
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Dejá el precio vacío para que la lista lo calcule con su regla. Cargá un valor para fijar un precio
          puntual a ese producto o variante: pisa la regla.
          {currency
            ? ` Esta lista es en ${currency}: el precio puntual va en ${currency} y se pasa a pesos con la cotización.`
            : ""}
          {list && list.is_active === false ? " La lista está apagada: el POS no la usa hasta que la prendas." : ""}
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
          {visibleProducts.map((p) => (
            <ProductRows
              key={p.id}
              product={p}
              list={list}
              tenantId={tenantId}
              itemsByKey={itemsByKey}
              resolveFor={resolveFor}
              currency={currency}
              priceRef={
                hintsActive && p.barcode
                  ? priceRefs?.get(p.barcode.trim())
                  : undefined
              }
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

type ResolveFor = (productId: string, variantId: string | null, productBase: number, base: number) => number;

function ProductRows({
  product,
  list,
  tenantId,
  itemsByKey,
  resolveFor,
  currency,
  priceRef,
}: {
  product: Product;
  list: PriceList | null;
  tenantId: string | null | undefined;
  itemsByKey: Map<string, PriceListItem>;
  resolveFor: ResolveFor;
  currency: string | null;
  // Referencia de precio del catálogo para el EAN del producto (si aplica). Se
  // comparte entre todas las variantes (el match es por barcode del producto).
  priceRef?: PriceReference;
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
          resolved={resolveFor(product.id, null, Number(product.price), Number(product.price))}
          currency={currency}
          priceRef={priceRef}
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
              resolved={resolveFor(product.id, v.id, Number(product.price), variantPrice(v, Number(product.price)))}
              currency={currency}
              priceRef={priceRef}
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
  resolved,
  currency,
  priceRef,
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
  /** Precio que cobraría el POS con esta lista (resolver del POS). */
  resolved: number;
  /** Moneda de la lista en moneda extranjera (el precio puntual va en esa moneda). */
  currency: string | null;
  priceRef?: PriceReference;
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
        <span className="flex items-center gap-1 truncate font-medium">
          {label}
          {/* Flecha vs catálogo de referencia: compara el precio EFECTIVO de la
              lista (resuelto) contra el precio de mercado del EAN del producto. */}
          <CatalogPriceArrow myPrice={resolved} reference={priceRef} />
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {sub ? `${sub} · ` : ""}base {formatCurrency(basePrice)}
          {item && currency ? ` · ${currency} ${item.price}` : ""}
          {resolved !== basePrice || item ? ` · lista ${formatCurrency(resolved)}` : ""}
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
        placeholder={currency ? currency : formatCurrency(resolved)}
        aria-label={currency ? `Precio puntual en ${currency}` : "Precio puntual"}
        className="h-9 w-28 shrink-0 rounded-md border border-input bg-background px-2 text-right text-sm outline-none focus:border-ninja-flameSoft"
      />
    </div>
  );
}
