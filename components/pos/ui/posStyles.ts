// Tokens visuales compartidos del POS rediseñado. El acento (pos_layout.accent)
// se inyecta como CSS vars en el contenedor del POS (--pos-from/via/to/ink);
// estas clases las consumen. Selección y foco van con RELLENO, nunca con borde
// de color (regla de marca).

import type { CSSProperties } from "react";
import { ACCENT_GRADIENT, type PosAccent } from "@/lib/pos/layout";

/** CTA principal (Cobrar): degradado del acento con tinta legible. */
export const POS_CTA =
  "bg-[linear-gradient(135deg,var(--pos-from),var(--pos-via)_55%,var(--pos-to))] text-[color:var(--pos-ink)] shadow-[0_12px_32px_-14px_var(--pos-from)] transition hover:brightness-[1.05] active:scale-[0.99] disabled:opacity-40 disabled:shadow-none";

/** Chip / segmento seleccionado (relleno invertido, estilo iOS). */
export const POS_SELECTED = "bg-foreground text-background";

/** Chip / segmento en reposo. */
export const POS_IDLE = "bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground";

/** Tinte suave del acento (fondos de estado, banners). */
export const POS_TINT = "bg-[color-mix(in_srgb,var(--pos-from)_13%,transparent)]";

/** Superficie elevada (tiles, paneles). */
export const POS_SURFACE = "bg-card shadow-[0_1px_0_rgba(255,255,255,0.04)_inset,0_6px_18px_-12px_rgba(8,5,20,0.5)]";

export function accentVars(accent: PosAccent): CSSProperties {
  const g = ACCENT_GRADIENT[accent] ?? ACCENT_GRADIENT.fire;
  return {
    ["--pos-from" as string]: g.from,
    ["--pos-via" as string]: g.via,
    ["--pos-to" as string]: g.to,
    ["--pos-ink" as string]: g.ink,
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

// Colores de las teclas rápidas (relleno sólido, texto legible).
export const QUICK_KEY_FILL: Record<string, string> = {
  flame: "bg-[linear-gradient(140deg,#FF4B22,#FF8A1F)] text-white",
  gold: "bg-[linear-gradient(140deg,#FFB21F,#FFD21F)] text-[#2A1B00]",
  violet: "bg-[linear-gradient(140deg,#5B2EFF,#8E6BFF)] text-white",
  ocean: "bg-[linear-gradient(140deg,#0369A1,#0EA5E9)] text-white",
  mint: "bg-[linear-gradient(140deg,#047857,#10B981)] text-white",
  rose: "bg-[linear-gradient(140deg,#BE123C,#FB7185)] text-white",
  slate: "bg-[linear-gradient(140deg,#334155,#64748B)] text-white",
};

// Monograma para productos sin foto (Boutique): color estable por nombre.
const MONO = [
  "from-[#FF4B22] to-[#FFB21F]",
  "from-[#5B2EFF] to-[#B79CFF]",
  "from-[#0369A1] to-[#67E8F9]",
  "from-[#047857] to-[#6EE7B7]",
  "from-[#BE123C] to-[#FDA4AF]",
  "from-[#7C2D12] to-[#FDBA74]",
];
export function monogramGradient(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return MONO[h % MONO.length] as string;
}
