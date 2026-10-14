"use client";

import { useState } from "react";
import { cn } from "@/lib/utils/cn";
import { storeIcon } from "@/lib/catalog/storeLogos";

// Logo de una tienda de origen del catálogo: primero el ícono oficial
// (public/tiendas/iconos), después el logo_url que trajo el feed y, si no hay
// o no carga, las iniciales.
//
// Siempre sobre una baldosa clara (blanca, esquinas redondeadas, padding
// interno y borde sutil) del mismo tamaño en todos lados: los íconos oficiales
// tienen fondo transparente y colores pensados para fondo blanco, y sobre los
// temas oscuros se perdían. La baldosa es blanca en los 4 temas a propósito
// (es el "papel" del logo, no un color de la interfaz).
export function storeInitials(name: string): string {
  const words = name.replace(/[^A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ ]/g, " ").split(/\s+/).filter(Boolean);
  const [a = "", b = ""] = words;
  if (!a) return "?";
  if (!b) return a.slice(0, 2).toUpperCase();
  return (a.charAt(0) + b.charAt(0)).toUpperCase();
}

/** Padding interno de la baldosa según el tamaño (14 %, mínimo 2 px). */
export function storeTilePadding(size: number): number {
  return Math.max(2, Math.round(size * 0.14));
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
    "inline-grid shrink-0 place-items-center overflow-hidden border border-black/10 bg-white",
    size >= 32 ? "rounded-lg" : "rounded-md",
    className,
  );
  const style = { width: size, height: size, padding: storeTilePadding(size) };

  if (!src) {
    return (
      <span
        style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.36)) }}
        aria-hidden
        data-store-tile
        className={cn(tile, "font-semibold leading-none text-neutral-600")}
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
        className="h-full w-full object-contain"
      />
    </span>
  );
}
