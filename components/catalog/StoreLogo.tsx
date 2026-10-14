"use client";

import { useState } from "react";
import { cn } from "@/lib/utils/cn";
import { storeIcon } from "@/lib/catalog/storeLogos";

// Logo de una tienda de origen del catálogo: primero el ícono oficial
// (public/tiendas/iconos), después el logo_url que trajo el feed y, si no hay
// o no carga, las iniciales.
//
// Sin fondo: el ícono oficial (transparente) se muestra tal cual, grande y
// nítido sobre la superficie del tema. Pedido explícito del dueño: nada de
// baldosas blancas ni de color detrás de los logos. Los íconos que se pierden
// sobre fondo oscuro (texto azul marino) se aclaran sólo en los temas oscuros.
const DARK_THEME_LIGHTEN = new Set(["MACRO"]);

export function storeInitials(name: string): string {
  const words = name.replace(/[^A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ ]/g, " ").split(/\s+/).filter(Boolean);
  const [a = "", b = ""] = words;
  if (!a) return "?";
  if (!b) return a.slice(0, 2).toUpperCase();
  return (a.charAt(0) + b.charAt(0)).toUpperCase();
}

/** Margen interno mínimo del ícono (sin fondo): 4 %, mínimo 1 px. */
export function storeTilePadding(size: number): number {
  return Math.max(1, Math.round(size * 0.04));
}

export function StoreLogo({
  storeKey,
  name,
  logoUrl,
  size = 24,
  className,
}: {
  storeKey: string;
  name: string;
  logoUrl?: string | null;
  size?: number;
  className?: string;
}) {
  const sources = [storeIcon(storeKey), logoUrl ?? null].filter((s): s is string => Boolean(s));
  const [idx, setIdx] = useState(0);
  const src = sources[idx];
  const tile = cn(
    "inline-grid shrink-0 place-items-center overflow-hidden",
    size >= 32 ? "rounded-lg" : "rounded-md",
    className,
  );
  const style = { width: size, height: size, padding: storeTilePadding(size) };
  const lighten = DARK_THEME_LIGHTEN.has(storeKey.toUpperCase()) && idx === 0;

  if (!src) {
    return (
      <span
        style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.36)) }}
        aria-hidden
        data-store-tile
        className={cn(tile, "border border-border font-semibold leading-none text-muted-foreground")}
      >
        {storeInitials(name)}
      </span>
    );
  }
  return (
    <span style={style} className={tile} data-store-tile aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        loading="lazy"
        onError={() => setIdx((i) => i + 1)}
        className={cn(
          "h-full w-full object-contain",
          lighten &&
            "[[data-theme=ninja-dark]_&]:[filter:invert(1)_hue-rotate(180deg)] [[data-theme=ninja-noir]_&]:[filter:invert(1)_hue-rotate(180deg)]",
        )}
      />
    </span>
  );
}
