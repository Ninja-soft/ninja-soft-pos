"use client";

// Logos de marca usados como ícono del menú y del encabezado de Configuración
// (ARCA, Mercado Libre, NubCeo) en lugar de un ícono genérico. Respetan la firma
// de un ícono de lucide (size, className) para usarse donde va un LucideIcon.

import type { ComponentType } from "react";
import { cn } from "@/lib/utils/cn";

export type SettingsIcon = ComponentType<{
  size?: number | string;
  className?: string;
  strokeWidth?: number | string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

function brandIcon(opts: {
  src: string;
  alt: string;
  /** Ancho relativo al alto (wordmarks más anchos que altos). */
  ratio?: number;
  /** Forzado a un solo color: blanco en temas oscuros, negro en claros. */
  mono?: boolean;
}): SettingsIcon {
  function BrandIcon({ size = 16, className }: { size?: number | string; className?: string }) {
    const h = typeof size === "number" ? size : Number.parseFloat(String(size)) || 16;
    const ratio = opts.ratio ?? 1;
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={opts.src}
        alt=""
        aria-hidden
        width={Math.round(h * ratio)}
        height={h}
        style={{ height: h, width: Math.round(h * ratio) }}
        className={cn(
          "shrink-0 object-contain",
          opts.mono &&
            "brightness-0 invert [[data-theme=ninja-light]_&]:invert-0 [[data-theme=ninja-sand]_&]:invert-0",
          // Los colores de texto del ícono no aplican a una imagen.
          className?.replace(/\btext-\S+/g, ""),
        )}
      />
    );
  }
  BrandIcon.displayName = `BrandIcon(${opts.alt})`;
  return BrandIcon;
}

// Logo oficial de ARCA (afip.gob.ar), forzado a blanco: en su azul original
// no se lee sobre el tema oscuro.
export const ArcaIcon = brandIcon({
  src: "/images/integrations/arca-logo.png",
  alt: "ARCA",
  ratio: 1181 / 407,
  mono: true,
});

export const MercadoLibreIcon = brandIcon({
  src: "/images/integrations/mercadolibre.webp",
  alt: "Mercado Libre",
});

export const NubceoIcon = brandIcon({
  src: "/images/integrations/nubceo-wordmark-on-dark.webp",
  alt: "NubCeo",
  ratio: 3.2,
});
