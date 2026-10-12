// Tokens visuales compartidos del POS. Mismo lenguaje que el resto de la app
// (docs/11-ui-brand.md §17): superficies neutras del tema, bordes sutiles,
// selección con relleno neutro (nunca borde/anillo de color ni relleno
// invertido) y el acento del negocio (pos_layout.accent) sólo en el CTA
// principal y en detalles chicos.
//
// Escala de radios del POS:
//   rounded-md → chips, pastillas, botones chicos y steppers.
//   rounded-lg → botones, campos, tiles y líneas del carrito.
//   rounded-xl → paneles (carrito, riel, mesas) y hojas.

import type { CSSProperties } from "react";
import { ACCENT_GRADIENT, type PosAccent } from "@/lib/pos/layout";

/** CTA principal (Cobrar): relleno sólido del acento, texto AA. */
export const POS_CTA =
  "bg-[var(--pos-solid)] text-[color:var(--pos-on)] shadow-sm transition-colors hover:bg-[var(--pos-solid-hover)] active:brightness-95 disabled:pointer-events-none disabled:opacity-40 disabled:shadow-none";

/** Panel del POS (carrito, riel, mesas, ticket). */
export const POS_PANEL = "rounded-xl border border-border bg-card";

/** Tile tocable (productos, teclas rápidas, mesas): superficie neutra. */
export const POS_TILE =
  "rounded-lg border border-border bg-card transition-[background-color,transform] duration-150 hover:bg-[color-mix(in_srgb,var(--card)_92%,var(--foreground))] active:scale-[0.98] motion-reduce:active:scale-100";

/** Botón secundario silencioso (relleno tonal neutro). */
export const POS_QUIET =
  "bg-fg-6 text-foreground transition-colors hover:bg-fg-10 disabled:pointer-events-none disabled:opacity-40";

/** Riel de un grupo segmentado (mismos tokens que components/ui/Segmented). */
export const POS_SEG_TRACK = "rounded-lg bg-[var(--seg-track)] p-1";
/** Segmento elegido dentro de un riel: "pulgar" neutro elevado. */
export const POS_SEG_ON = "bg-[var(--seg-thumb)] text-foreground shadow-[var(--seg-thumb-shadow)]";
/** Segmento en reposo dentro de un riel. */
export const POS_SEG_OFF = "text-muted-foreground hover:text-foreground";

/** Fila elegida en listas sobre card (riel de rubros, mesas): relleno neutro. */
export const POS_ROW_ON = "choice-on font-semibold";

/** Rótulo de sección (eyebrow). */
export const POS_EYEBROW = "text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground";

// Alias de compatibilidad con el mismo lenguaje neutro (nada invertido en
// blanco). Código nuevo: POS_SEG_* / POS_ROW_ON / POS_QUIET / POS_PANEL.
/** Chip / segmento seleccionado: relleno neutro elevado (como choice-on). */
export const POS_SELECTED = "choice-on";
/** Chip / segmento en reposo. */
export const POS_IDLE = "bg-fg-6 text-muted-foreground hover:bg-fg-10 hover:text-foreground";
/** Superficie: card con borde sutil, sin sombra pesada. */
export const POS_SURFACE = "border border-border bg-card";

// Relleno sólido del CTA por acento: tonos con contraste AA (≥ 4.5:1) contra
// texto blanco. El de fuego es la llama profunda de la marca.
const ACCENT_SOLID: Record<PosAccent, { solid: string; hover: string; on: string }> = {
  fire: { solid: "#DB3A14", hover: "#E8431B", on: "#FFFFFF" },
  violet: { solid: "#5B2EFF", hover: "#6D4AFF", on: "#FFFFFF" },
  ocean: { solid: "#0369A1", hover: "#0377B5", on: "#FFFFFF" },
  mint: { solid: "#047857", hover: "#058A64", on: "#FFFFFF" },
};

export function accentVars(accent: PosAccent): CSSProperties {
  const g = ACCENT_GRADIENT[accent] ?? ACCENT_GRADIENT.fire;
  const s = ACCENT_SOLID[accent] ?? ACCENT_SOLID.fire;
  return {
    ["--pos-from" as string]: g.from,
    ["--pos-via" as string]: g.via,
    ["--pos-to" as string]: g.to,
    ["--pos-ink" as string]: g.ink,
    ["--pos-solid" as string]: s.solid,
    ["--pos-solid-hover" as string]: s.hover,
    ["--pos-on" as string]: s.on,
  } as CSSProperties;
}

const money0 = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const money2 = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Precio compacto para el POS: sin ",00" cuando es entero. */
export function money(value: number | null | undefined): string {
  const n = Number(value ?? 0);
  return Number.isInteger(Math.round(n * 100) / 100) ? money0.format(n) : money2.format(n);
}

// Colores de las teclas rápidas en relleno sólido (muestrario de la
// configuración). Sin degradados; mismos tonos que QUICK_KEY_DOT.
export const QUICK_KEY_FILL: Record<string, string> = {
  flame: "bg-[#DB3A14] text-white",
  gold: "bg-[#F5B800] text-[#2A1B00]",
  violet: "bg-[#7C4DFF] text-white",
  ocean: "bg-[#0369A1] text-white",
  mint: "bg-[#047857] text-white",
  rose: "bg-[#E11D48] text-white",
  slate: "bg-[#475569] text-white",
};

// Color de la tecla rápida en la pantalla de venta: sólo una barrita de
// acento sobre el tile neutro, no un relleno saturado.
export const QUICK_KEY_DOT: Record<string, string> = {
  flame: "#FF4B22",
  gold: "#F5B800",
  violet: "#7C4DFF",
  ocean: "#0EA5E9",
  mint: "#10B981",
  rose: "#F43F5E",
  slate: "#64748B",
};

/** Iniciales para productos sin foto ("Remera Oversize" → "RO"). */
export function initials(name: string): string {
  const w = name
    .trim()
    .split(/\s+/)
    .filter((x) => /[\p{L}\p{N}]/u.test(x));
  return ((w[0]?.[0] ?? "") + (w[1]?.[0] ?? "")).toUpperCase();
}
