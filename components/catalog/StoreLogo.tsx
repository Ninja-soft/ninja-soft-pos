"use client";

import { useState } from "react";
import { cn } from "@/lib/utils/cn";
import { storeIcon } from "@/lib/catalog/storeLogos";

// Logo de una tienda de origen del catálogo: primero el ícono oficial
// (public/tiendas/iconos), después el logo_url que trajo el feed y, si no hay
// o no carga, las iniciales.
export function storeInitials(name: string): string {
  const words = name.replace(/[^A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ ]/g, " ").split(/\s+/).filter(Boolean);
  const [a = "", b = ""] = words;
  if (!a) return "?";
  if (!b) return a.slice(0, 2).toUpperCase();
  return (a.charAt(0) + b.charAt(0)).toUpperCase();
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
  const box = { width: size, height: size };
  if (!src) {
    return (
      <span
        style={box}
        aria-hidden
        className={cn(
          "inline-grid shrink-0 place-items-center rounded-md bg-muted text-[10px] font-semibold text-muted-foreground",
          className,
        )}
      >
        {storeInitials(name)}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      style={box}
      loading="lazy"
      onError={() => setIdx((i) => i + 1)}
      className={cn("shrink-0 rounded-md bg-white object-contain", className)}
    />
  );
}
