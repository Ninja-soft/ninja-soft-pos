"use client";

import { memo } from "react";
import { Layers } from "lucide-react";
import type { Product } from "@/modules/products/api";
import { formatQty } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { POS_SURFACE, monogramGradient, money } from "./posStyles";

export type TileVariant = "text" | "photo";

// Tile de producto del POS. "text" (Mostrador / Salón / Caja rápida): nombre en
// dos líneas, precio grande y stock. "photo" (Boutique): foto 4:5 con el
// precio abajo; sin foto, monograma de color estable.
export const ProductTile = memo(function ProductTile({
  product: p,
  variant,
  showStock,
  showImage,
  onPick,
}: {
  product: Product;
  variant: TileVariant;
  showStock: boolean;
  showImage: boolean;
  onPick: (p: Product) => void;
}) {
  const out = p.track_stock && Number(p.stock ?? 0) <= 0;
  const low = !out && p.track_stock && p.stock_min != null && Number(p.stock) <= Number(p.stock_min);
  const byWeight = p.unit === "kg";

  if (variant === "photo") {
    return (
      <button
        type="button"
        onClick={() => onPick(p)}
        className={cn(
          "group relative flex flex-col overflow-hidden rounded-2xl text-left transition duration-150 active:scale-[0.97]",
          POS_SURFACE,
          out && "opacity-55",
        )}
      >
        <span className="relative block aspect-[4/5] w-full overflow-hidden bg-muted">
          {showImage && p.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={p.image_url}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.04]"
            />
          ) : (
            <span
              className={cn(
                "grid h-full w-full place-items-center bg-gradient-to-br text-4xl font-black text-white/90",
                monogramGradient(p.name),
              )}
              aria-hidden
            >
              {p.name.trim().slice(0, 1).toUpperCase()}
            </span>
          )}
          {p.has_variants && (
            <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white backdrop-blur">
              <Layers size={11} /> Talles y colores
            </span>
          )}
          {out && (
            <span className="absolute inset-x-2 bottom-2 rounded-lg bg-black/60 py-1 text-center text-[11px] font-semibold text-white backdrop-blur">
              Sin stock
            </span>
          )}
        </span>
        <span className="flex flex-1 flex-col gap-0.5 px-3 pb-3 pt-2.5">
          <span className="line-clamp-2 text-[13px] font-semibold leading-snug text-foreground">
            {p.name}
          </span>
          <span className="mt-auto flex items-baseline justify-between gap-2 pt-1">
            <span className="font-price text-base font-black tabular-nums text-foreground">
              {money(p.price)}
            </span>
            {showStock && p.track_stock && (
              <span className={cn("text-[11px] tabular-nums", low ? "text-warning" : "text-muted-foreground")}>
                {formatQty(p.stock)} u
              </span>
            )}
          </span>
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onPick(p)}
      className={cn(
        "group relative flex min-h-[var(--tile-h,92px)] flex-col justify-between gap-2 rounded-2xl p-3 text-left transition duration-150 hover:bg-muted active:scale-[0.97]",
        POS_SURFACE,
        out && "opacity-55",
      )}
    >
      <span className="flex items-start justify-between gap-1.5">
        <span className="line-clamp-2 text-[13px] font-semibold leading-snug text-foreground">
          {p.name}
        </span>
        {p.has_variants && (
          <Layers size={14} className="mt-0.5 shrink-0 text-muted-foreground" aria-label="Con variantes" />
        )}
      </span>
      <span className="flex items-end justify-between gap-2">
        <span className="font-price text-[15px] font-black leading-none tabular-nums text-foreground">
          {money(p.price)}
          {byWeight && <span className="ml-0.5 text-[11px] font-semibold text-muted-foreground">/kg</span>}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {p.plu && (
            <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] font-semibold text-muted-foreground">
              {p.plu}
            </span>
          )}
          {showStock && p.track_stock && (
            <span
              className={cn(
                "rounded-md px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
                out
                  ? "bg-danger/15 text-danger"
                  : low
                    ? "bg-warning/15 text-warning"
                    : "text-muted-foreground",
              )}
            >
              {out ? "Sin stock" : `${formatQty(p.stock)} ${p.unit}`}
            </span>
          )}
        </span>
      </span>
    </button>
  );
});
