"use client";

// Ficha para agregar al carrito (ADR-130): variante (talle, color), cantidad
// con el tope del disponible y el precio del catálogo que resolvió el servidor.
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import {
  isOrderable,
  qtyCap,
  type CartItem,
  type CatalogProduct,
} from "@/lib/catalog/publicOrder";
import { Sheet } from "./Sheet";
import { QtyStepper } from "./QtyStepper";

export function ProductSheet({
  product,
  inCart,
  accent,
  accentInk,
  onClose,
  onAdd,
}: {
  product: CatalogProduct | null;
  /** Cantidad que ya está en el carrito por variante (para el tope). */
  inCart: (productId: string, variantId: string | null) => number;
  accent: string;
  accentInk: string;
  onClose: () => void;
  onAdd: (item: CartItem) => void;
}) {
  const variants = useMemo(() => (product?.has_variants ? (product.variants ?? []) : []), [product]);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [qty, setQty] = useState(1);

  useEffect(() => {
    if (!product) return;
    const first = variants.find((v) => isOrderable(v.available));
    setVariantId(first?.id ?? null);
    setQty(1);
  }, [product, variants]);

  if (!product) return null;
  const variant = variants.find((v) => v.id === variantId) ?? null;
  const price = variant ? Number(variant.price) : Number(product.price);
  const available = product.has_variants ? (variant?.available ?? 0) : (product.available ?? null);
  const unit = product.unit ?? "un";
  const already = inCart(product.id, variant?.id ?? null);
  const cap = Math.max(0, qtyCap(available) - already);
  const canAdd = (!product.has_variants || variant != null) && cap > 0 && qty > 0 && qty <= cap;

  return (
    <Sheet
      open
      onClose={onClose}
      title={product.name}
      side="center"
      footer={
        <button
          type="button"
          disabled={!canAdd}
          onClick={() => {
            onAdd({
              productId: product.id,
              variantId: variant?.id ?? null,
              name: product.name,
              variantLabel: variant?.label ?? null,
              unitPrice: price,
              qty,
              imageUrl: product.image_url,
              max: available == null ? null : qtyCap(available),
              unit,
            });
            onClose();
          }}
          className="flex h-12 w-full items-center justify-between gap-3 rounded-lg px-4 text-sm font-semibold transition-opacity disabled:opacity-40"
          style={{ backgroundColor: accent, color: accentInk }}
        >
          <span>{cap <= 0 && available != null ? "Sin stock disponible" : "Agregar al carrito"}</span>
          <span className="tabular-nums">{formatCurrency(price * qty)}</span>
        </button>
      }
    >
      <div className="flex gap-4">
        <div className="h-24 w-24 shrink-0 overflow-hidden rounded-lg bg-neutral-100">
          {product.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={product.image_url} alt="" className="h-full w-full object-cover" />
          ) : null}
        </div>
        <div className="min-w-0">
          {product.category && (
            <p className="text-[11px] uppercase tracking-wide text-neutral-500">{product.category}</p>
          )}
          <p className="text-lg font-bold tabular-nums">{formatCurrency(price)}</p>
          {available != null && (
            <p className="text-xs text-neutral-500">
              {Number(available) > 0 ? `Quedan ${Math.floor(Number(available))}` : "Sin stock"}
            </p>
          )}
        </div>
      </div>

      {variants.length > 0 && (
        <fieldset className="mt-5">
          <legend className="mb-2 text-sm font-semibold">Elegí una opción</legend>
          <div className="flex flex-wrap gap-2">
            {variants.map((v) => {
              const off = !isOrderable(v.available);
              const on = v.id === variantId;
              return (
                <button
                  key={v.id}
                  type="button"
                  disabled={off}
                  aria-pressed={on}
                  onClick={() => {
                    setVariantId(v.id);
                    setQty(1);
                  }}
                  className={cn(
                    "min-h-10 rounded-md border px-3 text-sm font-medium transition-colors",
                    on ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-200 bg-white hover:bg-neutral-50",
                    off && "cursor-not-allowed text-neutral-400 line-through hover:bg-white",
                  )}
                >
                  {v.label}
                </button>
              );
            })}
          </div>
        </fieldset>
      )}

      <div className="mt-5 flex items-center justify-between gap-3">
        <span className="text-sm font-semibold">Cantidad</span>
        <QtyStepper
          value={qty}
          max={Math.max(cap, 1)}
          step={1}
          onChange={(n) => setQty(Math.max(1, n))}
          label={`Cantidad de ${product.name}`}
        />
      </div>
      {already > 0 && (
        <p className="mt-2 text-xs text-neutral-500">Ya tenés {already} en el carrito.</p>
      )}
    </Sheet>
  );
}
