"use client";

import { memo } from "react";
import { Layers } from "lucide-react";
import type { Product } from "@/modules/products/api";
import { formatQty } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { POS_TILE, initials, money } from "./posStyles";

export type TileVariant = "text" | "photo";

// Con stock por sucursal (F17 · H94) el POS pasa en `stock` el saldo de SU
// sucursal y en `stockHint` lo que hay en las otras ("Norte: 3 · Centro: 1").
type TileProduct = Product & { stockHint?: string | null };

// Foto del producto: WebP del bucket (modules/products/images), diferida y
// con tamaño fijo para no mover la grilla mientras carga.
function ProductImage({ src, size, className }: { src: string; size: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      draggable={false}
      className={cn("object-cover", className)}
    />
  );
}

function StockBadge({ product: p, out, low }: { product: Product; out: boolean; low: boolean }) {
  if (out) {
    return (
      <span className="ml-auto shrink-0 rounded-md bg-danger/15 px-1.5 py-0.5 text-[11px] font-semibold text-danger">
        Sin stock
      </span>
    );
  }
  return (
    <span
      className={cn(
        "ml-auto shrink-0 rounded-md py-0.5 text-[11px] font-medium tabular-nums",
        low ? "bg-warning/15 px-1.5 font-semibold text-warning" : "text-muted-foreground",
      )}
    >
      {formatQty(p.stock)} {p.unit === "kg" ? "kg" : "u"}
    </span>
  );
}

// Tile de producto del POS.
//  - "text" (Mostrador, Salón, frecuentes): nombre en dos líneas, precio y
//    stock; con `showImage` y foto, miniatura cuadrada a la izquierda.
//  - "photo" (Boutique): foto 4:5 recortada (object-cover) con nombre y precio
//    debajo; sin foto, superficie neutra con las iniciales.
export const ProductTile = memo(function ProductTile({
  product: p,
  variant,
  showStock,
  showImage,
  onPick,
}: {
  product: TileProduct;
  variant: TileVariant;
  showStock: boolean;
  showImage: boolean;
  onPick: (p: Product) => void;
}) {
  const out = Boolean(p.track_stock && Number(p.stock ?? 0) <= 0);
  const low = Boolean(!out && p.track_stock && p.stock_min != null && Number(p.stock) <= Number(p.stock_min));
  const byWeight = p.unit === "kg";
  const stockLabel = p.track_stock ? (out ? ", sin stock" : low ? ", stock bajo" : "") : "";
  const hint = showStock && p.track_stock ? (p.stockHint ?? null) : null;
  const label = `${p.name}, ${money(p.price)}${byWeight ? " por kg" : ""}${stockLabel}${hint ? `. ${hint}` : ""}`;

  const price = (
    <span className="font-price text-[15px] font-semibold leading-none tabular-nums text-foreground">
      {money(p.price)}
      {byWeight && <span className="ml-0.5 text-xs font-medium text-muted-foreground">/kg</span>}
    </span>
  );

  if (variant === "photo") {
    return (
      <button
        type="button"
        onClick={() => onPick(p)}
        aria-label={label}
        title={hint ?? undefined}
        className={cn("group relative flex flex-col overflow-hidden text-left", POS_TILE)}
      >
        <span className="relative block aspect-[4/5] w-full overflow-hidden bg-fg-4">
          {showImage && p.image_url ? (
            <ProductImage src={p.image_url} size={320} className={cn("h-full w-full", out && "opacity-50 grayscale")} />
          ) : (
            <span className="grid h-full w-full place-items-center" aria-hidden>
              <span className="grid h-14 w-14 place-items-center rounded-full bg-fg-6 font-display text-lg font-semibold tracking-wide text-muted-foreground">
                {initials(p.name)}
              </span>
            </span>
          )}
          {p.has_variants && (
            <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-md bg-background/85 px-1.5 py-0.5 text-[11px] font-medium text-foreground backdrop-blur-sm">
              <Layers size={12} aria-hidden /> Variantes
            </span>
          )}
          {out && (
            <span className="absolute bottom-2 left-2 rounded-md bg-background/90 px-1.5 py-0.5 text-[11px] font-semibold text-danger backdrop-blur-sm">
              Sin stock
            </span>
          )}
        </span>
        <span className="flex flex-1 flex-col gap-2 p-3">
          <span className="line-clamp-2 text-[13px] font-medium leading-snug text-foreground">{p.name}</span>
          <span className="mt-auto flex items-center justify-between gap-2">
            {price}
            {showStock && p.track_stock && !out && (
              <span className={cn("text-[11px] tabular-nums", low ? "font-semibold text-warning" : "text-muted-foreground")}>
                {formatQty(p.stock)} u
              </span>
            )}
          </span>
        </span>
      </button>
    );
  }

  const thumb = showImage && p.image_url;
  return (
    <button
      type="button"
      onClick={() => onPick(p)}
      aria-label={label}
      title={hint ?? undefined}
      className={cn(
        "group relative flex min-h-[var(--tile-h,92px)] flex-col justify-between gap-2 p-2.5 text-left",
        POS_TILE,
      )}
    >
      <span className="flex items-start gap-2.5">
        {thumb && (
          <ProductImage
            src={p.image_url as string}
            size={44}
            className="h-11 w-11 shrink-0 rounded-md bg-fg-4"
          />
        )}
        <span
          className={cn(
            "line-clamp-2 min-w-0 flex-1 text-[13px] font-medium leading-snug",
            out ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {p.name}
        </span>
        {(p.plu || p.has_variants) && (
          <span className="flex shrink-0 items-center gap-1">
            {p.plu && (
              <span className="rounded bg-fg-6 px-1 py-px font-mono text-[10px] font-medium text-muted-foreground">
                {p.plu}
              </span>
            )}
            {p.has_variants && <Layers size={14} className="text-muted-foreground" aria-hidden />}
          </span>
        )}
      </span>
      <span className="flex flex-wrap items-end justify-between gap-x-1.5 gap-y-1">
        {price}
        {showStock && p.track_stock && <StockBadge product={p} out={out} low={low} />}
      </span>
    </button>
  );
});
